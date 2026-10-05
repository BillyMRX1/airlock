# Airlock — a Claude Code mod

Airlock is a **Claude Code mod** built with function hooks. It routes supported
project edits into a Git worktree so you can review each coding turn, then
**Accept** its patch or **Reject** it. It uses Claude Code's plugin system for
installation and distribution. This is worktree routing, not a filesystem or
command sandbox.

## Requirements

- Claude Code **2.1.289** (tested on macOS arm64).
- Git available on `PATH`.
- A project opened from an existing Git repository with a valid `HEAD` commit. Airlock does not initialize repositories or create commits in the real project.
- Host tools used by Airlock, including `bash`, `cp`, `mkdir`, and `rm`.

## One-time setup

Install the mod and create its temporary-worktree directory once:

```sh
claude plugin marketplace add BillyMRX1/airlock
claude plugin install airlock@airlock-marketplace
mkdir -p "$HOME/.claude-airlock"
```

The repository is private for now, so your GitHub account must have access and
Git must be authenticated for GitHub. Claude manages the download and plugin
cache; you do not need a manual clone or pull.

Next, save access to that directory once so you don't need a launch flag every
time. In `~/.claude/settings.json`, add `~/.claude-airlock` to
`permissions.additionalDirectories`:

```json
{
  "permissions": {
    "additionalDirectories": ["~/.claude-airlock"]
  }
}
```

If the file already has settings, merge this entry into it; keep the existing
settings and directory entries. If the file doesn't exist, create it with the
example above. This lets Claude's file tools access Airlock's worktree copies.
See Claude's [working-directory permissions](https://code.claude.com/docs/en/permissions#working-directories).

That's the setup. You don't need to repeat the install, `mkdir`, or permission
configuration for each session.

## Everyday use

Open a terminal in your Git project and start Claude as usual:

```sh
claude
```

The installed mod loads automatically. Restart an existing Claude session
after installing, and use `/airlock-status` to check that the command is available.
Ask for a code change, inspect the review, and choose Accept or Reject. If the
pane is hidden, run `/airlock-review`.

If you prefer not to save the directory permission, use
`claude --add-dir "$HOME/.claude-airlock"` for each launch instead.

### Updating

```sh
claude plugin marketplace update airlock-marketplace
claude plugin update airlock@airlock-marketplace
```

Restart Claude after updating.

## Load a source checkout instead

For development or manual installation, start Claude Code in your Git project
and pass the absolute path to the Airlock repository directory. With the
one-time directory permission saved above:

```sh
claude --plugin-dir /absolute/path/to/airlock
```

Use the real absolute path for your checkout. If you skipped the saved directory
permission, add `--add-dir "$HOME/.claude-airlock"` to this launch. Without either
form of access, routed file tools may prompt or be denied. Avoid loading a source
copy alongside an already installed Airlock copy.

The current project must already be a Git repository with a `HEAD`. The first coding turn creates a transaction automatically. Workspaces live beneath `~/.claude-airlock/`; transaction records are kept in Claude Code’s plugin-private persistent store.

## Local review archive

From the plugin directory, `python3 scripts/package.py` creates a local ZIP
under `dist/`. The private 0.1.0 preview release also includes this archive. Extract
it and pass the resulting `airlock` directory directly to `--plugin-dir`
(in place of the checkout path), with the same directory permission as above.
Tests and integration hosts stay in the source checkout; generated type files
and the private handoff documents are excluded from the archive.

## Try one transaction

1. Start Claude Code in an existing Git repository using the command above.
2. Ask Claude to make a small, reviewable code change.
3. When the turn finishes, inspect the Airlock review pane. If it is hidden, run `/airlock-review` to open it, or `/airlock-diff` for text output; `/airlock-status` shows the transaction state and worktree.
4. Run `/airlock-accept` to apply the reviewed project patch, or `/airlock-reject` to discard the transaction. The pane also offers Accept, Reject, and Review actions.

Accept checks for conflicting edits and whether the patch still applies, then applies it to the real worktree without changing the Git index. Reject does not apply the patch. Effects from commands outside the routed project files are not undone by either action.

Claude Code keeps automatically opened panes hidden below 144 terminal columns
(110 after you have explicitly opened that pane, until you close it by hand).
`/airlock-review` explicitly requests the pane and can show it inline in a narrower
terminal. While the pane has keyboard focus, Tab moves between controls and Enter
presses the selected button; Esc returns to the prompt. Headless sessions use
`/airlock-diff`, `/airlock-accept`, and `/airlock-reject`.

## Small demo: accept, then reject

Use an unused, non-ignored filename such as `airlock-demo.txt` in an existing repository,
with the default `includeUntracked: true`. In the Claude session, ask:

> Create airlock-demo.txt containing "ready for review" using Write. Do not run commands or change other files.

When the turn ends, `/airlock-status` should show REVIEW and `/airlock-diff`
should show the proposed new file. In another terminal at the real repository,
`git status --short -- airlock-demo.txt` should still show no file. Run
`/airlock-accept`: the file now exists in the real tree as an untracked file;
Airlock has not staged or committed it.

Next ask Claude:

> Read airlock-demo.txt and append "discard this line" using Edit. Do not run commands or change other files.

Review the proposed line, then run `/airlock-reject`. The real file should
still contain only "ready for review". Keep or remove the demo file yourself
when finished. These observations check this small structured-tool workflow;
they do not prove that arbitrary commands are isolated.

## Commands

| Command | Purpose |
| --- | --- |
| `/airlock-status` | Show the open transaction, its state, paths, change counts, and routed activity. |
| `/airlock-diff` | Show the current transaction diff (output is capped at 8,000 characters). |
| `/airlock-review` | Open and focus the review pane. Finish ACTIVE work with `/airlock-begin end` first; headless sessions use `/airlock-diff`. |
| `/airlock-accept` | Apply a transaction in review after conflict and apply checks. |
| `/airlock-reject` | Discard the open transaction; it does not apply a patch. |
| `/airlock-abort` | Discard an open transaction before review, or clear a pending multi-turn setting. |
| `/airlock-cleanup` | Report stale Airlock workspaces; `/airlock-cleanup purge` removes eligible stale workspaces. |
| `/airlock-history` | List recent finished transactions for the current repository. |
| `/airlock-mode` | Show the repository's mode; add `strict`, `balanced`, or `permissive` to set it. |
| `/airlock-begin` | Keep the next coding transaction open across multiple turns. `/airlock-begin end` stages it for review. |
| `/airlock-rejected` | List retained rejected workspaces; add a transaction ID to inspect its saved diff. |

## Multi-turn work

Run `/airlock-begin` before starting a coding turn to keep its transaction open for follow-up turns. When the work is ready, run `/airlock-begin end` to prepare it for review, then use `/airlock-diff` and `/airlock-accept` or `/airlock-reject`. Resolving the transaction clears multi-turn mode, so later coding turns use the default one-turn lifecycle.

## Configuration

Plugin configuration defaults are:

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `strict` | Denies classified external side effects and Git topology commands. `balanced` asks for one-time approval for a matched external side effect in an interactive session; `permissive` allows and records classified actions. |
| `includeUntracked` | `true` | Copies eligible, non-ignored untracked regular files into the transaction baseline. Ignored untracked files are excluded; symlinks, directories, and files over 4 MiB are skipped. |
| `retainRejectedTransactions` | `false` | When true, keeps rejected or aborted worktrees for later inspection instead of removing them. |
| `maxStoredTransactions` | `50` | Maximum finished transaction records stored per repository. |

`/airlock-mode` sets a mode override for the current repository. Balanced mode requires an interactive exact “Allow once” response for recognized external side effects; headless sessions deny those actions. The mode classifier is heuristic and incomplete; the setting does not make Bash safe or contained.

## Scope and known limitations

Airlock routes supported structured file tools such as Read, Edit, Write, and NotebookEdit when their paths are inside the current repository. Paths outside the repository pass through. Search tools are not virtualized and can read the real tree, which may differ from the transaction copy. MCP tools are outside Airlock's routing and side-effect controls.

Bash is executed by the plugin in the worktree, but it is **not sandboxed** and bypasses Claude Code's Bash permission gate. The command classifier is incomplete: unmatched commands pass in every mode, including `strict`. Absolute paths, `cd`, scripts, aliases, and network or database operations can affect resources outside the transaction. Rejecting or aborting does not undo those effects. Background Bash is denied during transactions.

Per-repository session checks are not atomic locks. Concurrent sessions can race, and real-path checks cannot eliminate time-of-check/time-of-use races such as a path changing between validation and access. Airlock does not run the project's test suite automatically; review-pane checks are preflight checks, not completed project tests.

If accept fails after applying has begun, Airlock attempts to restore backups and retains the workspace and backup when recovery is needed. A transaction marked `APPLY_FAILED` refuses another accept and requires manual recovery, including when termination happened before the actual apply. Inspect the reported paths and backup under `~/.claude-airlock/`, compare them with the repository, and recover manually before removing the retained files. A process termination during actual partial Git writes has not been verified end to end.

## Development checks

Run these from the plugin directory (the published repository root, or `mod/`
in the original development workspace):

```sh
claude plugin validate --strict .
claude plugin test .
NODE_PATH="$PWD/integration" bun run integration/real-git.ts
NODE_PATH="$PWD/integration" bun run integration/crash-recovery.ts
```

The integration hosts additionally need Bun and the existing demo seed at
`../spike-sandbox/demo-project` relative to the plugin directory. This development
seed is excluded from the published repository and archive; the hosts cannot run
without it.
Bun and Python are development/packaging tools, not plugin runtime dependencies.

## Development evidence

The plugin passes strict static validation and 137 engine tests across fourteen
files. Separate no-model hosts exercise production handlers against real Git,
including crash recovery at a pre-apply boundary. Owner testing on macOS/Warp
verified a live Write/accept and Read/Edit/reject workflow, native Review/Accept/
Reject actions, explicit `/airlock-review` opening, readable completion summaries,
and balanced-mode Deny and Allow once with `curl -X POST --help`
(local help only). This is a small manual workflow, not complete coverage of
concurrency, command isolation, or every native control. The native review-command
retest did not record a terminal column count; placement below 144 columns has
not been independently established by the screenshots.


## Security and recovery

Read [SECURITY.md](SECURITY.md) for the implemented boundaries and recovery
procedure. An `APPLY_FAILED` workspace and its sibling `.backup` directory
should be inspected and preserved before reject, abort, or cleanup.

## License

Airlock is licensed under the [MIT License](LICENSE).
