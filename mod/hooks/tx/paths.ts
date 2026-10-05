// Pure lexical path mapping. tools/rewrite.ts adds filesystem snapshot checks.

// Resolve '.', '..' and duplicate '/' lexically. Keeps a leading '/'.
export function normalize(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!p.startsWith('/')) out.push('..')
      // '..' above the root of an absolute path stays at the root
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return p.startsWith('/') ? '/' + joined : joined
}

function stripTrailingSlash(root: string): string {
  return root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root
}

// True when p is root itself or inside root, after lexical normalization.
export function contains(root: string, p: string): boolean {
  const r = stripTrailingSlash(normalize(root))
  const n = normalize(p)
  if (n === r) return true
  return n.startsWith(r + '/')
}

// Map a real repo path onto the transaction worktree; paths outside the
// repo (and paths already inside the worktree) pass through unchanged.
export function virtualize(path: string, repoRoot: string, txRoot: string): string {
  const root = stripTrailingSlash(normalize(repoRoot))
  const tx = stripTrailingSlash(normalize(txRoot))
  if (contains(tx, path)) return path
  if (!contains(root, path)) return path
  const n = normalize(path)
  if (n === root) return tx
  return tx + n.slice(root.length)
}
