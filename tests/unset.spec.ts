/**
 * Does `unset FOO` in a .envrc actually remove FOO from the real child?
 *
 * Uses the real executor stack, because the answer depends on how the
 * subprocess service layers an explicit env map over the scrubbed parent.
 *
 * @module tests/unset
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import DirenvService, { defaultConfig } from '../src/provider.js'
import { BASH, HAS_DIRENV, requireRealProcesses } from './helpers.js'
import { installDirenvShellAdapter } from '../src/shell-adapter.js'


let currentAgent: unknown
class FakeAgents extends Service {
  constructor(ctx: Context) { super(ctx, 'agents') }
  currentInitiator(): unknown { return currentAgent }
}

const describeReal = requireRealProcesses('real-process tests') ? describe : describe.skip

describeReal('unset semantics against a real child', () => {
  it('removes an inherited variable the .envrc unsets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-direnv-unset-'))
    const ws = join(root, 'ws')
    const home = join(root, 'home')
    const data = join(root, 'data')
    const conf = join(root, 'config')
    const cache = join(root, 'cache')
    for (const d of [ws, home, data, conf, cache]) mkdirSync(d, { recursive: true })
    const rc = join(ws, '.envrc')
    writeFileSync(rc, 'unset INHERITED_VAR\nexport ADDED=yes\n')

    const savedEnv = { ...process.env }
    Object.assign(process.env, {
      INHERITED_VAR: 'from-parent',
      HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: conf, XDG_CACHE_HOME: cache,
    })
    const allow = spawnSync('direnv', ['allow', rc], { env: process.env, encoding: 'utf8' })
    expect(allow.status).toBe(0)

    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    fibers.push(await ctx.plugin(SubprocessLocal))
    fibers.push(await ctx.plugin(BashLocal, { cwd: ws }))
    fibers.push(await ctx.plugin(FakeAgents))
    fibers.push(await ctx.plugin(DirenvService, { ...defaultConfig }))
    const adapter = installDirenvShellAdapter(ctx)
    currentAgent = { session: { header: { cwd: ws } } }
    try {
      const result = await ctx.shell.run(ctx.shell.resolve({
        command: 'printf "[%s]|[%s]" "${INHERITED_VAR-unset}" "${ADDED-unset}"',
      } as never))
      // The variable WAS inherited from the parent, and `unset` in the .envrc
      // must actually remove it from the child — not merely leave it alone.
      expect(result.stdout.text).toBe('[unset]|[yes]')
    } finally {
      adapter.dispose()
      for (const f of fibers.reverse()) await f.dispose()
      process.env = savedEnv
      rmSync(root, { recursive: true, force: true })
    }
  })
})
