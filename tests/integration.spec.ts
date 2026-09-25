/**
 * End-to-end tests against the REAL direnv binary, the REAL service, and the
 * REAL chain adapter over a recording shell executor.
 *
 * Every workspace, every authorization store, and every child environment lives
 * under one temp root with isolated XDG_DATA_HOME / XDG_CONFIG_HOME /
 * XDG_CACHE_HOME and HOME, so the developer's real direnv authorization state is
 * never read, compared, or written.
 *
 * @module tests/integration
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { afterAll, describe, expect, it } from 'vitest'
import DirenvService, { defaultConfig, type DirenvConfig } from '../src/provider.js'
import { BASH, HAS_DIRENV, requireRealProcesses } from './helpers.js'
import { installDirenvShellAdapter } from '../src/shell-adapter.js'


/** One isolated direnv sandbox: workspace plus private HOME and XDG roots. */
interface Sandbox {
  root: string
  home: string
  data: string
  config: string
  cache: string
  workspace: string
}

const sandboxes: Sandbox[] = []

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'dsh-direnv-e2e-'))
  const box: Sandbox = {
    root,
    home: join(root, 'home'),
    data: join(root, 'data'),
    config: join(root, 'config'),
    cache: join(root, 'cache'),
    workspace: join(root, 'ws'),
  }
  for (const dir of [box.home, box.data, box.config, box.cache, box.workspace]) mkdirSync(dir, { recursive: true })
  sandboxes.push(box)
  return box
}

/**
 * The environment every direnv child in these tests runs with.
 *
 * `process.env` is the base, exactly as production uses it, with only the
 * direnv authorization store redirected into the sandbox. That base matters:
 * `direnv export json` returns a DIFF against the environment it ran in, so a
 * deliberately minimal base would make bash's own startup files appear as
 * "changes" and pollute every assertion with unrelated variables.
 */
function direnvEnv(box: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: box.home,
    XDG_DATA_HOME: box.data,
    XDG_CONFIG_HOME: box.config,
    XDG_CACHE_HOME: box.cache,
  }
}

/** Authorize one RC file with the REAL direnv, in this sandbox's own store. */
function allowWithRealDirenv(box: Sandbox, rcPath: string): void {
  const result = spawnSync('direnv', ['allow', rcPath], { env: direnvEnv(box), encoding: 'utf8' })
  if (result.status !== 0) throw new Error('test setup: direnv allow failed: ' + String(result.stderr))
}

/** Write one .envrc, authorizing it by default. */
function writeRc(box: Sandbox, relativeDir: string, body: string, allow = true): string {
  const dir = join(box.workspace, relativeDir)
  mkdirSync(dir, { recursive: true })
  const rcPath = join(dir, '.envrc')
  writeFileSync(rcPath, body)
  if (allow) allowWithRealDirenv(box, rcPath)
  return rcPath
}

/** An `allow` runner that writes into the sandbox's own store. */
function allowIn(box: Sandbox) {
  return (rcPath: string, config: { executable: string; probeTimeoutMs: number }) => {
    const result = spawnSync(config.executable, ['allow', rcPath], {
      env: direnvEnv(box), timeout: config.probeTimeoutMs, encoding: 'utf8',
    })
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

/** Run the real direnv export in one sandbox, with its isolated store. */
function exportIn(box: Sandbox, dir: string, config: DirenvConfig) {
  const result = spawnSync(config.executable, ['export', 'json'], {
    cwd: dir, env: direnvEnv(box), timeout: config.probeTimeoutMs, encoding: 'utf8',
  })
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: false,
    spawnFailed: result.error !== undefined,
  }
}

afterAll(() => {
  for (const box of sandboxes.splice(0)) rmSync(box.root, { recursive: true, force: true })
})


/**
 * A recording shell executor: requests resolve through the REAL adapter chain
 * and each spec is captured, so assertions observe exactly the environment the
 * executor would have handed the child.
 */
class RecordingShell {
  specs: ShellExecSpec[] = []
  sandboxMode = undefined

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/default-workdir',
      timeoutMs: request.timeoutMs ?? 1_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1_024,
      ...request.signal !== undefined ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  last(): ShellExecSpec {
    const spec = this.specs.at(-1)
    if (spec === undefined) throw new Error('no spec was resolved')
    return spec
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.specs.push(spec)
    return Promise.resolve({
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    })
  }

  start(spec: ShellExecSpec): ShellProcess {
    this.specs.push(spec)
    return {
      status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => false,
    }
  }
}

/**
 * Install one plain object as the composition's `shell` service. `provide` is
 * used instead of a full plugin so the test never drags the real executor's
 * dependency chain into the process.
 */
function provideShell(ctx: Context, shell: RecordingShell): RecordingShell {
  ctx.provide('shell', shell)
  return shell
}

/** The fibers one test booted, so teardown awaits every plugin it started. */
interface Booted {
  ctx: Context
  shell: RecordingShell
  agents: FakeAgents
  dispose(): Promise<void>
}

/**
 * A minimal stand-in for the agent registry's initiator scope.
 *
 * The value lives in module state rather than on the service instance: a
 * Cordis service is reached through a traceable proxy, and assigning to a
 * property on that proxy writes the consumer's shadow, never the provider.
 */
let currentAgent: unknown
class FakeAgents extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents')
  }
  currentInitiator(): unknown {
    return currentAgent
  }
}

/** Boot a composition with the real service, real adapter, and fakes for the rest. */
async function boot(box: Sandbox, overrides: Partial<DirenvConfig> = {}, runExport?: () => never): Promise<Booted> {
  const ctx = new Context()
  const shell = provideShell(ctx, new RecordingShell())
  const agents = await ctx.plugin(FakeAgents)
  const config: DirenvConfig = { ...defaultConfig, ...overrides }
  const serviceFiber = await ctx.plugin(class extends DirenvService {
    constructor(applyCtx: Context) {
      // The sandbox environment travels through the runtime seam, so the probe
      // and the cache stamp always describe the same direnv store.
      super(applyCtx, config, {
        env: direnvEnv(box),
        runAllow: allowIn(box),
        ...runExport === undefined ? { runExport: (dir, cfg) => exportIn(box, dir, cfg) } : { runExport },
      })
    }
  })
  const adapter = installDirenvShellAdapter(ctx)
  currentAgent = { session: { header: { cwd: box.workspace } } }
  return {
    ctx,
    // The PROXY, not the raw object: the adapter chain is installed on the
    // provider target, and only the proxy dispatches through it.
    shell: ctx.shell as unknown as RecordingShell,
    agents: agents as unknown as FakeAgents,
    async dispose() {
      adapter.dispose()
      await serviceFiber.dispose()
      await agents.dispose()
    },
  }
}

const describeReal = requireRealProcesses('real-direnv tests') ? describe : describe.skip

describeReal('direnv injection (real direnv)', () => {
  it('injects an allowed .envrc into the resolved shell spec', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export E2E_ONE=alpha\nexport E2E_TWO="a b"\n')
    const app = await boot(box)
    try {
      app.shell.run(app.shell.resolve({ command: 'echo hi' }))
      const env = app.shell.last().env ?? {}
      expect(env.E2E_ONE).toBe('alpha')
      expect(env.E2E_TWO).toBe('a b')
    } finally { await app.dispose() }
  })

  it('never touches the command string', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n')
    const app = await boot(box)
    try {
      const command = 'echo "quoted \'text\'" && ls -la | wc -l'
      app.shell.run(app.shell.resolve({ command }))
      expect(app.shell.last().command).toBe(command)
    } finally { await app.dispose() }
  })

  it('injects nothing when no .envrc governs the workspace', async () => {
    const box = sandbox()
    const app = await boot(box)
    try {
      app.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env).toBeUndefined()
    } finally { await app.dispose() }
  })

  it('injects nothing for an unallowed .envrc, but reports the block actionably', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export SHOULD_NOT_APPEAR=1\n', false)
    const app = await boot(box)
    try {
      const result = await app.ctx.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env).toBeUndefined()
      expect(result.stderr.text).toContain('[dsh-direnv]')
      expect(result.stderr.text).toContain('direnv_allow')
      expect(result.stderr.text).toContain(join(box.workspace, '.envrc'))
      expect(result.stderr.text).not.toContain('SHOULD_NOT_APPEAR=1')
    } finally { await app.dispose() }
  })

  it('stays silent about a block when notifyOnBlocked is off', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n', false)
    const app = await boot(box, { notifyOnBlocked: false })
    try {
      const result = await app.ctx.shell.run(app.shell.resolve({ command: 'true' }))
      expect(result.stderr.text).toBe('')
    } finally { await app.dispose() }
  })

  it('drops a forged DSH_* namespace exported by an allowed .envrc', async () => {
    const box = sandbox()
    writeRc(box, '.', [
      'export DSH_HOME=/evil',
      'export DSH_SESSION_ID=forged-session',
      'export DSH_BACKDOOR=1',
      'export LEGITIMATE=kept',
      '',
    ].join('\n'))
    const app = await boot(box)
    try {
      app.shell.run(app.shell.resolve({ command: 'true' }))
      const env = app.shell.last().env ?? {}
      expect(env.LEGITIMATE).toBe('kept')
      expect('DSH_HOME' in env).toBe(false)
      expect('DSH_SESSION_ID' in env).toBe(false)
      expect('DSH_BACKDOOR' in env).toBe(false)
    } finally { await app.dispose() }
  })

  it('drops DIRENV_* bookkeeping variables', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export KEPT=v\n')
    const app = await boot(box)
    try {
      app.shell.run(app.shell.resolve({ command: 'true' }))
      const env = app.shell.last().env ?? {}
      expect(env.KEPT).toBe('v')
      for (const name of Object.keys(env)) expect(name.startsWith('DIRENV_')).toBe(false)
    } finally { await app.dispose() }
  })

  it('lets direnv extend PATH and unset a variable', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export PATH="$PATH:/opt/e2e/bin"\nunset E2E_REMOVE\n')
    const app = await boot(box)
    try {
      app.shell.run(app.shell.resolve({ command: 'true' }))
      const env = app.shell.last().env ?? {}
      expect(env.PATH?.endsWith('/opt/e2e/bin')).toBe(true)
      expect('E2E_REMOVE' in env).toBe(false)
    } finally { await app.dispose() }
  })

  it('re-blocks after content changes, and unblocks after a new allow', async () => {
    const box = sandbox()
    const rc = writeRc(box, '.', 'export V=v1\n')
    const app = await boot(box)
    try {
      app.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env?.V).toBe('v1')
      writeFileSync(rc, 'export V=v2\n')
      const blocked = await app.ctx.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env).toBeUndefined()
      expect(blocked.stderr.text).toContain('[dsh-direnv]')
      allowWithRealDirenv(box, rc)
      app.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env?.V).toBe('v2')
    } finally { await app.dispose() }
  })

  it('gives a nested package its own .envrc, like native direnv', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export ROOT_VAR=root\n')
    writeRc(box, 'packages/api', 'export PKG_VAR=api\n')
    const app = await boot(box)
    try {
      const nested = join(box.workspace, 'packages', 'api')
      app.shell.run(app.shell.resolve({ command: 'true', workdir: nested }))
      const nestedEnv = app.shell.last().env ?? {}
      expect(nestedEnv.PKG_VAR).toBe('api')
      expect('ROOT_VAR' in nestedEnv).toBe(false)
      app.shell.run(app.shell.resolve({ command: 'true' }))
      const rootEnv = app.shell.last().env ?? {}
      expect(rootEnv.ROOT_VAR).toBe('root')
      expect('PKG_VAR' in rootEnv).toBe(false)
    } finally { await app.dispose() }
  })

  it('uses only the workspace root when followWorkdir is off', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export ROOT_VAR=root\n')
    writeRc(box, 'packages/api', 'export PKG_VAR=api\n')
    const app = await boot(box, { followWorkdir: false })
    try {
      app.shell.run(app.shell.resolve({ command: 'true', workdir: join(box.workspace, 'packages', 'api') }))
      const env = app.shell.last().env ?? {}
      expect(env.ROOT_VAR).toBe('root')
      expect('PKG_VAR' in env).toBe(false)
    } finally { await app.dispose() }
  })

  it('does not inject for an agentless call', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n')
    const app = await boot(box)
    try {
      currentAgent = undefined
      app.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env).toBeUndefined()
    } finally { await app.dispose() }
  })

  it('does not inject when the agent has no usable cwd', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n')
    const app = await boot(box)
    try {
      currentAgent = { session: { header: {} } }
      app.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env).toBeUndefined()
    } finally { await app.dispose() }
  })

  it('does not inject when disabled', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n')
    const app = await boot(box, { enabled: false })
    try {
      app.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env).toBeUndefined()
    } finally { await app.dispose() }
  })

  it('keeps an explicit caller env winning over direnv', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export CONTESTED=from-direnv\nexport ONLY_DIRENV=d\n')
    const app = await boot(box)
    try {
      app.shell.run(app.shell.resolve({ command: 'true', env: { CONTESTED: 'from-caller' } }))
      const env = app.shell.last().env ?? {}
      expect(env.CONTESTED).toBe('from-caller')
      expect(env.ONLY_DIRENV).toBe('d')
    } finally { await app.dispose() }
  })

  it('stops injecting after the .envrc is deleted', async () => {
    const box = sandbox()
    const rc = writeRc(box, '.', 'export X=1\n')
    const app = await boot(box)
    try {
      app.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env?.X).toBe('1')
      rmSync(rc)
      app.shell.run(app.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env).toBeUndefined()
    } finally { await app.dispose() }
  })

  it('treats an empty allowed .envrc as no injection and no notice', async () => {
    const box = sandbox()
    writeRc(box, '.', '')
    const app = await boot(box)
    try {
      const result = await app.ctx.shell.run(app.shell.resolve({ command: 'true' }))
      expect(Object.keys(app.shell.last().env ?? {})).toHaveLength(0)
      expect(result.stderr.text).not.toContain('[dsh-direnv]')
    } finally { await app.dispose() }
  })

  it('appends nothing to a healthy background process', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n')
    const app = await boot(box)
    try {
      const proc = app.ctx.shell.start(app.shell.resolve({ command: 'true' }))
      expect(proc.readOutput().delta).toBe('')
      expect(app.shell.last().env?.X).toBe('1')
    } finally { await app.dispose() }
  })

  it('appends the notice to the first background read only', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n', false)
    const app = await boot(box)
    try {
      const proc = app.ctx.shell.start(app.shell.resolve({ command: 'true' }))
      expect(proc.readOutput().delta).toContain('[dsh-direnv]')
      expect(proc.readOutput().delta).not.toContain('[dsh-direnv]')
    } finally { await app.dispose() }
  })

  it('reports an unparseable direnv response as an error instead of injecting', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n')
    const probe = () => ({ code: 0, signal: null, stdout: 'not json', stderr: '', timedOut: false, spawnFailed: false })
    const app = await boot(box, {}, probe as never)
    try {
      const result = await app.ctx.shell.run(app.ctx.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env).toBeUndefined()
      expect(result.stderr.text).toContain('[dsh-direnv]')
    } finally {
      await app.dispose()
    }
  })

  it('reports a direnv timeout as an error instead of injecting', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n')
    const probe = () => ({ code: null, signal: 'SIGKILL' as const, stdout: '', stderr: '', timedOut: true, spawnFailed: false })
    const app = await boot(box, {}, probe as never)
    try {
      const result = await app.ctx.shell.run(app.ctx.shell.resolve({ command: 'true' }))
      expect(app.shell.last().env).toBeUndefined()
      expect(result.stderr.text).toContain('timed out')
    } finally {
      await app.dispose()
    }
  })

  it('reports a missing direnv executable as an error instead of injecting', async () => {
    const box = sandbox()
    writeRc(box, '.', 'export X=1\n')
    const app = await boot(box, { executable: '/nonexistent/direnv' }, undefined)
    // With the real runner, the missing executable is what produces the error.
    const app2 = await boot(box, { executable: '/nonexistent/direnv' })
    void app
    try {
      const result = await app2.ctx.shell.run(app2.ctx.shell.resolve({ command: 'true' }))
      expect(app2.shell.last().env).toBeUndefined()
      expect(result.stderr.text).toContain('could not be started')
    } finally {
      await app2.dispose()
      await app.dispose()
    }
  })
})
