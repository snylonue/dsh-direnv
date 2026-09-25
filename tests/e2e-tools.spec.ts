/**
 * Full-stack acceptance on a real composition: the model-facing bash tool and
 * both direnv tools, driven through the REAL tool registry.
 *
 * @module tests/e2e-tools
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import DirenvService, { defaultConfig } from '../src/provider.js'
import { installDirenvShellAdapter } from '../src/shell-adapter.js'
import { BASH, HAS_DIRENV, requireRealProcesses } from './helpers.js'
import * as DirenvTools from '../src/tools.js'


const roots: string[] = []
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

let currentAgent: unknown
let asked = 0
class FakeAgents extends Service {
  constructor(ctx: Context) { super(ctx, 'agents') }
  currentInitiator(): unknown { return currentAgent }
}
class FakeApproval extends Service {
  constructor(ctx: Context) { super(ctx, 'approval') }
  request() { asked += 1; return Promise.resolve('allowed-once') }
}

const describeReal = requireRealProcesses('real-process tests') ? describe : describe.skip

describeReal('end to end through the tool registry', () => {
  it('runs bash via the tool, approves, and reloads, all as real children', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-direnv-e2e-tools-'))
    roots.push(root)
    const ws = join(root, 'proj')
    const home = join(root, 'home')
    const data = join(root, 'data')
    const conf = join(root, 'config')
    const cache = join(root, 'cache')
    for (const d of [ws, home, data, conf, cache]) mkdirSync(d, { recursive: true })
    const rc = join(ws, '.envrc')
    writeFileSync(rc, 'export TOOLCHAIN=ready\n')

    const saved = { ...process.env }
    Object.assign(process.env, { HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: conf, XDG_CACHE_HOME: cache })

    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    fibers.push(await ctx.plugin(SubprocessLocal))
    fibers.push(await ctx.plugin(BashLocal, { cwd: ws }))
    fibers.push(await ctx.plugin(ShellEnv))
    fibers.push(await ctx.plugin(ToolRuntime))
    fibers.push(await ctx.plugin(SystemPrompt, {}))
    fibers.push(await ctx.plugin(FakeAgents))
    fibers.push(await ctx.plugin(FakeApproval))
    fibers.push(await ctx.plugin(DirenvService, { ...defaultConfig }))
    const adapter = installDirenvShellAdapter(ctx)
    fibers.push(await ctx.plugin(ToolBash, {}))
    fibers.push(await ctx.plugin(DirenvTools))
    currentAgent = { session: { header: { cwd: ws } } }
    asked = 0

    const call = (name: string, args: Record<string, unknown>) => ctx.tools.execute({
      callId: 'c-' + name,
      name,
      arguments: args,
      agent: currentAgent,
      signal: new AbortController().signal,
    } as never)

    try {
      // 1) The bash TOOL — the path the model actually uses. It supplies the
      //    managed dshEnv snapshot, so this also proves the layering.
      const blocked = await call('bash', { command: 'printf "[%s]" "${TOOLCHAIN-unset}"', description: 'check toolchain' })
      const blockedText = JSON.stringify(blocked)
      expect(blockedText).toContain('[unset]')
      expect(blockedText).toContain('dsh-direnv')

      // 2) Approve through the model-facing tool; the REAL direnv writes it.
      const approved = await call('direnv_allow', { path: rc, reason: 'the build needs it' })
      expect(asked).toBe(1)
      expect(JSON.stringify(approved)).toContain('approved')

      // 3) The very next bash tool call receives the environment.
      const injected = await call('bash', { command: 'printf "%s" "$TOOLCHAIN"', description: 'read toolchain' })
      expect(JSON.stringify(injected)).toContain('ready')

      // 4) The reload tool reports the resolved state.
      const reloaded = await call('direnv_reload', {})
      const reloadText = JSON.stringify(reloaded)
      expect(reloadText).toContain('injected')
      expect(reloadText).toContain('1');
    } finally {
      adapter.dispose()
      for (const f of fibers.reverse()) await f.dispose()
      process.env = saved
    }
  })
})
