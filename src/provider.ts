/**
 * `direnv` service provider: resolves one workspace's native direnv
 * environment for the shell adapter and owns the approval bookkeeping the
 * `direnv_allow` tool consults.
 *
 * The provider owns strict config validation, a bounded `direnv export json`
 * probe, and workspace resolution from the calling agent's session. It never
 * builds a shell string, never uses `shell: true`, and never mutates
 * `process.env`: direnv's diff is returned as a MAP for the executor to merge
 * into the child environment, so no workspace-controlled byte ever reaches a
 * command line.
 *
 * Workspaces are resolved at session startup or by an explicit reload. Commands
 * synchronously read the last snapshot; they never check files or run direnv.
 * Resolution remains asynchronous so a heavy `.envrc` leaves the event loop free.
 *
 * @module dsh-direnv
 */
import { resolve as resolvePath } from "node:path";
import type { ExecFileException } from "node:child_process";
import { execFileNoStdin } from "./process.js";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";
import {
	blockedNotice,
	defaultConfig,
	describeStatus,
	envNames,
	readNativeStatus,
	isAbsolutePath,
	refuseAllow,
	resolveStatus,
	type DirenvConfig,
	type DirenvStatus,
	type InjectableEnv,
} from "./core.js";

declare module "@deepseek-ai/cordis" {
	interface Context {
		/** Native direnv environment projections for agent-owned shell calls. */
		direnv: DirenvService;
	}
}

export type {
	DirenvConfig,
	DirenvStatus,
	InjectableEnv,
} from "./core.js";
export { defaultConfig, envNames } from "./core.js";

/** One directory's outcome after a reload. */
export interface ReloadChange {
	/** The directory whose environment was re-resolved. */
	directory: string;
	/** The governing RC file, when one was found. */
	rcPath?: string;
	/** The resolved state after the reload. */
	kind: DirenvStatus["kind"];
	/** How many variables will now be injected. */
	variables: number;
	/** Names set by the current filtered direnv environment diff. */
	added: string[];
	/** Names unset by the current filtered direnv environment diff. */
	removed: string[];
}

/** What one `reload` call did. */
export interface ReloadReport {
	/** How many directories were re-resolved. */
	reloaded: number;
	/** One entry per re-resolved directory. */
	changed: ReloadChange[];
}

export default class DirenvService extends Service {
	static Config = z.object({
		executable: z
			.string()
			.pattern(/^[^\0]+$/)
			.default(defaultConfig.executable),
		enabled: z.boolean().default(defaultConfig.enabled),
		probeTimeoutMs: z
			.natural()
			.min(1)
			.max(600_000)
			.default(defaultConfig.probeTimeoutMs),
		notifyOnBlocked: z.boolean().default(defaultConfig.notifyOnBlocked),
		sessionContext: z.boolean().default(defaultConfig.sessionContext),
		restrictAllowToWorkspace: z
			.boolean()
			.default(defaultConfig.restrictAllowToWorkspace),
	}) as z<DirenvConfig>;

	/**
	 * The shell service is required because the value of this plugin is exactly
	 * the environment its calls receive; without a shell there is nothing to
	 * inject into, so activation fails loudly instead of loading inert.
	 */
	static inject = ["shell"];

	constructor(
		ctx: Context,
		private readonly config: DirenvConfig = defaultConfig,
	) {
		super(ctx, "direnv");
	}

	/** Read-only projection of the `enabled` switch, read by the adapters per call. */
	get enabled(): boolean {
		return this.config.enabled;
	}

	/** Read-only projection of the resolved config, for adapters and tools. */
	get settings(): Readonly<DirenvConfig> {
		return this.config;
	}

	/**
	 * Resolve the workspace directory of one agent: its session's recorded
	 * absolute cwd. Returns `undefined` for an agent with no usable cwd, which
	 * makes every adapter pass its call through untouched.
	 */
	workspaceFor(agent: Agent): string | undefined {
		const cwd = agent.session.header.cwd;
		if (!isAbsolutePath(cwd)) return undefined;
		return resolvePath(cwd);
	}

	/** Resolved snapshots; command execution only reads these synchronously. */
	private readonly snapshots = new Map<string, DirenvStatus>();

	/** Concurrent explicit resolutions of a workspace share one probe. */
	private readonly inflight = new Map<string, Promise<DirenvStatus>>();

	/** Read the last resolved state without any process or filesystem access. */
	statusFor(workspace: string): DirenvStatus {
		if (!this.config.enabled) return { kind: "disabled", env: {}, dropped: [] };
		return (
			this.snapshots.get(workspace) ?? {
				kind: "error",
				env: {},
				dropped: [],
				detail:
					"workspace environment is not loaded; reopen the session or call direnv_reload",
			}
		);
	}

	private async resolveWorkspace(workspace: string): Promise<DirenvStatus> {
		const existing = this.inflight.get(workspace);
		if (existing !== undefined) return existing;
		const pending = (async (): Promise<DirenvStatus> => {
			let status: DirenvStatus;
			try {
				status = this.config.enabled
					? await resolveStatus(
							workspace,
							this.config,
							await readNativeStatus(workspace, this.config),
						)
					: { kind: "disabled", env: {}, dropped: [] };
			} catch (error) {
				status = {
					kind: "error",
					env: {},
					dropped: [],
					detail: error instanceof Error ? error.message : String(error),
				};
			}
			this.snapshots.set(workspace, status);
			return status;
		})();
		this.inflight.set(workspace, pending);
		try {
			return await pending;
		} finally {
			this.inflight.delete(workspace);
		}
	}

	/**
	 * Resolve one workspace (or all previously resolved workspaces) explicitly.
	 * Session startup also calls this; command execution never does.
	 * Report the current filtered direnv set/unset diff, not a cache comparison.
	 */
	async reload(workspace?: string): Promise<ReloadReport> {
		const targets =
			workspace === undefined ? [...this.snapshots.keys()] : [workspace];
		const changed: ReloadChange[] = [];
		for (const dir of targets) {
			const after = await this.resolveWorkspace(dir);
			const names = envNames(after.env);
			changed.push({
				directory: dir,
				kind: after.kind,
				variables: names.length,
				...(after.rcPath === undefined ? {} : { rcPath: after.rcPath }),
				added: names,
				removed: Object.keys(after.env)
					.filter((name) => after.env[name] === undefined)
					.sort(),
			});
		}
		return { reloaded: targets.length, changed };
	}

	/** The stored environment patch and optional command notice. No probing. */
	forWorkspace(workspace: string): {
		env: InjectableEnv;
		status: DirenvStatus;
		notice?: string;
	} {
		const status = this.statusFor(workspace);
		const notice = this.config.notifyOnBlocked
			? blockedNotice(status, workspace)
			: undefined;
		return {
			env: status.env,
			status,
			...(notice === undefined ? {} : { notice }),
		};
	}

	/** A log-safe description of the stored workspace state. */
	describe(workspace: string): string {
		return describeStatus(this.statusFor(workspace));
	}

	/** The refusal reason for approving an RC on behalf of a workspace. */
	refusalFor(
		rcPath: string,
		workspace: string | undefined,
	): string | undefined {
		return refuseAllow(rcPath, workspace, this.config.restrictAllowToWorkspace);
	}

	/** Approve current file content after explicit user consent. Does not reload. */
	async approve(
		rcPath: string,
		workspace: string | undefined,
	): Promise<{ ok: true } | { ok: false; reason: string }> {
		const refusal = this.refusalFor(rcPath, workspace);
		if (refusal !== undefined) return { ok: false, reason: refusal };
		try {
			await runAllow(rcPath, this.config);
		} catch (error) {
			const failure = error as ExecFileException & { stderr?: string };
			const detail = firstLine(failure.stderr ?? "");
			return {
				ok: false,
				reason: `direnv allow exited with code ${String(failure.code)}${detail.length === 0 ? "" : `: ${detail}`}`,
			};
		}
		return { ok: true };
	}
}

/** The first non-empty line of a diagnostic, ANSI-stripped and bounded. */
export function firstLine(text: string): string {
	const line =
		text
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Match the ESC byte that starts ANSI color sequences.
			.replace(/\u001B\[[0-9;]*m/g, "")
			.split("\n")
			.map((part) => part.trim())
			.find((part) => part.length > 0) ?? "";
	return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** Run direnv allow with a fixed argv, without blocking the event loop. */
export async function runAllow(
	rcPath: string,
	config: DirenvConfig,
): Promise<void> {
	await execFileNoStdin(config.executable, ["allow", rcPath], {
		timeout: config.probeTimeoutMs,
		maxBuffer: 1024 * 1024,
		killSignal: "SIGKILL",
		encoding: "utf8",
		windowsHide: true,
	});
}
