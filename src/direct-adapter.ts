/**
 * Transparent direct-subprocess environment adapter.
 *
 * The adapter wraps the existing subprocess methods in-place. Consumers keep
 * calling resolveExecutable/spawn/spawnTerminal as before; when the session
 * workspace has a usable direnv environment, the original method receives the
 * merged environment. No consumer-side preparation hook is required.
 */
import { Duplex, PassThrough } from "node:stream";
import type { Context } from "@deepseek-ai/cordis";
import type {
	SubprocessHandle,
	SubprocessSpawnSpec,
	SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

type ResolveExecutable = (
	command: string,
	env?: Readonly<Record<string, string>>,
	signal?: AbortSignal,
) => Promise<string>;
type Spawn = (spec: SubprocessSpawnSpec) => SubprocessHandle;
type SpawnTerminal = (spec: SubprocessTerminalSpawnSpec) => Promise<unknown>;

interface DirectSubprocess {
	resolveExecutable?: ResolveExecutable;
	spawn?: Spawn;
	spawnTerminal?: SpawnTerminal;
}

function emptyRead(fromByte: number) {
	return { text: "", nextOffset: fromByte, lossy: false };
}

/** Keep the synchronous subprocess handle contract while delaying the provider spawn. */
function deferredHandle(
	spec: SubprocessSpawnSpec,
	actualPromise: Promise<SubprocessHandle>,
): SubprocessHandle {
	let actual: SubprocessHandle | undefined;
	let terminated = false;

	const stdin = spec.stdio.stdin === "pipe" ? new PassThrough() : undefined;
	const stdout = spec.stdio.stdout === "pipe" ? new PassThrough() : undefined;
	const stderr = spec.stdio.stderr === "pipe" ? new PassThrough() : undefined;

	const control =
		spec.stdio.control === "pipe"
			? new Duplex({
					read() {},
					write(chunk, encoding, callback) {
						void actualPromise
							.then((handle) => {
								if (handle.control === undefined) callback();
								else handle.control.write(chunk, encoding, callback);
							})
							.catch(callback);
					},
					final(callback) {
						void actualPromise
							.then((handle) => {
								handle.control?.end();
								callback();
							})
							.catch(callback);
					},
				})
			: undefined;

	const connect = (handle: SubprocessHandle) => {
		actual = handle;
		if (terminated) handle.terminate();

		if (stdin !== undefined) {
			if (handle.stdin === undefined) stdin.end();
			else stdin.pipe(handle.stdin);
		}
		if (stdout !== undefined) {
			if (handle.stdout === undefined) stdout.end();
			else handle.stdout.pipe(stdout);
		}
		if (stderr !== undefined) {
			if (handle.stderr === undefined) stderr.end();
			else handle.stderr.pipe(stderr);
		}
		if (control !== undefined) {
			if (handle.control === undefined) control.end();
			else {
				handle.control.on("data", (chunk) => control.push(chunk));
				handle.control.once("end", () => control.push(null));
				handle.control.once("error", (error) => control.destroy(error));
			}
		}
	};

	const fail = (error: unknown) => {
		stdin?.destroy(error as Error);
		stdout?.destroy(error as Error);
		stderr?.destroy(error as Error);
		control?.destroy(error as Error);
	};

	void actualPromise.then(connect, fail);

	const collected = {
		...(typeof spec.stdio.stdout === "object"
			? {
					stdout: {
						readFrom: (fromByte: number) =>
							actual?.collected.stdout?.readFrom(fromByte) ??
							emptyRead(fromByte),
					},
				}
			: {}),
		...(typeof spec.stdio.stderr === "object"
			? {
					stderr: {
						readFrom: (fromByte: number) =>
							actual?.collected.stderr?.readFrom(fromByte) ??
							emptyRead(fromByte),
					},
				}
			: {}),
	};

	return {
		stdin,
		stdout,
		stderr,
		control,
		collected,
		done: actualPromise.then((handle) => handle.done),
		terminate() {
			terminated = true;
			actual?.terminate();
		},
		waitForExit(signal) {
			return actualPromise.then((handle) => handle.waitForExit(signal));
		},
	};
}

function restoreMethod(
	target: DirectSubprocess,
	name: "resolveExecutable" | "spawn" | "spawnTerminal",
	original: unknown,
	wrapped: unknown,
) {
	if (target[name] !== wrapped) return;
	if (original === undefined) delete target[name];
	else (target as Record<string, unknown>)[name] = original;
}

/** Install dsh-direnv as a transparent adapter for session-workspace subprocess calls. */
export function installDirenvDirectAdapter(ctx: Context): { dispose(): void } {
	const target = ctx.subprocess as unknown as DirectSubprocess;
	const originalResolve = target.resolveExecutable;
	const originalSpawn = target.spawn;
	const originalSpawnTerminal = target.spawnTerminal;

	const prepare = async (
		explicitEnv: Record<string, string | undefined> | undefined,
	) => {
		if (!ctx.direnv.enabled) return explicitEnv;

		const agent = ctx.agents.currentInitiator();
		if (agent === undefined) return explicitEnv;
		const workspace = ctx.direnv.workspaceFor(agent);
		if (workspace === undefined) return explicitEnv;

		// The adapter deliberately scopes direnv to the session workspace root.
		const probeDir = ctx.direnv.probeDirectory(workspace, workspace);
		const { env, status } = await ctx.direnv.forWorkspace(probeDir);
		if (status.kind === "no-rc" || status.kind === "disabled")
			return explicitEnv;

		const merged = { ...env, ...explicitEnv };
		return Object.keys(merged).length === 0 ? explicitEnv : merged;
	};

	let wrappedResolve: ResolveExecutable | undefined;
	if (originalResolve !== undefined) {
		wrappedResolve = async (command, env, signal) => {
			const prepared = await prepare(
				env === undefined ? undefined : { ...env },
			);
			const resolvedEnv =
				prepared === undefined
					? undefined
					: (Object.fromEntries(
							Object.entries(prepared).filter(
								([, value]) => value !== undefined,
							),
						) as Record<string, string>);
			return originalResolve.call(target, command, resolvedEnv, signal);
		};
		target.resolveExecutable = wrappedResolve;
	}

	let wrappedSpawn: Spawn | undefined;
	if (originalSpawn !== undefined) {
		wrappedSpawn = (spec) => {
			const actual = prepare(spec.env)
				.catch(() => spec.env)
				.then((env) =>
					originalSpawn.call(target, {
						...spec,
						...(env === undefined ? {} : { env }),
					}),
				);
			return deferredHandle(spec, actual);
		};
		target.spawn = wrappedSpawn;
	}

	let wrappedSpawnTerminal: SpawnTerminal | undefined;
	if (originalSpawnTerminal !== undefined) {
		wrappedSpawnTerminal = async (spec) => {
			const prepared = await prepare(spec.env);
			const env =
				prepared === undefined
					? undefined
					: (Object.fromEntries(
							Object.entries(prepared).filter(
								([, value]) => value !== undefined,
							),
						) as Record<string, string>);
			return originalSpawnTerminal.call(target, {
				...spec,
				...(env === undefined ? {} : { env }),
			});
		};
		target.spawnTerminal = wrappedSpawnTerminal;
	}

	return {
		dispose() {
			restoreMethod(
				target,
				"resolveExecutable",
				originalResolve,
				wrappedResolve,
			);
			restoreMethod(target, "spawn", originalSpawn, wrappedSpawn);
			restoreMethod(
				target,
				"spawnTerminal",
				originalSpawnTerminal,
				wrappedSpawnTerminal,
			);
		},
	};
}
