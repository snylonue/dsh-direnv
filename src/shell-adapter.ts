/**
 * Shell adapter: merges one workspace's native direnv environment into every
 * agent-owned shell call, and tells the model when it could not.
 *
 * Two links are installed on the concrete `ctx.shell` target:
 *
 * - `resolve` computes the workspace environment, merges it into
 *   `request.env`, and tags the returned spec with any "could not inject"
 *   notice;
 * - `execute` looks that notice up by spec and surfaces it to the caller: on
 *   the foreground `result()` stderr, on the consuming `readOutput()` delta,
 *   and on the non-consuming `observed.stderr` reader the job registry pumps
 *   for background output.
 *
 * The notice travels on the spec object itself under an enumerable symbol key,
 * because callers may clone a spec (`{...spec, signal}`, as the bash tool does
 * for background jobs) before handing it to the executor.
 *
 * The adapter never touches `request.command`: injection is an environment
 * MAP, so nothing a workspace controls is ever interpolated into a command
 * line and the command string the model and the UI see is byte-identical to
 * what was requested.
 *
 * Layering is deliberate and matches the executor's own contract
 * (`{...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv}`):
 *
 * - direnv values are placed FIRST, so an explicit `request.env` from a
 *   trusted in-process caller still wins over the workspace;
 * - `DSH_*` names are already excluded by `core.selectInjectable`, so the
 *   managed snapshot merged last can never be displaced by a workspace.
 *
 * A blocked `.envrc` still runs the command — without its environment — and
 * appends an actionable notice naming the exact `direnv_allow` call, so the
 * model's next step is unambiguous instead of silently wrong.
 *
 * @module dsh-direnv/shell-adapter
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecution, ShellProcessRead, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { installChainLink, type ChainHandle } from './method-chain.js'

/** The adapter's disposal boundary. */
export interface DirenvShellAdapterHandle {
  /** Remove every link. Idempotent; safe in any order relative to other links. */
  dispose(): void
}

/** Bound on an appended notice, so a pathological path cannot flood a result. */
const MAX_NOTICE_BYTES = 4_096

/**
 * Spec-borne notice channel. A symbol keeps the executor's string-keyed reads
 * untouched; `enumerable: true` is what lets an object-spread clone carry it.
 */
const NOTICE: unique symbol = Symbol('dsh-direnv.notice')

/**
 * Append one notice to a bounded collected-output record, preserving the
 * registry's shape. Appending never clears an existing truncation flag: the
 * notice is additional information, not a replacement for lost output.
 */
function appendNotice<T extends { text: string; truncated: boolean }>(output: T, notice: string): T {
  const bounded = notice.length > MAX_NOTICE_BYTES ? `${notice.slice(0, MAX_NOTICE_BYTES)}\n[truncated]\n` : notice
  return { ...output, text: `${output.text}${bounded}` }
}

/** Attach a notice to a settled foreground result. */
function noticeResult(result: ShellRunResult, notice: string): ShellRunResult {
  return { ...result, stderr: appendNotice(result.stderr, notice) }
}

/**
 * Wrap one execution handle so a notice reaches each consumer surface: the
 * foreground `result()`, the consuming `readOutput()` cursor, and the
 * non-consuming `observed.stderr` reader the job registry pumps. Each surface
 * emits the notice on its own first read; underlying offsets are never
 * rewritten, so no consumer steals bytes from another.
 *
 * A Proxy (rather than a spread copy) preserves the live handle: `status`,
 * `exitCode`, and `signal` are mutated in place as the process settles, so a
 * snapshot would freeze them at `running`.
 */
function withNotice(execution: ShellExecution, notice: string): ShellExecution {
  let resultEmitted = false
  let readEmitted = false
  let observedEmitted = false
  let resultView: (() => Promise<ShellRunResult>) | undefined
  let readView: (() => ShellProcessRead) | undefined
  let observedView: ShellExecution['observed'] | undefined

  const resultOf = (): Promise<ShellRunResult> =>
    execution.result().then((settled) => {
      if (resultEmitted) return settled
      resultEmitted = true
      return noticeResult(settled, notice)
    })

  const readOf = (): ShellProcessRead => {
    const read = execution.readOutput()
    if (readEmitted) return read
    readEmitted = true
    return { ...read, delta: `${read.delta}${notice}` }
  }

  const observedOf = (): ShellExecution['observed'] => {
    const observed = execution.observed
    return {
      stdout: observed.stdout,
      stderr: {
        readFrom: (fromByte: number) => {
          const read = observed.stderr.readFrom(fromByte)
          if (observedEmitted) return read
          observedEmitted = true
          return { ...read, text: `${read.text}${notice}` }
        },
      },
    }
  }

  return new Proxy(execution, {
    get(target, property, receiver) {
      if (property === 'result') return (resultView ??= resultOf)
      if (property === 'readOutput') return (readView ??= readOf)
      if (property === 'observed') return (observedView ??= observedOf())
      return Reflect.get(target, property, receiver)
    },
  })
}

/**
 * Install the adapter on the concrete `ctx.shell` provider target.
 *
 * Per call the adapter reads `ctx.direnv.enabled`, requires a current
 * initiating agent, resolves that agent's workspace from its session cwd, and
 * injects only when a `.envrc` actually governs the directory. Agentless
 * calls and workspaces with no `.envrc` pass through by reference, so the
 * adapter is completely inert outside an agent turn.
 *
 * @param ctx - composition context whose `shell`, `agents`, and `direnv`
 *   services the links read on every call.
 * @returns the adapter handle.
 */
export function installDirenvShellAdapter(ctx: Context): DirenvShellAdapterHandle {
  /** Notices keyed by the exact spec object `resolve` returned. */
  const notices = new WeakMap<object, string>()

  /** Recall the notice carried by one resolved spec, clone or not. */
  const recall = (spec: unknown): string | undefined => {
    if (typeof spec !== 'object' || spec === null) return undefined
    const tagged = (spec as Record<PropertyKey, unknown>)[NOTICE]
    if (typeof tagged === 'string') return tagged
    return notices.get(spec)
  }

  /**
   * Record a notice against one resolved spec. The WeakMap covers a spec passed
   * by reference; the enumerable symbol property is what survives the
   * object-spread clones callers make before execution.
   */
  const remember = (spec: object, notice: string): void => {
    notices.set(spec, notice)
    try {
      Object.defineProperty(spec, NOTICE, { value: notice, enumerable: true, configurable: true, writable: true })
    } catch {
      /* A frozen spec keeps the WeakMap entry as its only channel. */
    }
  }

  const handles: ChainHandle[] = []

  const resolveLink = installChainLink(ctx.shell, 'resolve', (next, _thisArg, args) => {
    const request = args[0] as ShellExecRequest | undefined
    if (request === undefined || typeof request.command !== 'string') return next()
    if (!ctx.direnv.enabled) return next()

    // currentInitiator() throws once the agents service is disposed; Cordis
    // unload ordering surfaces that error rather than degrading into an
    // un-injected run, which would quietly execute without the workspace env.
    const agent = ctx.agents.currentInitiator()
    if (agent === undefined) return next()
    const workspace = ctx.direnv.workspaceFor(agent)
    if (workspace === undefined) return next()

    // Match native direnv: the command's own directory selects the .envrc, so
    // a monorepo package gets its own environment instead of silently
    // inheriting the repository root's. `probeDirectory` falls back to the
    // workspace whenever workdir is absent, relative, or not a real directory.
    const probeDir = ctx.direnv.probeDirectory(workspace, request.workdir)
    const { env, status, notice } = ctx.direnv.forWorkspace(probeDir)
    if (status.kind === 'no-rc' || status.kind === 'disabled') return next()

    // `undefined` values are the seam's removal convention and must survive the
    // merge, so the map is built loosely and narrowed only at the seam boundary
    // (whose declared type does not model removal).
    const merged: Record<string, string | undefined> = { ...env, ...request.env }
    const nextRequest: ShellExecRequest = {
      ...request,
      ...Object.keys(merged).length === 0 ? {} : { env: merged as Record<string, string> },
    }
    const spec = next(nextRequest, ...args.slice(1))
    if (notice !== undefined && typeof spec === 'object' && spec !== null) remember(spec, notice)
    return spec
  })
  handles.push(resolveLink)

  // Installing the second link can fail (a provider without `execute`). The
  // owner fiber is about to go inactive, so a surviving `resolve` wrapper would
  // fault every later shell call on the dead `ctx.direnv` it reads.
  const executeLink = (() => {
    try {
      return installChainLink(ctx.shell, 'execute', (next, _thisArg, args) => {
        const notice = recall(args[0])
        const outcome = next()
        if (notice === undefined) return outcome
        // `execute` resolves the prepared handle; guard the shape instead of assuming it.
        if (typeof (outcome as Promise<ShellExecution> | undefined)?.then !== 'function') return outcome
        return (outcome as Promise<ShellExecution>).then((execution) => withNotice(execution, notice))
      })
    } catch (error) {
      for (const handle of handles.splice(0).reverse()) handle.dispose()
      throw error
    }
  })()
  handles.push(executeLink)

  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      // Reverse install order, though the chain itself is order-independent.
      for (const handle of handles.splice(0).reverse()) handle.dispose()
    },
  }
}