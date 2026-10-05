// Turn lifecycle (plan §8, §10): turn.start opens the transaction (one
// typed main-loop prompt → one transaction) and builds the baseline —
// the user's tracked-dirty changes and non-ignored untracked files are
// reproduced inside the worktree, then committed there as an ephemeral
// baseline so Claude's diff never includes the user's pre-existing work.
// turn.complete gathers stats against that baseline and moves to REVIEW.
// All engine calls are made here, in full ($.noun.event(...)) — the
// validator follows $ only within one file.

import { ctx, activeKey, recoverableRecord, multiTurnKey, LEGACY_ACTIVE_KEY } from './state.ts'
import type { TransactionRecord } from './state.ts'
import { txidFor, txRootFor } from './workspace.ts'
import { parseNumstat, parseNameOnly, parentDirOf } from './patch.ts'

// $.fs.read caps at 4 MiB; an untracked file above that is skipped and
// recorded rather than half-copied (plan §23: keep startup lightweight).
const MAX_COPY_BYTES = 4 * 1024 * 1024
// `git hash-object <path>` cannot hash a missing file. Keep absence distinct
// from every valid object id so accept can compare a deleted baseline safely.
const ABSENT_BASELINE = 'airlock:absent'

// Core has already shown the answer. Preserve a distinct completion notice
// supplied by another hook, but do not replay the answer in our plugin row.
// Notification rows sanitize controls; keep any forwarded notice on one line.
function completionNotice(previous: string, answer: string, notice: string): string {
  if (!previous || previous === answer) return notice
  return `${previous.replace(/[\x00-\x1f\x7f]/g, ' ')} | ${notice}`
}

async function home($: any): Promise<string> {
  const h = await $.env.get('HOME')
  return typeof h === 'string' && h.length > 0 ? h : '/tmp'
}

// Real-tree blob hashes for the paths the baseline touches (conflict
// layer 1, plan §11). One hash-object --stdin-paths batch; per-file
// fallback when the batch fails or comes back short.
async function hashPaths($: any, repoRoot: string, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (paths.length === 0) return out
  const hashOne = async (p: string): Promise<string> => {
    const one = await $.process.run(['git', 'hash-object', '--', p], { cwd: repoRoot })
    if (one.exitCode === 0 && !one.isStdoutTruncated && one.stdout.trim() !== '') return one.stdout.trim()
    let exists: boolean
    try {
      exists = await $.fs.exists(`${repoRoot}/${p}`)
    } catch {
      throw new Error(`could not inspect baseline path ${p}`)
    }
    if (!exists) return ABSENT_BASELINE
    throw new Error(`could not fingerprint baseline path ${p}`)
  }
  // `--stdin-paths` is newline-delimited, so it cannot represent a path
  // containing a literal newline. Quoting and backslashes are also kept in
  // argv form to avoid ambiguity in Git's path parsing.
  if (paths.some(p => /["\\\r\n]/.test(p))) {
    for (const p of paths) out[p] = await hashOne(p)
    return out
  }
  const batch = await $.process.run(['git', 'hash-object', '--stdin-paths'], {
    cwd: repoRoot,
    stdin: `${paths.join('\n')}\n`,
  })
  const lines = batch.stdout.split('\n').map(s => s.trim()).filter(s => s !== '')
  if (batch.exitCode === 0 && !batch.isStdoutTruncated && lines.length === paths.length) {
    for (let i = 0; i < paths.length; i++) out[paths[i]] = lines[i]
    return out
  }
  for (const p of paths) out[p] = await hashOne(p)
  return out
}

// Copy non-ignored untracked files into the worktree. Copied by argv
// (`cp -p`) rather than $.fs.read+$.fs.write on purpose: $.fs.write is
// text-only and would corrupt binary files, and the bytes of a bad copy
// would ride into the patch applied to the real tree on accept. Files
// that cannot be copied faithfully are skipped and recorded, never fatal.
async function copyUntracked($: any, repoRoot: string, txRoot: string): Promise<{ copied: string[]; skipped: string[] }> {
  const ls = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard'], { cwd: repoRoot })
  if (ls.exitCode !== 0 || ls.isStdoutTruncated) throw new Error(`untracked-file listing failed${ls.isStdoutTruncated ? ' (output truncated)' : ` (exit ${ls.exitCode})`}`)
  const paths = parseNameOnly(ls.stdout)
  const copied: string[] = []
  const skipped: string[] = []
  for (const rel of paths) {
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      skipped.push(rel) // not a sane repo-relative path; never touch it
      continue
    }
    let st: { kind: string; size: number; isLink: boolean } | null = null
    try {
      st = await $.fs.stat(`${repoRoot}/${rel}`)
    } catch {
      st = null
    }
    // Skip symlinks (they may lead outside the repo, plan §22), dirs and
    // anything oversized.
    if (!st || st.kind !== 'file' || st.isLink || st.size > MAX_COPY_BYTES) {
      skipped.push(rel)
      continue
    }
    const parent = parentDirOf(rel)
    if (parent !== '') {
      await $.process.run(['mkdir', '-p', '--', `${txRoot}/${parent}`], { cwd: repoRoot })
    }
    const cp = await $.process.run(['cp', '-p', '--', `${repoRoot}/${rel}`, `${txRoot}/${rel}`], { cwd: repoRoot })
    if (cp.exitCode !== 0) {
      skipped.push(rel)
      continue
    }
    copied.push(rel)
  }
  return { copied, skipped }
}

// Creates the worktree and its baseline; resolves null when any step
// failed (the caller then fails safe: block mutations, never edit the
// real tree). The worktree is removed on failure so nothing is leaked.
async function createTx($: any, repoRoot: string, turnId: string, sessionId: string): Promise<TransactionRecord | null> {
  const h = await home($)
  const txid = txidFor(turnId)
  const txRoot = txRootFor(h, repoRoot, txid)
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot })
  if (head.exitCode !== 0) return null
  const add = await $.process.run(['git', 'worktree', 'add', '--detach', txRoot, 'HEAD'], {
    cwd: repoRoot,
    timeoutMs: 60000,
  })
  if (add.exitCode !== 0) return null
  try {
    // 1. The user's tracked changes (staged + unstaged vs HEAD)…
    const dirty = await $.process.run(['git', 'diff', 'HEAD', '--binary'], { cwd: repoRoot })
    if (dirty.exitCode !== 0 || dirty.isStdoutTruncated) {
      throw new Error(`tracked-change diff failed${dirty.isStdoutTruncated ? ' (output truncated)' : ` (exit ${dirty.exitCode})`}`)
    }
    const dirtyPatch = dirty.stdout
    // …reproduced inside the worktree. If they will not apply, there is
    // no faithful baseline: fail safe, destroy the workspace.
    if (dirtyPatch.trim() !== '') {
      const applied = await $.process.run(['git', 'apply', '--binary', '-'], { cwd: txRoot, stdin: dirtyPatch })
      if (applied.exitCode !== 0) throw new Error(`baseline apply failed: ${applied.stderr.slice(0, 200)}`)
    }
    // 2. Non-ignored untracked files, copied in (skips are recorded).
    const un = ctx.options.includeUntracked
      ? await copyUntracked($, repoRoot, txRoot)
      : { copied: [] as string[], skipped: [] as string[] }
    // 3. Fingerprint the real paths the baseline touched.
    const names = await $.process.run(['git', 'diff', 'HEAD', '--name-only'], { cwd: repoRoot })
    if (names.exitCode !== 0 || names.isStdoutTruncated) {
      throw new Error(`changed-file listing failed${names.isStdoutTruncated ? ' (output truncated)' : ` (exit ${names.exitCode})`}`)
    }
    const dirtyPaths = dirtyPatch.trim() !== '' ? parseNameOnly(names.stdout) : []
    const fingerprint = await hashPaths($, repoRoot, [...dirtyPaths, ...un.copied])
    // 4. The ephemeral baseline commit — skipped entirely on a clean tree
    //    (fast path: baselineCommit is HEAD, no extra git calls).
    let baselineCommit = head.stdout.trim()
    if (dirtyPatch.trim() !== '' || un.copied.length > 0) {
      const staged = await $.process.run(['git', 'add', '-A'], { cwd: txRoot })
      if (staged.exitCode !== 0 || staged.isStderrTruncated) throw new Error(`baseline staging failed${staged.isStderrTruncated ? ' (error output truncated)' : ` (exit ${staged.exitCode})`}`)
      // NB: `-c key=value` config overrides must precede the subcommand —
      // after `commit`, `-c` means "reuse message from commit <commit>".
      const commit = await $.process.run(
        ['git', '-c', 'user.name=airlock', '-c', 'user.email=airlock@localhost', 'commit', '-m', 'airlock baseline'],
        { cwd: txRoot },
      )
      if (commit.exitCode !== 0) throw new Error(`baseline commit failed: ${commit.stderr.slice(0, 200)}`)
      const base = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: txRoot })
      if (base.exitCode !== 0) throw new Error('baseline rev-parse failed')
      baselineCommit = base.stdout.trim()
    }
    return {
      transactionId: txid,
      sessionId,
      turnId,
      repoRoot,
      txRoot,
      startedAt: Date.now(),
      baseHead: head.stdout.trim(),
      baselineCommit,
      baselineFingerprint: fingerprint,
      untrackedCopied: un.copied,
      skippedFiles: un.skipped,
      state: 'ACTIVE',
      changedFiles: [],
      stats: { files: 0, insertions: 0, deletions: 0 },
      sideEffectEvents: [],
      bashCalls: 0,
      rewrites: 0,
    }
  } catch (_err) {
    // Fail safe (plan §24): remove the half-built workspace; the caller
    // blocks mutations rather than edit the real tree un-isolated.
    await $.process.run(['git', 'worktree', 'remove', '--force', txRoot], { cwd: repoRoot })
    await $.process.run(['git', 'worktree', 'prune'], { cwd: repoRoot })
    return null
  }
}

export async function onTurnStart($: any, e: any, next: any): Promise<unknown> {
  if (ctx.isolationFailed || !ctx.repoRoot) return next(e)
  if (!e.text) return next(e) // a turn with no typed prompt (command output, continuations)

  let sessionId = ''
  try {
    sessionId = await $.session.id()
  } catch {
    sessionId = ''
  }

  // Multi-session guard (self-healing): the machine shares one
  // active-transaction record. When another session owns it for THIS repo
  // and its workspace still exists, refuse to open a second one — two
  // loops writing one worktree cannot be tracked. Mutations are denied
  // (not fail-safe-blocked: the other session's transaction is healthy)
  // until that session accepts or aborts; every later turn re-checks, so
  // the block lifts itself once the record is resolved. A record whose
  // workspace is gone is stale: clear it and go on.
  const key = activeKey(ctx.repoRoot)
  let saved = await $.store.get(key)
  if (saved === undefined) {
    const legacy = await $.store.get(LEGACY_ACTIVE_KEY)
    const candidate = recoverableRecord(legacy, ctx.repoRoot)
    if (candidate) { saved = candidate; await $.store.set(key, candidate); await $.store.delete(LEGACY_ACTIVE_KEY) }
  }
  const foreign = recoverableRecord(saved, ctx.repoRoot)
  if (foreign && foreign.sessionId === sessionId && foreign.multiTurn === true && foreign.state === 'ACTIVE') {
    ctx.tx = foreign
    ctx.blockedByOtherSession = null
    return next(e)
  }
  if (foreign && foreign.sessionId === sessionId) {
    ctx.tx = null
    ctx.blockedByOtherSession = `${foreign.state === 'ACTIVE' ? 'unfinished' : 'review pending'} (${foreign.transactionId})`
    return next(e)
  }
  if (foreign && foreign.sessionId !== sessionId) {
    ctx.tx = null
    let live = false
    try {
      live = await $.fs.exists(foreign.txRoot)
    } catch {
      live = false
    }
    if (live) {
      if (ctx.blockedByOtherSession === null) {
        $.ui.status(`airlock: transaction ${foreign.transactionId} is open in another session — mutations blocked here`)
      }
      ctx.blockedByOtherSession = `session ${foreign.sessionId}`
      return next(e)
    }
    await $.store.delete(key)
  }

  // Reached when no other session holds the record (or its workspace was
  // a stale ghost just cleared above): any earlier block lifts.
  ctx.blockedByOtherSession = null

  ctx.tx = null
  const optedIn = ctx.multiTurn || await $.store.get(multiTurnKey(ctx.repoRoot)) === true
  ctx.multiTurn = optedIn
  const record = await createTx($, ctx.repoRoot, e.turnId, sessionId)
  if (record) record.multiTurn = optedIn
  if (!record) {
    // Fail safe (plan §24): no isolation, so mutations are blocked for
    // the rest of the session rather than silently hitting the real tree.
    ctx.isolationFailed = true
    $.ui.status('airlock: isolation unavailable — mutations blocked (fail-safe)')
    return next(e)
  }
  ctx.tx = record
  await $.store.set(key, record)
  $.ui.status(`AIRLOCK ${record.transactionId} • ACTIVE (mode: ${ctx.options.mode})`)
  return next(e)
}

export async function onTurnComplete($: any, e: any, next: any): Promise<unknown> {
  const t = ctx.tx
  if (!t || e.agentId) return next(e) // subagent turns roll into the same transaction

  // Commands can resolve or replace this transaction while a turn is in
  // flight. Read the persisted owner before writing it back so completion
  // cannot resurrect a transaction that was just aborted or replaced.
  let persisted: any
  try {
    persisted = await $.store.get(activeKey(t.repoRoot))
  } catch {
    const message = 'airlock: could not verify the active transaction record; it remains unresolved.'
    $.ui.status(message)
    const r = await next(e)
    return { ...r, text: completionNotice(r.text, e.answer, message) }
  }
  if (!persisted || persisted.transactionId !== t.transactionId || persisted.state !== 'ACTIVE' || t.state !== 'ACTIVE') {
    if (ctx.tx?.transactionId === t.transactionId) ctx.tx = null
    return next(e)
  }

  if (t.multiTurn === true) {
    await $.store.set(activeKey(t.repoRoot), t)
    return next(e)
  }

  // Stage everything inside the worktree (its own index — the real repo's
  // staging area is untouched) so new and deleted files are in the patch.
  const staged = await $.process.run(['git', 'add', '-A'], { cwd: t.txRoot })
  if (staged.exitCode !== 0 || staged.isStderrTruncated) {
    t.state = 'ACTIVE'
    await $.store.set(activeKey(t.repoRoot), t)
    const message = `airlock: could not stage the transaction for review${staged.isStderrTruncated ? ' (git error output was truncated)' : ` (git exit ${staged.exitCode})`}. The transaction remains ACTIVE and was not accepted.`
    $.ui.status(message)
    const r = await next(e)
    return { ...r, text: completionNotice(r.text, e.answer, message) }
  }

  // Stats are measured against the baseline, never HEAD: on a dirty tree
  // the user's pre-existing work must not appear in this transaction.
  const numstat = await $.process.run(['git', 'diff', t.baselineCommit, '--numstat'], { cwd: t.txRoot })
  if (numstat.exitCode !== 0 || numstat.isStdoutTruncated) {
    t.state = 'ACTIVE'
    await $.store.set(activeKey(t.repoRoot), t)
    const message = `airlock: could not read complete transaction stats${numstat.isStdoutTruncated ? ' (output truncated)' : ` (git exit ${numstat.exitCode})`}. The transaction remains ACTIVE and was not accepted.`
    $.ui.status(message)
    const r = await next(e)
    return { ...r, text: completionNotice(r.text, e.answer, message) }
  }
  const stat = numstat.exitCode === 0
    ? parseNumstat(numstat.stdout)
    : { files: 0, insertions: 0, deletions: 0, changedFiles: [] as string[] }
  t.changedFiles = stat.changedFiles
  t.stats = { files: stat.files, insertions: stat.insertions, deletions: stat.deletions }
  t.state = 'REVIEW'
  await $.store.set(activeKey(t.repoRoot), t)
  $.ui.status(undefined)
  if (ctx.isInteractive) {
    const opened = await $.ui.open({ id: 'airlock-review', title: 'Airlock review', rows: 12 })
    if (!opened.isPlaced) $.ui.toast('Airlock review is ready; use /airlock-review to open the pane, or /airlock-diff.')
  }

  const summary = [
    `airlock: transaction ${t.transactionId} awaiting review`,
    stat.files > 0
      ? `${stat.files} file(s) changed, +${stat.insertions}/-${stat.deletions}${t.sideEffectEvents.length > 0 ? `, ${t.sideEffectEvents.length} external-effect event(s)` : ''}`
      : 'no changes',
    `bash routed into workspace: ${t.bashCalls}; path rewrites: ${t.rewrites}`,
    'review with /airlock-review or /airlock-diff; apply with /airlock-accept; discard with /airlock-reject',
  ].join(' | ')
  const r = await next(e)
  // Core already shows the assistant answer. A different completion text
  // becomes a separate plugin row, not a replacement of that answer. Keep
  // this row to our own single-line summary: replaying r.text duplicates
  // the answer, and native notification rows sanitize embedded newlines.
  return { ...r, text: completionNotice(r.text, e.answer, summary) }
}

// Error handler for turn.start: a hook that fails must never leave the
// session editing the real tree believing a transaction is open.
export function onTurnStartError($: any, e: any, next: any): unknown {
  ctx.isolationFailed = true
  $.ui.status('airlock: isolation failed — mutations blocked (fail-safe)')
  return next(e)
}
