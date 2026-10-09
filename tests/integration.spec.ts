/**
 * End-to-end tests against the REAL direnv binary, the REAL service, and the
 * REAL chain adapter over a recording shell executor.
 *
 * Every workspace, every authorization store, and every child environment lives
 * under one temp root with isolated XDG_DATA_HOME / XDG_CONFIG_HOME /
 * XDG_CACHE_HOME and HOME, so the developer's real direnv authorization state is
 * never read, compared, or written.
 *
 * @module tests/integration
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import type {
	ShellExecRequest,
	ShellExecSpec,
	ShellExecution,
} from "@deepseek-ai/dsh-shell";
import { afterAll, describe, expect, it } from "vitest";
import DirenvService, {
	defaultConfig,
	type DirenvConfig,
} from "../src/provider.js";
import { requireRealProcesses } from "./helpers.js";
import { installDirenvShellAdapter } from "../src/shell-adapter.js";
import { readNativeStatus } from "../src/core.js";

/** One isolated direnv sandbox: workspace plus private HOME and XDG roots. */
interface Sandbox {
	root: string;
	home: string;
	data: string;
	config: string;
	cache: string;
	workspace: string;
}

const sandboxes: Sandbox[] = [];

function sandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "dsh-direnv-e2e-"));
	const box: Sandbox = {
		root,
		home: join(root, "home"),
		data: join(root, "data"),
		config: join(root, "config"),
		cache: join(root, "cache"),
		workspace: join(root, "ws"),
	};
	for (const dir of [box.home, box.data, box.config, box.cache, box.workspace])
		mkdirSync(dir, { recursive: true });
	sandboxes.push(box);
	return box;
}

/**
 * The environment every direnv child in these tests runs with.
 *
 * `process.env` is the base, exactly as production uses it, with only the
 * direnv authorization store redirected into the sandbox. That base matters:
 * `direnv export json` returns a DIFF against the environment it ran in, so a
 * deliberately minimal base would make bash's own startup files appear as
 * "changes" and pollute every assertion with unrelated variables.
 */
function direnvEnv(box: Sandbox): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: box.home,
		XDG_DATA_HOME: box.data,
		XDG_CONFIG_HOME: box.config,
		XDG_CACHE_HOME: box.cache,
	};
}

/** Authorize one RC file with the REAL direnv, in this sandbox's own store. */
function allowWithRealDirenv(box: Sandbox, rcPath: string): void {
	const result = spawnSync("direnv", ["allow", rcPath], {
		env: direnvEnv(box),
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(
			`test setup: direnv allow failed: ${String(result.stderr)}`,
		);
}

/** Write one .envrc, authorizing it by default. */
function writeRc(
	box: Sandbox,
	relativeDir: string,
	body: string,
	allow = true,
): string {
	const dir = join(box.workspace, relativeDir);
	mkdirSync(dir, { recursive: true });
	const rcPath = join(dir, ".envrc");
	writeFileSync(rcPath, body);
	if (allow) allowWithRealDirenv(box, rcPath);
	return rcPath;
}

/** Run the real direnv export in one sandbox, with its isolated store. */
function exportIn(box: Sandbox, dir: string, config: DirenvConfig) {
	const result = spawnSync(config.executable, ["export", "json"], {
		cwd: dir,
		env: direnvEnv(box),
		timeout: config.probeTimeoutMs,
		encoding: "utf8",
	});
	return {
		code: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		timedOut: false,
		spawnFailed: result.error !== undefined,
	};
}

afterAll(() => {
	for (const box of sandboxes.splice(0))
		rmSync(box.root, { recursive: true, force: true });
});

/**
 * A recording shell executor: requests resolve through the REAL adapter chain
 * and each spec is captured, so assertions observe exactly the environment the
 * executor would have handed the child.
 */
class RecordingShell {
	specs: ShellExecSpec[] = [];
	sandboxMode = undefined;

	resolve(request: ShellExecRequest): ShellExecSpec {
		return {
			command: request.command,
			workdir: request.workdir ?? "/default-workdir",
			timeoutMs: request.timeoutMs ?? 1_000,
			onExpiry: request.onExpiry ?? "kill",
			stdoutMaxBytes: request.stdoutMaxBytes ?? 1_024,
			...(request.signal !== undefined ? { signal: request.signal } : {}),
			...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
			...(request.env !== undefined ? { env: request.env } : {}),
			...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
			sandboxPolicy: request.sandboxPolicy,
		};
	}

	last(): ShellExecSpec {
		const spec = this.specs.at(-1);
		if (spec === undefined) throw new Error("no spec was resolved");
		return spec;
	}

	/** Resolve and record; callers that only inspect `last()` ignore the handle. */
	run(request: ShellExecRequest): Promise<ShellExecution> {
		return this.execute(this.resolve(request));
	}

	execute(spec: ShellExecSpec): Promise<ShellExecution> {
		this.specs.push(spec);
		return Promise.resolve(resultOf(spec, ""));
	}
}

/**
 * One fake execution handle matching the real executor's shape: a live
 * `status`/`exitCode`, a consuming `readOutput`, and the non-consuming
 * `observed` stream readers the job registry pumps.
 */
function resultOf(spec: ShellExecSpec, stderrText: string): ShellExecution {
	let readOffset = 0;
	let observedOffset = 0;
	const handle = {
		status: "completed" as const,
		exitCode: 0,
		signal: null,
		sandbox: undefined,
		done: Promise.resolve(),
		readOutput: () => {
			const delta = readOffset === 0 ? stderrText : "";
			readOffset = stderrText.length;
			return { delta, lossy: false };
		},
		observed: {
			stdout: {
				readFrom: (from: number) => ({
					text: "",
					nextOffset: from,
					lossy: false,
				}),
			},
			stderr: {
				readFrom: (from: number) => {
					const text = stderrText.slice(Math.min(from, stderrText.length));
					observedOffset = stderrText.length;
					return { text, nextOffset: observedOffset, lossy: false };
				},
			},
		},
		kill: () => false,
		result: () =>
			Promise.resolve({
				exitCode: 0,
				signal: null,
				timedOut: false,
				aborted: false,
				timeoutMs: spec.timeoutMs,
				stdout: { text: "", truncated: false },
				stderr: { text: stderrText, truncated: false },
			}),
	};
	return handle as unknown as ShellExecution;
}

/**
 * Install one plain object as the composition's `shell` service. `provide` is
 * used instead of a full plugin so the test never drags the real executor's
 * dependency chain into the process.
 */
function provideShell(ctx: Context, shell: RecordingShell): RecordingShell {
	ctx.provide("shell", shell);
	return shell;
}

/** The fibers one test booted, so teardown awaits every plugin it started. */
interface Booted {
	ctx: Context;
	shell: RecordingShell;
	agents: FakeAgents;
	dispose(): Promise<void>;
}

/**
 * A minimal stand-in for the agent registry's initiator scope.
 *
 * The value lives in module state rather than on the service instance: a
 * Cordis service is reached through a traceable proxy, and assigning to a
 * property on that proxy writes the consumer's shadow, never the provider.
 */
let currentAgent: unknown;
class FakeAgents extends Service {
	constructor(ctx: Context) {
		super(ctx, "agents");
	}
	currentInitiator(): unknown {
		return currentAgent;
	}
}

/** Boot a composition with the real service, real adapter, and fakes for the rest. */
async function boot(
	box: Sandbox,
	overrides: Partial<DirenvConfig> = {},
	runExport?: () => never,
): Promise<Booted> {
	const ctx = new Context();
	provideShell(ctx, new RecordingShell());
	const agents = await ctx.plugin(FakeAgents);
	const config: DirenvConfig = { ...defaultConfig, ...overrides };
	const serviceFiber = await ctx.plugin(
		class extends DirenvService {
			constructor(applyCtx: Context) {
				// The sandbox environment travels through the runtime seam, so the probe
				// and the cache stamp always describe the same direnv store.
				super(applyCtx, config, {
					env: direnvEnv(box),
					...(runExport === undefined
						? { runExport: (dir, cfg) => exportIn(box, dir, cfg) }
						: { runExport }),
				});
			}
		},
	);
	const adapter = installDirenvShellAdapter(ctx);
	currentAgent = { session: { header: { cwd: box.workspace } } };
	return {
		ctx,
		// The PROXY, not the raw object: the adapter chain is installed on the
		// provider target, and only the proxy dispatches through it.
		shell: ctx.shell as unknown as RecordingShell,
		agents: agents as unknown as FakeAgents,
		async dispose() {
			adapter.dispose();
			await serviceFiber.dispose();
			await agents.dispose();
		},
	};
}

const describeReal = requireRealProcesses("real-direnv tests")
	? describe
	: describe.skip;

describeReal("native RC discovery", () => {
	it("finds the nearest ancestor RC without evaluating it", async () => {
		const box = sandbox();
		const rootRc = writeRc(box, ".", "exit 77\n");
		const sub = join(box.workspace, "packages", "api");
		mkdirSync(sub, { recursive: true });
		const config = { ...defaultConfig, env: direnvEnv(box) };
		const root = await readNativeStatus(sub, config);
		expect(root?.path).toBe(rootRc);
		const nearerRc = join(box.workspace, "packages", ".envrc");
		writeFileSync(nearerRc, "exit 88\n");
		const nearer = await readNativeStatus(sub, config);
		expect(nearer?.path).toBe(nearerRc);
	});

	it("honors native load_dotenv and .envrc precedence", async () => {
		const box = sandbox();
		const dotenv = join(box.workspace, ".env");
		writeFileSync(dotenv, "A=1\n");
		const config = { ...defaultConfig, env: direnvEnv(box) };
		const disabled = await readNativeStatus(box.workspace, config);
		expect(disabled?.path).not.toBe(dotenv);
		mkdirSync(join(box.config, "direnv"), { recursive: true });
		writeFileSync(
			join(box.config, "direnv", "direnv.toml"),
			"[global]\nload_dotenv = true\n",
		);
		const enabled = await readNativeStatus(box.workspace, config);
		expect(enabled?.path).toBe(dotenv);
		const rc = writeRc(box, ".", "export A=2\n", false);
		const preferred = await readNativeStatus(box.workspace, config);
		expect(preferred?.path).toBe(rc);
	});

	it("reports a status failure instead of falling back to custom discovery", async () => {
		const box = sandbox();
		writeRc(box, ".", "export A=1\n", false);
		await expect(readNativeStatus(box.workspace, {
			...defaultConfig,
			executable: "/nonexistent/direnv",
			env: direnvEnv(box),
		})).rejects.toThrow("direnv could not be started");
	});
});

describeReal("direnv injection (real direnv)", () => {
	it("leaves a missing approval target for direnv to reject", async () => {
		const box = sandbox();
		const app = await boot(box);
		try {
			const result = await app.ctx.direnv.approve(
				join(box.workspace, ".envrc"),
				box.workspace,
			);
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("direnv allowed a missing file");
			expect(result.reason).toContain("direnv allow exited with code");
		} finally {
			await app.dispose();
		}
	});

	it("injects an allowed .envrc into the executed shell spec", async () => {
		const box = sandbox();
		writeRc(box, ".", 'export E2E_ONE=alpha\nexport E2E_TWO="a b"\n');
		const app = await boot(box);
		try {
			await app.shell.run(app.shell.resolve({ command: "echo hi" }));
			const env = app.shell.last().env ?? {};
			expect(env.E2E_ONE).toBe("alpha");
			expect(env.E2E_TWO).toBe("a b");
		} finally {
			await app.dispose();
		}
	});

	it("injects on execute only, never on the synchronous resolve", async () => {
		const box = sandbox();
		writeRc(box, ".", "export ONLY_EXEC=1\n");
		const app = await boot(box);
		try {
			// `resolve` is synchronous by contract and stays unwrapped; the async
			// probe runs in `execute`, so the env lands on the spec the executor
			// receives rather than on one a caller merely prepared.
			expect(app.shell.resolve({ command: "true" }).env).toBeUndefined();
			await app.shell.run(app.shell.resolve({ command: "true" }));
			expect(app.shell.last().env?.ONLY_EXEC).toBe("1");
		} finally {
			await app.dispose();
		}
	});

	it("never touches the command string", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n");
		const app = await boot(box);
		try {
			const command = "echo \"quoted 'text'\" && ls -la | wc -l";
			await app.shell.run(app.shell.resolve({ command }));
			expect(app.shell.last().command).toBe(command);
		} finally {
			await app.dispose();
		}
	});

	it("injects nothing when no .envrc governs the workspace", async () => {
		const box = sandbox();
		const app = await boot(box);
		try {
			await app.shell.run(app.shell.resolve({ command: "true" }));
			expect(app.shell.last().env).toBeUndefined();
		} finally {
			await app.dispose();
		}
	});

	it("injects nothing for an unallowed .envrc, but reports the block actionably", async () => {
		const box = sandbox();
		writeRc(box, ".", "export SHOULD_NOT_APPEAR=1\n", false);
		const app = await boot(box);
		try {
			const result = await (
				await app.ctx.shell.execute(app.shell.resolve({ command: "true" }))
			).result();
			expect(app.shell.last().env).toBeUndefined();
			expect(result.stderr.text).toContain("[dsh-direnv]");
			expect(result.stderr.text).toContain("direnv_allow");
			expect(result.stderr.text).toContain(join(box.workspace, ".envrc"));
			expect(result.stderr.text).not.toContain("SHOULD_NOT_APPEAR=1");
		} finally {
			await app.dispose();
		}
	});

	it("stays silent about a block when notifyOnBlocked is off", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n", false);
		const app = await boot(box, { notifyOnBlocked: false });
		try {
			const result = await (
				await app.ctx.shell.execute(app.shell.resolve({ command: "true" }))
			).result();
			expect(result.stderr.text).toBe("");
		} finally {
			await app.dispose();
		}
	});

	it("drops a forged DSH_* namespace exported by an allowed .envrc", async () => {
		const box = sandbox();
		writeRc(
			box,
			".",
			[
				"export DSH_HOME=/evil",
				"export DSH_SESSION_ID=forged-session",
				"export DSH_BACKDOOR=1",
				"export LEGITIMATE=kept",
				"",
			].join("\n"),
		);
		const app = await boot(box);
		try {
			await app.shell.run(app.shell.resolve({ command: "true" }));
			const env = app.shell.last().env ?? {};
			expect(env.LEGITIMATE).toBe("kept");
			expect("DSH_HOME" in env).toBe(false);
			expect("DSH_SESSION_ID" in env).toBe(false);
			expect("DSH_BACKDOOR" in env).toBe(false);
		} finally {
			await app.dispose();
		}
	});

	it("drops DIRENV_* bookkeeping variables", async () => {
		const box = sandbox();
		writeRc(box, ".", "export KEPT=v\n");
		const app = await boot(box);
		try {
			await app.shell.run(app.shell.resolve({ command: "true" }));
			const env = app.shell.last().env ?? {};
			expect(env.KEPT).toBe("v");
			for (const name of Object.keys(env))
				expect(name.startsWith("DIRENV_")).toBe(false);
		} finally {
			await app.dispose();
		}
	});

	it("lets direnv extend PATH and unset a variable", async () => {
		const box = sandbox();
		writeRc(box, ".", 'export PATH="$PATH:/opt/e2e/bin"\nunset E2E_REMOVE\n');
		const app = await boot(box);
		try {
			await app.shell.run(app.shell.resolve({ command: "true" }));
			const env = app.shell.last().env ?? {};
			expect(env.PATH?.endsWith("/opt/e2e/bin")).toBe(true);
			expect("E2E_REMOVE" in env).toBe(false);
		} finally {
			await app.dispose();
		}
	});

	it("re-blocks after content changes, and unblocks after a new allow", async () => {
		const box = sandbox();
		const rc = writeRc(box, ".", "export V=v1\n");
		const app = await boot(box);
		try {
			await app.shell.run(app.shell.resolve({ command: "true" }));
			expect(app.shell.last().env?.V).toBe("v1");
			writeFileSync(rc, "export V=v2\n");
			const blocked = await (
				await app.ctx.shell.execute(app.shell.resolve({ command: "true" }))
			).result();
			expect(app.shell.last().env).toBeUndefined();
			expect(blocked.stderr.text).toContain("[dsh-direnv]");
			allowWithRealDirenv(box, rc);
			await app.shell.run(app.shell.resolve({ command: "true" }));
			expect(app.shell.last().env?.V).toBe("v2");
		} finally {
			await app.dispose();
		}
	});

	it("gives a nested package its own .envrc, like native direnv", async () => {
		const box = sandbox();
		writeRc(box, ".", "export ROOT_VAR=root\n");
		writeRc(box, "packages/api", "export PKG_VAR=api\n");
		const app = await boot(box);
		try {
			const nested = join(box.workspace, "packages", "api");
			await app.shell.run(
				app.shell.resolve({ command: "true", workdir: nested }),
			);
			const nestedEnv = app.shell.last().env ?? {};
			expect(nestedEnv.PKG_VAR).toBe("api");
			expect("ROOT_VAR" in nestedEnv).toBe(false);
			await app.shell.run(app.shell.resolve({ command: "true" }));
			const rootEnv = app.shell.last().env ?? {};
			expect(rootEnv.ROOT_VAR).toBe("root");
			expect("PKG_VAR" in rootEnv).toBe(false);
		} finally {
			await app.dispose();
		}
	});

	it("uses only the workspace root when followWorkdir is off", async () => {
		const box = sandbox();
		writeRc(box, ".", "export ROOT_VAR=root\n");
		writeRc(box, "packages/api", "export PKG_VAR=api\n");
		const app = await boot(box, { followWorkdir: false });
		try {
			await app.shell.run(
				app.shell.resolve({
					command: "true",
					workdir: join(box.workspace, "packages", "api"),
				}),
			);
			const env = app.shell.last().env ?? {};
			expect(env.ROOT_VAR).toBe("root");
			expect("PKG_VAR" in env).toBe(false);
		} finally {
			await app.dispose();
		}
	});

	it("does not inject for an agentless call", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n");
		const app = await boot(box);
		try {
			currentAgent = undefined;
			await app.shell.run(app.shell.resolve({ command: "true" }));
			expect(app.shell.last().env).toBeUndefined();
		} finally {
			await app.dispose();
		}
	});

	it("does not inject when the agent has no usable cwd", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n");
		const app = await boot(box);
		try {
			currentAgent = { session: { header: {} } };
			await app.shell.run(app.shell.resolve({ command: "true" }));
			expect(app.shell.last().env).toBeUndefined();
		} finally {
			await app.dispose();
		}
	});

	it("does not inject when disabled", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n");
		const app = await boot(box, { enabled: false });
		try {
			await app.shell.run(app.shell.resolve({ command: "true" }));
			expect(app.shell.last().env).toBeUndefined();
		} finally {
			await app.dispose();
		}
	});

	it("keeps an explicit caller env winning over direnv", async () => {
		const box = sandbox();
		writeRc(box, ".", "export CONTESTED=from-direnv\nexport ONLY_DIRENV=d\n");
		const app = await boot(box);
		try {
			await app.shell.run(
				app.shell.resolve({
					command: "true",
					env: { CONTESTED: "from-caller" },
				}),
			);
			const env = app.shell.last().env ?? {};
			expect(env.CONTESTED).toBe("from-caller");
			expect(env.ONLY_DIRENV).toBe("d");
		} finally {
			await app.dispose();
		}
	});

	it("stops injecting after the .envrc is deleted", async () => {
		const box = sandbox();
		const rc = writeRc(box, ".", "export X=1\n");
		const app = await boot(box);
		try {
			await app.shell.run(app.shell.resolve({ command: "true" }));
			expect(app.shell.last().env?.X).toBe("1");
			rmSync(rc);
			await app.shell.run(app.shell.resolve({ command: "true" }));
			expect(app.shell.last().env).toBeUndefined();
		} finally {
			await app.dispose();
		}
	});

	it("treats an empty allowed .envrc as no injection and no notice", async () => {
		const box = sandbox();
		writeRc(box, ".", "");
		const app = await boot(box);
		try {
			const result = await (
				await app.ctx.shell.execute(app.shell.resolve({ command: "true" }))
			).result();
			expect(Object.keys(app.shell.last().env ?? {})).toHaveLength(0);
			expect(result.stderr.text).not.toContain("[dsh-direnv]");
		} finally {
			await app.dispose();
		}
	});

	it("appends nothing to a healthy background process", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n");
		const app = await boot(box);
		try {
			const proc = await app.ctx.shell.execute(
				app.shell.resolve({ command: "true" }),
			);
			expect(proc.readOutput().delta).toBe("");
			expect(app.shell.last().env?.X).toBe("1");
		} finally {
			await app.dispose();
		}
	});

	it("appends the notice to the first background read only", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n", false);
		const app = await boot(box);
		try {
			const proc = await app.ctx.shell.execute(
				app.shell.resolve({ command: "true" }),
			);
			expect(proc.readOutput().delta).toContain("[dsh-direnv]");
			expect(proc.readOutput().delta).not.toContain("[dsh-direnv]");
		} finally {
			await app.dispose();
		}
	});

	it("surfaces the notice on the observed stderr the job registry pumps", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n", false);
		const app = await boot(box);
		try {
			const proc = await app.ctx.shell.execute(
				app.shell.resolve({ command: "true" }),
			);
			const first = proc.observed.stderr.readFrom(0);
			expect(first.text).toContain("[dsh-direnv]");
			// A second, independent reader at a later offset never repeats the notice,
			// and the consuming cursor never stole those bytes from it.
			expect(
				proc.observed.stderr.readFrom(first.nextOffset).text,
			).not.toContain("[dsh-direnv]");
		} finally {
			await app.dispose();
		}
	});

	it("reports an unparseable direnv response as an error instead of injecting", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n");
		const probe = () => ({
			code: 0,
			signal: null,
			stdout: "not json",
			stderr: "",
			timedOut: false,
			spawnFailed: false,
		});
		const app = await boot(box, {}, probe as never);
		try {
			const result = await (
				await app.ctx.shell.execute(app.ctx.shell.resolve({ command: "true" }))
			).result();
			expect(app.shell.last().env).toBeUndefined();
			expect(result.stderr.text).toContain("[dsh-direnv]");
		} finally {
			await app.dispose();
		}
	});

	it("reports a direnv timeout as an error instead of injecting", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n");
		const probe = () => ({
			code: null,
			signal: "SIGKILL" as const,
			stdout: "",
			stderr: "",
			timedOut: true,
			spawnFailed: false,
		});
		const app = await boot(box, {}, probe as never);
		try {
			const result = await (
				await app.ctx.shell.execute(app.ctx.shell.resolve({ command: "true" }))
			).result();
			expect(app.shell.last().env).toBeUndefined();
			expect(result.stderr.text).toContain("timed out");
		} finally {
			await app.dispose();
		}
	});

	it("reports a missing direnv executable as an error instead of injecting", async () => {
		const box = sandbox();
		writeRc(box, ".", "export X=1\n");
		const app = await boot(
			box,
			{ executable: "/nonexistent/direnv" },
			undefined,
		);
		// With the real runner, the missing executable is what produces the error.
		const app2 = await boot(box, { executable: "/nonexistent/direnv" });
		void app;
		try {
			const result = await (
				await app2.ctx.shell.execute(
					app2.ctx.shell.resolve({ command: "true" }),
				)
			).result();
			expect(app2.shell.last().env).toBeUndefined();
			expect(result.stderr.text).toContain("could not be started");
		} finally {
			await app2.dispose();
			await app.dispose();
		}
	});
});

/**
 * The regression that mattered in production: the adapter used to wrap the
 * pre-`execute` `run`/`start` methods, throw on the host that only has
 * `execute`, and leave the already-installed `resolve` wrapper behind. Because
 * that dead wrapper reads `ctx.direnv` per call, every later shell call — even
 * a plain `bash` command — failed with "cannot get required service direnv in
 * inactive context".
 */
describe("adapter installation against a shell provider with no execute", () => {
	it("leaves no wrapper behind when the seam does not match", async () => {
		const ctx = new Context();
		// A provider exposing only the old methods: the adapter must fail loudly
		// WITHOUT touching `resolve`.
		const legacy = {
			resolve: (request: ShellExecRequest) => request,
			run: () => Promise.resolve({}),
			start: () => ({}),
		};
		ctx.provide("shell", legacy as never);
		const agents = await ctx.plugin(FakeAgents);
		const service = await ctx.plugin(
			class extends DirenvService {
				constructor(applyCtx: Context) {
					super(
						applyCtx,
						{ ...defaultConfig },
						{
							env: { ...process.env },
							runExport: () => {
								throw new Error("unused");
							},
						},
					);
				}
			},
		);
		currentAgent = { session: { header: { cwd: "/tmp" } } };
		try {
			const before = ctx.shell.resolve;
			expect(() => installDirenvShellAdapter(ctx)).toThrow(
				/cannot wrap non-function method execute/,
			);
			// The failed install must be atomic: `resolve` is exactly as it was.
			expect(ctx.shell.resolve).toBe(before);
			const request = { command: "true" };
			expect(ctx.shell.resolve(request as never)).toBe(request);
		} finally {
			await service.dispose();
			await agents.dispose();
		}
	});
});
