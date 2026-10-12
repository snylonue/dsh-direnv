/**
 * Per-workspace cache and manual reload, against the REAL direnv binary.
 *
 * The cache exists to avoid paying direnv's startup cost on every command, so
 * these tests verify synchronous reads and changes applied only on explicit reload.
 *
 * @module tests/cache
 */
import { spawnSync } from "node:child_process";
import * as ChildProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { envNames, defaultConfig, type DirenvConfig } from "../src/provider.js";
import DirenvService from "../src/provider.js";
import { requireRealProcesses } from "./helpers.js";
import { installDirenvShellAdapter } from "../src/shell-adapter.js";

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

const describeReal = requireRealProcesses("real-direnv tests")
	? describe
	: describe.skip;

interface Sandbox {
	root: string;
	ws: string;
	env: NodeJS.ProcessEnv;
}
const boxes: Sandbox[] = [];
function sandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "dsh-direnv-cache-"));
	const ws = join(root, "ws");
	const home = join(root, "home");
	const data = join(root, "data");
	const conf = join(root, "config");
	const cache = join(root, "cache");
	for (const d of [ws, home, data, conf, cache])
		mkdirSync(d, { recursive: true });
	const box: Sandbox = {
		root,
		ws,
		env: {
			...process.env,
			HOME: home,
			XDG_DATA_HOME: data,
			XDG_CONFIG_HOME: conf,
			DIRENV_CONFIG: join(conf, "direnv"),
			XDG_CACHE_HOME: cache,
		},
	};
	boxes.push(box);
	return box;
}
afterAll(() => {
	for (const b of boxes.splice(0))
		rmSync(b.root, { recursive: true, force: true });
});

let currentAgent: unknown;
class FakeAgents extends Service {
	constructor(ctx: Context) {
		super(ctx, "agents");
	}
	currentInitiator(): unknown {
		return currentAgent;
	}
}

/** Boot the service with a counting probe, all in the sandbox environment. */
async function boot(box: Sandbox, overrides: Partial<DirenvConfig> = {}) {
	for (const name of [
		"HOME",
		"XDG_DATA_HOME",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"DIRENV_CONFIG",
	])
		vi.stubEnv(name, box.env[name]);
	const exec = vi.mocked(ChildProcess.spawn);
	const ctx = new Context();
	ctx.provide("shell", {
		resolve: () => ({}),
		execute: () => Promise.resolve({}),
	});
	const agentsFiber = await ctx.plugin(FakeAgents);
	const config: DirenvConfig = { ...defaultConfig, ...overrides };
	const fiber = await ctx.plugin(
		class extends DirenvService {
			constructor(applyCtx: Context) {
				super(applyCtx, config);
			}
		},
	);
	const adapter = installDirenvShellAdapter(ctx);
	currentAgent = { session: { header: { cwd: box.ws } } };
	return {
		ctx,
		get probes() {
			return exec.mock.calls.filter(([, args]) => args?.[0] === "export")
				.length;
		},
		service: ctx.direnv,
		async dispose() {
			adapter.dispose();
			await fiber.dispose();
			await agentsFiber.dispose();
		},
	};
}

function writeRc(box: Sandbox, body: string): string {
	const rc = join(box.ws, ".envrc");
	writeFileSync(rc, body);
	const r = spawnSync("direnv", ["allow", rc], {
		env: box.env,
		encoding: "utf8",
	});
	if (r.status !== 0)
		throw new Error(`test setup: allow failed: ${String(r.stderr)}`);
	return rc;
}

describeReal("workspace snapshots", () => {
	it("reads synchronously without status or export rechecks", async () => {
		const box = sandbox();
		writeRc(box, "export CACHED=yes\n");
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			const calls = vi.mocked(ChildProcess.spawn).mock.calls.length;
			for (let i = 0; i < 5; i += 1) {
				expect(app.service.statusFor(box.ws).env.CACHED).toBe("yes");
				expect(app.service.forWorkspace(box.ws).env.CACHED).toBe("yes");
				app.service.describe(box.ws);
				await app.ctx.shell.execute({ command: "true" } as never);
			}
			expect(vi.mocked(ChildProcess.spawn).mock.calls).toHaveLength(calls);
			expect(app.probes).toBe(1);
		} finally {
			await app.dispose();
		}
	});

	it("does not lazily resolve an unknown workspace", async () => {
		const box = sandbox();
		writeRc(box, "export V=1\n");
		const app = await boot(box);
		try {
			expect(app.service.statusFor(box.ws)).toMatchObject({
				kind: "error",
				env: {},
			});
			expect(app.service.forWorkspace(box.ws).notice).toContain(
				"direnv_reload",
			);
			expect(vi.mocked(ChildProcess.spawn)).not.toHaveBeenCalled();
		} finally {
			await app.dispose();
		}
	});

	it("stores different workspaces independently", async () => {
		const box = sandbox();
		writeRc(box, "export ROOT=1\n");
		const sub = join(box.ws, "pkg");
		mkdirSync(sub);
		const rc = join(sub, ".envrc");
		writeFileSync(rc, "export SUB=1\n");
		spawnSync("direnv", ["allow", rc], { env: box.env });
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			await app.service.reload(sub);
			expect(envNames(app.service.statusFor(box.ws).env)).toEqual(["ROOT"]);
			expect(envNames(app.service.statusFor(sub).env)).toEqual(["SUB"]);
			expect(app.probes).toBe(2);
		} finally {
			await app.dispose();
		}
	});

	it("keeps the snapshot after edits and checks authorization on explicit reload", async () => {
		const box = sandbox();
		const rc = writeRc(box, "export V=v1\n");
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			writeFileSync(rc, "export V=v2\n");
			expect(app.service.statusFor(box.ws).env.V).toBe("v1");
			expect(app.probes).toBe(1);
			await app.service.reload(box.ws);
			expect(app.service.statusFor(box.ws)).toMatchObject({
				kind: "blocked",
				env: {},
			});
			spawnSync("direnv", ["allow", rc], { env: box.env });
			expect(app.service.statusFor(box.ws).kind).toBe("blocked");
			await app.service.reload(box.ws);
			expect(app.service.statusFor(box.ws).env.V).toBe("v2");
		} finally {
			await app.dispose();
		}
	});

	it("observes external allow only on explicit reload", async () => {
		const box = sandbox();
		const rc = join(box.ws, ".envrc");
		writeFileSync(rc, "export LATE=yes\n");
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			expect(app.service.statusFor(box.ws).kind).toBe("blocked");
			spawnSync("direnv", ["allow", rc], { env: box.env });
			expect(app.service.statusFor(box.ws).kind).toBe("blocked");
			await app.service.reload(box.ws);
			expect(app.service.statusFor(box.ws).env.LATE).toBe("yes");
		} finally {
			await app.dispose();
		}
	});

	it("observes external deny only on explicit reload", async () => {
		const box = sandbox();
		const rc = writeRc(box, "export DENIED=1\n");
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			spawnSync("direnv", ["deny", rc], { env: box.env });
			expect(app.service.statusFor(box.ws).env.DENIED).toBe("1");
			await app.service.reload(box.ws);
			expect(app.service.statusFor(box.ws)).toMatchObject({
				kind: "denied",
				env: {},
			});
		} finally {
			await app.dispose();
		}
	});

	it("observes RC removal only on explicit reload", async () => {
		const box = sandbox();
		const rc = writeRc(box, "export GONE=1\n");
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			rmSync(rc);
			expect(app.service.statusFor(box.ws).env.GONE).toBe("1");
			await app.service.reload(box.ws);
			expect(app.service.statusFor(box.ws)).toMatchObject({
				kind: "no-rc",
				env: {},
			});
		} finally {
			await app.dispose();
		}
	});

	it("shares concurrent explicit resolutions", async () => {
		const box = sandbox();
		writeRc(box, "export V=1\n");
		const app = await boot(box);
		try {
			await Promise.all([
				app.service.reload(box.ws),
				app.service.reload(box.ws),
			]);
			expect(app.probes).toBe(1);
			expect(
				vi
					.mocked(ChildProcess.spawn)
					.mock.calls.filter(([, args]) => args?.[0] === "status"),
			).toHaveLength(1);
		} finally {
			await app.dispose();
		}
	});
});

describeReal("manual reload", () => {
	it("reports an inherited variable unset by direnv without an old cache entry", async () => {
		vi.stubEnv("CACHE_RELOAD_REMOVED", "inherited");
		const box = sandbox();
		writeRc(box, "export ADDED=1\nunset CACHE_RELOAD_REMOVED\n");
		const app = await boot(box);
		try {
			const report = await app.service.reload(box.ws);
			expect(report.changed[0]?.added).toEqual(["ADDED"]);
			expect(report.changed[0]?.removed).toEqual(["CACHE_RELOAD_REMOVED"]);
			expect(report.changed[0]?.variables).toBe(1);
		} finally {
			await app.dispose();
		}
	});

	it("reports names set by direnv without a cached result", async () => {
		const box = sandbox();
		writeRc(box, "export B=2\nexport A=1\n");
		const app = await boot(box);
		try {
			const report = await app.service.reload(box.ws);
			expect(report.changed[0]?.added).toEqual(["A", "B"]);
			expect(report.changed[0]?.removed).toEqual([]);
		} finally {
			await app.dispose();
		}
	});

	it("returns empty arrays when direnv produces no environment changes", async () => {
		const box = sandbox();
		writeRc(box, "");
		const app = await boot(box);
		try {
			const report = await app.service.reload(box.ws);
			expect(report.changed[0]?.added).toEqual([]);
			expect(report.changed[0]?.removed).toEqual([]);
		} finally {
			await app.dispose();
		}
	});

	it("re-resolves one directory and reports the variable count", async () => {
		const box = sandbox();
		writeRc(box, "export A=1\nexport B=2\n");
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			const before = app.probes;
			const report = await app.service.reload(box.ws);
			expect(report.reloaded).toBe(1);
			expect(report.changed).toHaveLength(1);
			expect(report.changed[0]?.variables).toBe(2);
			expect(report.changed[0]?.added).toEqual(["A", "B"]);
			expect(report.changed[0]?.removed).toEqual([]);
			expect(report.changed[0]?.kind).toBe("injected");
			expect(app.probes).toBe(before + 1);
		} finally {
			await app.dispose();
		}
	});

	it("reports the current direnv diff rather than differences from the old cache", async () => {
		const box = sandbox();
		const rc = writeRc(box, "export KEEP=1\nexport DROP=2\n");
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			writeFileSync(rc, "export KEEP=1\nexport FRESH=3\n");
			spawnSync("direnv", ["allow", rc], { env: box.env });
			const report = await app.service.reload(box.ws);
			expect(report.changed[0]?.added).toEqual(["FRESH", "KEEP"]);
			// Removing an old export is not an unset in the current native diff.
			expect(report.changed[0]?.removed).toEqual([]);
		} finally {
			await app.dispose();
		}
	});

	it("reloads every cached directory when given none", async () => {
		const box = sandbox();
		writeRc(box, "export ROOT=1\n");
		const sub = join(box.ws, "pkg");
		mkdirSync(sub, { recursive: true });
		const subRc = join(sub, ".envrc");
		writeFileSync(subRc, "export SUB=1\n");
		spawnSync("direnv", ["allow", subRc], { env: box.env });
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			await app.service.reload(sub);
			const report = await app.service.reload();
			expect(report.reloaded).toBe(2);
			expect(report.changed.map((c) => c.directory).sort()).toEqual(
				[box.ws, sub].sort(),
			);
		} finally {
			await app.dispose();
		}
	});

	it("reports zero when nothing was cached", async () => {
		const box = sandbox();
		writeRc(box, "export V=1\n");
		const app = await boot(box);
		try {
			expect((await app.service.reload()).reloaded).toBe(0);
		} finally {
			await app.dispose();
		}
	});

	it("resolves again when explicitly requested", async () => {
		const box = sandbox();
		writeRc(box, "export V=1\n");
		const app = await boot(box);
		try {
			await app.service.reload(box.ws);
			// Explicit reload always resolves again, even when files are unchanged.
			const report = await app.service.reload(box.ws);
			expect(report.changed[0]?.kind).toBe("injected");
		} finally {
			await app.dispose();
		}
	});
});
