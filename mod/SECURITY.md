# Security

Airlock routes supported file edits and foreground Bash commands into a Git worktree so you can review a change before applying it. It is a change-management aid, not an operating-system sandbox or a security boundary. Keep normal Claude Code permissions, shell access, credentials, and network access in mind when using it.

## What it protects

For an active transaction, Edit, Write, and NotebookEdit paths inside the repository are canonicalized and routed to the transaction worktree. A path that appears to be inside the repository but resolves outside it is refused for mutation; a path already outside the repository passes through unchanged. Read paths that resolve outside the repository also pass through unchanged. These checks apply to supported structured file tools; they are snapshot checks and cannot prevent a concurrent symlink or path replacement.

Airlock runs foreground Bash itself with the transaction worktree as its working directory. That means Bash does **not** go through Claude Code's normal Bash permission prompt or Bash sandbox. The mod uses a heuristic classifier for known external side effects and Git operations. Strict mode denies recognized side-effect patterns and Git topology mutations; balanced mode asks once for recognized side effects and denies when confirmation is unavailable; permissive mode allows them and records recognized effects. Unknown commands pass in every mode. Shell syntax, aliases, scripts, and command substitutions can evade or confuse classification. Background Bash is refused while a transaction is active.

Search tools are not virtualized, so search may inspect the real repository. MCP tools are not virtualized either; Airlock does not make MCP calls read-only. Other tools or processes that write files directly can also bypass the routing hooks.

## Shared Git state and transaction contents

Git worktrees share the repository's object store, refs, and configuration. The transaction starts from the current HEAD, and a dirty baseline is reproduced and committed only inside the transaction worktree. Airlock leaves the real tree's existing commits and dirty files in place during setup. On accept, it checks affected files against recorded baseline fingerprints (or baseline blobs) and checks patch fit before applying. These are preflight checks, not an atomic lock: another process can change files between the check and apply. Multi-session guards are store-backed checks, not atomic locks.

Non-ignored untracked files are copied into the baseline when configured; files that are too large or unsuitable may be skipped and reported. Ignored untracked files are excluded. A tracked file remains part of the baseline even if it is now matched by an ignore rule. Review the skipped-file list and the transaction diff before accepting.

Transaction workspaces and backups can contain private tracked or untracked
project data. Recognized side-effect event records include the command string,
which can itself contain credentials or other sensitive arguments. Airlock
does not add encryption to these files or records. Ignoring an untracked file
excludes it from automatic copying; it does not prevent an unvirtualized tool
or command from reading it. Retained workspaces require explicit cleanup;
trimming the history record count does not remove retained directories.

Reject and abort discard the transaction worktree, or retain it when configured; they cannot undo side effects that already happened outside it, such as network requests, published artifacts, database changes, or writes made by unvirtualized tools. Accept applies a patch to the real tree and does not commit it.

## Recovery

An `APPLY_FAILED` record is a conservative marker written before apply begins. It can mean apply failed, rollback was incomplete, or the process stopped before or during apply. Airlock refuses another accept until manual recovery; the transaction workspace and any backup are retained for inspection. Automatic recovery from a process killed during partial Git writes has not been verified.

If a transaction is `APPLY_FAILED`, or a session exits unexpectedly:

1. Stop other sessions or processes that may be changing the same repository.
2. Inspect `/airlock-status`, `/airlock-diff`, and the repository's `git status` and diffs. For `APPLY_FAILED`, compare the real tree with the retained transaction workspace and sibling backup directory before changing anything.
3. Preserve the workspace, backup, and repository state while investigating. Do not rerun accept, reject, abort, cleanup purge, or broad reset/clean commands until you understand which files are present in each location.
4. Restore files manually from the backup or transaction workspace only after identifying the correct version for each affected path. Then verify the repository state before resuming work.

`/airlock-cleanup` lists stale workspaces without removing them. Its `purge` option removes stale Airlock-owned workspaces; inspect the list and preserve any data you need before using it. Do not use blanket Git cleanup commands to recover a transaction.

## Verification limits

The development suite includes engine test-kit tests, plus no-model real-Git
and SIGKILL hosts that call the production handlers. The crash probes
cover an ACTIVE transaction and a pause immediately before apply with the
recovery marker and backup already saved; they use a JSON store adapter.
They do not establish safety during actual partial writes or a native Claude
host crash. Owner manual testing verified a small live Write/accept and
Read/Edit/reject workflow, native Review/Accept/Reject controls, explicit pane
opening, readable completion summaries, and balanced-mode Deny and Allow once
for a local help command. Native dialog dismissal and narrow-terminal placement
with a measured column count remain unverified.
Seamless hot reload is unverified: a fresh module denies mutations until
session initialization restores its context.

## Reporting a problem

Until a project security contact is published, report suspected vulnerabilities or data loss through the project owner's established support channel. Include the Airlock version, Claude Code version, operating system, safety mode, the command or tool involved, and a minimal reproduction. Remove credentials, private paths, and other sensitive data from the report.
