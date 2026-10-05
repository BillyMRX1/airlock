// Workspace naming and safety guards (pure; the $.process calls that
// create/destroy worktrees live in the hook files that need them).
//
// The transaction workspace is a detached git worktree under
// ~/.claude-airlock/ — it shares the repo's object store but has
// its own index, so staging inside it never touches the real repository.
// Never mutate the user's branch/ref to create one (plan §5, §15, §23).

export const TX_DIR_NAME = '.claude-airlock'

export function transactionsRoot(home: string): string {
  const h = home.endsWith('/') ? home.slice(0, -1) : home
  return `${h}/${TX_DIR_NAME}`
}

export function txidFor(turnId: string): string {
  return `${turnId.slice(0, 8)}-${Date.now().toString(36)}`
}

export function txRootFor(home: string, repoRoot: string, txid: string): string {
  const base = repoRoot.split('/').filter(Boolean).pop() ?? 'repo'
  return `${transactionsRoot(home)}/${base}-${txid}`
}

// A path we may safely destroy must be one we created: directly inside
// our own transactions root and nowhere deeper or elsewhere (plan §22).
export function isOurTxRoot(home: string, txRoot: string): boolean {
  const root = transactionsRoot(home)
  const leaf = txRoot.slice(root.length + 1)
  return txRoot.startsWith(root + '/') && leaf !== '' && leaf !== '.' && leaf !== '..' && !leaf.includes('/')
}
