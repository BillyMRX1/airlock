// Git command policy inside a transaction (plan §15).
//
// Read-oriented git runs freely; topology-mutating git is denied for the
// MVP (it can break transaction tracking); remote git is a side effect
// and is handled by the side-effect policy. This classification is
// conservative by design: an unknown subcommand counts as mutating
// (fail safe, plan §24). It is a heuristic, not a parser — compound
// commands are split and every git segment classified, the most severe
// answer wins (remote > mutating > readonly).
//
// The mod itself runs `git add -A`, `git diff`, `git worktree add/remove`
// through $.process.run argv — that is our code, not the model's, and is
// unaffected by this classifier.

export type GitClass = 'readonly' | 'mutating' | 'remote'

const READONLY = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'describe', 'ls-files', 'cat-file', 'blame', 'shortlog', 'grep',
])
const REMOTE = new Set(['push', 'fetch', 'pull', 'remote', 'clone', 'submodule'])
// Everything else (commit, merge, rebase, reset, checkout, switch, clean,
// worktree, stash, cherry-pick, revert, tag, branch, add, rm, mv, apply,
// am, bisect, filter-branch, unknown…) is mutating.

const SEVERITY: Record<GitClass, number> = { readonly: 0, mutating: 1, remote: 2 }

// Classify one git invocation, given the tokens after 'git'.
function classifyGitTokens(tokens: readonly string[]): GitClass {
  const sub = tokens.find(t => !t.startsWith('-'))
  if (sub === undefined) return 'readonly' // bare `git` / `git --version`
  const name = sub.toLowerCase()
  if (REMOTE.has(name)) return 'remote'
  if (READONLY.has(name)) return 'readonly'
  if (name === 'branch') {
    // `git branch --show-current` style (flags only) is a read; any
    // non-flag argument creates/renames/deletes a branch.
    const rest = tokens.slice(tokens.indexOf(sub) + 1)
    return rest.some(t => !t.startsWith('-')) ? 'mutating' : 'readonly'
  }
  if (name === 'config') {
    const rest = tokens.slice(tokens.indexOf(sub) + 1)
    const readsOnly = rest.every(t => t.startsWith('-') || t.startsWith('user.') === false)
    // `git config --get x`, `git config --list` read; `git config k v` writes.
    if (rest.some(t => t === '--get' || t === '--list' || t === '-l' || t === '--get-regexp')) return 'readonly'
    return readsOnly && rest.length === 0 ? 'readonly' : 'mutating'
  }
  return 'mutating'
}

function classifySegment(segment: string): GitClass | null {
  const tokens = segment.trim().split(/\s+/)
  // `sudo git …`, `env git …`, `GIT_DIR=… git …` all reach git.
  let i = 0
  while (
    i < tokens.length &&
    (tokens[i] === 'sudo' || tokens[i] === 'env' || (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) && tokens[i] !== 'git'))
  ) {
    i++
  }
  if (tokens[i] !== 'git') return null
  return classifyGitTokens(tokens.slice(i + 1))
}

// Classify a whole (possibly compound) command line.
export function classifyGit(command: string): GitClass | null {
  // Split on shell separators; keep it lexical — this is a policy hint,
  // not a shell parser. Quotes are not interpreted (documented limit).
  const segments = command.split(/&&|\|\||;|\|/)
  let worst: GitClass | null = null
  for (const seg of segments) {
    const c = classifySegment(seg)
    if (c !== null && (worst === null || SEVERITY[c] > SEVERITY[worst])) worst = c
  }
  return worst
}
