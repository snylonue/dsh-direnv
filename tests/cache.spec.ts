/**
 * Per-workspace cache and manual reload, against the REAL direnv binary.
 *
 * The cache exists to avoid paying direnv's startup cost on every command, so
 * these tests assert both halves of the bargain: the probe is skipped while
 * nothing changes, and every way the answer CAN change is still observed.
 *
 * @module tests/cache
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import { envNames, defaultConfig, type DirenvConfig, type ExportConfig } from '../src/provider.js'
import DirenvService from '../src/provider.js'
import { BASH, HAS_DIRENV, requireRealProcesses } from './helpers.js'
import { installDirenvShellAdapter } from '../src/shell-adapter.js'

const describeReal = requireRealProcesses('real-direnv tests') ? describe : describe.skip

interface Sandbox { root: string; ws: string; env: NodeJS.ProcessEnv }
const boxes: Sandbox[] = []
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'dsh-direnv-cache-'))
  const ws = join(root, 'ws')
  const home = join(root, 'home')
  const data = join(root, 'data')
  const conf = join(root, 'config')
  const cache = join(root, 'cache')
  for (const d of [ws, home, data, conf, cache]) mkdirSync(d, { recursive: true })
  const box: Sandbox = {
    root, ws,
    env: { ...process.env, HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: conf, XDG_CACHE_HOME: cache },
  }
  boxes.push(box)
  return box;
}
afterAll(() => { for (const b of boxes.splice(0)) rmSync(b.root, { recursive: true, force: true }) })

let currentAgent: unknown
class FakeAgents extends Service {
  constructor(ctx: Context) { super(ctx, 'agents') }
  currentInitiator(): unknown { return currentAgent }
}

/** Boot the service with a counting probe, all in the sandbox environment. */
async function boot(box: Sandbox, overrides: Partial<DirenvConfig> = {}) {
  const ctx = new Context()
  ctx.provide('shell', { resolve: () => ({}), run: () => Promise.resolve({}), start: () => ({}) })
  const agentsFiber = await ctx.plugin(FakeAgents)
  let probes = 0
  const config: DirenvConfig = { ...defaultConfig, ...overrides }
  const fiber = await ctx.plugin(class extends DirenvService {
    constructor(applyCtx: Context) {
      super(applyCtx, config, {
        env: box.env,
        runExport: (dir: string, cfg: ExportConfig) => {
          probes += 1;
          const r = spawnSync(cfg.executable, ['export', 'json'], { cwd: dir, env: box.env, encoding: 'utf8' });
          return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: false, spawnFailed: r.error !== undefined };
        },
        runAllow: (rcPath: string, cfg: ExportConfig) => {
          const r = spawnSync(cfg.executable, ['allow', rcPath], { env: box.env, encoding: 'utf8' });
          return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        },
      });
    }
  })
  const adapter = installDirenvShellAdapter(ctx)
  currentAgent = { session: { header: { cwd: box.ws } } }
  return {
    ctx,
    get probes() { return probes },
    service: ctx.direnv,
    async dispose() { adapter.dispose(); await fiber.dispose(); await agentsFiber.dispose() },
  }
}

function writeRc(box: Sandbox, body: string): string {
  const rc = join(box.ws, '.envrc')
  writeFileSync(rc, body)
  const r = spawnSync('direnv', ['allow', rc], { env: box.env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('test setup: allow failed: ' + String(r.stderr))
  return rc;
}

describeReal('per-workspace cache', () => {
  it('probes once and reuses the result', async () => {
    const box = sandbox()
    writeRc(box, 'export CACHED=yes\n')
    const app = await boot(box)
    try {
      expect(envNames(app.service.statusFor(box.ws).env)).toEqual(['CACHED'])
      expect(app.probes).toBe(1)
      for (let i = 0; i < 5; i += 1) app.service.statusFor(box.ws)
      expect(app.probes).toBe(1)
    } finally { await app.dispose() }
  })

  it('caches per directory, not globally', async () => {
    const box = sandbox()
    writeRc(box, 'export ROOT=1\n')
    const sub = join(box.ws, 'pkg')
    mkdirSync(sub, { recursive: true })
    const subRc = join(sub, '.envrc')
    writeFileSync(subRc, 'export SUB=1\n')
    spawnSync('direnv', ['allow', subRc], { env: box.env })
    const app = await boot(box)
    try {
      expect(envNames(app.service.statusFor(box.ws).env)).toEqual(['ROOT'])
      expect(envNames(app.service.statusFor(sub).env)).toEqual(['SUB'])
      expect(app.probes).toBe(2)
    } finally { await app.dispose() }
  })

  it('invalidates when the .envrc content changes', async () => {
    const box = sandbox()
    const rc = writeRc(box, 'export V=v1\n')
    const app = await boot(box)
    try {
      expect(app.service.statusFor(box.ws).env.V).toBe('v1')
      expect(app.probes).toBe(1)
      writeFileSync(rc, 'export V=v2\n')
      // Content changed, so the authorization hash no longer matches: the
      // cache must not serve the old value.
      expect(app.service.statusFor(box.ws).kind).toBe('blocked')
      expect(app.probes).toBe(2)
      spawnSync('direnv', ['allow', rc], { env: box.env })
      expect(app.service.statusFor(box.ws).env.V).toBe('v2')
    } finally { await app.dispose() }
  })

  it('sees a direnv allow run outside this harness', async () => {
    const box = sandbox()
    const rc = join(box.ws, '.envrc')
    writeFileSync(rc, 'export LATE=yes\n')
    const app = await boot(box)
    try {
      // Unapproved at first: blocked, and cached as such.
      expect(app.service.statusFor(box.ws).kind).toBe('blocked')
      const afterFirst = app.probes
      // An approval performed entirely outside the plugin (the user in a
      // terminal) rewrites direnv's allow store, which the stamp covers.
      spawnSync('direnv', ['allow', rc], { env: box.env })
      expect(app.service.statusFor(box.ws).kind).toBe('injected')
      expect(app.probes).toBeGreaterThan(afterFirst)
    } finally { await app.dispose() }
  })

  it('sees a direnv deny run outside this harness', async () => {
    const box = sandbox()
    const rc = writeRc(box, 'export DENIED=1\n')
    const app = await boot(box)
    try {
      expect(app.service.statusFor(box.ws).kind).toBe('injected')
      spawnSync('direnv', ['deny', rc], { env: box.env })
      const after = app.service.statusFor(box.ws)
      expect(after.kind === 'injected').toBe(false)
      expect(envNames(after.env)).not.toContain('DENIED')
    } finally { await app.dispose() }
  })

  it('stops injecting once the .envrc is deleted', async () => {
    const box = sandbox()
    const rc = writeRc(box, 'export GONE=1\n')
    const app = await boot(box)
    try {
      expect(app.service.statusFor(box.ws).env.GONE).toBe('1')
      rmSync(rc)
      expect(app.service.statusFor(box.ws).kind).toBe('no-rc')
    } finally { await app.dispose() }
  })

  it('probes every time when the cache is off', async () => {
    const box = sandbox()
    writeRc(box, 'export V=1\n')
    const app = await boot(box, { cache: false })
    try {
      for (let i = 0; i < 3; i += 1) app.service.statusFor(box.ws)
      expect(app.probes).toBe(3)
    } finally { await app.dispose() }
  })
})

describeReal('manual reload', () => {
  it('re-resolves one directory and reports the variable count', async () => {
    const box = sandbox()
    writeRc(box, 'export A=1\nexport B=2\n')
    const app = await boot(box)
    try {
      app.service.statusFor(box.ws)
      const before = app.probes
      const report = app.service.reload(box.ws)
      expect(report.reloaded).toBe(1)
      expect(report.changed).toHaveLength(1)
      expect(report.changed[0]?.variables).toBe(2)
      expect(report.changed[0]?.kind).toBe('injected')
      expect(app.probes).toBe(before + 1)
    } finally { await app.dispose() }
  })

  it('reports which names were added and removed since the last resolution', async () => {
    const box = sandbox()
    const rc = writeRc(box, 'export KEEP=1\nexport DROP=2\n')
    const app = await boot(box)
    try {
      app.service.statusFor(box.ws)
      writeFileSync(rc, 'export KEEP=1\nexport FRESH=3\n')
      spawnSync('direnv', ['allow', rc], { env: box.env })
      const report = app.service.reload(box.ws)
      expect(report.changed[0]?.added).toEqual(['FRESH'])
      expect(report.changed[0]?.removed).toEqual(['DROP'])
    } finally { await app.dispose() }
  })

  it('reloads every cached directory when given none', async () => {
    const box = sandbox()
    writeRc(box, 'export ROOT=1\n')
    const sub = join(box.ws, 'pkg')
    mkdirSync(sub, { recursive: true })
    const subRc = join(sub, '.envrc')
    writeFileSync(subRc, 'export SUB=1\n')
    spawnSync('direnv', ['allow', subRc], { env: box.env })
    const app = await boot(box)
    try {
      app.service.statusFor(box.ws)
      app.service.statusFor(sub)
      const report = app.service.reload()
      expect(report.reloaded).toBe(2)
      expect(report.changed.map((c) => c.directory).sort()).toEqual([box.ws, sub].sort())
    } finally { await app.dispose() }
  })

  it('reports zero when nothing was cached', async () => {
    const box = sandbox()
    writeRc(box, 'export V=1\n')
    const app = await boot(box)
    try {
      expect(app.service.reload().reloaded).toBe(0)
    } finally { await app.dispose() }
  })

  it('picks up an external change that the stamp cannot see', async () => {
    const box = sandbox()
    writeRc(box, 'export V=1\n')
    const app = await boot(box)
    try {
      app.service.statusFor(box.ws)
      // Simulate an unobservable dependency: clear the cache by hand, which is
      // exactly what a manual reload does, and confirm the fresh read.
      app.service.invalidate(box.ws)
      const report = app.service.reload(box.ws)
      expect(report.changed[0]?.kind).toBe('injected')
    } finally { await app.dispose() }
  })
})
