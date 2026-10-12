# dsh-direnv

Workspace-aware [direnv](https://direnv.net) support for DeepSeek Harness: every
agent-owned shell command automatically receives its workspace's `.envrc`
environment, and a blocked `.envrc` produces an actionable notice plus a
`direnv_allow` tool that asks the user before authorizing anything.

## What it does

| | |
|---|---|
| **Injects** | the environment `direnv export json` reports for the session workspace, merged into the child's environment map |
| **Per workspace** | the workspace is fixed by the calling agent's session cwd; command `workdir` never selects another environment |
| **Announces at startup** | starting a session injects one model-facing snapshot naming the workspace's direnv variables, or why none loaded; values are never included and a workspace with no `.envrc` stays silent |
| **Never wraps commands** | `request.command` is byte-identical to what the model asked for — injection is an environment map, so a workspace cannot inject shell syntax |
| **Asks before allowing** | `direnv_allow` routes through DSH's approval channel before running `direnv allow` |
| **Fails closed** | resolution refuses blocked or denied files; commands use the saved snapshot until explicit reload; no approval service means no approval |

## Session-start context

When a session starts, the plugin resolves its workspace once and queues one
model-facing context message (`agent/created` + `agent.inject()`)
before the first turn. The model therefore knows, without running anything,
whether the workspace has an active direnv environment:

```text
[dsh-direnv] The workspace direnv environment is active.
[dsh-direnv] /home/me/proj/.envrc injects 3 variable(s) into every command the agent runs:
[dsh-direnv]   API_BASE, PROJECT_TOOLCHAIN, RUST_LOG
[dsh-direnv] Values are applied to each command's environment and are deliberately not shown here.
```

Only variable **names** are ever published — values may be secrets and stay in
the execution environment. A blocked, denied, or failed workspace gets the same
actionable wording as the command notice, so the model can call `direnv_allow`
immediately. A workspace with no `.envrc` stays silent, and the message is a
`snapshot`: a resumed or compacted session re-publishes the current state
instead of accumulating stale copies.

Session creation awaits this asynchronous resolution before the first turn.
Every later command reads the saved environment synchronously, without running
direnv or checking files. Set `sessionContext: false` to suppress the message;
the workspace is still resolved.

## The blocked-workspace UX

An unapproved `.envrc` does not fail the command and does not leak its
contents. The command runs without the environment, and the result's stderr
gains a notice the model can act on:

```text
[dsh-direnv] This command ran WITHOUT the workspace direnv environment.
[dsh-direnv] /home/me/proj/.envrc is not approved, so native direnv refused to load it.
[dsh-direnv] Call the direnv_allow tool to ask the user to approve this workspace:
[dsh-direnv]   direnv_allow
[dsh-direnv] Workspace: /home/me/proj
```

The model then calls `direnv_allow` (optionally with a `reason`), which requests
user approval for the calling session workspace without reading or previewing
the file contents. Only
`allowed-once` proceeds; rejection, cancellation, and an unreachable answerer
all refuse. The host runs `direnv allow` without a path argument, with its cwd
set to the fixed session workspace. File discovery (including parent-directory
RC files), existence, and authorization errors are left entirely to direnv.

`direnv allow` authorizes the file content at execution time: editing the `.envrc`
afterwards invalidates it in direnv's own hash. The saved environment stays active
until an explicit reload, which reports the file as blocked until re-approved.
The `direnv_allow` tool refreshes the session workspace after a successful approval.

A **denied** `.envrc` is reported distinctly, because direnv ≥ 2.33 makes
`direnv deny` revoke authorization *silently* — `direnv export` still exits
zero, applying nothing. Simply seeing an empty result cannot tell that apart
from a legitimately empty file, so the plugin consults direnv's own deny store
(whose file name is direnv's `pathHash`, reproducing it exactly). A denied file
gets its own notice pointing at `direnv status`; an empty one is treated as
"nothing to inject" and stays quiet.

## Workspace snapshots and explicit reload

At session startup, the plugin runs `direnv status --json` and
`direnv export json` asynchronously in the fixed workspace, respecting native
RC discovery and authorization. Startup waits for the result; a failed resolution
is saved as an error and does not prevent the session from starting.

Commands only read the saved snapshot. There is no automatic refresh after file
edits, deletions, dependency changes, or external `direnv allow/deny` calls.
Use the model-facing tool explicitly to apply changes:

```text
direnv_reload                          # reload the calling session workspace
```

Changing a command's working directory never changes its direnv environment.
The service requires `reload(workspace)` and returns that workspace's result
directly. The tool has no parameters and refreshes only the calling session workspace.

Reload returns `reloaded` and a single structured `detail` object containing
`directory`, optional `rcPath`, `kind`, `variables`, `added`, and `removed`.
These lists report names set/unset by the current filtered native direnv diff,
not changes relative to the saved snapshot. Values are never included. A missing
session workspace returns only `{ error }`. The output schema uses a top-level
`oneOf` to distinguish success from error, without nullable or optional results.
The text summary is generated separately for display. Reload does
not approve files. The previous snapshot remains readable while reload runs and
is replaced when resolution completes; subsequent commands use the new result.

## Configuration

```yaml
- id: direnv
  name: dsh-direnv
  config:
    executable: direnv          # bare PATH name or absolute path
    enabled: true               # master switch
    probeTimeoutMs: 10000       # budget for one direnv run
    notifyOnBlocked: true       # append the actionable notice to results
    sessionContext: true        # inject one model-facing snapshot at session start
```

| Field | Default | Meaning |
|---|---|---|
| `executable` | `direnv` | The direnv binary; must be on `PATH` or absolute. |
| `enabled` | `true` | When off, the adapter is inert and no probe runs. |
| `probeTimeoutMs` | `10000` | Each `direnv status --json` or `direnv export json` run is killed past this. |
| `notifyOnBlocked` | `true` | Off keeps results byte-identical to an un-instrumented run. |
| `sessionContext` | `true` | On, starting a session injects one model-facing snapshot naming the workspace's direnv variables (or why none loaded). Values are never included. |

## Installation

## From npm

```sh
dsh plugin --profile web add @snylonue/dsh-direnv
```

### From GitHub


```sh
dsh plugin --profile web add github:snylonue/dsh-direnv

# If failed, allow the git repo to run its prepare script, then re-run step 1.
cat >> ~/.dsh/profiles/web/pnpm-workspace.yaml <<'EOF'
allowBuilds:
  'dsh-direnv@git+https://github.com/snylonue/dsh-direnv.git': true
EOF
```

**The plugin only takes effect after a restart.** DSH composes the plugin tree
at boot, so an already-running host does not pick up newly installed rows; the
settings-page plugin list reflects the live loader and will not show it until
then either.

To uninstall, use `dsh plugin --profile web remove dsh-direnv`.

## Requirements and limits

- **The `shell` service must exist.** The provider injects into `ctx.shell`'s
  calls; without a shell there is nothing to inject, so activation fails loudly.
- **The session-start context is best-effort.** A missing `direnv`, an
  unreadable workspace, or a failed injection never blocks session startup; the
  model simply learns the state when it runs a command.
- **Approval is required for `direnv_allow`.** With no approval channel composed,
  the tool refuses rather than approving on its own.
- **`direnv deny` semantics are direnv's.** On direnv >= 2.33 a denied `.envrc`
  makes `direnv export` succeed while applying nothing; this plugin reports that
  case as `denied` and tells the user to check with `direnv status`.
- **Persistent terminals are out of scope.** DSH mounts `terminals` inside a
  preset-private realm; this plugin covers the `ctx.shell` seam.
- **`direnv export json` returns a diff** against the environment direnv ran in.
  The plugin filters it: `DSH_*` and `DIRENV_*` names are dropped, as is any
  name that is not a portable environment identifier.
- **`unset` compiles to removal, not absence.** An environment map cannot
  remove a variable by omitting it — the executor merges the map onto the
  credential-scrubbed parent environment, so an absent name keeps the inherited
  value. A `.envrc`'s `unset FOO` therefore becomes an `undefined` value, which
  is the subprocess seam's removal convention, and the child genuinely does not
  have `FOO`. The renderer types the map as `Record<string, string>`, so the
  widening is narrowed again at that one boundary.

## Development

```sh
pnpm install
pnpm typecheck   # source AND tests
pnpm test        # builds, then runs vitest
```

The suite runs in layers:

- **pure core logic** — diff parsing, filtering, refusals, the
  cache stamp and the session-start context renderer;
- **the method chain**, including the non-LIFO disposal case a naive
  descriptor-restoring wrapper gets wrong;
- **the approval gate**, asserting that nothing reaches `direnv allow` without
  an explicit `allowed-once`;
- **the session-start path**, asserting what a real `agent/session-start`
  event queues and that the startup probe warms the cache;
- **end-to-end runs against the real `direnv` binary**;
- **real compositions** that boot `dsh-subprocess-local` + `dsh-bash-local` +
  `dsh-shell-env` + `dsh-tool-bash`, drive the model-facing `bash`,
  `direnv_allow`, and `direnv_reload` tools through the actual tool registry,
  and assert on what a genuine child process received.

Tests never touch the developer's real direnv authorization store: every
workspace, `HOME`, and XDG root lives in one temp tree.

## License

MIT.

The plugin icon is the [direnv logo](https://github.com/direnv/direnv-logo)
by Peter Waller, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
