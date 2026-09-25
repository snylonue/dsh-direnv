/**
 * Two model-facing tools:
 *
 * - `direnv_allow` asks the user to approve one workspace `.envrc`, then
 *   performs the approval with the host's own `direnv allow`. The consent path
 *   is DSH's own approval seam (`ctx.approval.request`), not a bespoke prompt:
 *   the request carries the agent, the tool identity, the exact call id, and a
 *   reason, and the composed answerer (the Web UI) renders it as a normal
 *   approval. Outcomes map exactly like the sandbox escalation precedent: only
 *   `allowed-once` proceeds, and every other outcome — rejection, cancellation,
 *   or an unavailable channel — refuses before anything runs. The model never
 *   supplies the file contents and cannot approve anything by itself: it names a
 *   path, the user sees the path plus a bounded preview and the file's SHA-256,
 *   and direnv performs the write. The tool is additionally confined to the
 *   calling agent's own workspace by default.
 *
 * - `direnv_reload` re-resolves one workspace (or every cached workspace) now,
 *   which is the manual escape hatch for the per-workspace cache: use it after
 *   changing something direnv depends on that this plugin cannot see, or to
 *   confirm what a workspace currently injects. It needs no approval — it only
 *   reads, never authorizes.
 *
 * @module dsh-direnv/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { previewRc } from './core.js'
import { envNames } from './provider.js'

export const name = 'direnv-tools'

/**
 * The tool needs the registry, the prompt, the approval channel (optional at
 * load time — a missing channel fails the CALL closed, never the load), and
 * the direnv service that owns validation and `direnv allow`.
 */
export const inject = ['tools', 'systemPrompt', 'direnv']

/** No integration-local settings; behavior belongs to the provider row. */
export interface Config {}
export const Config = z.object({}) as z<Config>

/** Indent a preview block so a multi-line `.envrc` stays readable in a one-line reason. */
function indent(text: string, prefix = '    | '): string {
  if (text.length === 0) return `${prefix}(empty file)`
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'direnv_allow',
    description: [
      'Ask the user to approve a workspace direnv file (.envrc or .env) so its environment variables load into future bash commands.',
      'Call this only when a bash result carries a [dsh-direnv] notice saying the workspace direnv environment is blocked, or when the user explicitly asks to approve one.',
      'The user sees the file path, its SHA-256, and a preview of its contents, and must approve before anything is written.',
      'Approving authorizes exactly the current file content: editing the file afterwards requires a new approval.',
      'This tool never writes or edits the file itself.',
    ].join(' '),
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the .envrc or .env file to approve, as named in the [dsh-direnv] notice.',
      },
      reason: {
        type: 'string',
        description: 'One short sentence for the user explaining why this environment is needed, e.g. "the project needs its toolchain on PATH to run the build".',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              outcome: { type: 'string', required: true, const: 'approved' },
              path: { type: 'string', required: true },
              sha256: { type: 'string', required: true },
              variables: { type: 'integer', required: true },
              detail: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              outcome: { type: 'string', required: true, enum: ['rejected', 'cancelled', 'unavailable', 'refused'] },
              path: { type: 'string', required: true },
              detail: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args, exec) {
      const path = args.path
      const workspace = exec.agent === undefined ? undefined : ctx.direnv.workspaceFor(exec.agent)

      // Validate BEFORE asking: never show a user a prompt for a path this
      // plugin would refuse anyway.
      const refusal = ctx.direnv.refusalFor(path, workspace)
      if (refusal !== undefined) {
        return { outcome: 'refused' as const, path, detail: `dsh-direnv: refusing to approve: ${refusal}` }
      }

      if (exec.agent === undefined) {
        return { outcome: 'unavailable' as const, path, detail: 'dsh-direnv: this call has no agent, so no user can be asked to approve it' }
      }
      const approval = ctx.get('approval')
      if (approval === undefined) {
        return { outcome: 'unavailable' as const, path, detail: 'dsh-direnv: no approval channel is composed, so the file cannot be approved' }
      }

      const preview = previewRc(path, ctx.direnv.settings.previewBytes)
      const reason = [
        args.reason === undefined || args.reason.trim().length === 0 ? undefined : args.reason.trim(),
        `Approve this direnv file so its environment loads into bash commands?`,
        `  path:   ${preview.path}`,
        `  size:   ${preview.bytes} bytes`,
        `  sha256: ${preview.sha256}`,
        preview.truncated ? `  contents (first ${ctx.direnv.settings.previewBytes} bytes):` : '  contents:',
        indent(preview.text),
        'Approving authorizes exactly this content; editing the file afterwards requires a new approval.',
      ].filter((part): part is string => part !== undefined).join('\n')

      const outcome = await approval.request({
        agent: exec.agent,
        toolName: 'direnv_allow',
        callId: exec.callId,
        reason,
        signal: exec.signal,
      })

      switch (outcome) {
        case 'allowed-once': break
        case 'rejected':
          return { outcome: 'rejected' as const, path, detail: `dsh-direnv: the user rejected approving ${path}; the workspace environment stays unavailable` }
        case 'cancelled':
          return { outcome: 'cancelled' as const, path, detail: `dsh-direnv: approval for ${path} was cancelled; the workspace environment stays unavailable` }
        case 'unavailable':
          return { outcome: 'unavailable' as const, path, detail: `dsh-direnv: no approval answerer was reachable, so ${path} was not approved` }
      }

      const approved = ctx.direnv.approve(path, workspace)
      if (!approved.ok) {
        return { outcome: 'refused' as const, path, detail: `dsh-direnv: the user approved, but direnv refused the write: ${approved.reason}` }
      }
      // Count only names that will actually be set: a removal entry (a
      // `.envrc`'s `unset`) is not an injected variable.
      const after = ctx.direnv.statusFor(workspace ?? path.slice(0, path.lastIndexOf('/')))
      const variables = envNames(after.env).length
      return {
        outcome: 'approved' as const,
        path,
        sha256: preview.sha256,
        variables,
        detail: [
          `dsh-direnv: approved ${path}.`,
          `The next bash command in this workspace receives ${variables} injected variable${variables === 1 ? '' : 's'}.`,
          ...after.kind === 'injected' ? [] : [`Current state: ${ctx.direnv.describe(workspace ?? path)}.`],
        ].join(' '),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Request direnv approval',
      kind: 'execute',
      rawInput: args.path,
      content: [{ type: 'text', text: args.reason === undefined ? args.path : `${args.path}\n${args.reason}` }],
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'direnv_reload',
    description: [
      'Re-resolve the workspace direnv environment now, and report what changed.',
      'Each workspace is normally resolved once and cached; the cache already refreshes itself when the .envrc or direnv\'s own allow/deny state changes.',
      'Call this after changing something direnv depends on that this plugin cannot observe, or to confirm what a workspace currently injects.',
      'Omit directory to refresh every workspace that has been resolved so far.',
      'This tool only reads: it never approves a file and needs no user approval.',
    ].join(' '),
    parameters: {
      directory: {
        type: 'string',
        description: 'Absolute path of the directory to re-resolve. Defaults to the calling agent\'s workspace root.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reloaded: { type: 'integer', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args, exec) {
      const workspace = exec.agent === undefined ? undefined : ctx.direnv.workspaceFor(exec.agent)
      const requested = args.directory
      const target = requested ?? (workspace === undefined ? undefined : ctx.direnv.probeDirectory(workspace, undefined))
      if (requested === undefined && target === undefined) {
        return { reloaded: 0, detail: 'dsh-direnv: this call has no workspace to reload; pass an explicit directory.' }
      }
      const report = ctx.direnv.reload(target)
      if (report.reloaded === 0) {
        return {
          reloaded: 0,
          detail: requested === undefined
            ? 'dsh-direnv: nothing was cached yet, so the next command resolves this workspace fresh.'
            : `dsh-direnv: ${String(requested)} is not cached; the next command resolves it fresh.`,
        }
      }
      const lines = report.changed.map((change) => {
        const where = change.rcPath === undefined ? change.directory : change.rcPath
        const delta = [
          ...change.added === undefined || change.added.length === 0 ? [] : [`+${change.added.join(',+')}`],
          ...change.removed === undefined || change.removed.length === 0 ? [] : [`-${change.removed.join(',-')}`],
        ]
        const suffix = delta.length === 0 ? '' : ` (changed: ${delta.join(' ')})`
        return `  ${where}: ${change.kind}, ${String(change.variables)} variable(s)${suffix}`
      })
      return {
        reloaded: report.reloaded,
        detail: [`dsh-direnv: reloaded ${String(report.reloaded)} workspace(s).`, ...lines].join('\n'),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Reload direnv environment',
      kind: 'execute',
      rawInput: args.directory ?? '',
      content: [{ type: 'text', text: args.directory ?? '(current workspace)' }],
    }),
  }))
}
