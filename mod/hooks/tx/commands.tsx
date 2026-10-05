// /airlock-status, /airlock-diff, /airlock-accept, /airlock-reject (plan
// §12, §13, §17). Accept is two conflict layers then a guarded apply:
//   1. baseline fingerprint — re-hash the real paths the transaction's
//      patch touches; any drift means a concurrent human edit → CONFLICTED,
//      nothing applied (plan §11).
//   2. git apply --check — the patch must still fit the real tree.
// Then a byte-faithful backup of the files the patch touches (cp, argv —
// $.fs.write is text-only) so a mid-apply failure is rolled back exactly;
// on failure the transaction is kept in APPLY_FAILED, never half-applied
// silently. Nothing is ever committed; git apply never touches the index,
// so the user's staging state survives.
//
import { ctx, activeKey, historyKey, modeKey, multiTurnKey, LEGACY_ACTIVE_KEY, recoverableRecord } from './state.ts'
import type { HistoryRecord } from './state.ts'
import { isOurTxRoot, transactionsRoot } from './workspace.ts'
import { trimHistory } from './state.ts'
import { parseNameOnly, parseNumstat, parentDirOf } from './patch.ts'

async function home($: any): Promise<string> {
  const h = await $.env.get('HOME')
  return typeof h === 'string' && h.length > 0 ? h : '/tmp'
}

async function baselineHashes($: any, t: any, paths: string[]): Promise<Record<string, string | null | undefined>> {
  const out: Record<string, string | null | undefined> = {}
  for (const path of paths) {
    const saved = t.baselineFingerprint?.[path]
    if (saved === 'airlock:absent') { out[path] = null; continue }
    if (typeof saved === 'string') { out[path] = saved; continue }

    const spec = `${t.baselineCommit}:${path}`
    const blob = await $.process.run(['git', 'rev-parse', '--verify', '--end-of-options', spec], { cwd: t.txRoot })
    if (blob.exitCode === 0 && blob.isStdoutTruncated !== true && /^[0-9a-f]{40}(?:[0-9a-f]{24})?\s*$/i.test(blob.stdout)) {
      out[path] = blob.stdout.trim()
      continue
    }
    // A failed blob lookup means the baseline path may be absent, but first
    // distinguish that from a Git/repository/process error.
    const entry = await $.process.run(['git', 'ls-tree', '-r', '-z', '--name-only', t.baselineCommit, '--', path], { cwd: t.txRoot })
    if (entry.exitCode !== 0 || entry.isStdoutTruncated === true) continue
    const names = entry.stdout.split('\0').filter((name: string) => name !== '')
    out[path] = names.includes(path) ? undefined : null
  }
  return out
}

async function currentHashes($: any, repoRoot: string, paths: string[]): Promise<Record<string, string | null | undefined>> {
  const out: Record<string, string | null | undefined> = {}
  for (const path of paths) {
    const hash = await $.process.run(['git', 'hash-object', '--', path], { cwd: repoRoot })
    if (hash.exitCode === 0 && hash.isStdoutTruncated !== true && /^[0-9a-f]{40}(?:[0-9a-f]{24})?\s*$/i.test(hash.stdout)) {
      out[path] = hash.stdout.trim()
      continue
    }
    try {
      out[path] = await $.fs.exists(`${repoRoot}/${path}`) ? undefined : null
    } catch {
      out[path] = undefined
    }
  }
  return out
}

async function unsafeAffectedPaths($: any, t: any, paths: string[]): Promise<string[]> {
  const unsafe: string[] = []
  let repoReal = t.repoRoot
  try {
    const rootStat = await $.fs.stat(t.repoRoot, { resolve: true })
    if (typeof rootStat?.realPath !== 'string') return [...paths]
    repoReal = rootStat.realPath.replace(/\/$/, '')
  } catch {
    return [...paths]
  }
  for (const rel of paths) {
    const parts = rel.split('/')
    let bad = false
    for (let i = 0; i < parts.length; i++) {
      const spelling = `${t.repoRoot}/${parts.slice(0, i + 1).join('/')}`
      let stat: any
      try {
        stat = await $.fs.stat(spelling, { resolve: true })
      } catch {
        try {
          if (await $.fs.exists(spelling)) bad = true
        } catch {
          bad = true
        }
        if (bad) break
        continue // A missing path component is valid for a new file.
      }
      if (i === parts.length - 1 && stat?.isLink === true) { bad = true; break }
      if (typeof stat?.realPath !== 'string') {
        if (stat?.kind === 'other') {
          try {
            if (!(await $.fs.exists(spelling))) continue
          } catch {
            bad = true
            break
          }
        }
        bad = true
        break
      }
      const real = stat.realPath.replace(/\/$/, '')
      if (real !== repoReal && !real.startsWith(`${repoReal}/`)) { bad = true; break }
    }
    if (bad) unsafe.push(rel)
  }
  return unsafe
}

// The transaction's own patch, measured against the baseline commit.
async function generatePatch($: any, t: any): Promise<string | null> {
  try {
    const diff = await $.process.run(['git', 'diff', t.baselineCommit, '--binary'], { cwd: t.txRoot })
    return diff.exitCode === 0 && diff.isStdoutTruncated !== true ? diff.stdout : null
  } catch {
    return null
  }
}

function safeRepoPath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path) && !path.includes('\0') &&
    !path.split('/').some(part => part === '' || part === '.' || part === '..')
}

async function touchedPaths($: any, t: any): Promise<string[] | null> {
  try {
    const names = await $.process.run(['git', 'diff', '--name-only', t.baselineCommit], { cwd: t.txRoot })
    if (names.exitCode !== 0 || names.isStdoutTruncated === true) return null
    const paths = parseNameOnly(names.stdout)
    return paths.every(safeRepoPath) ? paths : null
  } catch {
    return null
  }
}

async function destroyTx($: any, h: string, txRoot: string, repoRoot: string): Promise<boolean> {
  if (!isOurTxRoot(h, txRoot)) return false
  try {
    const rm = await $.process.run(['git', 'worktree', 'remove', '--force', txRoot], { cwd: repoRoot })
    if (rm.exitCode === 0) return true
    // Best effort: prune stale admin entries so later worktrees list clean.
    await $.process.run(['git', 'worktree', 'prune'], { cwd: repoRoot })
    return false
  } catch {
    return false
  }
}

async function pushHistory($: any, record: HistoryRecord): Promise<void> {
  const list = trimHistory(await $.store.get(historyKey(record.repoRoot)), ctx.options.maxStoredTransactions)
  list.push(record)
  await $.store.set(historyKey(record.repoRoot), trimHistory(list, ctx.options.maxStoredTransactions))
}

async function currentTx($: any): Promise<any | null> {
  if (!ctx.repoRoot) return null
  const saved = await $.store.get(activeKey(ctx.repoRoot))
  const t = recoverableRecord(saved, ctx.repoRoot)
  if (!t) { ctx.tx = null; return null }
  let live = false
  try { live = await $.fs.exists(t.txRoot) } catch { live = false }
  if (!live) { ctx.tx = null; return null }
  ctx.tx = t
  return t
}

function historyOf(t: any, outcome: 'accepted' | 'rejected' | 'aborted', retained: boolean): HistoryRecord {
  return {
    transactionId: t.transactionId,
    turnId: t.turnId,
    repoRoot: t.repoRoot,
    txRoot: retained ? t.txRoot : null,
    baselineCommit: retained ? t.baselineCommit : undefined,
    startedAt: t.startedAt,
    endedAt: Date.now(),
    outcome,
    stats: t.stats,
    retained,
  }
}

// Backup every real-tree file the patch touches (byte-faithful cp, argv
// form); returns which paths existed (backed up) and which are new.
async function backupTouched($: any, t: any, touched: string[]): Promise<{ backedUp: string[]; newFiles: string[]; backupRoot: string } | null> {
  const backupRoot = `${t.txRoot}.backup`
  if (!isOurTxRoot(await home($), backupRoot)) return null
  try {
    // Never reuse a backup path which Bash or an earlier failed attempt
    // could have replaced with a symlink or another filesystem object.
    if (await $.fs.exists(backupRoot)) return null
    const made = await $.process.run(['mkdir', '-p', '--', backupRoot], { cwd: t.repoRoot })
    if (made.exitCode !== 0) return null
    const rootStat = await $.fs.stat(backupRoot, { resolve: true })
    if (rootStat?.kind !== 'dir' || rootStat?.isLink === true || typeof rootStat?.realPath !== 'string') return null
    const txRootStat = await $.fs.stat(t.txRoot, { resolve: true })
    const transactionsStat = await $.fs.stat(transactionsRoot(await home($)), { resolve: true })
    const canonicalTransactionsRoot = typeof transactionsStat?.realPath === 'string' ? transactionsStat.realPath.replace(/\/$/, '') : ''
    if (typeof txRootStat?.realPath !== 'string' || rootStat.realPath !== `${txRootStat.realPath}.backup` || canonicalTransactionsRoot === '' || !rootStat.realPath.startsWith(`${canonicalTransactionsRoot}/`)) return null
  } catch {
    return null
  }
  const backedUp: string[] = []
  const newFiles: string[] = []
  for (const p of touched) {
    let exists = false
    try {
      exists = await $.fs.exists(`${t.repoRoot}/${p}`)
    } catch {
      return null
    }
    if (exists) {
      const parent = parentDirOf(p)
      if (parent !== '') {
        const parentMade = await $.process.run(['mkdir', '-p', '--', `${backupRoot}/${parent}`], { cwd: t.repoRoot })
        if (parentMade.exitCode !== 0) return null
      }
      const cp = await $.process.run(['cp', '-p', '--', `${t.repoRoot}/${p}`, `${backupRoot}/${p}`], { cwd: t.repoRoot })
      if (cp.exitCode !== 0) return null // no faithful backup → refuse to apply
      backedUp.push(p)
    } else {
      newFiles.push(p)
    }
  }
  return { backedUp, newFiles, backupRoot }
}

// Roll back a failed apply: restore the backed-up files byte-for-byte,
// remove files the patch created, report exactly what happened.
async function rollbackApply($: any, t: any, backup: { backedUp: string[]; newFiles: string[]; backupRoot: string }): Promise<{ restored: string[]; removed: string[]; failed: string[] }> {
  const restored: string[] = []
  const removed: string[] = []
  const failed: string[] = []
  for (const p of backup.backedUp) {
    try {
      const cp = await $.process.run(['cp', '-p', '--', `${backup.backupRoot}/${p}`, `${t.repoRoot}/${p}`], { cwd: t.repoRoot })
      if (cp.exitCode === 0) restored.push(p)
      else failed.push(`restore ${p}`)
    } catch {
      failed.push(`restore ${p}`)
    }
  }
  for (const p of backup.newFiles) {
    let exists = false
    try {
      exists = await $.fs.exists(`${t.repoRoot}/${p}`)
    } catch {
      failed.push(`verify removal ${p}`)
      continue
    }
    if (exists) {
      try {
        const rm = await $.process.run(['rm', '--', `${t.repoRoot}/${p}`], { cwd: t.repoRoot })
        if (rm.exitCode === 0) removed.push(p)
        else failed.push(`remove ${p}`)
      } catch {
        failed.push(`remove ${p}`)
      }
    }
  }
  return { restored, removed, failed }
}

export async function onTxStatus($: any, _e: any): Promise<{ text: string }> {
  const t = await currentTx($)
  if (!t) return { text: 'airlock: no open transaction.' }
  const lines = [
    `transaction ${t.transactionId} • ${t.state}`,
    `repo:     ${t.repoRoot}`,
    `worktree: ${t.txRoot}`,
    `base:     ${t.baseHead.slice(0, 10)}${t.baselineCommit !== t.baseHead ? ` (baseline ${t.baselineCommit.slice(0, 10)})` : ''}`,
    `files:    ${t.stats.files} (+${t.stats.insertions}/-${t.stats.deletions})`,
    `bash routed: ${t.bashCalls} · path rewrites: ${t.rewrites} · side-effect events: ${t.sideEffectEvents.length}`,
    `mode: ${ctx.options.mode}`,
  ]
  if (t.untrackedCopied.length > 0) lines.push(`untracked carried into baseline: ${t.untrackedCopied.length}`)
  if (t.skippedFiles.length > 0) lines.push(`untracked skipped (size/symlink/dir): ${t.skippedFiles.join(', ')}`)
  return { text: lines.join('\n') }
}

export async function onTxDiff($: any, _e: any): Promise<{ text: string }> {
  const t = await currentTx($)
  if (!t) return { text: 'airlock: no open transaction.' }
  const patch = await generatePatch($, t)
  return { text: patch === null ? 'airlock: could not read the complete transaction diff.' : patch.slice(0, 8000) || '(no changes in the transaction)' }
}

export async function onTxAccept($: any, _e: any): Promise<{ text: string }> {
  const t = await currentTx($)
  if (!t) return { text: 'airlock: no open transaction.' }
  const h = await home($)
  if (!isOurTxRoot(h, t.txRoot)) {
    return { text: 'airlock: refusing to act on a workspace that is not ours (safety guard).' }
  }
  if (t.state === 'APPLY_FAILED') {
    return { text: 'airlock: this transaction may be partially applied and needs manual recovery; it cannot be accepted again. The workspace and backups are retained.' }
  }
  if (t.state !== 'REVIEW' && t.state !== 'CONFLICTED') {
    return { text: `airlock: transaction is ${t.state}; finish the multi-turn work with /airlock-begin end before accepting.` }
  }

  const patch = await generatePatch($, t)
  if (patch === null) {
    return { text: 'airlock: could not read the complete transaction diff — refusing to accept. The transaction is kept for review.' }
  }
  if (!patch.trim()) {
    const destroyed = await destroyTx($, h, t.txRoot, t.repoRoot)
    await $.store.delete(activeKey(t.repoRoot))
    await $.store.set(multiTurnKey(t.repoRoot), false)
    ctx.multiTurn = false
    ctx.blockedByOtherSession = null
    ctx.tx = null
    await pushHistory($, historyOf(t, 'accepted', !destroyed))
    return { text: `airlock: empty transaction — nothing to apply.${destroyed ? ' Workspace removed.' : ` Workspace retained at ${t.txRoot} because it could not be removed.`}` }
  }

  const touched = await touchedPaths($, t)
  if (touched === null || touched.length === 0) {
    return { text: 'airlock: could not read a complete, safe, nonempty list of changed paths — refusing to accept. The transaction is kept for review.' }
  }

  // Conflict layer 1 (plan §11): the real tree must be byte-identical on
  // every path the baseline fingerprinted that this patch touches. Any
  // drift is a concurrent human edit: never auto-overwrite.
  const unsafe = await unsafeAffectedPaths($, t, touched)
  const expected = await baselineHashes($, t, touched)
  const actual = await currentHashes($, t.repoRoot, touched)
  const drifted = touched.filter(p => unsafe.includes(p) || expected[p] === undefined || actual[p] === undefined || expected[p] !== actual[p])
  if (drifted.length > 0) {
    t.state = 'CONFLICTED'
    await $.store.set(activeKey(t.repoRoot), t)
    return {
      text: `airlock: CONFLICT — these file(s) changed or failed path verification in the real tree since the transaction began:\n  ${drifted.join('\n  ')}\nNothing was applied; the transaction is kept. Review with /airlock-diff, discard with /airlock-reject, or resolve the change and accept again.`,
    }
  }

  // Conflict layer 2: the patch must still fit the real tree.
  const check = await $.process.run(['git', 'apply', '--check', '-'], { cwd: t.repoRoot, stdin: patch })
  if (check.exitCode !== 0) {
    t.state = 'CONFLICTED'
    await $.store.set(activeKey(t.repoRoot), t)
    return {
      text: `airlock: CONFLICT — the real tree changed since the transaction began; nothing was applied and the transaction is kept for review.\n${check.stderr.slice(0, 500)}`,
    }
  }

  // Pre-apply backup (plan §12): if the apply fails midway we restore
  // exactly, leaving no unexplained partial state. Without a faithful
  // backup we refuse to apply at all.
  let backup: Awaited<ReturnType<typeof backupTouched>> = null
  try { backup = await backupTouched($, t, touched) } catch { backup = null }
  if (!backup) {
    t.state = 'CONFLICTED'
    await $.store.set(activeKey(t.repoRoot), t)
    return { text: 'airlock: could not back up the affected files — refusing to apply (fail-safe). The transaction is kept.' }
  }

  // Persist a crash-recovery state before invoking a command that may make
  // partial changes. A process/session death leaves this transaction
  // ineligible for another blind accept.
  t.state = 'APPLY_FAILED'
  await $.store.set(activeKey(t.repoRoot), t)
  let applied: any
  try {
    applied = await $.process.run(['git', 'apply', '-'], { cwd: t.repoRoot, stdin: patch })
  } catch (error) {
    applied = { exitCode: 1, stderr: error instanceof Error ? error.message : 'process.run failed' }
  }
  if (applied.exitCode !== 0) {
    const rolled = await rollbackApply($, t, backup)
    t.state = 'APPLY_FAILED'
    await $.store.set(activeKey(t.repoRoot), t)
    return {
      text: `airlock: apply failed midway${rolled.failed.length === 0 ? ' and was rolled back completely' : ' and rollback was incomplete'}${rolled.restored.length > 0 ? ` — restored ${rolled.restored.join(', ')}` : ''}${rolled.removed.length > 0 ? ` — removed ${rolled.removed.join(', ')}` : ''}${rolled.failed.length > 0 ? ` — manual recovery needed: ${rolled.failed.join(', ')}` : ''}. The transaction and backup ${backup.backupRoot} are kept in APPLY_FAILED for manual recovery.\n${applied.stderr.slice(0, 400)}`,
    }
  }

  const destroyed = await destroyTx($, h, t.txRoot, t.repoRoot)
  // The backup directory is ours by construction; remove it only under
  // the same ownership guard as the workspace itself.
  if (isOurTxRoot(h, backup.backupRoot)) {
    await $.process.run(['rm', '-rf', '--', backup.backupRoot], { cwd: t.repoRoot })
  }
  await $.store.delete(activeKey(t.repoRoot))
  await $.store.set(multiTurnKey(t.repoRoot), false)
  ctx.multiTurn = false
  ctx.blockedByOtherSession = null
  ctx.tx = null
  await pushHistory($, historyOf(t, 'accepted', !destroyed))
  return {
    text: `airlock: applied transaction ${t.transactionId} to the real worktree (${t.stats.files} file(s), +${t.stats.insertions}/-${t.stats.deletions}). Nothing was committed; changes are unstaged.${destroyed ? '' : ` The transaction workspace is retained at ${t.txRoot} because it could not be removed.`}`,
  }
}

export async function onTxReject($: any, _e: any): Promise<{ text: string }> {
  const t = await currentTx($)
  if (!t) return { text: 'airlock: no open transaction.' }
  const h = await home($)
  if (!isOurTxRoot(h, t.txRoot)) {
    return { text: 'airlock: refusing to act on a workspace that is not ours (safety guard).' }
  }

  if (ctx.options.retainRejectedTransactions) {
    // Keep the worktree and the diff on disk for later inspection.
    t.state = 'REJECTED'
    await $.store.delete(activeKey(t.repoRoot))
    await $.store.set(multiTurnKey(t.repoRoot), false)
    ctx.multiTurn = false
    ctx.blockedByOtherSession = null
    ctx.tx = null
    await pushHistory($, historyOf(t, 'rejected', true))
    return {
      text: `airlock: transaction ${t.transactionId} rejected. No patch is applied by this action; the workspace is retained at ${t.txRoot} for inspection.`,
    }
  }

  const destroyed = await destroyTx($, h, t.txRoot, t.repoRoot)
  await $.store.delete(activeKey(t.repoRoot))
  await $.store.set(multiTurnKey(t.repoRoot), false)
  ctx.multiTurn = false
  ctx.blockedByOtherSession = null
  ctx.tx = null
  await pushHistory($, historyOf(t, 'rejected', !destroyed))
  return {
    text: destroyed
      ? 'airlock: transaction rejected and destroyed. This action did not apply a patch. Effects outside the workspace are not undone.'
      : 'airlock: transaction rejected; the worktree could not be removed automatically (kept for manual cleanup).',
  }
}

// /airlock-abort (plan §17): the in-flight discard — same guarantee as
// reject (discard without applying a patch), taken before review rather
// than after. Idempotent.
export async function onTxAbort($: any, _e: any): Promise<{ text: string }> {
  const t = await currentTx($)
  if (!t) {
    if (ctx.repoRoot) await $.store.set(multiTurnKey(ctx.repoRoot), false)
    ctx.multiTurn = false
    return { text: 'airlock: no open transaction; pending multi-turn mode cleared.' }
  }
  const h = await home($)
  if (!isOurTxRoot(h, t.txRoot)) {
    return { text: 'airlock: refusing to act on a workspace that is not ours (safety guard).' }
  }

  if (ctx.options.retainRejectedTransactions) {
    t.state = 'ABORTED'
    await $.store.delete(activeKey(t.repoRoot))
    await $.store.set(multiTurnKey(t.repoRoot), false)
    ctx.multiTurn = false
    ctx.blockedByOtherSession = null
    ctx.tx = null
    $.ui.status(undefined)
    await pushHistory($, historyOf(t, 'aborted', true))
    return {
      text: `airlock: transaction ${t.transactionId} aborted. No patch is applied by this action; the workspace is retained at ${t.txRoot} for inspection.`,
    }
  }

  const destroyed = await destroyTx($, h, t.txRoot, t.repoRoot)
  await $.store.delete(activeKey(t.repoRoot))
  await $.store.set(multiTurnKey(t.repoRoot), false)
  ctx.multiTurn = false
  ctx.blockedByOtherSession = null
  ctx.tx = null
  $.ui.status(undefined)
  await pushHistory($, historyOf(t, 'aborted', !destroyed))
  return {
    text: destroyed
      ? 'airlock: transaction aborted and destroyed. This action did not apply a patch. Effects outside the workspace are not undone.'
      : 'airlock: transaction aborted; the worktree could not be removed automatically (kept for manual cleanup with /airlock-cleanup).',
  }
}

// /airlock-cleanup (plan §17): stale workspaces under our transactions
// root. Report-only by default (recovery favors preserving data, plan
// §21); `purge` removes them — never anything outside ~/.claude-airlock
// and never the current transaction (or its pre-apply backup directory).
export async function onTxCleanup($: any, e: any): Promise<{ text: string }> {
  const h = await home($)
  const root = transactionsRoot(h)
  const purge = typeof e?.args === 'string' && e.args.includes('purge')

  // Cleanup must never remove a workspace owned by any repository record.
  const protectedRoots = new Set<string>()
  for (const key of await $.store.keys()) {
    if (!key.endsWith(':active') && key !== LEGACY_ACTIVE_KEY) continue
    const saved = await $.store.get(key) as { txRoot?: unknown } | undefined
    if (!saved || typeof saved.txRoot !== 'string') continue
    let live = true
    try { live = await $.fs.exists(saved.txRoot) } catch { live = true }
    if (live) protectedRoots.add(saved.txRoot)
    else await $.store.delete(key)
  }

  let entries: Array<{ name: string }> = []
  try {
    entries = (await $.fs.list(root)) as Array<{ name: string }>
  } catch {
    return { text: 'airlock: no transactions directory yet — nothing to clean.' }
  }

  const stale: Array<{ path: string; mtimeMs: number }> = []
  for (const en of entries ?? []) {
    const path = `${root}/${en.name}`
    if (protectedRoots.has(path) || [...protectedRoots].some(active => `${active}.backup` === path)) continue
    if (!isOurTxRoot(h, path)) continue // never touch anything not directly ours
    let mtimeMs = 0
    try {
      const st = await $.fs.stat(path)
      mtimeMs = typeof st?.mtimeMs === 'number' ? st.mtimeMs : 0
    } catch {
      mtimeMs = 0
    }
    stale.push({ path, mtimeMs })
  }

  if (stale.length === 0) {
    return { text: 'airlock: no stale workspaces (the open transaction, if any, is excluded).' }
  }

  if (!purge) {
    const lines = stale.map(s => {
      const age = s.mtimeMs > 0 ? `${Math.max(1, Math.round((Date.now() - s.mtimeMs) / 60000))} min old` : 'unknown age'
      return `  ${s.path} (${age})`
    })
    return {
      text: `airlock: ${stale.length} stale workspace(s):\n${lines.join('\n')}\nNothing was removed. Run /airlock-cleanup purge to remove them.`,
    }
  }

  const removed: string[] = []
  const failed: string[] = []
  for (const s of stale) {
    let gone = false
    // Real git refuses `worktree remove` on the worktree the command
    // itself runs in, so resolve the main repository first and remove
    // from there — this also cleans the worktree's admin entry.
    const common = await $.process.run(['git', '-C', s.path, 'rev-parse', '--git-common-dir'])
    if (common.exitCode === 0) {
      let dir = common.stdout.trim()
      if (dir !== '' && !dir.startsWith('/')) dir = `${s.path}/${dir}`
      const mainRepo = dir.replace(/\/\.git$/, '').replace(/\/$/, '')
      if (mainRepo !== '' && isOurTxRoot(h, s.path)) {
        const rm = await $.process.run(['git', '-C', mainRepo, 'worktree', 'remove', '--force', s.path])
        if (rm.exitCode === 0) gone = true
      }
    }
    if (!gone) {
      // Not a live worktree (a pruned admin entry, a backup directory):
      // remove directly — the ownership guard already proved it is ours.
      const rmrf = await $.process.run(['rm', '-rf', '--', s.path])
      if (rmrf.exitCode === 0) gone = true
    }
    if (gone) removed.push(s.path)
    else failed.push(s.path)
  }

  const parts = [`airlock: cleanup removed ${removed.length} workspace(s).`]
  if (failed.length > 0) parts.push(`Could not remove (manual inspection needed):\n  ${failed.join('\n  ')}`)
  return { text: parts.join('\n') }
}

// /airlock-history (plan §17): the bounded ring of finished transactions.
export async function onTxHistory($: any, _e: any): Promise<{ text: string }> {
  if (!ctx.repoRoot) return { text: 'airlock: transaction history is available only inside a git repository.' }
  const list = trimHistory(await $.store.get(historyKey(ctx.repoRoot)), ctx.options.maxStoredTransactions)
  if (list.length === 0) return { text: 'airlock: no transaction history yet.' }
  const lines = list.slice(-20).map(r => {
    const when = new Date(r.startedAt).toISOString()
    const tail = r.retained && r.txRoot !== null ? ` • retained: ${r.txRoot}` : ''
    return `${r.transactionId} • ${r.outcome} • ${r.stats.files} file(s) +${r.stats.insertions}/-${r.stats.deletions} • ${when}${tail}`
  })
  return { text: `airlock: last ${lines.length} transaction(s):\n${lines.join('\n')}` }
}

export async function onTxMode($: any, e: any): Promise<{ text: string }> {
  const arg = typeof e?.args === 'string' ? e.args.trim().toLowerCase() : ''
  if (!ctx.repoRoot) return { text: 'airlock: safety mode is available only inside a git repository.' }
  if (arg === '') {
    const saved = await $.store.get(modeKey(ctx.repoRoot))
    if (saved === 'strict' || saved === 'balanced' || saved === 'permissive') ctx.options.mode = saved
    return { text: `airlock: mode for ${ctx.repoRoot}: ${ctx.options.mode}. Set with /airlock-mode strict|balanced|permissive.` }
  }
  if (arg !== 'strict' && arg !== 'balanced' && arg !== 'permissive') return { text: 'airlock: mode must be strict, balanced, or permissive.' }
  ctx.options.mode = arg
  await $.store.set(modeKey(ctx.repoRoot), arg)
  return { text: `airlock: mode for ${ctx.repoRoot} set to ${arg}.` }
}

export async function onTxBegin($: any, e: any): Promise<{ text: string }> {
  const arg = typeof e?.args === 'string' ? e.args.trim().toLowerCase() : ''
  if (!ctx.repoRoot) return { text: 'airlock: multi-turn transactions are available only inside a git repository.' }
  if (arg !== '' && arg !== 'end' && arg !== 'review') return { text: 'airlock: use /airlock-begin to enable multi-turn mode or /airlock-begin end to open the current transaction for review.' }
  const t = await currentTx($)
  if (arg === 'end' || arg === 'review') {
    if (!t) return { text: 'airlock: no open multi-turn transaction.' }
    if (t.state !== 'ACTIVE') return { text: `airlock: transaction is ${t.state}; use /airlock-accept or /airlock-reject.` }
    let stat: any
    try {
      const added = await $.process.run(['git', 'add', '-A'], { cwd: t.txRoot })
      if (added.exitCode !== 0 || added.isStdoutTruncated === true) {
        return { text: 'airlock: could not stage the complete multi-turn workspace; it remains ACTIVE. Retry /airlock-begin end after resolving the Git error.' }
      }
      stat = await $.process.run(['git', 'diff', t.baselineCommit, '--numstat'], { cwd: t.txRoot })
    } catch {
      return { text: 'airlock: Git failed while preparing multi-turn review; the transaction remains ACTIVE.' }
    }
    if (stat.exitCode !== 0 || stat.isStdoutTruncated === true) {
      return { text: 'airlock: could not read complete multi-turn change statistics; the transaction remains ACTIVE.' }
    }
    const parsed = parseNumstat(stat.stdout)
    t.changedFiles = parsed.changedFiles
    t.stats = { files: parsed.files, insertions: parsed.insertions, deletions: parsed.deletions }
    t.state = 'REVIEW'
    t.multiTurn = false
    ctx.multiTurn = false
    await $.store.set(multiTurnKey(ctx.repoRoot), false)
    await $.store.set(activeKey(ctx.repoRoot), t)
    if (ctx.isInteractive) await $.ui.open({ id: 'airlock-review', title: 'Airlock review', rows: 12 })
    return { text: `airlock: multi-turn transaction ${t.transactionId} is ready for review (${parsed.files} file(s)). Use /airlock-accept or /airlock-reject.` }
  }
  if (t && t.state !== 'ACTIVE') return { text: `airlock: transaction is ${t.state}; resolve it before enabling multi-turn mode.` }
  if (t?.state === 'ACTIVE') {
    t.multiTurn = true
    ctx.multiTurn = true
    await $.store.set(multiTurnKey(ctx.repoRoot), true)
    await $.store.set(activeKey(ctx.repoRoot), t)
    return { text: `airlock: transaction ${t.transactionId} will stay open across turns. Use /airlock-begin end when ready for review.` }
  }
  ctx.multiTurn = true
  await $.store.set(multiTurnKey(ctx.repoRoot), true)
  return { text: 'airlock: multi-turn mode enabled for this repository. The next coding turn opens a transaction that remains active across turns; use /airlock-begin end to review it.' }
}

export async function onTxRejected($: any, _e: any): Promise<{ text: string }> {
  if (!ctx.repoRoot) return { text: 'airlock: retained transactions are available only inside a git repository.' }
  const list = trimHistory(await $.store.get(historyKey(ctx.repoRoot)), ctx.options.maxStoredTransactions)
  const requested = typeof _e?.args === 'string' ? _e.args.trim() : ''
  const retained = list.filter(r => r.outcome === 'rejected' && r.retained && (requested === '' || r.transactionId === requested))
  if (retained.length === 0) return { text: 'airlock: no retained rejected transactions for this repository.' }
  if (requested !== '') {
    const record = retained[0]
    if (!record.txRoot || record.repoRoot !== ctx.repoRoot || !isOurTxRoot(await home($), record.txRoot)) {
      return { text: 'airlock: retained workspace path failed its repository ownership check.' }
    }
    let live = false
    try { live = await $.fs.exists(record.txRoot) } catch { live = false }
    if (!live) return { text: 'airlock: retained workspace is no longer available.' }
    const base = typeof record.baselineCommit === 'string' && record.baselineCommit !== '' ? record.baselineCommit : 'HEAD'
    const diff = await $.process.run(['git', 'diff', base, '--binary'], { cwd: record.txRoot })
    if (diff.exitCode !== 0) return { text: 'airlock: could not read retained transaction diff.' }
    return { text: diff.stdout.length > 8000 ? `${diff.stdout.slice(0, 8000)}\n\n[diff truncated at 8000 characters]` : diff.stdout || '(no changes in retained transaction)' }
  }
  return { text: `airlock: retained rejected transactions (use /airlock-rejected <transaction-id> to inspect):\n${retained.map(r => `  ${r.transactionId} • ${r.txRoot}`).join('\n')}` }
}

export async function onTxReview($: any, _e: any): Promise<{ text: string }> {
  const t = await currentTx($)
  if (!t) return { text: 'airlock: no open transaction to review.' }
  if (t.state === 'ACTIVE') {
    return { text: 'airlock: this transaction is still ACTIVE. Finish the work with /airlock-begin end before opening it for review.' }
  }
  if (t.state !== 'REVIEW' && t.state !== 'CONFLICTED' && t.state !== 'APPLY_FAILED') {
    return { text: `airlock: transaction is ${t.state}; there is no open review to show.` }
  }
  if (!ctx.isInteractive) {
    return { text: 'airlock: the review pane needs an interactive session. Use /airlock-diff to inspect the transaction here.' }
  }

  const opened = await $.ui.open({ id: REVIEW_PANE, title: 'Airlock review', focus: true, rows: 12 })
  if (!opened?.isPlaced) {
    const reason = typeof opened?.reason === 'string' && opened.reason !== '' ? ` (${opened.reason})` : ''
    return { text: `airlock: could not place the review pane${reason}. Use /airlock-diff to inspect the transaction.` }
  }
  if (t.state === 'APPLY_FAILED') {
    return { text: `airlock: opened inspection for transaction ${t.transactionId} in APPLY_FAILED. Keep the workspace and backup for manual recovery; Airlock will not retry this apply.` }
  }
  return { text: `airlock: opened review for transaction ${t.transactionId} (${t.state}). Accept checks concurrent edits and patch fit; it does not run project tests.` }
}

// Pane handlers share this file with command handlers so the engine can
// track every $ call and button actions use the same accept/reject logic.
const REVIEW_PANE = 'airlock-review'

type ReviewTransaction = {
  transactionId?: string
  repoRoot?: string
  txRoot?: string
  baseHead?: string
  baselineCommit?: string
  state?: string
  changedFiles?: string[]
  skippedFiles?: string[]
  untrackedCopied?: string[]
  stats?: { files?: number; insertions?: number; deletions?: number }
  sideEffectEvents?: Array<{ pattern?: string; action?: string; reason?: string }>
}

async function storedTransaction($: any): Promise<ReviewTransaction | null> {
  if (!ctx.repoRoot) return null
  const value = await $.store.get(activeKey(ctx.repoRoot))
  return value && typeof value === 'object' ? value as ReviewTransaction : null
}

function diffKey(repoRoot: string): string { return `airlock:${repoRoot}:review-diff` }

async function isCurrentReview($: any, transactionId: string): Promise<boolean> {
  const latest = await storedTransaction($)
  if (latest?.transactionId === transactionId) return true
  $.ui.toast('This review pane is stale. Open the current transaction review before acting.')
  $.ui.invalidate('ui.render')
  return false
}

export async function onReviewRender($: any, e: any): Promise<unknown> {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const tx = await storedTransaction($)
  if (!tx) return <Box flexDirection="column"><Text>Airlock has no open transaction for this repository.</Text></Box>

  const stats = tx.stats ?? {}
  const files = Array.isArray(tx.changedFiles) ? tx.changedFiles : []
  const skipped = Array.isArray(tx.skippedFiles) ? tx.skippedFiles : []
  const untracked = Array.isArray(tx.untrackedCopied) ? tx.untrackedCopied : []
  const effects = Array.isArray(tx.sideEffectEvents) ? tx.sideEffectEvents : []
  const savedDiff = await $.store.get(diffKey(ctx.repoRoot)) as { transactionId?: string; text?: string; truncated?: boolean } | undefined
  const currentDiff = savedDiff?.transactionId === tx.transactionId ? savedDiff : undefined

  return (
    <Box flexDirection="column">
      <Text>Transaction {tx.transactionId ?? '(unknown)'} · {tx.state ?? 'REVIEW'}</Text>
      <Text dimColor>Repository: {tx.repoRoot ?? ctx.repoRoot}</Text>
      <Text dimColor>Worktree: {tx.txRoot}</Text>
      <Text>Changes: {stats.files ?? files.length} file(s), +{stats.insertions ?? 0}/-{stats.deletions ?? 0}</Text>
      {files.length > 0 && <Text>Files: {files.slice(0, 8).join(', ')}{files.length > 8 ? ` and ${files.length - 8} more` : ''}</Text>}
      {untracked.length > 0 && <Text dimColor>Untracked files included in baseline: {untracked.length}</Text>}
      {skipped.length > 0 && <Text dimColor>Skipped files: {skipped.join(', ')}</Text>}
      {effects.length > 0 && <Text dimColor>Side-effect events: {effects.length} ({effects.filter(x => x.action === 'denied').length} denied). Effects already performed outside the workspace cannot be rolled back by reject.</Text>}
      <Text dimColor>Checks: Airlock does not run your project test suite. Accept checks concurrent edits and patch fit before applying. Reject discards this worktree.</Text>
      {tx.state === 'APPLY_FAILED' && <Text>APPLY_FAILED: this transaction may be partially applied. Preserve the workspace and backup for manual recovery; Accept cannot retry this apply.</Text>}
      {typeof currentDiff?.text === 'string' && currentDiff.text !== '' && (currentDiff.truncated
        ? <Box flexDirection="column"><Text dimColor>Pane preview is capped at 10,000 characters; the diff may be incomplete.</Text><Code source={currentDiff.text} /></Box>
        : <Code source={currentDiff.text} format="diff" />)}
      <Box flexDirection="row">
        <Button key="review-diff" label="Review" hotkey="v" onPress={async () => {
          if (!(await isCurrentReview($, tx.transactionId ?? ''))) return
          const patch = await $.process.run(['git', 'diff', tx.baselineCommit ?? tx.baseHead ?? 'HEAD', '--binary'], { cwd: tx.txRoot })
          const latest = await storedTransaction($)
          if (latest?.transactionId !== tx.transactionId) return
          const text = patch.exitCode === 0 ? patch.stdout : `Could not read the transaction diff (exit code ${patch.exitCode ?? 'unknown'}).`
          await $.store.set(diffKey(ctx.repoRoot), {
            transactionId: tx.transactionId,
            text: text.slice(0, 10000),
            truncated: patch.isStdoutTruncated || text.length > 10000,
          })
          $.ui.invalidate('ui.render')
        }} />
        <Button key="accept" label="Accept" hotkey="a" variant="primary" onPress={async e => {
          if (!(await isCurrentReview($, tx.transactionId ?? ''))) return
          const result: any = await onTxAccept($, {})
          $.ui.toast(result?.text?.split('\n')[0] ?? 'Airlock accept finished.', { timeoutMs: 6000 })
          if (await $.store.get(activeKey(ctx.repoRoot)) === undefined) await $.ui.close({ id: REVIEW_PANE })
          else $.ui.invalidate('ui.render')
        }} />
        <Button key="reject" label="Reject" hotkey="r" variant="secondary" onPress={async e => {
          if (!(await isCurrentReview($, tx.transactionId ?? ''))) return
          const result: any = await onTxReject($, {})
          $.ui.toast(result?.text?.split('\n')[0] ?? 'Airlock reject finished.', { timeoutMs: 6000 })
          if (await $.store.get(activeKey(ctx.repoRoot)) === undefined) await $.ui.close({ id: REVIEW_PANE })
          else $.ui.invalidate('ui.render')
        }} />
      </Box>
    </Box>
  )
}
