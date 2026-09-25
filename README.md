# dsh-direnv

Workspace-aware [direnv](https://direnv.net) support for DeepSeek Harness: every
agent-owned shell command automatically receives its workspace's `.envrc`
environment, and a blocked `.envrc` produces an actionable notice plus a
`direnv_allow` tool that asks the user before authorizing anything.

## What it does

| | |
|---|---|
| **Injects** | the environment `direnv export json` reports for the command's directory, merged into the child's environment map |
| **Per workspace** | the workspace comes from the calling agent's session cwd; the command's own `workdir` selects a nested `.envrc`, like native direnv |
| **Never wraps commands** | `request.command` is byte-identical to what the model asked for — injection is an environment map, so a workspace cannot inject shell syntax |
| **Asks before allowing** | `direnv_allow` routes through DSH's approval channel; the user sees the path, its SHA-256, and a bounded preview |
| **Fails closed** | a blocked, denied, or changed `.envrc` injects nothing and says so; no approval service means no approval |

## The blocked-workspace UX

An unapproved `.envrc` does not fail the command and does not leak its
contents. The command runs without the environment, and the result's stderr
gains a notice the model can act on:

```text
[dsh-direnv] This command ran WITHOUT the workspace direnv environment.
[dsh-direnv] /home/me/proj/.envrc is not approved, so native direnv refused to load it.
[dsh-direnv] Call the direnv_allow tool with this path to ask the user to approve it:
[dsh-direnv]   direnv_allow path=/home/me/proj/.envrc
[dsh-direnv] Workspace: /home/me/proj
```

The model then calls `direnv_allow`. The user is shown the path, the file size,
its SHA-256, and a bounded preview of the contents, and must approve. Only
`allowed-once` proceeds; rejection, cancellation, and an unreachable answerer
all refuse, and the file is written by the host's own `direnv allow`.

Approval authorizes **exactly the current content**: editing the `.envrc`
afterwards invalidates it in direnv's own hash, and the next command is blocked
again until it is re-approved.

A **denied** `.envrc` is reported distinctly, because direnv ≥ 2.33 makes
`direnv deny` revoke authorization *silently* — `direnv export` still exits
zero, applying nothing. Simply seeing an empty result cannot tell that apart
from a legitimately empty file, so the plugin consults direnv's own deny store
(whose file name is direnv's `pathHash`, reproducing it exactly). A denied file
gets its own notice pointing at `direnv status`; an empty one is treated as
"nothing to inject" and stays quiet.

## Caching and manual reload

Each directory is resolved once and the answer is reused, so a workspace pays
for one `direnv export` rather than one per command. The cache is keyed by the
directory that selects the `.envrc`, and its validity is a cheap stamp over
everything that can change the answer:

- the governing `.envrc` — its size and mtime (an edit also invalidates
  direnv's own content hash);
- direnv's **allow and deny stores** — so a `direnv allow` or `direnv deny`
  run in your own terminal is observed, even though it changes no file the
  plugin could otherwise see.

When that is not enough — a dependency of the `.envrc` you changed, an
environment direnv reads that this plugin cannot observe — call the
`direnv_reload` tool:

```text
direnv_reload                          # re-resolve the calling workspace
direnv_reload directory=/path/to/ws    # re-resolve one directory
direnv_reload                          # with nothing cached: resolves nothing, says so
```

It reports each directory's resulting state and which variable names were added
or removed. It only reads: it never approves a file and needs no user approval.

## Configuration

```yaml
- id: direnv
  name: dsh-direnv
  config:
    executable: direnv          # bare PATH name or absolute path
    enabled: true               # master switch
    probeTimeoutMs: 10000       # budget for one direnv run
    notifyOnBlocked: true       # append the actionable notice to results
    restrictAllowToWorkspace: true  # direnv_allow may only name a file inside the agent's workspace
    followWorkdir: true         # the command's own directory selects the .envrc
    cache: true                 # resolve each directory once; reload on demand
    previewBytes: 2048          # bounded preview shown in the approval prompt
```

| Field | Default | Meaning |
|---|---|---|
| `executable` | `direnv` | The direnv binary; must be on `PATH` or absolute. |
| `enabled` | `true` | When off, the adapter is inert and no probe runs. |
| `probeTimeoutMs` | `10000` | One `direnv export json` run is killed past this. |
| `notifyOnBlocked` | `true` | Off keeps results byte-identical to an un-instrumented run. |
| `restrictAllowToWorkspace` | `true` | On, `direnv_allow` refuses any path outside the agent's workspace, including via `..` or a symlink. |
| `followWorkdir` | `true` | On, a command run in `<ws>/packages/api` picks up *that* `.envrc`. Off, every command uses the session workspace root. |
| `cache` | `true` | Resolve each directory once and reuse the result. The cache refreshes itself when the `.envrc` changes or when direnv's allow/deny store is rewritten, and `direnv_reload` forces a refresh. Off, every command pays the probe (about 35 ms for an allowed `.envrc`). |
| `previewBytes` | `2048` | How much of the `.envrc` the user sees. `0` shows only the hash. |

## Installation

### From GitHub


```sh
dsh plugin --profile web add github:snylonue/dsh-direnv

# If failed, allow the git repo to run its prepare script, then re-run step 1.
cat >> ~/.dsh/profiles/web/pnpm-workspace.yaml <<'EOF'
allowBuilds:
  'dsh-direnv@git+https://github.com/snylonue/dsh-direnv.git': true
EOF
```

### From a local path or tarball

```sh
dsh plugin --profile web add /path/to/dsh-direnv        # link:, requires dist/ to exist
dsh plugin --profile web add /path/to/dsh-direnv.tgz    # packed, self-contained
dsh --profile web --dump-config                         # confirm the three rows
```

**The plugin only takes effect after a restart.** DSH composes the plugin tree
at boot, so an already-running host does not pick up newly installed rows; the
settings-page plugin list reflects the live loader and will not show it until
then either.

To uninstall, use `dsh plugin --profile web remove dsh-direnv`.

## Requirements and limits

- **The `shell` service must exist.** The provider injects into `ctx.shell`'s
  calls; without a shell there is nothing to inject, so activation fails loudly.
- **Approval is required for `direnv_allow`.** With no approval channel composed,
  the tool refuses rather than approving on its own.
- **`direnv deny` semantics are direnv's.** On direnv >= 2.33 a denied `.envrc`
  makes `direnv export` succeed while applying nothing; this plugin reports that
  case as `denied` and tells the user to check with `direnv status`.
- **Persistent terminals are out of scope.** DSH mounts `terminals` inside a
  preset-private realm; this plugin covers the bash tool (`ctx.shell`).
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

The suite (119 tests) runs in layers:

- **pure core logic** — RC discovery, diff parsing, filtering, refusals, the
  cache stamp, and the deny-store hash the plugin reproduces from direnv;
- **the method chain**, including the non-LIFO disposal case a naive
  descriptor-restoring wrapper gets wrong;
- **the approval gate**, asserting that nothing reaches `direnv allow` without
  an explicit `allowed-once`;
- **end-to-end runs against the real `direnv` binary**;
- **real compositions** that boot `dsh-subprocess-local` + `dsh-bash-local` +
  `dsh-shell-env` + `dsh-tool-bash`, drive the model-facing `bash`,
  `direnv_allow`, and `direnv_reload` tools through the actual tool registry,
  and assert on what a genuine child process received.

Tests never touch the developer's real direnv authorization store: every
workspace, `HOME`, and XDG root lives in one temp tree.

## License

MIT.
