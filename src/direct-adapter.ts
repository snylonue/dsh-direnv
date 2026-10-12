/**
 * Transparent direct-subprocess environment adapter.
 *
 * The adapter wraps the existing subprocess methods in-place. Consumers keep
 * calling resolveExecutable/spawn/spawnTerminal as before; when the session
 * workspace has a usable direnv environment, the original method receives the
 * merged environment. No consumer-side preparation hook is required.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { installChainLink, type ChainHandle } from "./method-chain.js";

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

	const prepare = (explicitEnv: SubprocessSpawnSpec["env"]) => {
		if (!ctx.direnv.enabled) return explicitEnv;

		const agent = ctx.agents.currentInitiator();
		if (agent === undefined) return explicitEnv;
		const workspace = ctx.direnv.workspaceFor(agent);
		if (workspace === undefined) return explicitEnv;

		// The adapter deliberately scopes direnv to the session workspace root.
		const { env, status } = ctx.direnv.forWorkspace(workspace);
		if (status.kind === "no-rc" || status.kind === "disabled")
			return explicitEnv;

		return { ...env, ...explicitEnv };
	};

	try {
		handles.push(
			installChainLink(
				target,
				"resolveExecutable",
				(next, _thisArg, [command, env, signal]) => {
					const prepared = prepare(env);
					return next(command, stringEnv(prepared), signal);
				},
			),
		);
		handles.push(
			installChainLink(target, "spawn", (next, _thisArg, [spec]) => {
				return next({ ...spec, env: prepare(spec.env) });
			}),
		);
		handles.push(
			installChainLink(target, "spawnTerminal", (next, _thisArg, [spec]) => {
				const prepared = prepare(spec.env);
				return next({ ...spec, env: stringEnv(prepared) });
			}),
		);
	} catch (error) {
		dispose();
		throw error;
	}

	return { dispose };
}
