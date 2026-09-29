/**
 * Session-start context: when a session begins, resolve its workspace's direnv
 * state once and seed the model with a snapshot of it.
 *
 * This is the one true "inject at session start" seam in DSH:
 * `agent/created` fires once per entered agent, before its first turn, and
 * `agent.inject()` queues model-facing context for the next pre-step. The
 * injected message names the workspace's direnv variables and states, but never
 * their values, and it resolves through the same provider cache the shell
 * adapter uses — so the first command after startup reuses this probe instead
 * of paying for another.
 *
 * Injection is best-effort by design. A session must still start when direnv is
 * missing, a workspace is unreadable, or a context message cannot be appended,
 * so every failure is contained and logged rather than allowed to veto the
 * lifecycle.
 *
 * @module dsh-direnv/session-context
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { SESSION_CONTEXT_PLUGIN, sessionContextText } from './core.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-direnv': { kind: 'dsh-direnv' } & ContextFormed
  }
}

/** The session-context listener's disposal boundary. */
export interface DirenvSessionContextHandle {
  /** Remove the listener. Idempotent. */
  dispose(): void
}

/**
 * Resolve one starting agent's workspace and inject a model-facing snapshot of
 * its direnv state.
 *
 * Never throws: a caller is the session-lifecycle boundary, where a context
 * message is an enhancement and must not become a startup failure.
 *
 * @param ctx - composition context whose `direnv` service resolves the state.
 * @param agent - the agent whose session just started.
 */
export function injectSessionContext(ctx: Context, agent: Agent): void {
  try {
    if (!ctx.direnv.enabled || !ctx.direnv.settings.sessionContext) return
    const workspace = ctx.direnv.workspaceFor(agent)
    if (workspace === undefined) return

    // No command workdir exists at session start, so the workspace root is the
    // directory that selects the .envrc — exactly what `followWorkdir` resolves
    // a command with no workdir to.
    const probeDir = ctx.direnv.probeDirectory(workspace, undefined)

    // Resolving answers the context AND warms the per-directory cache, so the
    // session's first bash command reuses this probe.
    const status = ctx.direnv.statusFor(probeDir)
    const text = sessionContextText(status, probeDir)
    if (text === undefined) return

    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      // `snapshot` is the form for "current state, where a later snapshot from
      // the same producer supersedes an earlier one" — a resumed or compacted
      // session therefore re-publishes instead of accumulating stale copies.
      source: {
        kind: SESSION_CONTEXT_PLUGIN,
        form: 'snapshot',
        sections: [{ name: SESSION_CONTEXT_PLUGIN, text }],
      },
    }))
  } catch (error) {
    try {
      ctx.logger.warn(`dsh-direnv: session-start context failed: ${String(error)}`)
    } catch {
      // Logging is itself best-effort; it must never become the failure.
    }
  }
}

/**
 * Install the `agent/created` listener that seeds the context.
 *
 * `agent/created` is 0.1.7's per-agent initialization hook — the old
 * `agent/session-start` no longer exists — and it fires once per entered agent
 * for fresh creation, resume, clear, and compaction alike.
 *
 * The listener is registered on `ctx` and therefore disposed with the calling
 * fiber even without an explicit {@link DirenvSessionContextHandle.dispose}.
 *
 * @param ctx - composition context to listen on and resolve through.
 * @returns the handle that removes the listener.
 */
export function installDirenvSessionContext(ctx: Context): DirenvSessionContextHandle {
  const off = ctx.on('agent/created', ({ agent }) => {
    injectSessionContext(ctx, agent)
    return undefined
  })
  return { dispose: () => void off() }
}
