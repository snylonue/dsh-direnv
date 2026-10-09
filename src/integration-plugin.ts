/**
 * Cordis plugin wiring the direnv shell adapter into the Host composition.
 *
 * Declares the agent registry, shell provider, and direnv provider as required
 * services. `apply` installs the shell adapter inside one effect; fiber unload
 * removes it. A provider that failed activation means this row never activates,
 * so a broken direnv setup can never leave a half-instrumented shell.
 *
 * @module dsh-direnv/integration-plugin
 */
import { type Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { installDirenvSessionContext } from "./session-context.js";
import { installDirenvShellAdapter } from "./shell-adapter.js";
import { installDirenvDirectAdapter } from "./direct-adapter.js";

export const name = "direnv-integration";

/** Activate once the Host services the adapter reads per call exist. */
export const inject = ["agents", "shell", "direnv"];

/** No integration-local settings; behavior belongs to the provider row. */
export interface Config {}

export const Config = z.object({}) as z<Config>;

export function apply(ctx: Context, _config: Config): void {
	ctx.inject(["subprocess"], (subprocessCtx: Context) => {
		const adapter = installDirenvDirectAdapter(subprocessCtx);
		subprocessCtx.effect(() => () => adapter.dispose());
	});

	ctx.effect(() => {
		const adapter = installDirenvShellAdapter(ctx);
		let sessionContext;
		try {
			sessionContext = installDirenvSessionContext(ctx);
		} catch (error) {
			// The effect's disposer is never registered when its setup throws, so a
			// failure here would strand `adapter` on the shell provider after this
			// fiber goes inactive — every later shell call would then fault on the
			// dead `ctx.direnv` it reads per call.
			adapter.dispose();
			throw error;
		}
		return () => {
			// Reverse install order, though both are independent.
			sessionContext.dispose();
			adapter.dispose();
		};
	});
}
