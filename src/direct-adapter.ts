/**
 * Transparent direct-subprocess environment adapter.
 *
 * The adapter wraps the existing subprocess methods in-place. Consumers keep
 * calling resolveExecutable/spawn/spawnTerminal as before; when the session
 * workspace has a usable direnv environment, the original method receives the
 * merged environment. No consumer-side preparation hook is required.
 */
import { Duplex, PassThrough, type Readable } from "node:stream";
import type { Context } from "@deepseek-ai/cordis";
import type {
	SubprocessHandle,
	SubprocessOutputReader,
	SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import { installChainLink, type ChainHandle } from "./method-chain.js";

function emptyRead(fromByte: number) {
	return { text: "", nextOffset: fromByte, lossy: false };
}

function connectOutput(
	source: Readable | undefined,
	proxy: PassThrough | undefined,
) {
	if (proxy === undefined) return;
	if (source === undefined) proxy.end();
	else source.pipe(proxy);
}

function deferredOutputReader(
	getReader: () => SubprocessOutputReader | undefined,
): SubprocessOutputReader {
	return {
		readFrom: (fromByte) =>
			getReader()?.readFrom(fromByte) ?? emptyRead(fromByte),
	};
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
		connectOutput(handle.stdout, stdout);
		connectOutput(handle.stderr, stderr);
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
		for (const stream of [stdin, stdout, stderr, control]) {
			stream?.destroy(error as Error);
		}
	};

	void actualPromise.then(connect, fail);

	const collected = {
		...(typeof spec.stdio.stdout === "object"
			? { stdout: deferredOutputReader(() => actual?.collected.stdout) }
			: {}),
		...(typeof spec.stdio.stderr === "object"
			? { stderr: deferredOutputReader(() => actual?.collected.stderr) }
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

/** String-only seams cannot represent environment removal entries. */
function stringEnv(env: SubprocessSpawnSpec["env"]): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env ?? {}).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}

/** Install dsh-direnv as a transparent adapter for session-workspace subprocess calls. */
export function installDirenvDirectAdapter(ctx: Context): { dispose(): void } {
	const target = ctx.subprocess;
	const handles: ChainHandle[] = [];
	const dispose = () => {
		for (const handle of handles.splice(0).reverse()) handle.dispose();
	};

	const prepare = async (explicitEnv: SubprocessSpawnSpec["env"]) => {
		if (!ctx.direnv.enabled) return explicitEnv;

		const agent = ctx.agents.currentInitiator();
		if (agent === undefined) return explicitEnv;
		const workspace = ctx.direnv.workspaceFor(agent);
		if (workspace === undefined) return explicitEnv;

		// The adapter deliberately scopes direnv to the session workspace root.
		const { env, status } = await ctx.direnv.forWorkspace(workspace);
		if (status.kind === "no-rc" || status.kind === "disabled")
			return explicitEnv;

		return { ...env, ...explicitEnv };
	};

	try {
		handles.push(
			installChainLink(
				target,
				"resolveExecutable",
				async (next, _thisArg, [command, env, signal]) => {
					const prepared = await prepare(env);
					return next(command, stringEnv(prepared), signal);
				},
			),
		);
		handles.push(
			installChainLink(target, "spawn", (next, _thisArg, [spec]) => {
				const actual = prepare(spec.env)
					.catch(() => spec.env)
					.then((env) => next({ ...spec, env }));
				return deferredHandle(spec, actual);
			}),
		);
		handles.push(
			installChainLink(
				target,
				"spawnTerminal",
				async (next, _thisArg, [spec]) => {
					const prepared = await prepare(spec.env);
					return next({ ...spec, env: stringEnv(prepared) });
				},
			),
		);
	} catch (error) {
		dispose();
		throw error;
	}

	return { dispose };
}
