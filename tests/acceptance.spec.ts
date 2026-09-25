/**
 * Acceptance test: the whole user story in one flow, on a real composition.
 *
 * An unapproved .envrc injects nothing and produces an actionable notice; the
 * model calls direnv_allow; the user approves; the very next command receives
 * the workspace environment. The approval writes through the REAL direnv.
 *
 * @module tests/acceptance
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-direnv-accept-'))
  created.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let asked = 0
class FakeApproval extends Service {
  constructor(ctx: Context) { super(ctx, 'approval') }
  request() { asked += 1; return Promise.resolve('allowed-once') }
}
let currentAgent: unknown
class FakeAgents extends Service {
  constructor(ctx: Context) { super(ctx, 'agents') }
  currentInitiator(): unknown { return currentAgent }
}

const describeReal = requireRealProcesses('acceptance tests') ? describe : describe.skip

describeReal('acceptance: unapproved -> approve -> injected', () => {
  it('takes a workspace from blocked to injected through the user-facing flow', async () => {
    const root = scratch()
    const workspace = join(root, 'project')
    const home = join(root, 'home')
    const data = join(root, 'data')
    const configDir = join(root, 'config')
    const cache = join(root, 'cache')
    for (const dir of [workspace, home, data, configDir, cache]) mkdirSync(dir, { recursive: true })
    const rcPath = join(workspace, '.envrc')
    writeFileSync(rcPath, 'export PROJECT_TOOLCHAIN=ready\nexport API_BASE=https://example.test\n')

    // Redirect the direnv store into the sandbox for the whole test.
    const previous = { ...process.env }
    Object.assign(process.env, {
      HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: configDir, XDG_CACHE_HOME: cache,
    })

    const ctx = new Context()
    const fibers = [] as Array<{ dispose(): Promise<void> }>
    fibers.push(await ctx.plugin(SubprocessLocal))
    fibers.push(await ctx.plugin(BashLocal, { cwd: workspace }))
    fibers.push(await ctx.plugin(ShellEnv))
    fibers.push(await ctx.plugin(ToolRuntime))
    fibers.push(await ctx.plugin(SystemPrompt, {}))
    fibers.push(await ctx.plugin(FakeAgents))
    fibers.push(await ctx.plugin(FakeApproval))
    fibers.push(await ctx.plugin(DirenvService, { ...defaultConfig }))
    const adapter = installDirenvShellAdapter(ctx)
    fibers.push(await ctx.plugin(ToolBash, {}))
    fibers.push(await ctx.plugin(AllowTool))
    currentAgent = { session: { header: { cwd: workspace } } }
    asked = 0

    const run = (command: string) =>
      ctx.shell.run(ctx.shell.resolve({ command } as never))

    try {
      // STEP 1 - unapproved: the command runs, gets no workspace env, and the
      // model is told exactly how to fix it.
      const blocked = await run('printf "[%s]" "${PROJECT_TOOLCHAIN-unset}"')
      expect(blocked.exitCode).toBe(0)
      expect(blocked.stdout.text).toBe('[unset]')
      expect(blocked.stderr.text).toContain('[dsh-direnv]')
      expect(blocked.stderr.text).toContain(rcPath)
      expect(blocked.stderr.text).toContain('direnv_allow')

      // STEP 2 - the model asks; the user's answer arrives through the approval
      // channel; the REAL direnv records the authorization.
      const allowResult = await ctx.tools.execute({
        callId: 'call-accept-1',
        name: 'direnv_allow',
        arguments: { path: rcPath, reason: 'the project toolchain is needed' },
        agent: currentAgent,
        signal: new AbortController().signal,
      } as never)
      expect(asked).toBe(1)
      expect(JSON.stringify(allowResult)).toContain('approved')
      // The tool's report must be truthful about what the next command will
      // receive, checked against the REAL direnv rather than a mock. This fixture
      // has the workspace BE the RC's directory, so it cannot tell a probe of the
      // wrong directory apart — `tools.spec.ts` covers that with a nested layout.
      // What it pins here is that the real direnv's answer reaches the report at
      // all: two variables were just authorized, so the count is exactly 2.
      const reported = (allowResult as { value: { variables?: number; detail?: string } }).value
      expect(reported.variables).toBe(2)
      expect(String(reported.detail)).not.toContain('no .envrc governs')
      // ...and the child really does receive them, asserted in STEP 3 below.

      // STEP 3 - the very next command receives the environment.
      const injected = await run('printf "%s|%s" "$PROJECT_TOOLCHAIN" "$API_BASE"')
      expect(injected.exitCode).toBe(0)
      expect(injected.stdout.text).toBe('ready|https://example.test')
      expect(injected.stderr.text).not.toContain('[dsh-direnv]')
    } finally {
      adapter.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      process.env = previous
    }
  })
})
