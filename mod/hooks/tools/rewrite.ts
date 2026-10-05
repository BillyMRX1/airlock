// Structured file paths are routed through canonical source and destination
// checks. Missing leaves resolve through an existing ancestor; inaccessible or
// unresolved existing paths deny mutations. Read escapes pass through. This
// is snapshot containment, not a sandbox or protection against symlink races.

import { ctx, activeKey } from '../tx/state.ts'
import { virtualize, contains, normalize } from '../tx/paths.ts'

const ESCAPE_DENY =
  'airlock: path resolves outside the repository (symlink?); refused while a transaction is open.'

// Resolve missing leaves through their nearest existing ancestor. Unknown or
// inaccessible paths fail closed. This is a snapshot check, not a filesystem
// lock; arbitrary Bash and concurrent symlink replacement remain limitations.
async function canonicalPath($: any, path: string): Promise<string | null> {
  let current = normalize(path)
  const suffix: string[] = []
  while (current.startsWith('/')) {
    try {
      const st = await $.fs.stat(current, { resolve: true })
      if (typeof st?.realPath === 'string') return normalize([st.realPath, ...suffix].join('/'))
      if (st?.isLink || st?.kind !== 'other') return null
      if (await $.fs.exists(current)) return null
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && !String(err?.message ?? err).includes('ENOENT')) return null
    }
    if (current === '/') return null
    const at = current.lastIndexOf('/')
    suffix.unshift(current.slice(at + 1))
    current = current.slice(0, at) || '/'
  }
  return null
}

async function safeMappedPath($: any, original: string): Promise<string | null> {
  const lexicalInside = contains(ctx.repoRoot, original) || contains(ctx.tx!.txRoot, original)
  let repo: string | null = null
  let tx: string | null = null
  try {
    const repoStat = await $.fs.stat(ctx.repoRoot, { resolve: true })
    const txStat = await $.fs.stat(ctx.tx!.txRoot, { resolve: true })
    repo = typeof repoStat?.realPath === 'string' ? normalize(repoStat.realPath) : null
    tx = txStat?.isLink !== true && typeof txStat?.realPath === 'string' ? normalize(txStat.realPath) : null
  } catch { return null }
  if (!repo || !tx || repo === tx) return null
  if (!lexicalInside && !contains(repo, original) && !contains(tx, original)) return original
  const source = await canonicalPath($, original)
  if (!source) return null
  const fromTx = contains(ctx.tx!.txRoot, original) || contains(tx, original)
  if (!contains(fromTx ? tx : repo, source)) return null
  const mapped = fromTx ? source : virtualize(source, repo, tx)
  const destination = await canonicalPath($, mapped)
  return destination && contains(tx, destination) ? destination : null
}

async function stillActive($: any): Promise<boolean> {
  try {
    const saved = await $.store.get(activeKey(ctx.repoRoot))
    return saved?.transactionId === ctx.tx?.transactionId && saved?.state === 'ACTIVE'
  } catch { return false }
}

function blockedDeny(verb: string): { deny: string } {
  return {
    deny: `airlock: ${ctx.blockedByOtherSession} holds the open transaction for this repository. Review or resolve it with /airlock-diff, /airlock-accept, or /airlock-abort before retrying. ${verb} refused.`,
  }
}

export async function onReadCall($: any, e: any, next: any): Promise<unknown> {
  if (!ctx.tx) return next(e)
  const mapped = await safeMappedPath($, e.file_path)
  return next(mapped === null ? e : { ...e, file_path: mapped })
}

export async function onEditCall($: any, e: any, next: any): Promise<unknown> {
  if (ctx.isolationFailed) return { deny: 'airlock: no transaction workspace (fail-safe); edit refused.' }
  if (ctx.blockedByOtherSession) return blockedDeny('Edit')
  if (!ctx.tx) return next(e)
  if (ctx.tx.state !== 'ACTIVE' || !(await stillActive($))) return { deny: 'airlock: this transaction is awaiting review. Accept or reject it before editing.' }
  const mapped = await safeMappedPath($, e.file_path)
  if (mapped === null) return { deny: ESCAPE_DENY }
  ctx.tx.rewrites++
  return next({ ...e, file_path: mapped })
}

export async function onWriteCall($: any, e: any, next: any): Promise<unknown> {
  if (ctx.isolationFailed) return { deny: 'airlock: no transaction workspace (fail-safe); write refused.' }
  if (ctx.blockedByOtherSession) return blockedDeny('Write')
  if (!ctx.tx) return next(e)
  if (ctx.tx.state !== 'ACTIVE' || !(await stillActive($))) return { deny: 'airlock: this transaction is awaiting review. Accept or reject it before editing.' }
  const mapped = await safeMappedPath($, e.file_path)
  if (mapped === null) return { deny: ESCAPE_DENY }
  ctx.tx.rewrites++
  return next({ ...e, file_path: mapped })
}

export async function onNotebookEditCall($: any, e: any, next: any): Promise<unknown> {
  if (ctx.isolationFailed) return { deny: 'airlock: no transaction workspace (fail-safe); edit refused.' }
  if (ctx.blockedByOtherSession) return blockedDeny('NotebookEdit')
  if (!ctx.tx) return next(e)
  if (ctx.tx.state !== 'ACTIVE' || !(await stillActive($))) return { deny: 'airlock: this transaction is awaiting review. Accept or reject it before editing.' }
  const mapped = await safeMappedPath($, e.notebook_path)
  if (mapped === null) return { deny: ESCAPE_DENY }
  ctx.tx.rewrites++
  return next({ ...e, notebook_path: mapped })
}
