/**
 * Shell adapter: merges one workspace's native direnv environment into every
 * agent-owned shell call, and tells the model when it could not.
 *
 * Three links are installed on the concrete `ctx.shell` target:
 *
 * - `resolve` computes the workspace environment and merges it into
 *   `request.env`, recording any "could not inject" notice against the exact
 *   spec object it returns;
 * - `run` and `start` look that notice up by spec identity and append it to
 *   the command's stderr, which is where the model reads diagnostics.
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
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { installChainLink, type ChainHandle } from './method-chain.js'

/** The adapter's disposal boundary. */
export interface DirenvShellAdapterHandle {
  /** Remove every link. Idempotent; safe in any order relative to other links. */
  dispose(): void
}

/** Bound on an appended notice, so a pathological path cannot flood a result. */
const MAX_NOTICE_BYTES = 4_096

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
    if (notice !== undefined && typeof spec === 'object' && spec !== null) notices.set(spec, notice)
    return spec
  })

  const runLink = installChainLink(ctx.shell, 'run', (next, _thisArg, args) => {
    const spec = args[0] as ShellExecSpec | undefined
    const notice = spec === undefined ? undefined : notices.get(spec)
    const outcome = next()
    if (notice === undefined) return outcome
    // `run` is async on every provider; guard the shape instead of assuming it.
    if (typeof (outcome as Promise<ShellRunResult>)?.then === 'function') {
      return (outcome as Promise<ShellRunResult>).then((result) => noticeResult(result, notice))
    }
    return noticeResult(outcome as ShellRunResult, notice)
  })

  const startLink = installChainLink(ctx.shell, 'start', (next, _thisArg, args) => {
    const spec = args[0] as ShellExecSpec | undefined
    const notice = spec === undefined ? undefined : notices.get(spec)
    const process = next() as ShellProcess
    if (notice === undefined || typeof process !== 'object' || process === null) return process
    let emitted = false
    return {
      ...process,
      readOutput: () => {
        const read = process.readOutput()
        if (emitted) return read
        emitted = true
        return { ...read, delta: `${read.delta}${notice}` }
      },
    } satisfies ShellProcess
  })

  const handles: ChainHandle[] = [resolveLink, runLink, startLink]
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      // Reverse install order, though the chain itself is order-independent.
      for (const handle of handles.reverse()) handle.dispose()
    },
  }
}
