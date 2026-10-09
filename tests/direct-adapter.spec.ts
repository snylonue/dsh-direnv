import { describe, expect, it, vi } from "vitest";
import { installDirenvDirectAdapter } from "../src/direct-adapter.js";

describe("direct subprocess direnv adapter", () => {
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
				return "/workspace/bin/tool";
			},
		);
		const spawn = vi.fn((_spec: unknown) => handle);
		const subprocess = { resolveExecutable, spawn };
		const probeDirectory = vi.fn((workspace: string) => workspace);
		const forWorkspace = vi.fn(async () => ({
			env: { FROM_DIRENV: "yes", SHARED: "direnv" },
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

		expect(probeDirectory).toHaveBeenCalledTimes(2);
		expect(probeDirectory).toHaveBeenNthCalledWith(
			1,
			"/workspace",
			"/workspace",
		);
		expect(probeDirectory).toHaveBeenNthCalledWith(
			2,
			"/workspace",
			"/workspace",
		);
		expect(forWorkspace).toHaveBeenCalledTimes(2);
		expect(forWorkspace).toHaveBeenCalledWith("/workspace");
		expect(spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/workspace/pkg",
				env: { FROM_DIRENV: "yes", SHARED: "explicit" },
			}),
		);

		adapter.dispose();
		expect(subprocess.resolveExecutable).toBe(resolveExecutable);
		expect(subprocess.spawn).toBe(spawn);
	});

	it("passes through unchanged when the session workspace has no .envrc", async () => {
		const resolveExecutable = vi.fn(
			async (_command: string, env?: Readonly<Record<string, string>>) => env,
		);
		const subprocess = { resolveExecutable };
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
		adapter.dispose();
	});
});
