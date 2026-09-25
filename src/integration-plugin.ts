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
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installDirenvShellAdapter } from './shell-adapter.js'

export const name = 'direnv-integration'

/** Activate once the Host services the adapter reads per call exist. */
export const inject = ['agents', 'shell', 'direnv']

/** No integration-local settings; behavior belongs to the provider row. */
export interface Config {}

export const Config = z.object({}) as z<Config>

export function apply(ctx: Context, _config: Config): void {
  ctx.effect(() => {
    const adapter = installDirenvShellAdapter(ctx)
    return () => adapter.dispose()
  })
}
