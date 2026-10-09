/**
 * Pure direnv projections for the dsh-direnv plugin.
 *
 * This module is free of host services and side-effect free: it validates inputs,
 * interprets one `direnv export json` run, filters the resulting diff into a
 * safe environment map, and locates the `.envrc` that governs a workspace.
 * No shell string is ever built and no command is ever wrapped — the plugin
 * injects an environment MAP, so nothing model- or workspace-controlled ever
 * reaches a command line.
 *
 * @module dsh-direnv/core
 */
import type { ExecFileException } from "node:child_process";
import { execFileNoStdin } from "./process.js";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
// resolvePath is used by the deny-store hash, which mirrors direnv's own.
import {
	basename,
	isAbsolute,
	join,
	resolve as resolvePath,
} from "node:path";
import { realpathSync } from "node:fs";
import { DSH_ENV_PREFIX } from "@deepseek-ai/dsh-shell";

/** Environment variable names this plugin is willing to inject. */
export const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The harness-managed namespace, taken from the harness's own declaration so
 * it can never drift from what the shell seam actually owns. A workspace
 * `.envrc` must never be able to supply a `DSH_*` fact: the managed snapshot is
 * authoritative, and an unmanaged `DSH_*` name would otherwise read as a
 * harness fact to the model. Every such name is dropped from the injected diff.
 */
export const MANAGED_ENV_PREFIX = DSH_ENV_PREFIX;

/** Supported RC basenames for explicit approval requests. */
export const RC_NAMES = [".envrc", ".env"] as const;

/** The plugin name carried on the session-start context message and its section. */
export const SESSION_CONTEXT_PLUGIN = "dsh-direnv";

/**
 * Cap on the variable names a session-start context lists, so a Nix-scale
 * environment (hundreds of names) stays a readable snapshot instead of
 * flooding the first request. The count is always exact even when the list is
 * elided.
 */
export const SESSION_CONTEXT_MAX_NAMES = 64;

/** Config of the dsh-direnv plugin, validated strictly. */
export interface DirenvConfig {
	/** The direnv executable: a bare PATH name or an absolute path. */
	executable: string;
	/** Whether workspace environment injection is active. */
	enabled: boolean;
	/**
	 * Wall-clock budget for each native status or export run, in milliseconds.
	 * Exceeding it kills direnv and the command runs without injection.
	 */
	probeTimeoutMs: number;
	/**
	 * Whether a blocked `.envrc` makes the shell result carry an actionable
	 * notice. Disabling it keeps results byte-identical to the un-injected run.
	 */
	notifyOnBlocked: boolean;
	/**
	 * Whether starting a session injects one model-facing context message that
	 * states the workspace's direnv state: which variable NAMES are injected, or
	 * why none are (blocked, denied, error). Values are never included, and a
	 * workspace with no `.envrc` stays silent. Off means the model learns about
	 * direnv only from command notices.
	 */
	sessionContext: boolean;
	/**
	 * Whether `direnv_allow` may only approve a file inside the calling agent's
	 * own workspace root. Turn off only when the model is trusted to request
	 * arbitrary paths.
	 */
	restrictAllowToWorkspace: boolean;
	/**
	 * Whether a command's own working directory selects the `.envrc`, matching
	 * native direnv. On, a command run in `<workspace>/packages/api` picks up
	 * that package's `.envrc` rather than the repository root's, which is what
	 * direnv itself would do. Off, every command in a session uses exactly the
	 * session workspace root, which costs one probe per session instead of one
	 * per distinct directory.
	 */
	followWorkdir: boolean;
	/**
	 * Whether to resolve each directory once and reuse the result.
	 *
	 * On, each resolution checks native status, but only cache misses evaluate
	 * `direnv export`. The cache is invalidated automatically when
	 * the `.envrc` changes or when direnv's allow/deny store is rewritten
	 * (including by a `direnv allow` run outside this harness), and on demand by
	 * the `direnv_reload` tool. Off, every command runs export as well as status.
	 */
	cache: boolean;
}

/** The plan's defaults. */
export const defaultConfig: DirenvConfig = {
	executable: "direnv",
	enabled: true,
	probeTimeoutMs: 10_000,
	notifyOnBlocked: true,
	sessionContext: true,
	restrictAllowToWorkspace: true,
	followWorkdir: true,
	cache: true,
};

/** Why a workspace produced no injectable environment. */
export type DirenvStatusKind =
	| "injected"
	| "no-rc"
	| "blocked"
	| "denied"
	| "error"
	| "disabled";

/** One workspace's resolved direnv state. */
export interface DirenvStatus {
	kind: DirenvStatusKind;
	/** The `.envrc`/`.env` that governs the workspace, when one was found. */
	rcPath?: string;
	/**
	 * Variables to inject, already filtered; never contains a `DSH_*` name.
	 * A `undefined` value means "remove this name from the child environment",
	 * which is what a `.envrc`'s `unset` compiles to.
	 */
	env: InjectableEnv;
	/** Names dropped from the diff because they are unsafe to inject. */
	dropped: string[];
	/** A bounded, log-safe explanation; never contains an environment value. */
	detail?: string;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNulFreeString(value: unknown): value is string {
	return typeof value === "string" && !value.includes("\0");
}

function isInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

/** Validate the semantic config invariants the schema cannot express. */
export function assertDirenvConfig(config: DirenvConfig): void {
	if (
		!isNonEmptyString(config.executable) ||
		!isNulFreeString(config.executable) ||
		!isInteger(config.probeTimeoutMs) ||
		config.probeTimeoutMs <= 0
	) {
		throw new TypeError("invalid direnv config");
	}
}

export function isAbsolutePath(value: unknown): value is string {
	return isNulFreeString(value) && isAbsolute(value);
}

export function assertAbsolutePath(value: unknown): asserts value is string {
	if (!isAbsolutePath(value)) {
		throw new TypeError("invalid path");
	}
}

/**
 * A cheap identity for everything that can change what `direnv export` returns
 * for one directory:
 *
 * - the governing RC file (path, size, mtime) — an edit invalidates direnv's
 *   own content hash, so a new probe is mandatory;
 * - direnv's allow and deny stores (directory mtimes) — a `direnv allow` or
 *   `direnv deny` run OUTSIDE this harness changes neither the file nor its
 *   mtime, but it does rewrite one of those stores.
 *
 * The store paths follow direnv's own XDG layout so no direnv process is
 * needed to compute this. A missing entry contributes only its resolved path,
 * so the transition from "absent" to "present" changes the stamp.
 */
export function cacheStamp(
	rcPath: string | undefined,
	env: NodeJS.ProcessEnv | undefined = process.env,
): string {
	const parts: string[] = [rcPath ?? "-"];
	if (rcPath !== undefined) {
		try {
			const stat = statSync(rcPath);
			parts.push(`${String(stat.size)}:${String(stat.mtimeMs)}`);
		} catch {
			parts.push("missing");
		}
	}
	const dataHome =
		env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
			? env.XDG_DATA_HOME
			: env.HOME !== undefined && env.HOME.length > 0
				? join(env.HOME, ".local", "share")
				: undefined;
	if (dataHome !== undefined) {
		for (const store of ["allow", "deny"]) {
			const dir = join(dataHome, "direnv", store);
			try {
				parts.push(`${dir}:${String(statSync(dir).mtimeMs)}`);
			} catch {
				parts.push(`${dir}:absent`);
			}
		}
	}
	return parts.join("|");
}

/** Whether `path` names an existing directory. */
export function isExistingDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Run `direnv export json` in `workspace`. `export json` prints the DIFF direnv
 * would apply, which is exactly the injection this plugin performs.
 */
export async function runExport(
	workspace: string,
	config: DirenvConfig,
): Promise<{ stdout: string; stderr: string }> {
	assertAbsolutePath(workspace);
	return execFileNoStdin(config.executable, ["export", "json"], {
		cwd: workspace,
		timeout: config.probeTimeoutMs,
		maxBuffer: 8 * 1024 * 1024,
		killSignal: "SIGKILL",
		encoding: "utf8",
		windowsHide: true,
	});
}

/** The RC selected by native direnv, with its native authorization status. */
export interface NativeRc {
	path: string;
	allowed: number;
}

/** Let direnv own RC discovery. No RC is null; command or format errors throw. */
export async function readNativeStatus(
	workspace: string,
	config: DirenvConfig,
): Promise<NativeRc | null> {
	assertAbsolutePath(workspace);
	let stdout: string;
	try {
		stdout = (await execFileNoStdin(config.executable, ["status", "--json"], {
			cwd: workspace,
			timeout: config.probeTimeoutMs,
			maxBuffer: 1024 * 1024,
			killSignal: "SIGKILL",
			encoding: "utf8",
			windowsHide: true,
		})).stdout;
	} catch (error) {
		const failure = error as ExecFileException;
		throw new Error(
			failure.killed && typeof failure.code !== "string"
				? `direnv status timed out after ${config.probeTimeoutMs} ms`
				: `direnv status failed (${String(failure.code)})`,
			{ cause: error },
		);
	}
	try {
		const rc = JSON.parse(stdout)?.state?.foundRC;
		if (rc !== null && (
			!isAbsolutePath(rc?.path) || !isInteger(rc.allowed)
		)) throw new Error();
		return rc;
	} catch {
		throw new Error("direnv status produced output this plugin could not parse");
	}
}

/** One parsed diff entry: a value to set, or `null` meaning "unset me". */
export type DiffEntry = string | null;

/**
 * An environment map for one execution.
 *
 * The shell seam's declared type is `Record<string, string>`, but the
 * subprocess layer that consumes it removes every entry whose value is
 * `undefined` from the child environment. That is the only way to express a
 * real `unset` — which a `.envrc` can ask for — so the value type is widened
 * here and narrowed again at the seam boundary.
 */
export type InjectableEnv = Record<string, string | undefined>;

/**
 * Parse one `direnv export json` stdout into a diff. Returns `undefined` for
 * output that is not a JSON object of strings-or-null, so a malformed response
 * degrades to "no injection" instead of injecting garbage.
 */
export function parseExport(
	stdout: string,
): Record<string, DiffEntry> | undefined {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return undefined;
	const diff: Record<string, DiffEntry> = {};
	for (const [name, value] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		if (value === null) diff[name] = null;
		else if (typeof value === "string") diff[name] = value;
		else return undefined;
	}
	return diff;
}

/**
 * Filter one diff into the injectable map.
 *
 * Dropped: every `DSH_*` name (the managed snapshot is authoritative and must
 * never be forgeable from a workspace), every name that is not a portable
 * environment identifier, and every `DIRENV_*` bookkeeping variable (it
 * describes a shell hook this plugin does not run, and a stale `DIRENV_DIR`
 * would mislead tools that read it).
 */
export function selectInjectable(diff: Record<string, DiffEntry>): {
	env: InjectableEnv;
	dropped: string[];
} {
	const env: InjectableEnv = {};
	const dropped: string[] = [];
	for (const [name, value] of Object.entries(diff)) {
		if (
			!SAFE_ENV_NAME.test(name) ||
			name.startsWith(MANAGED_ENV_PREFIX) ||
			name.startsWith("DIRENV_")
		) {
			dropped.push(name);
			continue;
		}
		// `null` is direnv saying "this name must not be set". Omitting the name
		// would be wrong: the executor merges this map onto the credential-scrubbed
		// parent environment, so an absent name keeps whatever the parent had and
		// `unset FOO` in a .envrc would silently do nothing. `undefined` is the
		// subprocess seam's removal convention — it filters those entries out of
		// the target environment, so the child genuinely does not have the name.
		if (value === null) {
			env[name] = undefined;
			continue;
		}
		if (!isNulFreeString(value)) {
			dropped.push(name);
			continue;
		}
		env[name] = value;
	}
	return { env, dropped };
}

/** Recognize direnv's own refusal text without pinning ANSI or wording. */
export function looksBlocked(stderr: string): boolean {
	return /is blocked|blocked\. Run/i.test(stderr);
}

/**
 * The directory holding direnv's authorization stores, following direnv's own
 * XDG layout (`$XDG_DATA_HOME/direnv`, else `$HOME/.local/share/direnv`).
 * Returns `undefined` when neither variable is set, in which case the caller
 * must not claim to know direnv's authorization state.
 */
export function direnvStoreDir(
	env: NodeJS.ProcessEnv | undefined = process.env,
): string | undefined {
	const dataHome =
		env?.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
			? env.XDG_DATA_HOME
			: env?.HOME !== undefined && env.HOME.length > 0
				? join(env.HOME, ".local", "share")
				: undefined;
	return dataHome === undefined ? undefined : join(dataHome, "direnv");
}

/**
 * Whether direnv has recorded a DENY for this exact file.
 *
 * A denied `.envrc` is indistinguishable from an empty one by its export
 * output — direnv exits zero and applies nothing in both cases — so the deny
 * store is the only authoritative signal. The file name is direnv's own
 * `pathHash`: sha256 of the absolute path plus a newline.
 */
export function isDenied(
	rcPath: string,
	env: NodeJS.ProcessEnv | undefined = process.env,
): boolean {
	const store = direnvStoreDir(env);
	if (store === undefined) return false;
	const hash = createHash("sha256")
		.update(`${resolvePath(rcPath)}\n`)
		.digest("hex");
	try {
		return statSync(join(store, "deny", hash)).isFile();
	} catch {
		return false;
	}
}

/**
 * Whether a diff carries any entry direnv itself produced.
 *
 * `direnv export json` always emits its own `DIRENV_*` bookkeeping keys, even
 * for a denied or empty RC, so "did direnv apply anything" must be asked of the
 * remaining names rather than of the raw object.
 */
export function hasAppliedEntries(diff: Record<string, DiffEntry>): boolean {
	return Object.keys(diff).some((name) => !name.startsWith("DIRENV_"));
}

/**
 * Resolve one workspace's export using the RC path selected by native status.
 * Ask direnv for the diff and project it into an injectable map. Native
 * direnv owns authorization — a file that was never allowed, or whose content
 * changed since it was allowed, is refused by direnv itself and this function
 * reports `blocked` without ever evaluating the file.
 */
export async function resolveStatus(
	workspace: string,
	config: DirenvConfig,
	rcPath: string | undefined,
): Promise<DirenvStatus> {
	if (!config.enabled) return { kind: "disabled", env: {}, dropped: [] };
	let stdout: string;
	try {
		stdout = (await runExport(workspace, config)).stdout;
	} catch (error) {
		const failure = error as ExecFileException & { stderr?: string };
		const blocked = typeof failure.code === "number" && looksBlocked(failure.stderr ?? "");
		return {
			kind: blocked ? "blocked" : "error", env: {}, dropped: [],
			...(rcPath === undefined ? {} : { rcPath }),
			detail: blocked
				? "the workspace .envrc is not approved; native direnv refused to load it"
				: failure.killed && typeof failure.code !== "string"
					? `direnv export timed out after ${config.probeTimeoutMs} ms`
					: `direnv export failed (${String(failure.code)})`,
		};
	}

	const diff = parseExport(stdout);
	if (diff === undefined) {
		return {
			kind: "error",
			env: {},
			dropped: [],
			...(rcPath === undefined ? {} : { rcPath }),
			detail: "direnv export produced output this plugin could not parse",
		};
	}
	const { env, dropped } = selectInjectable(diff);
	if (rcPath === undefined) {
		// No RC anywhere: nothing governs this directory and there is nothing to allow.
		return { kind: "no-rc", env, dropped };
	}
	if (Object.keys(env).length === 0 && !hasAppliedEntries(diff)) {
		// An RC exists, direnv exited zero, yet it applied nothing. That is either
		// a denied file (direnv >= 2.33 revokes silently) or a legitimately empty
		// one; only the deny store distinguishes them, so an empty .envrc is
		// reported as "nothing to inject" rather than as an error the user must act
		// on. `unset`-only diffs are non-empty here and therefore still inject.
		if (!isDenied(rcPath)) {
			return { kind: "no-rc", rcPath, env, dropped };
		}
		return {
			kind: "denied",
			rcPath,
			env,
			dropped,
			detail: "this .envrc is denied; re-approve it to load its environment",
		};
	}
	return { kind: "injected", rcPath, env, dropped };
}

/** A short, log-safe one-line summary of a status; never carries env values. */
export function describeStatus(status: DirenvStatus): string {
	const where = status.rcPath === undefined ? "" : ` (${status.rcPath})`;
	switch (status.kind) {
		case "injected":
			return `direnv injected ${Object.keys(status.env).length} variable(s)${where}`;
		case "no-rc":
			return "no .envrc governs this workspace";
		case "blocked":
			return `the workspace .envrc is blocked${where}`;
		case "denied":
			return `the workspace .envrc is denied${where}`;
		case "error":
			return status.detail ?? "direnv could not be consulted";
		case "disabled":
			return "direnv injection is disabled";
	}
}

/**
 * The actionable notice appended to a shell result when a workspace cannot be
 * injected. It names the exact file and the exact tool call, so the model's
 * next action is unambiguous.
 */
export function blockedNotice(
	status: DirenvStatus,
	workspace: string,
): string | undefined {
	const rc = status.rcPath;
	if (status.kind === "blocked") {
		const target = rc === undefined ? "the workspace .envrc" : rc;
		return [
			"",
			"[dsh-direnv] This command ran WITHOUT the workspace direnv environment.",
			`[dsh-direnv] ${target} is not approved, so native direnv refused to load it.`,
			"[dsh-direnv] Call the direnv_allow tool with this path to ask the user to approve it:",
			`[dsh-direnv]   direnv_allow path=${target}`,
			`[dsh-direnv] Workspace: ${workspace}`,
			"",
		].join("\n");
	}
	if (status.kind === "denied") {
		const target = rc === undefined ? "the workspace .envrc" : rc;
		return [
			"",
			"[dsh-direnv] This command ran WITHOUT the workspace direnv environment.",
			`[dsh-direnv] ${target} exists but direnv applied nothing: it is denied, or the file exports nothing.`,
			"[dsh-direnv] Ask the user to check it with: direnv status",
			"",
		].join("\n");
	}
	if (status.kind === "error") {
		return [
			"",
			"[dsh-direnv] This command ran WITHOUT the workspace direnv environment.",
			`[dsh-direnv] ${status.detail ?? "direnv could not be consulted."}`,
			"",
		].join("\n");
	}
	return undefined;
}

/**
 * The model-facing context injected once when a session starts, or `undefined`
 * when the workspace has nothing to say (`no-rc`, `disabled`).
 *
 * The text names the injected variables but never their values: values belong
 * to the workspace and may be secrets, so the message is a snapshot of WHICH
 * environment a session has, not of the environment itself. The text is
 * self-identifying because it arrives as a plugin-sourced user message with no
 * surrounding command output to attribute it.
 */
export function sessionContextText(
	status: DirenvStatus,
	workspace: string,
): string | undefined {
	const prefix = `[${SESSION_CONTEXT_PLUGIN}]`;
	switch (status.kind) {
		case "disabled":
		case "no-rc":
			return undefined;
		case "injected": {
			// Count only names that will be SET; a `.envrc`'s `unset` is not an
			// injected variable and must not inflate the list or its count.
			const names = Object.entries(status.env)
				.filter(([, value]) => value !== undefined)
				.map(([name]) => name)
				.sort();
			const shown = names.slice(0, SESSION_CONTEXT_MAX_NAMES);
			const hidden = names.length - shown.length;
			const list =
				shown.length === 0
					? "(no variables; this .envrc only unsets names)"
					: `${shown.join(", ")}${hidden > 0 ? `, and ${String(hidden)} more` : ""}`;
			return [
				`${prefix} The workspace direnv environment is active.`,
				`${prefix} ${status.rcPath ?? "The governing .envrc"} injects ${String(names.length)} variable(s) into every command the agent runs:`,
				`${prefix}   ${list}`,
				`${prefix} Values are applied to each command's environment and are deliberately not shown here.`,
			].join("\n");
		}
		case "blocked": {
			const target = status.rcPath ?? "the workspace .envrc";
			return [
				`${prefix} The workspace direnv environment is NOT loaded: ${target} is not approved.`,
				`${prefix} Call the direnv_allow tool with this path to ask the user to approve it:`,
				`${prefix}   direnv_allow path=${target}`,
				`${prefix} Workspace: ${workspace}`,
			].join("\n");
		}
		case "denied": {
			const target = status.rcPath ?? "the workspace .envrc";
			return [
				`${prefix} The workspace direnv environment is NOT loaded: ${target} is denied.`,
				`${prefix} Ask the user to check it with: direnv status`,
				`${prefix} Workspace: ${workspace}`,
			].join("\n");
		}
		case "error":
			return [
				`${prefix} The workspace direnv environment is NOT loaded.`,
				`${prefix} ${status.detail ?? "direnv could not be consulted."}`,
				`${prefix} Workspace: ${workspace}`,
			].join("\n");
	}
}

/**
 * Canonicalize a path for containment checks: resolve symlinks when the path
 * exists, and fall back to lexical normalization when it does not.
 */
function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolvePath(path);
	}
}

/**
 * Whether `child` is inside `root` (or is `root`).
 *
 * Both sides are canonicalized first, so neither a `..` segment nor a symlink
 * can smuggle a path out of the workspace: a textual prefix check alone would
 * accept `/ws/../elsewhere/.envrc` and a symlinked `.envrc` pointing outside.
 */
export function isWithin(root: string, child: string): boolean {
	assertAbsolutePath(root);
	assertAbsolutePath(child);
	const realRoot = canonicalize(root);
	const realChild = canonicalize(child);
	if (realChild === realRoot) return true;
	return realChild.startsWith(
		realRoot.endsWith("/") ? realRoot : `${realRoot}/`,
	);
}

/**
 * Enforce the tool's explicit-path and workspace policy before asking for consent.
 * File existence, file type, and authorization errors are left to direnv.
 * Returns a refusal reason, or `undefined` when these preconditions hold.
 */
export function refuseAllow(
	rcPath: string,
	workspace: string | undefined,
	restrict: boolean,
): string | undefined {
	if (!isAbsolutePath(rcPath)) return "invalid path";
	if (!(RC_NAMES as readonly string[]).includes(basename(rcPath))) {
		return `path must name one of ${RC_NAMES.join(", ")}: ${rcPath}`;
	}
	if (restrict) {
		if (workspace === undefined)
			return "this call has no workspace, so an absolute path cannot be approved";
		if (!isWithin(workspace, rcPath)) {
			return `path is outside the calling workspace (${workspace}): ${rcPath}`;
		}
	}
	return undefined;
}
