/**
 * Session-start context tests.
 *
 * The pure renderer is exercised directly; the injection path runs against the
 * REAL `DirenvService` with only its probe seam replaced, so the assertions
 * observe what a live `agent/session-start` would actually queue — without
 * needing the `direnv` binary or a shell.
 *
 * @module tests/session-context
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterAll, describe, expect, it } from 'vitest'
import DirenvService, { defaultConfig, type DirenvConfig, type DirenvServiceRuntime } from '../src/provider.js'
import {
  SESSION_CONTEXT_MAX_NAMES,
  SESSION_CONTEXT_PLUGIN,
  sessionContextText,
  type DirenvStatus,
  type ExportRun,
} from '../src/core.js'
import { injectSessionContext, installDirenvSessionContext } from '../src/session-context.js'

const roots: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-direnv-sctx-'))
  roots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Return one `direnv export json` outcome. */
function exported(diff: Record<string, string | null>): ExportRun {
  return { code: 0, signal: null, stdout: JSON.stringify(diff), stderr: '', timedOut: false, spawnFailed: false }
}

const BLOCKED_RUN: ExportRun = {
  code: 1,
  signal: null,
  stdout: '',
  stderr: 'direnv: error /ws/.envrc is blocked. Run `direnv allow` to approve its content',
  timedOut: false,
  spawnFailed: false,
}

describe('sessionContextText', () => {
  it('names an active environment without leaking values', () => {
    const status: DirenvStatus = {
      kind: 'injected',
      rcPath: '/ws/.envrc',
      env: { FOO: 'one', BAR: 'two', UNSET: undefined },
      dropped: [],
    }
    const text = sessionContextText(status, '/ws')
    expect(text).toBeDefined()
    expect(text).toContain('injects 2 variable(s)')
    expect(text).toContain('BAR, FOO')
    // Neither the values nor a removal-only name may appear.
    expect(text).not.toContain('one')
    expect(text).not.toContain('two')
    expect(text).not.toContain('UNSET')
  })

  it('caps a Nix-scale environment but keeps the exact count', () => {
    const env: Record<string, string> = {}
    for (let index = 0; index < SESSION_CONTEXT_MAX_NAMES + 6; index += 1) {
      env[`VAR_${String(index).padStart(3, '0')}`] = 'x'
    }
    const text = sessionContextText({ kind: 'injected', rcPath: '/ws/.envrc', env, dropped: [] }, '/ws')
    expect(text).toContain(`injects ${String(SESSION_CONTEXT_MAX_NAMES + 6)} variable(s)`)
    expect(text).toContain('and 6 more')
  })

  it('points a blocked workspace at direnv_allow', () => {
    const text = sessionContextText({ kind: 'blocked', rcPath: '/ws/.envrc', env: {}, dropped: [] }, '/ws')
    expect(text).toContain('direnv_allow path=/ws/.envrc')
    expect(text).toContain('Workspace: /ws')
    expect(text).not.toContain('This command ran')
  })

  it('reports a denied workspace without a variable list', () => {
    const text = sessionContextText({ kind: 'denied', rcPath: '/ws/.envrc', env: {}, dropped: [] }, '/ws')
    expect(text).toContain('denied')
    expect(text).toContain('direnv status')
  })

  it('surfaces an error detail', () => {
    const text = sessionContextText({ kind: 'error', env: {}, dropped: [], detail: 'direnv export timed out' }, '/ws')
    expect(text).toContain('direnv export timed out')
  })

  it('stays silent when nothing governs the workspace or the plugin is off', () => {
    expect(sessionContextText({ kind: 'no-rc', rcPath: '/ws/.envrc', env: {}, dropped: [] }, '/ws')).toBeUndefined()
    expect(sessionContextText({ kind: 'disabled', env: {}, dropped: [] }, '/ws')).toBeUndefined()
  })
})

interface Booted {
  ctx: Context
  agent: Agent
  injected: UserMessage[]
  probeCalls: () => number
  workspace: string
  dispose(): Promise<void>
}

/** Boot the real service with a replaced probe; no direnv binary is needed. */
async function boot(options: {
  rcPath?: string
  probe?: () => ExportRun
  config?: Partial<DirenvConfig>
} = {}): Promise<Booted> {
  const root = scratch()
  const workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })
  const ctx = new Context()
  ctx.provide('shell', {} as never)
  const rcPath = options.rcPath
  let probeCalls = 0
  const runtime: DirenvServiceRuntime = {
    env: { ...process.env, HOME: root, XDG_DATA_HOME: join(root, 'data') },
    findRcPath: () => rcPath,
    runExport: () => {
      probeCalls += 1
      return (options.probe ?? (() => exported({})))()
    },
  }
  const config: DirenvConfig = { ...defaultConfig, ...options.config }
  const fiber = await ctx.plugin(class extends DirenvService {
    constructor(applyCtx: Context) {
      super(applyCtx, config, runtime)
    }
  })
  const injected: UserMessage[] = []
  const agent = {
    session: { header: { cwd: workspace } },
    inject: (message: UserMessage) => { injected.push(message) },
  } as unknown as Agent
  return {
    ctx,
    agent,
    injected,
    probeCalls: () => probeCalls,
    workspace,
    async dispose() {
      await fiber.dispose()
    },
  }
}

describe('injectSessionContext', () => {
  it('queues one plugin snapshot naming the injected variables', async () => {
    const app = await boot({
      rcPath: join(scratch(), '.envrc'),
      probe: () => exported({ E2E_ONE: 'alpha', E2E_TWO: 'beta', DIRENV_DIR: '/ignored' }),
    })
    try {
      injectSessionContext(app.ctx, app.agent)
      expect(app.injected).toHaveLength(1)
      const message = app.injected[0]
      expect(message?.source).toMatchObject({ kind: 'plugin', plugin: SESSION_CONTEXT_PLUGIN, form: 'snapshot' })
      const text = (message?.content[0] as { text: string }).text
      expect(text).toContain('E2E_ONE, E2E_TWO')
      expect(text).not.toContain('alpha')
      expect(text).not.toContain('DIRENV_DIR')
    } finally {
      await app.dispose()
    }
  })

  it('tells the model to approve a blocked .envrc', async () => {
    const rcPath = join(scratch(), '.envrc')
    const app = await boot({ rcPath, probe: () => BLOCKED_RUN })
    try {
      injectSessionContext(app.ctx, app.agent)
      expect(app.injected).toHaveLength(1)
      const text = (app.injected[0]?.content[0] as { text: string }).text
      expect(text).toContain(`direnv_allow path=${rcPath}`)
    } finally {
      await app.dispose()
    }
  })

  it('stays silent without an RC, when disabled, or when the context is off', async () => {
    const noRc = await boot()
    const off = await boot({ rcPath: join(scratch(), '.envrc'), config: { sessionContext: false } })
    const disabled = await boot({ rcPath: join(scratch(), '.envrc'), config: { enabled: false } })
    try {
      injectSessionContext(noRc.ctx, noRc.agent)
      injectSessionContext(off.ctx, off.agent)
      injectSessionContext(disabled.ctx, disabled.agent)
      expect(noRc.injected).toHaveLength(0)
      expect(off.injected).toHaveLength(0)
      expect(disabled.injected).toHaveLength(0)
    } finally {
      await noRc.dispose()
      await off.dispose()
      await disabled.dispose()
    }
  })

  it('skips an agent with no usable cwd', async () => {
    const app = await boot({ rcPath: join(scratch(), '.envrc'), probe: () => exported({ A: '1' }) })
    try {
      const homeless = { session: { header: {} }, inject: (message: UserMessage) => { app.injected.push(message) } } as unknown as Agent
      injectSessionContext(app.ctx, homeless)
      expect(app.injected).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  it('warms the cache so the first command does not probe again', async () => {
    const ws = scratch()
    const app = await boot({ rcPath: join(ws, '.envrc'), probe: () => exported({ A: '1' }) })
    try {
      injectSessionContext(app.ctx, app.agent)
      expect(app.probeCalls()).toBe(1)
      // A later resolution through the same provider must reuse the warmed entry.
      expect(app.ctx.direnv.statusFor(app.workspace).kind).toBe('injected')
      expect(app.probeCalls()).toBe(1)
    } finally {
      await app.dispose()
    }
  })

  it('runs from a real agent/session-start event', async () => {
    const app = await boot({ rcPath: join(scratch(), '.envrc'), probe: () => exported({ A: '1' }) })
    try {
      const listener = installDirenvSessionContext(app.ctx)
      emitAgentEvent(app.ctx, app.agent, 'agent/session-start', { source: 'startup' })
      expect(app.injected).toHaveLength(1)
      listener.dispose()
      emitAgentEvent(app.ctx, app.agent, 'agent/session-start', { source: 'resume' })
      expect(app.injected).toHaveLength(1)
    } finally {
      await app.dispose()
    }
  })
})
