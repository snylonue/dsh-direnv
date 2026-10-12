# dsh-direnv

[direnv](https://direnv.net) support for DeepSeek Harness

## What it does

| | |
|---|---|
| **Injects** | the environment `direnv export json` reports for the session workspace, merged into the child's environment variables |
| **Per workspace** | the workspace is fixed by the calling agent's session cwd |
| **Announces at startup** | starting a session injects one model-facing snapshot naming the workspace's direnv variables, or why none loaded; a workspace with no `.envrc` stays silent |
| **Asks before allowing** | `direnv_allow` routes through DSH's approval channel before running `direnv allow` |

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

Only variable **names** are ever shown. A blocked, denied, or failed workspace gets the same
actionable wording as the command notice, so the model can call `direnv_allow`
immediately. A workspace with no `.envrc` stays silent. A new message is sent after compact or resume.

Session creation awaits this resolution before the first turn.
Set `sessionContext: false` to suppress the message;
the workspace is still resolved.

## The blocked-workspace UX

An unapproved `.envrc` does not fail the command and does not leak its
contents. The command runs without the direnv environment. Set `notifyOnBlocked: true` to add a notice to the result's
stderr that the model can act on:

```text
[dsh-direnv] This command ran WITHOUT the workspace direnv environment.
[dsh-direnv] /home/me/proj/.envrc is not approved, so native direnv refused to load it.
[dsh-direnv] Call the direnv_allow tool to ask the user to approve this workspace:
[dsh-direnv]   direnv_allow
[dsh-direnv] Workspace: /home/me/proj
```

The model then calls `direnv_allow` (optionally with a `reason`), which requests
user approval for the calling session workspace without reading or previewing
the file contents. The host runs `direnv allow` in the workspace.

## Explicit reload

At session startup, the plugin runs `direnv status --json` and
`direnv export json` in the fixed workspace, waits for the result; a failed resolution
is saved as an error and does not prevent the session from starting.

Commands only read the resolved environment. Use the model-facing tool explicitly to apply changes:

```text
direnv_reload                          # reload the calling session workspace
```

## Configuration

```yaml
- id: direnv
  name: dsh-direnv
  config:
    executable: direnv          # bare PATH name or absolute path
    probeTimeoutMs: 10000       # budget for one direnv run
    notifyOnBlocked: false      # opt in to append actionable notices to results
    sessionContext: true        # inject the workspace's direnv variables at session start
```

| Field | Default | Meaning |
|---|---|---|
| `executable` | `direnv` | The direnv binary; must be on `PATH` or absolute. |
| `probeTimeoutMs` | `10000` | Each `direnv status --json` or `direnv export json` run is killed past this. |
| `notifyOnBlocked` | `false` | Opt in to append actionable notices; off leaves command results unchanged. |
| `sessionContext` | `true` | On, starting a session injects the workspace's direnv variables (or why none loaded). |

Disable the provider with Cordis's `disabled: true` on its plugin row, outside
`config`. Its dependent adapters and tools become inactive automatically.

## Installation

## From npm

```sh
dsh plugin --profile web add @snylonue/dsh-direnv
```

**The plugin only takes effect after a restart.**

To uninstall, use `dsh plugin --profile web remove @snylonue/dsh-direnv`.

## Development

```sh
pnpm install
pnpm typecheck   # source AND tests
pnpm test        # builds, then runs vitest
```

## License

MIT.

The plugin icon is the [direnv logo](https://github.com/direnv/direnv-logo)
by Peter Waller, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
