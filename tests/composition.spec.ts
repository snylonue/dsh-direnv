/**
 * Real-composition test: boots a genuine Cordis context with the REAL
 * executor stack (subprocess-local + bash-local + shell-env + tool-bash)
 * plus this plugin, then executes a real bash command and inspects what the
 * child actually received.
 *
 * Nothing here is a double except the agent registry, which only has to answer
 * `currentInitiator()`.
 *
 * @module tests/composition
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
import * as AllowTool from '../src/tools.js'


const created: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-direnv-comp-'))
  created.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One isolated direnv sandbox. */
interface Sandbox { workspace: string; home: string; data: string; config: string; cache: string }
function sandbox(): Sandbox {
  const root = scratch()
  const box: Sandbox = {
    workspace: join(root, 'ws'), home: join(root, 'home'),
    data: join(root, 'data'), config: join(root, 'config'), cache: join(root, 'cache'),
  }
  for (const dir of Object.values(box)) mkdirSync(dir, { recursive: true })
  return box
}

let currentAgent: unknown
class FakeAgents extends Service {
  constructor(ctx: Context) { super(ctx, 'agents') }
  currentInitiator(): unknown { return currentAgent }
}

/** Boot the real executor stack plus this plugin. */
async function boot(box: Sandbox) {
  const ctx = new Context()
  const fibers = [] as Array<{ dispose(): Promise<void> }>
  fibers.push(await ctx.plugin(SubprocessLocal))
  fibers.push(await ctx.plugin(BashLocal, { cwd: box.workspace }))
  fibers.push(await ctx.plugin(ShellEnv, {}))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(SystemPrompt, {}))
  fibers.push(await ctx.plugin(FakeAgents))
  fibers.push(await ctx.plugin(DirenvService, { ...defaultConfig }))
  const adapter = installDirenvShellAdapter(ctx)
  fibers.push(await ctx.plugin(ToolBash, {}))
  fibers.push(await ctx.plugin(AllowTool))
  currentAgent = { session: { header: { cwd: box.workspace } } }
  return {
    ctx,
    async dispose() {
      adapter.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

const describeReal = requireRealProcesses('real-composition tests') ? describe : describe.skip

/** Run one real command through the composed bash executor. */
async function bash(app: { ctx: Context }, command: string, extra: Record<string, unknown> = {}) {
  const spec = app.ctx.shell.resolve({ command, ...extra } as never)
  return app.ctx.shell.run(spec)
}

describeReal('real composition: bash-local + shell-env + tool-bash + dsh-direnv', () => {
  it('injects an allowed .envrc into a real child process', async () => {
    const box = sandbox()
    const rc = join(box.workspace, '.envrc')
    writeFileSync(rc, 'export REAL_VAR=injected-value\n')
    const env = {
      ...process.env, HOME: box.home, XDG_DATA_HOME: box.data,
      XDG_CONFIG_HOME: box.config, XDG_CACHE_HOME: box.cache,
    }
    const allow = spawnSync('direnv', ['allow', rc], { env, encoding: 'utf8' })
    expect(allow.status).toBe(0)

    const previous = { ...process.env }
    Object.assign(process.env, {
      HOME: box.home, XDG_DATA_HOME: box.data,
      XDG_CONFIG_HOME: box.config, XDG_CACHE_HOME: box.cache,
    })
    const app = await boot(box)
    try {
      // The child must actually receive the variable: print it from bash.
      const result = await bash(app, 'printf %s "$REAL_VAR"');
      if (result.exitCode !== 0) {
        throw new Error('child failed: ' + result.stderr.text.slice(0, 400))
      }
      expect(result.stdout.text).toBe('injected-value')
    } finally {
      await app.dispose()
      process.env = previous
    }
  })

  it('does not inject an unapproved .envrc, and tells the model to allow it', async () => {
    const box = sandbox()
    const rc = join(box.workspace, '.envrc')
    writeFileSync(rc, 'export SECRET_VAR=never-injected\n')
    const previous = { ...process.env }
    Object.assign(process.env, {
      HOME: box.home, XDG_DATA_HOME: box.data,
      XDG_CONFIG_HOME: box.config, XDG_CACHE_HOME: box.cache,
    })
    const app = await boot(box)
    try {
      const result = await bash(app, 'printf "[%s]" "${SECRET_VAR-unset}"');
      expect(result.stdout.text).toBe('[unset]')
      expect(result.stderr.text).toContain('[dsh-direnv]');
      expect(result.stderr.text).toContain('direnv_allow');
      expect(result.stderr.text).toContain(rc);
    } finally {
      await app.dispose()
      process.env = previous
    }
  })

  it('exposes direnv_allow as a registered model-facing tool', async () => {
    const box = sandbox()
    const previous = { ...process.env }
    Object.assign(process.env, {
      HOME: box.home, XDG_DATA_HOME: box.data,
      XDG_CONFIG_HOME: box.config, XDG_CACHE_HOME: box.cache,
    })
    const app = await boot(box)
    try {
      const names = app.ctx.tools.schemas().map((schema) => schema.name)
      expect(names).toContain('bash')
      expect(names).toContain('direnv_allow')
      const schema = app.ctx.tools.schemas().find((s) => s.name === 'direnv_allow')
      const parameters = schema?.parameters as { properties: Record<string, unknown> }
      expect(Object.keys(parameters.properties)).toContain('path')
    } finally {
      await app.dispose()
      process.env = previous
    }
  })

  it('keeps the managed DSH_* namespace authoritative in the real child', async () => {
    const box = sandbox()
    const rc = join(box.workspace, '.envrc')
    writeFileSync(rc, 'export DSH_SHELL=forged\nexport DSH_EVIL=1\nexport GOOD=ok\n')
    const allowEnv = {
      ...process.env, HOME: box.home, XDG_DATA_HOME: box.data,
      XDG_CONFIG_HOME: box.config, XDG_CACHE_HOME: box.cache,
    }
    spawnSync('direnv', ['allow', rc], { env: allowEnv })
    const previous = { ...process.env }
    Object.assign(process.env, {
      HOME: box.home, XDG_DATA_HOME: box.data,
      XDG_CONFIG_HOME: box.config, XDG_CACHE_HOME: box.cache,
    })
    const app = await boot(box)
    try {
      // Supply the managed snapshot exactly as the real bash tool does
      // (ctx.shellEnv.collect): the executor merges dshEnv LAST, after direnv.
      const result = await bash(
        app,
        'printf "%s|%s|%s" "$GOOD" "${DSH_EVIL-unset}" "$DSH_SHELL"',
        { dshEnv: { DSH_SHELL: '1', DSH_HOME: '/harness/home' } },
      )
      const parts = result.stdout.text.split('|')
      expect(parts[0]).toBe('ok')
      // The workspace's forged names never reach the child.
      expect(parts[1]).toBe('unset')
      // The harness managed fact survives, despite .envrc forging it.
      expect(parts[2]).toBe('1')
    } finally {
      await app.dispose()
      process.env = previous
    }
  })

  it('leaves the child environment untouched when no .envrc exists', async () => {
    const box = sandbox()
    const previous = { ...process.env }
    Object.assign(process.env, {
      HOME: box.home, XDG_DATA_HOME: box.data,
      XDG_CONFIG_HOME: box.config, XDG_CACHE_HOME: box.cache,
    })
    const app = await boot(box)
    try {
      const result = await bash(app, 'printf "[%s]" "${ABSENT_VAR-unset}"');
      expect(result.stdout.text).toBe('[unset]')
      expect(result.stderr.text).not.toContain('[dsh-direnv]')
      expect(result.exitCode).toBe(0)
    } finally {
      await app.dispose()
      process.env = previous
    }
  })
})
