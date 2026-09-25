/**
 * Pure direnv projections for the dsh-direnv plugin.
 *
 * This module is framework-free and side-effect free: it validates inputs,
 * interprets one `direnv export json` run, filters the resulting diff into a
 * safe environment map, and locates the `.envrc` that governs a workspace.
 * No shell string is ever built and no command is ever wrapped — the plugin
 * injects an environment MAP, so nothing model- or workspace-controlled ever
 * reaches a command line.
 *
 * @module dsh-direnv/core
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
// resolvePath is used by the deny-store hash, which mirrors direnv's own.
import { dirname, isAbsolute, join, parse, resolve as resolvePath } from 'node:path'
import { realpathSync } from 'node:fs'

/** Environment variable names this plugin is willing to inject. */
export const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The harness-managed namespace. A workspace `.envrc` must never be able to
 * supply a `DSH_*` fact: the managed snapshot is authoritative, and an
 * unmanaged `DSH_*` name would otherwise read as a harness fact to the model.
 * Every such name is dropped from the injected diff.
 */
export const MANAGED_ENV_PREFIX = 'DSH_'

/** The config file names native direnv looks for, nearest-first. */
export const RC_NAMES = ['.envrc', '.env'] as const

/** Config of the dsh-direnv plugin, validated strictly. */
export interface DirenvConfig {
  /** The direnv executable: a bare PATH name or an absolute path. */
  executable: string
  /** Whether workspace environment injection is active. */
  enabled: boolean
  /**
   * Wall-clock budget for one `direnv export json` run, in milliseconds.
   * Exceeding it kills direnv and the command runs without injection.
   */
  probeTimeoutMs: number
  /**
   * Whether a blocked `.envrc` makes the shell result carry an actionable
   * notice. Disabling it keeps results byte-identical to the un-injected run.
   */
  notifyOnBlocked: boolean
  /**
   * Whether `direnv_allow` may only approve a file inside the calling agent's
   * own workspace root. Turn off only when the model is trusted to request
   * arbitrary paths.
   */
  restrictAllowToWorkspace: boolean
  /**
   * Whether a command's own working directory selects the `.envrc`, matching
   * native direnv. On, a command run in `<workspace>/packages/api` picks up
   * that package's `.envrc` rather than the repository root's, which is what
   * direnv itself would do. Off, every command in a session uses exactly the
   * session workspace root, which costs one probe per session instead of one
   * per distinct directory.
   */
  followWorkdir: boolean
  /**
   * Whether to resolve each directory once and reuse the result.
   *
   * On, the first command in a directory pays for one `direnv export` and every
   * later command reads the cache. The cache is invalidated automatically when
   * the `.envrc` changes or when direnv's allow/deny store is rewritten
   * (including by a `direnv allow` run outside this harness), and on demand by
   * the `direnv_reload` tool. Off, every command pays the probe — roughly 35 ms
   * for an allowed `.envrc` — and no cache exists to reason about.
   */
  cache: boolean
  /** Maximum `.envrc` bytes shown to the user in the approval prompt. */
  previewBytes: number
}

/** The plan's defaults. */
export const defaultConfig: DirenvConfig = {
  executable: 'direnv',
  enabled: true,
  probeTimeoutMs: 10_000,
  notifyOnBlocked: true,
  restrictAllowToWorkspace: true,
  followWorkdir: true,
  cache: true,
  previewBytes: 2_048,
}

/** Why a workspace produced no injectable environment. */
export type DirenvStatusKind = 'injected' | 'no-rc' | 'blocked' | 'denied' | 'error' | 'disabled'

/** One workspace's resolved direnv state. */
export interface DirenvStatus {
  kind: DirenvStatusKind
  /** The `.envrc`/`.env` that governs the workspace, when one was found. */
  rcPath?: string
  /**
   * Variables to inject, already filtered; never contains a `DSH_*` name.
   * A `undefined` value means "remove this name from the child environment",
   * which is what a `.envrc`'s `unset` compiles to.
   */
  env: InjectableEnv
  /** Names dropped from the diff because they are unsafe to inject. */
  dropped: string[]
  /** A bounded, log-safe explanation; never contains an environment value. */
  detail?: string
}

function assertNonEmpty(value: string, what: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`dsh-direnv: ${what} must be a non-empty string`)
}

function assertNoNul(value: string, what: string): void {
  if (value.includes('\0')) throw new TypeError(`dsh-direnv: ${what} must not contain a NUL byte`)
}

/** Validate the semantic config invariants the schema cannot express. */
export function assertDirenvConfig(config: DirenvConfig): void {
  assertNonEmpty(config.executable, 'config.executable')
  assertNoNul(config.executable, 'config.executable')
  if (!Number.isInteger(config.probeTimeoutMs) || config.probeTimeoutMs <= 0) {
    throw new TypeError('dsh-direnv: config.probeTimeoutMs must be a positive integer')
  }
  if (!Number.isInteger(config.previewBytes) || config.previewBytes < 0) {
    throw new TypeError('dsh-direnv: config.previewBytes must be a non-negative integer')
  }
}

/** An absolute directory this plugin may probe. */
export function assertWorkspace(workspace: string): void {
  assertNonEmpty(workspace, 'workspace')
  assertNoNul(workspace, 'workspace')
  if (!isAbsolute(workspace)) throw new TypeError(`dsh-direnv: workspace must be an absolute path: ${workspace}`)
}

/**
 * Walk from `workspace` to the filesystem root and return the nearest
 * `.envrc`/`.env`, matching native direnv's own search order. Returns
 * `undefined` when no file governs the directory.
 */
export function findRcPath(workspace: string): string | undefined {
  assertWorkspace(workspace)
  let dir = workspace
  const root = parse(dir).root
  for (;;) {
    for (const name of RC_NAMES) {
      const candidate = join(dir, name)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Absent or unreadable: keep walking, exactly as direnv does.
      }
    }
    if (dir === root) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * A cheap identity for everything that can change what `direnv export` returns
 * for one directory:
 *
 * - the governing RC file (path, size, mtime) — an edit invalidates direnv's
 *   own content hash, so a new probe is mandatory;
 * - direnv's allow and deny stores (directory mtimes) — a `direnv allow` or
 *   `direnv deny` run OUTSIDE this harness changes neither the file nor its
 *   mtime, but it does rewrite one of those stores.
 *
 * The store paths follow direnv's own XDG layout so no direnv process is
 * needed to compute this. A missing entry contributes only its resolved path,
 * so the transition from "absent" to "present" changes the stamp.
 */
export function cacheStamp(rcPath: string | undefined, env: NodeJS.ProcessEnv | undefined = process.env): string {
  const parts: string[] = [rcPath ?? '-']
  if (rcPath !== undefined) {
    try {
      const stat = statSync(rcPath)
      parts.push(`${String(stat.size)}:${String(stat.mtimeMs)}`)
    } catch {
      parts.push('missing')
    }
  }
  const dataHome = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : env.HOME !== undefined && env.HOME.length > 0
      ? join(env.HOME, '.local', 'share')
      : undefined
  if (dataHome !== undefined) {
    for (const store of ['allow', 'deny']) {
      const dir = join(dataHome, 'direnv', store)
      try {
        parts.push(`${dir}:${String(statSync(dir).mtimeMs)}`)
      } catch {
        parts.push(`${dir}:absent`)
      }
    }
  }
  return parts.join('|')
}

/** Whether `path` names an existing directory. */
export function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** One bounded, hash-stable view of the file a user is asked to approve. */
export interface RcPreview {
  path: string
  /** Lowercase hex SHA-256 of the full file bytes. */
  sha256: string
  /** Total file size in bytes. */
  bytes: number
  /** The leading bytes, decoded as UTF-8, bounded by the configured budget. */
  text: string
  /** True when `text` is shorter than the file. */
  truncated: boolean
}

/**
 * Read a bounded preview of one RC file. Never throws for a missing file —
 * callers turn that into a refusal — and never reads more than `maxBytes`
 * beyond the hash pass.
 */
export function previewRc(rcPath: string, maxBytes: number): RcPreview {
  assertNonEmpty(rcPath, 'rcPath')
  const stat = statSync(rcPath)
  if (!stat.isFile()) throw new TypeError(`dsh-direnv: not a regular file: ${rcPath}`)
  const fd = openSync(rcPath, 'r')
  try {
    const hash = createHash('sha256')
    const head = Buffer.alloc(Math.max(0, maxBytes))
    let headBytes = 0
    const chunk = Buffer.alloc(64 * 1024)
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read <= 0) break
      hash.update(chunk.subarray(0, read))
      if (headBytes < head.length) {
        const take = Math.min(head.length - headBytes, read)
        chunk.copy(head, headBytes, 0, take)
        headBytes += take
      }
    }
    return {
      path: rcPath,
      sha256: hash.digest('hex'),
      bytes: stat.size,
      text: head.subarray(0, headBytes).toString('utf8'),
      truncated: stat.size > headBytes,
    }
  } finally {
    closeSync(fd)
  }
}

/** The outcome of one `direnv export json` child. */
export interface ExportRun {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** True when the probe budget elapsed and the child was killed. */
  timedOut: boolean
  /** True when the executable could not be started at all. */
  spawnFailed: boolean
}

/** The config one probe runs under, including the environment it inherits. */
export interface ExportConfig extends DirenvConfig {
  /** Environment for the direnv child; defaults to the harness process's own. */
  env?: NodeJS.ProcessEnv
}

/** Injectable probe seam so activation and status are testable without a host. */
export type ExportRunner = (workspace: string, config: ExportConfig) => ExportRun

/**
 * Run `direnv export json` in `workspace`. `shell` is never used: the argv is
 * fixed and the directory travels as `cwd`, so no workspace-controlled byte
 * ever reaches a command line. `export json` prints only the DIFF direnv would
 * apply, which is exactly the injection this plugin performs.
 */
export const runExport: ExportRunner = (workspace, config: ExportConfig) => {
  assertWorkspace(workspace)
  const result = spawnSync(config.executable, ['export', 'json'], {
    cwd: workspace,
    env: config.env ?? process.env,
    timeout: config.probeTimeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
    spawnFailed: result.error !== undefined && (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT',
  }
}

/** One parsed diff entry: a value to set, or `null` meaning "unset me". */
export type DiffEntry = string | null

/**
 * An environment map for one execution.
 *
 * The shell seam's declared type is `Record<string, string>`, but the
 * subprocess layer that consumes it removes every entry whose value is
 * `undefined` from the child environment. That is the only way to express a
 * real `unset` — which a `.envrc` can ask for — so the value type is widened
 * here and narrowed again at the seam boundary.
 */
export type InjectableEnv = Record<string, string | undefined>

/**
 * Parse one `direnv export json` stdout into a diff. Returns `undefined` for
 * output that is not a JSON object of strings-or-null, so a malformed response
 * degrades to "no injection" instead of injecting garbage.
 */
export function parseExport(stdout: string): Record<string, DiffEntry> | undefined {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const diff: Record<string, DiffEntry> = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null) diff[name] = null
    else if (typeof value === 'string') diff[name] = value
    else return undefined
  }
  return diff
}

/**
 * Filter one diff into the injectable map.
 *
 * Dropped: every `DSH_*` name (the managed snapshot is authoritative and must
 * never be forgeable from a workspace), every name that is not a portable
 * environment identifier, and every `DIRENV_*` bookkeeping variable (it
 * describes a shell hook this plugin does not run, and a stale `DIRENV_DIR`
 * would mislead tools that read it).
 */
export function selectInjectable(diff: Record<string, DiffEntry>): {
  env: InjectableEnv
  dropped: string[]
} {
  const env: InjectableEnv = {}
  const dropped: string[] = []
  for (const [name, value] of Object.entries(diff)) {
    if (!SAFE_ENV_NAME.test(name) || name.startsWith(MANAGED_ENV_PREFIX) || name.startsWith('DIRENV_')) {
      dropped.push(name)
      continue
    }
    // `null` is direnv saying "this name must not be set". Omitting the name
    // would be wrong: the executor merges this map onto the credential-scrubbed
    // parent environment, so an absent name keeps whatever the parent had and
    // `unset FOO` in a .envrc would silently do nothing. `undefined` is the
    // subprocess seam's removal convention — it filters those entries out of
    // the target environment, so the child genuinely does not have the name.
    if (value === null) {
      env[name] = undefined
      continue
    }
    if (value.includes('\0')) {
      dropped.push(name)
      continue
    }
    env[name] = value
  }
  return { env, dropped }
}

/** Recognize direnv's own refusal text without pinning ANSI or wording. */
export function looksBlocked(stderr: string): boolean {
  return /is blocked|blocked\. Run/i.test(stderr)
}

/**
 * The directory holding direnv's authorization stores, following direnv's own
 * XDG layout (`$XDG_DATA_HOME/direnv`, else `$HOME/.local/share/direnv`).
 * Returns `undefined` when neither variable is set, in which case the caller
 * must not claim to know direnv's authorization state.
 */
export function direnvStoreDir(env: NodeJS.ProcessEnv | undefined = process.env): string | undefined {
  const dataHome = env?.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : env?.HOME !== undefined && env.HOME.length > 0
      ? join(env.HOME, '.local', 'share')
      : undefined
  return dataHome === undefined ? undefined : join(dataHome, 'direnv')
}

/**
 * Whether direnv has recorded a DENY for this exact file.
 *
 * A denied `.envrc` is indistinguishable from an empty one by its export
 * output — direnv exits zero and applies nothing in both cases — so the deny
 * store is the only authoritative signal. The file name is direnv's own
 * `pathHash`: sha256 of the absolute path plus a newline.
 */
export function isDenied(rcPath: string, env: NodeJS.ProcessEnv | undefined = process.env): boolean {
  const store = direnvStoreDir(env)
  if (store === undefined) return false
  const hash = createHash('sha256').update(`${resolvePath(rcPath)}\n`).digest('hex')
  try {
    return statSync(join(store, 'deny', hash)).isFile()
  } catch {
    return false
  }
}

/**
 * Whether a diff carries any entry direnv itself produced.
 *
 * `direnv export json` always emits its own `DIRENV_*` bookkeeping keys, even
 * for a denied or empty RC, so "did direnv apply anything" must be asked of the
 * remaining names rather than of the raw object.
 */
export function hasAppliedEntries(diff: Record<string, DiffEntry>): boolean {
  return Object.keys(diff).some((name) => !name.startsWith('DIRENV_'))
}

/** Injectable seam: the export runner, the RC locator, and the child environment. */
export interface DirenvRuntime {
  runExport?: ExportRunner
  findRcPath?: (workspace: string) => string | undefined
  /**
   * The environment every direnv child runs under, and the one that decides
   * which allow/deny store a cache stamp describes.
   *
   * Both must come from here rather than from `process.env` independently:
   * `direnv export` resolves its store from `XDG_DATA_HOME`/`HOME`, so a stamp
   * computed against a different environment would describe a store the probe
   * never consulted, and an external `direnv allow` would go unnoticed.
   */
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve one workspace's direnv state: locate the governing `.envrc`, ask
 * native direnv for the diff, and project it into an injectable map. Native
 * direnv owns authorization — a file that was never allowed, or whose content
 * changed since it was allowed, is refused by direnv itself and this function
 * reports `blocked` without ever evaluating the file.
 */
export function resolveStatus(
  workspace: string,
  config: ExportConfig,
  runtime: DirenvRuntime = {},
): DirenvStatus {
  if (!config.enabled) return { kind: 'disabled', env: {}, dropped: [] }
  const find = runtime.findRcPath ?? findRcPath
  const rcPath = find(workspace)
  const run = (runtime.runExport ?? runExport)(workspace, config)

  if (run.spawnFailed) {
    return { kind: 'error', env: {}, dropped: [], detail: 'direnv could not be started' }
  }
  if (run.timedOut) {
    return {
      kind: 'error',
      env: {},
      dropped: [],
      ...rcPath === undefined ? {} : { rcPath },
      detail: `direnv export timed out after ${config.probeTimeoutMs} ms`,
    }
  }
  if (run.code !== 0) {
    const blocked = looksBlocked(run.stderr)
    return {
      kind: blocked ? 'blocked' : 'error',
      env: {},
      dropped: [],
      ...rcPath === undefined ? {} : { rcPath },
      detail: blocked
        ? 'the workspace .envrc is not approved; native direnv refused to load it'
        : `direnv export exited with code ${String(run.code)}`,
    }
  }

  const diff = parseExport(run.stdout)
  if (diff === undefined) {
    return {
      kind: 'error',
      env: {},
      dropped: [],
      ...rcPath === undefined ? {} : { rcPath },
      detail: 'direnv export produced output this plugin could not parse',
    }
  }
  const { env, dropped } = selectInjectable(diff)
  if (rcPath === undefined) {
    // No RC anywhere: nothing governs this directory and there is nothing to allow.
    return { kind: 'no-rc', env, dropped }
  }
  if (Object.keys(env).length === 0 && !hasAppliedEntries(diff)) {
    // An RC exists, direnv exited zero, yet it applied nothing. That is either
    // a denied file (direnv >= 2.33 revokes silently) or a legitimately empty
    // one; only the deny store distinguishes them, so an empty .envrc is
    // reported as "nothing to inject" rather than as an error the user must act
    // on. `unset`-only diffs are non-empty here and therefore still inject.
    if (!isDenied(rcPath, config.env)) {
      return { kind: 'no-rc', rcPath, env, dropped }
    }
    return {
      kind: 'denied',
      rcPath,
      env,
      dropped,
      detail: 'this .envrc is denied; re-approve it to load its environment',
    }
  }
  return { kind: 'injected', rcPath, env, dropped }
}

/** A short, log-safe one-line summary of a status; never carries env values. */
export function describeStatus(status: DirenvStatus): string {
  const where = status.rcPath === undefined ? '' : ` (${status.rcPath})`
  switch (status.kind) {
    case 'injected': return `direnv injected ${Object.keys(status.env).length} variable(s)${where}`
    case 'no-rc': return 'no .envrc governs this workspace'
    case 'blocked': return `the workspace .envrc is blocked${where}`
    case 'denied': return `the workspace .envrc is denied${where}`
    case 'error': return status.detail ?? 'direnv could not be consulted'
    case 'disabled': return 'direnv injection is disabled'
  }
}

/**
 * The actionable notice appended to a shell result when a workspace cannot be
 * injected. It names the exact file and the exact tool call, so the model's
 * next action is unambiguous.
 */
export function blockedNotice(status: DirenvStatus, workspace: string): string | undefined {
  const rc = status.rcPath
  if (status.kind === 'blocked') {
    const target = rc === undefined ? 'the workspace .envrc' : rc
    return [
      '',
      '[dsh-direnv] This command ran WITHOUT the workspace direnv environment.',
      `[dsh-direnv] ${target} is not approved, so native direnv refused to load it.`,
      '[dsh-direnv] Call the direnv_allow tool with this path to ask the user to approve it:',
      `[dsh-direnv]   direnv_allow path=${target}`,
      `[dsh-direnv] Workspace: ${workspace}`,
      '',
    ].join('\n')
  }
  if (status.kind === 'denied') {
    const target = rc === undefined ? 'the workspace .envrc' : rc
    return [
      '',
      '[dsh-direnv] This command ran WITHOUT the workspace direnv environment.',
      `[dsh-direnv] ${target} exists but direnv applied nothing: it is denied, or the file exports nothing.`,
      '[dsh-direnv] Ask the user to check it with: direnv status',
      '',
    ].join('\n')
  }
  if (status.kind === 'error') {
    return [
      '',
      '[dsh-direnv] This command ran WITHOUT the workspace direnv environment.',
      `[dsh-direnv] ${status.detail ?? 'direnv could not be consulted.'}`,
      '',
    ].join('\n')
  }
  return undefined
}

/**
 * Canonicalize a path for containment checks: resolve symlinks when the path
 * exists, and fall back to lexical normalization when it does not.
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}

/**
 * Whether `child` is inside `root` (or is `root`).
 *
 * Both sides are canonicalized first, so neither a `..` segment nor a symlink
 * can smuggle a path out of the workspace: a textual prefix check alone would
 * accept `/ws/../elsewhere/.envrc` and a symlinked `.envrc` pointing outside.
 */
export function isWithin(root: string, child: string): boolean {
  assertWorkspace(root)
  assertWorkspace(child)
  const realRoot = canonicalize(root)
  const realChild = canonicalize(child)
  if (realChild === realRoot) return true
  return realChild.startsWith(realRoot.endsWith('/') ? realRoot : `${realRoot}/`)
}

/**
 * Validate that `rcPath` is an approvable direnv file. Returns the refusal
 * reason, or `undefined` when the path is acceptable. Deliberately narrow: an
 * absolute path to an existing regular file whose basename is a native direnv
 * RC name.
 */
export function refuseAllow(rcPath: string, workspace: string | undefined, restrict: boolean): string | undefined {
  if (typeof rcPath !== 'string' || rcPath.length === 0) return 'path must be a non-empty string'
  if (rcPath.includes('\0')) return 'path must not contain a NUL byte'
  if (!isAbsolute(rcPath)) return `path must be absolute: ${rcPath}`
  const base = rcPath.slice(rcPath.lastIndexOf('/') + 1)
  if (!(RC_NAMES as readonly string[]).includes(base)) {
    return `path must name one of ${RC_NAMES.join(', ')}: ${rcPath}`
  }
  let stat
  try {
    stat = statSync(rcPath)
  } catch {
    return `file does not exist: ${rcPath}`
  }
  if (!stat.isFile()) return `not a regular file: ${rcPath}`
  if (restrict) {
    if (workspace === undefined) return 'this call has no workspace, so an absolute path cannot be approved'
    if (!isWithin(workspace, rcPath)) {
      return `path is outside the calling workspace (${workspace}): ${rcPath}`
    }
  }
  return undefined
}
