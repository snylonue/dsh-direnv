import { describe, expect, it, vi } from "vitest";
import { installDirenvDirectAdapter } from "../src/direct-adapter.js";

function unusedSubprocessMethods() {
	return {
		spawn: vi.fn(() => {
			throw new Error("unexpected spawn");
		}),
		spawnTerminal: vi.fn(async () => {
			throw new Error("unexpected terminal spawn");
		}),
	};
}

describe("direct subprocess direnv adapter", () => {
	it("normalizes an empty direnv diff without explicit overrides to an empty map", async () => {
		const resolveExecutable = vi.fn(
			async (_command: string) => "/workspace/bin/tool",
		);
		const subprocess = { ...unusedSubprocessMethods(), resolveExecutable };
		const context = {
			subprocess,
			agents: { currentInitiator: () => ({ id: "agent" }) },
			direnv: {
				enabled: true,
				workspaceFor: () => "/workspace",
				forWorkspace: async () => ({ env: {}, status: { kind: "loaded" } }),
			},
		};
		const adapter = installDirenvDirectAdapter(context as never);
		await subprocess.resolveExecutable("tool");
		expect(resolveExecutable).toHaveBeenCalledWith("tool", {}, undefined);
		adapter.dispose();
	});

	it("wraps resolveExecutable and spawn without installing a preparation hook", async () => {
		const handle = {
			stdin: undefined,
			stdout: undefined,
			stderr: undefined,
			control: undefined,
			collected: {},
			done: Promise.resolve({ exitCode: 0, signal: null }),
			terminate: vi.fn(),
			waitForExit: vi.fn(async () => true),
		};
		const resolveExecutable = vi.fn(
			async (_command: string, env?: Readonly<Record<string, string>>) => {
				expect(env).toMatchObject({ FROM_DIRENV: "yes", SHARED: "explicit" });
				expect(env).not.toHaveProperty("REMOVED");
				return "/workspace/bin/tool";
			},
		);
		const spawn = vi.fn((_spec: unknown) => handle);
		const terminalHandle = { id: "terminal" };
		const spawnTerminal = vi.fn(async (_spec: unknown) => terminalHandle);
		const subprocess = { resolveExecutable, spawn, spawnTerminal };
		const probeDirectory = vi.fn((workspace: string) => workspace);
		const forWorkspace = vi.fn(async () => ({
			env: { FROM_DIRENV: "yes", SHARED: "direnv", REMOVED: undefined },
			status: { kind: "loaded" },
		}));
		const context = {
			subprocess,
			agents: { currentInitiator: () => ({ id: "agent" }) },
			direnv: {
				enabled: true,
				workspaceFor: () => "/workspace",
				probeDirectory,
				forWorkspace,
			},
		};

		const adapter = installDirenvDirectAdapter(context as never);
		expect("prepareDirectExecution" in subprocess).toBe(false);

		await subprocess.resolveExecutable("tool", { SHARED: "explicit" });
		const spawned = subprocess.spawn({
			argv: ["/workspace/bin/tool"],
			cwd: "/workspace/pkg",
			env: { SHARED: "explicit" },
			stdio: { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
			graceMs: 100,
		});
		await spawned.done;

		expect(probeDirectory).not.toHaveBeenCalled();
		expect(forWorkspace).toHaveBeenCalledTimes(2);
		expect(forWorkspace).toHaveBeenCalledWith("/workspace");
		expect(spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/workspace/pkg",
				env: { FROM_DIRENV: "yes", SHARED: "explicit", REMOVED: undefined },
			}),
		);

		expect(
			await subprocess.spawnTerminal({
				argv: ["/workspace/bin/tool"],
				cwd: "/workspace/pkg",
				env: { SHARED: "explicit" },
				rows: 24,
				cols: 80,
				terminalType: "xterm",
				graceMs: 100,
			}),
		).toBe(terminalHandle);
		expect(spawnTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				env: { FROM_DIRENV: "yes", SHARED: "explicit" },
			}),
		);

		adapter.dispose();
		expect(subprocess.spawnTerminal).toBe(spawnTerminal);
		expect(subprocess.resolveExecutable).toBe(resolveExecutable);
		expect(subprocess.spawn).toBe(spawn);
	});

	it("passes through unchanged when the session workspace has no .envrc", async () => {
		const resolveExecutable = vi.fn(
			async (_command: string, env?: Readonly<Record<string, string>>) => env,
		);
		const subprocess = { ...unusedSubprocessMethods(), resolveExecutable };
		const context = {
			subprocess,
			agents: { currentInitiator: () => ({ id: "agent" }) },
			direnv: {
				enabled: true,
				workspaceFor: () => "/workspace",
				probeDirectory: () => "/workspace",
				forWorkspace: async () => ({
					env: { IGNORED: "yes" },
					status: { kind: "no-rc" },
				}),
			},
		};

		const adapter = installDirenvDirectAdapter(context as never);
		await subprocess.resolveExecutable("tool", { EXPLICIT: "yes" });

		expect(resolveExecutable).toHaveBeenCalledWith(
			"tool",
			{ EXPLICIT: "yes" },
			undefined,
		);
		await subprocess.resolveExecutable("tool");
		expect(resolveExecutable).toHaveBeenLastCalledWith("tool", {}, undefined);
		adapter.dispose();
	});
});
