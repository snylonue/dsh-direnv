/**
 * `direnv` service provider: resolves one workspace's native direnv
 * environment for the shell adapter and owns the approval bookkeeping the
 * `direnv_allow` tool consults.
 *
 * The provider owns strict config validation, a bounded `direnv export json`
 * probe, and workspace resolution from the calling agent's session. It never
 * builds a shell string, never uses `shell: true`, and never mutates
 * `process.env`: direnv's diff is returned as a MAP for the executor to merge
 * into the child environment, so no workspace-controlled byte ever reaches a
 * command line.
 *
 * There is deliberately NO status cache. Native direnv re-evaluates and
 * re-checks its authorization hash on every call; memoizing that result would
 * reintroduce exactly the staleness this design exists to avoid. The probe
 * costs roughly 35 ms for an allowed `.envrc` and a few milliseconds when
 * direnv refuses early.
 *
 * @module dsh-direnv
 */
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import {
  assertDirenvConfig,
  blockedNotice,
  cacheStamp,
  defaultConfig,
  describeStatus,
  findRcPath,
  isExistingDirectory,
  refuseAllow,
  resolveStatus,
  runExport,
  type DirenvConfig,
  type DirenvRuntime,
  type DirenvStatus,
  type ExportConfig,
  type InjectableEnv,
} from './core.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Native direnv environment projections for agent-owned shell calls. */
    direnv: DirenvService
  }
}

export type { DirenvConfig, DirenvStatus, ExportConfig, InjectableEnv } from './core.js'
export { defaultConfig } from './core.js'

/** The variable names in one injectable map, ignoring removal entries. */
export function envNames(env: InjectableEnv): string[] {
  return Object.entries(env).filter(([, value]) => value !== undefined).map(([name]) => name).sort()
}

/** One directory's outcome after a reload. */
export interface ReloadChange {
  /** The directory whose environment was re-resolved. */
  directory: string
  /** The governing RC file, when one was found. */
  rcPath?: string
  /** The resolved state after the reload. */
  kind: DirenvStatus['kind']
  /** How many variables will now be injected. */
  variables: number
  /** Names newly injected, when a previous resolution was available to compare. */
  added?: string[]
  /** Names no longer injected, when a previous resolution was available. */
  removed?: string[]
}

/** What one `reload` call did. */
export interface ReloadReport {
  /** How many directories were re-resolved. */
  reloaded: number
  /** One entry per re-resolved directory. */
  changed: ReloadChange[]
}

/** One `direnv allow` child outcome. */
export interface AllowRun {
  code: number | null
  stdout: string
  stderr: string
}

/** Constructor-only seams for deterministic tests. */
export interface DirenvServiceRuntime extends DirenvRuntime {
  /** Injectable `direnv allow` runner; production spawns the real executable. */
  runAllow?: (rcPath: string, config: ExportConfig) => AllowRun
}

export default class DirenvService extends Service {
  static Config = z.object({
    executable: z.string().default(defaultConfig.executable),
    enabled: z.boolean().default(defaultConfig.enabled),
    probeTimeoutMs: z.natural().min(1).max(600_000).default(defaultConfig.probeTimeoutMs),
    notifyOnBlocked: z.boolean().default(defaultConfig.notifyOnBlocked),
    restrictAllowToWorkspace: z.boolean().default(defaultConfig.restrictAllowToWorkspace),
    followWorkdir: z.boolean().default(defaultConfig.followWorkdir),
    cache: z.boolean().default(defaultConfig.cache),
    previewBytes: z.natural().min(0).max(65_536).default(defaultConfig.previewBytes),
  }) as z<DirenvConfig>

  /**
   * The shell service is required because the value of this plugin is exactly
   * the environment its calls receive; without a shell there is nothing to
   * inject into, so activation fails loudly instead of loading inert.
   */
  static inject = ['shell']

  constructor(
    ctx: Context,
    private readonly config: DirenvConfig = defaultConfig,
    private readonly runtime: DirenvServiceRuntime = {},
  ) {
    super(ctx, 'direnv')
    assertDirenvConfig(config)
  }

  /** Read-only projection of the `enabled` switch, read by the adapters per call. */
  get enabled(): boolean {
    return this.config.enabled
  }

  /** Read-only projection of the resolved config, for adapters and tools. */
  get settings(): Readonly<DirenvConfig> {
    return this.config
  }

  /**
   * Resolve the workspace directory of one agent: its session's recorded
   * absolute cwd. Returns `undefined` for an agent with no usable cwd, which
   * makes every adapter pass its call through untouched.
   */
  workspaceFor(agent: Agent): string | undefined {
    const cwd = agent.session?.header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) return undefined
    return resolvePath(cwd)
  }

  /**
   * The directory whose `.envrc` governs one call: the command's own working
   * directory when `followWorkdir` is on and that directory exists, otherwise
   * the session workspace root. Matching native direnv here is what makes a
   * nested package's `.envrc` work instead of silently applying the root's.
   */
  probeDirectory(workspace: string, workdir: string | undefined): string {
    if (!this.config.followWorkdir) return workspace
    if (workdir === undefined || workdir.length === 0 || !isAbsolute(workdir)) return workspace
    return isExistingDirectory(workdir) ? workdir : workspace
  }

  /**
   * One cached resolution. `stamp` covers the RC file and direnv's own
   * allow/deny stores, so every way the answer can change is observed without
   * running direnv.
   */
  private readonly cache = new Map<string, { status: DirenvStatus; stamp: string }>()

  /**
   * The environment every direnv child inherits. Read from the runtime seam so
   * the probe and the cache stamp can never disagree about which allow/deny
   * store they describe.
   */
  private get direnvEnv(): NodeJS.ProcessEnv {
    return this.runtime.env ?? process.env
  }

  /**
   * The stamp a cache entry for `probeDir` is valid under. Cheap: two stats
   * plus, when an RC governs the directory, one more.
   */
  private stampFor(probeDir: string): string {
    const find = this.runtime.findRcPath ?? findRcPath
    return cacheStamp(find(probeDir), this.direnvEnv)
  }

  /** Resolve one directory's direnv state, consulting the cache when enabled. */
  statusFor(probeDir: string): DirenvStatus {
    if (!this.config.enabled) return { kind: 'disabled', env: {}, dropped: [] }
    const { env, ...runtime } = this.runtime
    const probeConfig: ExportConfig = { ...this.config, ...env === undefined ? {} : { env } }
    const probe = (): DirenvStatus => resolveStatus(probeDir, probeConfig, runtime)
    if (!this.config.cache) return probe()

    const stamp = this.stampFor(probeDir)
    const hit = this.cache.get(probeDir)
    if (hit !== undefined && hit.stamp === stamp) return hit.status
    const status = probe()
    this.cache.set(probeDir, { status, stamp })
    return status
  }

  /**
   * Drop cached resolutions. With a directory, drops just that one; without,
   * drops every workspace. Called after a successful `direnv allow` and by the
   * `direnv_reload` tool.
   */
  invalidate(probeDir?: string): void {
    if (probeDir === undefined) this.cache.clear()
    else this.cache.delete(probeDir)
  }

  /**
   * Re-resolve one directory (or every cached directory) now, bypassing the
   * cache, and report what changed. The stamp is recorded so a following
   * command reuses this result rather than probing again.
   */
  reload(probeDir?: string): ReloadReport {
    // Snapshot the keys first: resolving a directory re-inserts it, and the
    // "reload everything" form must not chase its own insertions.
    const targets = probeDir === undefined ? [...this.cache.keys()] : [probeDir]
    const changed: ReloadChange[] = []
    for (const dir of targets) {
      const before = this.cache.get(dir)?.status
      const beforeNames = before === undefined ? undefined : envNames(before.env)
      this.invalidate(dir)
      const after = this.statusFor(dir)
      const afterNames = envNames(after.env)
      changed.push({
        directory: dir,
        kind: after.kind,
        variables: afterNames.length,
        ...after.rcPath === undefined ? {} : { rcPath: after.rcPath },
        ...beforeNames === undefined
          ? {}
          : {
              added: afterNames.filter((name) => !beforeNames.includes(name)),
              removed: beforeNames.filter((name) => !afterNames.includes(name)),
            },
      })
    }
    return { reloaded: targets.length, changed }
  }

  /**
   * The environment to merge into one shell call, plus the actionable notice
   * to append when the workspace could not be injected.
   */
  forWorkspace(workspace: string): { env: InjectableEnv; status: DirenvStatus; notice?: string } {
    const status = this.statusFor(workspace)
    const notice = this.config.notifyOnBlocked ? blockedNotice(status, workspace) : undefined
    return {
      env: status.env,
      status,
      ...notice === undefined ? {} : { notice },
    }
  }

  /** A log-safe one-line description of one workspace's state. */
  describe(workspace: string): string {
    return describeStatus(this.statusFor(workspace))
  }

  /** The refusal reason for approving `rcPath` on behalf of `workspace`. */
  refusalFor(rcPath: string, workspace: string | undefined): string | undefined {
    return refuseAllow(rcPath, workspace, this.config.restrictAllowToWorkspace)
  }

  /**
   * Approve one RC file by running the host's own `direnv allow`, which
   * authorizes the CURRENT file content. The caller is responsible for having
   * obtained explicit user consent first; this method only performs the
   * approval and reports direnv's own verdict.
   */
  approve(rcPath: string, workspace: string | undefined): { ok: true } | { ok: false; reason: string } {
    const refusal = this.refusalFor(rcPath, workspace)
    if (refusal !== undefined) return { ok: false, reason: refusal }
    const run = this.runtime.runAllow ?? runAllow
    const result = run(rcPath, { ...this.config, env: this.direnvEnv })
    if (result.code !== 0) {
      const detail = firstLine(result.stderr)
      return {
        ok: false,
        reason: `direnv allow exited with code ${String(result.code)}${detail.length === 0 ? '' : `: ${detail}`}`,
      }
    }
    // The approval just changed direnv's authorization, so every cached answer
    // that depended on it is stale. The cache is keyed by the directory that was
    // probed, and with `followWorkdir` on that is the RC's own directory rather
    // than the session workspace, so drop both.
    this.invalidate(dirnameOf(rcPath))
    this.invalidate(workspace)
    return { ok: true }
  }
}

/**
 * The directory that owns an RC file, which is the key a probe of that RC is
 * cached under.
 * @param rcPath - absolute path of a `.envrc`.
 * @returns its directory.
 */
function dirnameOf(rcPath: string): string {
  return dirname(resolvePath(rcPath))
}

/** The first non-empty line of a diagnostic, ANSI-stripped and bounded. */
export function firstLine(text: string): string {
  const line = text
    .replace(/\u001B\[[0-9;]*m/g, '')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? ''
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

/** Run `direnv allow <rcPath>` with a fixed argv and no shell. */
export function runAllow(rcPath: string, config: ExportConfig): AllowRun {
  const result = spawnSync(config.executable, ['allow', rcPath], {
    env: config.env ?? process.env,
    timeout: config.probeTimeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
