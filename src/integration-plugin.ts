/**
 * Cordis plugin wiring direnv adapters and session context into the Host.
 *
 * The agent registry and direnv provider are required by the whole plugin.
 * Each adapter waits for its execution service through `ctx.inject()`; effects
 * remove the installed adapters and listeners when their owning fiber unloads.
 *
 * @module dsh-direnv/integration-plugin
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { installDirenvSessionContext } from "./session-context.js";
import { installDirenvShellAdapter } from "./shell-adapter.js";
import { installDirenvDirectAdapter } from "./direct-adapter.js";

export const name = "direnv-integration";

export const inject = ["agents", "direnv"];

/** No integration-local settings; behavior belongs to the provider row. */
export type Config = Record<string, never>;

export const Config = z.object({}) as z<Config>;

export function apply(ctx: Context, _config: Config): void {
	ctx.inject(["subprocess"], (ctx: Context) => {
		ctx.effect(() => {
			const adapter = installDirenvDirectAdapter(ctx);
			return () => adapter.dispose();
		});
	});

	ctx.inject(["shell"], (ctx: Context) => {
		ctx.effect(() => {
			const adapter = installDirenvShellAdapter(ctx);
			return () => adapter.dispose();
		});
	});

	ctx.effect(() => {
		const sessionContext = installDirenvSessionContext(ctx);
		return () => sessionContext.dispose();
	});
}
