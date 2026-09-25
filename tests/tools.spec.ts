/**
 * Approval-gate tests for the direnv_allow tool.
 *
 * The tool definition is captured from the real registry registration and
 * then executed directly with a fabricated caller, so these tests observe
 * exactly the consent logic without depending on agent-loop plumbing.
 *
 * @module tests/tools
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DirenvService, { defaultConfig, type DirenvConfig } from '../src/provider.js'
import * as AllowTool from '../src/tools.js'

const created: string[] = []
function scratch(prefix = 'dsh-direnv-allow-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Every question the most recent harness asked, in order. */
let asked: Array<{ toolName: string; callId: string; reason: string }> = []
/** The scripted answer the next question receives. */
let answer: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once'

/**
 * Records approval questions and answers with a scripted outcome. State is
 * module-level because a Cordis service cannot be inspected through its proxy.
 */
class FakeApproval extends Service {
  constructor(ctx: Context) {
    super(ctx, 'approval')
  }
  request(req: { toolName: string; callId: string; reason?: string }) {
    asked.push({ toolName: req.toolName, callId: req.callId, reason: req.reason ?? '' })
    return Promise.resolve(answer)
  }
}

/** One captured tool registration. */
interface CapturedTool {
  name: string
  description: string
  parameters: unknown
  /** The tool body, invoked by the harness with a fabricated caller. */
  execute: (args: Record<string, unknown>, exec: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/** The `direnv allow` runner the harness injects; it records the path it received. */
type AllowSpy = (rcPath: string) => { code: number; stdout: string; stderr: string }

/**
 * The most recently registered definitions. Module state rather than an
 * instance property: a Cordis service is reached through a traceable proxy, so
 * a test cannot read a provider's fields back off `ctx.<service>`.
 */
let captured: CapturedTool[] = []

/** Captures registered tool definitions instead of using the real registry. */
class CapturingTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  register(definition: CapturedTool) {
    captured.push(definition)
    return () => {}
  }
}

/** The registration captured by the most recent `harness()` call. */
function capturedTool(name: string): CapturedTool | undefined {
  return captured.find((tool) => tool.name === name)
}

/** A system prompt service is injected but unread by the tool. */
class FakePrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }
  section() { return () => {} }
  getSectionOrder() { return 0 }
}

interface Caller { session: { header: { cwd?: string } } }

interface Harness {
  ctx: Context
  allowSpy: ReturnType<typeof vi.fn<AllowSpy>>
  workspace: string
  rcPath: string
  call(args: Record<string, unknown>, opts?: { agent?: Caller | undefined }): Promise<Record<string, unknown>>
  dispose(): Promise<void>
}

async function harness(options: {
  outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  withApproval?: boolean;
  allowCode?: number;
  allowStderr?: string;
  config?: Partial<DirenvConfig>;
} = {}): Promise<Harness> {
  const workspace = scratch()
  const rcPath = join(workspace, '.envrc')
  writeFileSync(rcPath, 'export ALLOW_TOOL_TEST=1\nexport SECOND=2\n')

  const ctx = new Context()
  captured = []
  asked = []
  answer = options.outcome ?? 'allowed-once'
  // DirenvService injects `shell`; the tool only needs it to exist so the
  // provider activates, never to execute anything.
  ctx.provide('shell', { resolve: () => ({}), run: () => Promise.resolve({}), start: () => ({}) })
  const toolsFiber = await ctx.plugin(CapturingTools)
  const promptFiber = await ctx.plugin(FakePrompt)
  const approvalFiber = options.withApproval === false ? undefined : await ctx.plugin(FakeApproval)


  const allowSpy = vi.fn<AllowSpy>(() => ({ code: options.allowCode ?? 0, stdout: '', stderr: options.allowStderr ?? '' }))
  const providerFiber = await ctx.plugin(class extends DirenvService {
    constructor(applyCtx: Context) {
      super(applyCtx, { ...defaultConfig, ...options.config }, {
        runAllow: (path: string) => allowSpy(path),
        runExport: () => ({ code: 0, signal: null, stdout: '{}', stderr: '', timedOut: false, spawnFailed: false }),
      })
    }
  })
  const toolFiber = await ctx.plugin(AllowTool)
  const definition = capturedTool('direnv_allow')
  if (definition === undefined) throw new Error('the tool did not register')

  const agent: Caller = { session: { header: { cwd: workspace } } }
  return {
    ctx, allowSpy, workspace, rcPath,
    async call(args, opts = {}) {
      const caller = 'agent' in opts ? opts.agent : agent
      return definition.execute(args, {
        callId: 'call-1',
        name: 'direnv_allow',
        arguments: args,
        ...caller === undefined ? {} : { agent: caller },
        signal: new AbortController().signal,
      }) as Promise<Record<string, unknown>>
    },
    async dispose() {
      await toolFiber.dispose()
      await providerFiber.dispose()
      if (approvalFiber !== undefined) await approvalFiber.dispose()
      await promptFiber.dispose()
      await toolsFiber.dispose()
    },
  }
}

describe('direnv_allow registration', () => {
  it('registers a tool named direnv_allow with a required path parameter', async () => {
    const h = await harness()
    try {
      const definition = capturedTool('direnv_allow')
      expect(definition).toBeDefined()
      expect(definition?.description).toContain('approve');
      const parameters = definition?.parameters as { properties: Record<string, unknown>; required: string[] }
      expect(Object.keys(parameters.properties)).toContain('path')
      expect(Object.keys(parameters.properties)).toContain('reason')
      expect(parameters.required).toEqual(['path'])
    } finally { await h.dispose() }
  })
})

describe('approval gate', () => {
  it('asks the user exactly once with the tool identity, call id, and a preview', async () => {
    const h = await harness()
    try {
      const result = await h.call({ path: h.rcPath, reason: 'the build needs the toolchain' })
      expect(asked).toHaveLength(1)
      const request = asked[0]
      expect(request?.toolName).toBe('direnv_allow')
      expect(request?.callId).toBe('call-1')
      expect(request?.reason).toContain(h.rcPath)
      expect(request?.reason).toContain('the build needs the toolchain')
      expect(request?.reason).toContain('export ALLOW_TOOL_TEST=1')
      expect(request?.reason).toMatch(/sha256: [0-9a-f]{64}/)
      expect(result.outcome).toBe('approved')
    } finally { await h.dispose() }
  })

  it('performs the approval only after an allowed-once outcome', async () => {
    const h = await harness({ outcome: 'allowed-once' })
    try {
      const result = await h.call({ path: h.rcPath })
      expect(h.allowSpy).toHaveBeenCalledTimes(1)
      expect(h.allowSpy).toHaveBeenCalledWith(h.rcPath)
      expect(result.outcome).toBe('approved')
      expect(String(result.detail)).toContain('approved')
    } finally { await h.dispose() }
  })

  it('never approves when the user rejects', async () => {
    const h = await harness({ outcome: 'rejected' })
    try {
      const result = await h.call({ path: h.rcPath })
      expect(asked).toHaveLength(1)
      expect(h.allowSpy).not.toHaveBeenCalled()
      expect(result.outcome).toBe('rejected')
    } finally { await h.dispose() }
  })

  it('never approves when the question is cancelled', async () => {
    const h = await harness({ outcome: 'cancelled' })
    try {
      const result = await h.call({ path: h.rcPath })
      expect(h.allowSpy).not.toHaveBeenCalled()
      expect(result.outcome).toBe('cancelled')
    } finally { await h.dispose() }
  })

  it('never approves when no answerer is reachable', async () => {
    const h = await harness({ outcome: 'unavailable' })
    try {
      const result = await h.call({ path: h.rcPath })
      expect(h.allowSpy).not.toHaveBeenCalled()
      expect(result.outcome).toBe('unavailable')
    } finally { await h.dispose() }
  })

  it('never approves when no approval service is composed', async () => {
    const h = await harness({ withApproval: false })
    try {
      const result = await h.call({ path: h.rcPath })
      expect(h.allowSpy).not.toHaveBeenCalled()
      expect(result.outcome).toBe('unavailable')
      expect(String(result.detail)).toContain('no approval channel')
    } finally { await h.dispose() }
  })
})

describe('refusals happen before any user is asked', () => {
  const cases: Array<[string, (h: Harness) => string]> = [
    ['a relative path', () => '.envrc'],
    ['an absolute path outside the workspace', () => {
      const outside = scratch('dsh-direnv-outside-')
      const rc = join(outside, '.envrc')
      writeFileSync(rc, 'export X=1\n')
      return rc;
    }],
    ['a file that is not a direnv RC name', (h) => {
      const other = join(h.workspace, 'evil.sh')
      writeFileSync(other, 'echo hi\n')
      return other;
    }],
    ['a path that does not exist', (h) => join(h.workspace, 'missing', '.envrc')],
  ]

  for (const [label, make] of cases) {
    it('refuses ' + label + ' without asking or approving', async () => {
      const h = await harness()
      try {
        const result = await h.call({ path: make(h) })
        expect(result.outcome).toBe('refused')
        expect(asked).toHaveLength(0)
        expect(h.allowSpy).not.toHaveBeenCalled()
      } finally { await h.dispose() }
    })
  }

  it('refuses a valid path when there is no workspace to scope it to', async () => {
    // With the workspace restriction on, an agentless call has no workspace and
    // the path is refused before anyone could be asked.
    const h = await harness({ config: { restrictAllowToWorkspace: true } })
    try {
      const result = await h.call({ path: h.rcPath }, { agent: undefined })
      expect(result.outcome).toBe('refused')
      expect(String(result.detail)).toContain('no workspace')
      expect(asked).toHaveLength(0)
      expect(h.allowSpy).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('refuses an agentless call as unavailable once the workspace restriction is off', async () => {
    // Isolation of the agent check: with scoping disabled the path itself is
    // approvable, so what stops the call is the absence of an agent to route
    // the question through. Nothing may be approved without a user.
    const h = await harness({ config: { restrictAllowToWorkspace: false } })
    try {
      const result = await h.call({ path: h.rcPath }, { agent: undefined })
      expect(result.outcome).toBe('unavailable')
      expect(String(result.detail)).toContain('no agent')
      expect(asked).toHaveLength(0)
      expect(h.allowSpy).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('refuses a path outside the workspace only when the restriction is on', async () => {
    const strict = await harness({ config: { restrictAllowToWorkspace: true } })
    const lax = await harness({ config: { restrictAllowToWorkspace: false } })
    try {
      const outside = scratch('dsh-direnv-shared-')
      const rc = join(outside, '.envrc')
      writeFileSync(rc, 'export X=1\n')
      expect((await strict.call({ path: rc })).outcome).toBe('refused')
      expect(strict.allowSpy).not.toHaveBeenCalled()
      // With the restriction off, the same path is approvable — the user still decides.
      const laxResult = await lax.call({ path: rc })
      expect(laxResult.outcome).toBe('approved')
      expect(lax.allowSpy).toHaveBeenCalledTimes(1)
    } finally {
      await strict.dispose()
      await lax.dispose()
    }
  })
})

describe('after an approval', () => {
  it('reports the number of variables the next command will receive', async () => {
    const h = await harness({ config: { enabled: true } })
    try {
      // The injected probe returns an empty diff, so the count is zero; the
      // contract under test is that the count is reported, not its value.
      const result = await h.call({ path: h.rcPath })
      expect(result.outcome).toBe('approved')
      expect(typeof result.variables).toBe('number')
      expect(result.path).toBe(h.rcPath)
      expect(String(result.sha256)).toMatch(/^[0-9a-f]{64}$/);
    } finally { await h.dispose() }
  })

  it('reports a direnv write failure as a refusal, not an approval', async () => {
    const h = await harness({ allowCode: 1, allowStderr: 'direnv: error cannot write' })
    try {
      const result = await h.call({ path: h.rcPath })
      expect(result.outcome).toBe('refused')
      expect(h.allowSpy).toHaveBeenCalledTimes(1)
      expect(String(result.detail)).toContain('direnv refused the write')
    } finally { await h.dispose() }
  })

  it('shows the file hash so the user approves exact content', async () => {
    const h = await harness()
    try {
      const before = await h.call({ path: h.rcPath })
      const firstHash = String(before.sha256)
      writeFileSync(h.rcPath, 'export ALLOW_TOOL_TEST=2\n')
      const again = await h.call({ path: h.rcPath })
      expect(String(again.sha256)).not.toBe(firstHash)
    } finally { await h.dispose() }
  })
})

