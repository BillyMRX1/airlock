# Real-Git integration host

Run from the repository root with Bun installed:

```sh
NODE_PATH="$PWD/mod/integration" bun run mod/integration/real-git.ts
```

This no-model host imports Airlock's production lifecycle, recovery, and
accept/reject/abort handlers. Its `$` adapter runs real Git and filesystem
operations; the fixture is a disposable clone of `spike-sandbox/demo-project`.
The production handler may create its ephemeral baseline commit only in that
clone's linked worktree. The host covers dirty staged/unstaged/untracked and
ignored state, binary and Unicode filenames, apply, conflict, reject, abort,
saved-state recovery, subdirectory sessions, detached HEAD, and a nested repo.
It also verifies realpath-aware routing through an in-repository symlink,
denial of an external symlink, acceptance of a filename containing a newline,
and baseline-blob fallback conflict detection for a distant edit that still
passes `git apply --check` (the saved fingerprint is deliberately omitted).

Run the separate crash recovery probe with:

```sh
NODE_PATH="$PWD/mod/integration" bun run mod/integration/crash-recovery.ts
```

That probe starts a child host, creates and stores an ACTIVE transaction,
then terminates the child with SIGKILL. A fresh host loads the saved record,
recovers the linked worktree through the production session-start handler,
and aborts it; the fixture's HEAD, index, and real tracked-file state are
checked before cleanup. A second child pauses after production persists
APPLY_FAILED and creates a backup, immediately before applying. SIGKILL there
leaves the transaction requiring manual recovery: another accept is refused
and the worktree/backup remain. This is a pre-apply boundary test, not a kill
during actual partial writes.

The host does not emulate Claude's engine. Permission rewriting, UI rendering,
hook dispatch, and live model behavior remain outside this integration suite;
`claude plugin test mod` and any separately approved engine E2E cover those
boundaries. The pane renderer is never invoked, so the tiny
`react/jsx-dev-runtime` stub under `integration/react/` only permits importing
the TSX command module.
