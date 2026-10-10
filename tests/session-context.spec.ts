/**
 * Session-start context tests.
 *
 * The pure renderer is exercised directly; the injection path runs against the
 * REAL `DirenvService` with native status mocked and its export probe replaced,
 * so the assertions
 * observe what a live `agent/created` would actually queue — without
 * needing the `direnv` binary or a shell.
 *
 * @module tests/session-context
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { emitAgentEvent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Core from "../src/core.js";
import * as ChildProcess from "node:child_process";
import { completeCommand, type CommandResult } from "./process-fixture.js";
import DirenvService, {
	defaultConfig,
	type DirenvConfig,
} from "../src/provider.js";
import {
	SESSION_CONTEXT_MAX_NAMES,
	SESSION_CONTEXT_PLUGIN,
	sessionContextText,
	type DirenvStatus,
} from "../src/core.js";
import {
	injectSessionContext,
	installDirenvSessionContext,
} from "../src/session-context.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { mockSpawn } = await import("./process-fixture.js");
	return { ...actual, spawn: mockSpawn(actual.spawn) };
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.resetAllMocks();
	vi.unstubAllEnvs();
});

const roots: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "dsh-direnv-sctx-"));
	roots.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of roots.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Let the fire-and-forget `agent/created` listener's async probe settle. */
const flush = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

/** Return one `direnv export json` outcome. */
function exported(diff: Record<string, string | null>): CommandResult {
	return {
		code: 0,
		signal: null,
		stdout: JSON.stringify(diff),
		stderr: "",
	};
}

describe("sessionContextText", () => {
	it("names an active environment without leaking values", () => {
		const status: DirenvStatus = {
			kind: "injected",
			rcPath: "/ws/.envrc",
			env: { FOO: "one", BAR: "two", UNSET: undefined },
			dropped: [],
		};
		const text = sessionContextText(status, "/ws");
		expect(text).toBeDefined();
		expect(text).toContain("injects 2 variable(s)");
		expect(text).toContain("BAR, FOO");
		// Neither the values nor a removal-only name may appear.
		expect(text).not.toContain("one");
		expect(text).not.toContain("two");
		expect(text).not.toContain("UNSET");
	});

	it("caps a Nix-scale environment but keeps the exact count", () => {
		const env: Record<string, string> = {};
		for (let index = 0; index < SESSION_CONTEXT_MAX_NAMES + 6; index += 1) {
			env[`VAR_${String(index).padStart(3, "0")}`] = "x";
		}
		const text = sessionContextText(
			{ kind: "injected", rcPath: "/ws/.envrc", env, dropped: [] },
			"/ws",
		);
		expect(text).toContain(
			`injects ${String(SESSION_CONTEXT_MAX_NAMES + 6)} variable(s)`,
		);
		expect(text).toContain("and 6 more");
	});

	it("points a blocked workspace at direnv_allow", () => {
		const text = sessionContextText(
			{ kind: "blocked", rcPath: "/ws/.envrc", env: {}, dropped: [] },
			"/ws",
		);
		expect(text).toContain("direnv_allow path=/ws/.envrc");
		expect(text).toContain("Workspace: /ws");
		expect(text).not.toContain("This command ran");
	});

	it("reports a denied workspace without a variable list", () => {
		const text = sessionContextText(
			{ kind: "denied", rcPath: "/ws/.envrc", env: {}, dropped: [] },
			"/ws",
		);
		expect(text).toContain("denied");
		expect(text).toContain("direnv status");
	});

	it("surfaces an error detail", () => {
		const text = sessionContextText(
			{
				kind: "error",
				env: {},
				dropped: [],
				detail: "direnv export timed out",
			},
			"/ws",
		);
		expect(text).toContain("direnv export timed out");
	});

	it("stays silent when nothing governs the workspace or the plugin is off", () => {
		expect(
			sessionContextText(
				{ kind: "no-rc", rcPath: "/ws/.envrc", env: {}, dropped: [] },
				"/ws",
			),
		).toBeUndefined();
		expect(
			sessionContextText({ kind: "disabled", env: {}, dropped: [] }, "/ws"),
		).toBeUndefined();
	});
});

interface Booted {
	ctx: Context;
	agent: Agent;
	injected: UserMessage[];
	probeCalls: () => number;
	workspace: string;
	dispose(): Promise<void>;
}

/** Boot the real service with a replaced probe; no direnv binary is needed. */
async function boot(
	options: {
		rcPath?: string;
		probe?: () => CommandResult;
		config?: Partial<DirenvConfig>;
	} = {},
): Promise<Booted> {
	const root = scratch();
	const workspace =
		options.rcPath === undefined ? join(root, "ws") : dirname(options.rcPath);
	mkdirSync(workspace, { recursive: true });
	if (options.rcPath !== undefined) writeFileSync(options.rcPath, "");
	vi.spyOn(Core, "readNativeStatus").mockImplementation(async (dir) =>
		dir === workspace && options.rcPath !== undefined
			? { path: options.rcPath, allowed: 0 }
			: null,
	);
	const ctx = new Context();
	ctx.provide("shell", {} as never);
	let probeCalls = 0;
	vi.stubEnv("HOME", root);
	vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
	vi.stubEnv("DIRENV_CONFIG", join(root, "config", "direnv"));
	const { spawn: exec } =
		await vi.importActual<typeof ChildProcess>("node:child_process");
	vi.mocked(ChildProcess.spawn).mockImplementation((command, args, opts) => {
		if (args?.[0] !== "export") return exec(command, args, opts);
		probeCalls += 1;
		return completeCommand(
			(options.probe ?? (() => exported({})))(),
			new ChildProcess.ChildProcess(),
		);
	});
	const config: DirenvConfig = { ...defaultConfig, ...options.config };
	const fiber = await ctx.plugin(
		class extends DirenvService {
			constructor(applyCtx: Context) {
				super(applyCtx, config);
			}
		},
	);
	const injected: UserMessage[] = [];
	const agent = {
		session: { header: { cwd: workspace } },
		inject: (message: UserMessage) => {
			injected.push(message);
		},
	} as unknown as Agent;
	return {
		ctx,
		agent,
		injected,
		probeCalls: () => probeCalls,
		workspace,
		async dispose() {
			await fiber.dispose();
		},
	};
}

describe("injectSessionContext", () => {
	it("queues one plugin snapshot naming the injected variables", async () => {
		const app = await boot({
			rcPath: join(scratch(), ".envrc"),
			probe: () =>
				exported({ E2E_ONE: "alpha", E2E_TWO: "beta", DIRENV_DIR: "/ignored" }),
		});
		try {
			await injectSessionContext(app.ctx, app.agent);
			expect(app.injected).toHaveLength(1);
			const message = app.injected[0];
			expect(message?.source).toMatchObject({
				kind: SESSION_CONTEXT_PLUGIN,
				form: "snapshot",
			});
			const text = (message?.content[0] as { text: string } | undefined)?.text;
			expect(text).toContain("E2E_ONE, E2E_TWO");
			expect(text).not.toContain("alpha");
			expect(text).not.toContain("DIRENV_DIR");
		} finally {
			await app.dispose();
		}
	});

	it("tells the model to approve a blocked .envrc", async () => {
		const rcPath = join(scratch(), ".envrc");
		const app = await boot({ rcPath });
		vi.mocked(Core.readNativeStatus).mockResolvedValue({
			path: rcPath,
			allowed: 1,
		});
		try {
			await injectSessionContext(app.ctx, app.agent);
			expect(app.injected).toHaveLength(1);
			const text = (app.injected[0]?.content[0] as { text: string } | undefined)
				?.text;
			expect(text).toContain(`direnv_allow path=${rcPath}`);
			expect(app.probeCalls()).toBe(0);
		} finally {
			await app.dispose();
		}
	});

	it("stays silent without an RC, when disabled, or when the context is off", async () => {
		const noRc = await boot();
		const off = await boot({
			rcPath: join(scratch(), ".envrc"),
			config: { sessionContext: false },
		});
		const disabled = await boot({
			rcPath: join(scratch(), ".envrc"),
			config: { enabled: false },
		});
		try {
			await injectSessionContext(noRc.ctx, noRc.agent);
			await injectSessionContext(off.ctx, off.agent);
			await injectSessionContext(disabled.ctx, disabled.agent);
			expect(noRc.injected).toHaveLength(0);
			expect(off.injected).toHaveLength(0);
			expect(disabled.injected).toHaveLength(0);
		} finally {
			await noRc.dispose();
			await off.dispose();
			await disabled.dispose();
		}
	});

	it("skips an agent with no usable cwd", async () => {
		const app = await boot({
			rcPath: join(scratch(), ".envrc"),
			probe: () => exported({ A: "1" }),
		});
		try {
			const homeless = {
				session: { header: {} },
				inject: (message: UserMessage) => {
					app.injected.push(message);
				},
			} as unknown as Agent;
			await injectSessionContext(app.ctx, homeless);
			expect(app.injected).toHaveLength(0);
		} finally {
			await app.dispose();
		}
	});

	it("warms the cache so the first command does not probe again", async () => {
		const ws = scratch();
		const app = await boot({
			rcPath: join(ws, ".envrc"),
			probe: () => exported({ A: "1" }),
		});
		try {
			await injectSessionContext(app.ctx, app.agent);
			expect(app.probeCalls()).toBe(1);
			// A later resolution through the same provider must reuse the warmed entry.
			expect((await app.ctx.direnv.statusFor(app.workspace)).kind).toBe(
				"injected",
			);
			expect(app.probeCalls()).toBe(1);
		} finally {
			await app.dispose();
		}
	});

	it("runs from a real agent/created event", async () => {
		const app = await boot({
			rcPath: join(scratch(), ".envrc"),
			probe: () => exported({ A: "1" }),
		});
		try {
			const listener = installDirenvSessionContext(app.ctx);
			emitAgentEvent(app.ctx, app.agent, "agent/created", {
				source: "startup",
			});
			await flush();
			expect(app.injected).toHaveLength(1);
			listener.dispose();
			emitAgentEvent(app.ctx, app.agent, "agent/created", { source: "resume" });
			await flush();
			expect(app.injected).toHaveLength(1);
		} finally {
			await app.dispose();
		}
	});
});
