// Session start: repo detection, command registration, and recovery of
// a transaction left open by a previous session (crash, killed terminal).
// Recovery favors preserving data: the worktree and the store record are
// left exactly as they were; only the in-memory context is rebuilt.

import { ctx, activeKey, historyKey, modeKey, multiTurnKey, LEGACY_ACTIVE_KEY, LEGACY_HISTORY_KEY, recoverableRecord, trimHistory } from './state.ts'

export async function onSessionStart($: any, e: any, next: any): Promise<unknown> {
  ctx.tx = null
  ctx.blockedByOtherSession = null
  ctx.isInteractive = e.isInteractive === true
  const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: e.cwd })
  ctx.repoRoot = git.exitCode === 0 && !git.isStdoutTruncated ? git.stdout.trim() : ''
  if (!ctx.repoRoot) {
    // No repo (or git broken): fail safe — no transactions in this session.
    ctx.isolationFailed = true
  } else {
    ctx.isolationFailed = false
    const key = activeKey(ctx.repoRoot)
    let saved = await $.store.get(key)
    // Migrate only when the legacy value explicitly identifies this repo.
    if (saved === undefined) {
      const legacy = await $.store.get(LEGACY_ACTIVE_KEY)
      const candidate = recoverableRecord(legacy, ctx.repoRoot)
      if (candidate) { saved = candidate; await $.store.set(key, candidate); await $.store.delete(LEGACY_ACTIVE_KEY) }
    }
    const oldHistory = await $.store.get(LEGACY_HISTORY_KEY)
    if (Array.isArray(oldHistory)) {
      const mine = oldHistory.filter((r: any) => r && r.repoRoot === ctx.repoRoot)
      if (mine.length > 0) {
        const current = await $.store.get(historyKey(ctx.repoRoot))
        const merged = [...(Array.isArray(current) ? current : []), ...mine]
        const unique = merged.filter((r: any, i: number) => merged.findIndex((candidate: any) => candidate?.transactionId === r?.transactionId) === i)
        await $.store.set(historyKey(ctx.repoRoot), trimHistory(unique, ctx.options.maxStoredTransactions))
      }
      const other = oldHistory.filter((r: any) => !r || r.repoRoot !== ctx.repoRoot)
      if (other.length > 0) await $.store.set(LEGACY_HISTORY_KEY, other)
      else await $.store.delete(LEGACY_HISTORY_KEY)
    }
    const savedMode = await $.store.get(modeKey(ctx.repoRoot))
    if (savedMode === 'strict' || savedMode === 'balanced' || savedMode === 'permissive') ctx.options.mode = savedMode
    const multiTurn = await $.store.get(multiTurnKey(ctx.repoRoot))
    ctx.multiTurn = multiTurn === true
    const recovered = recoverableRecord(saved, ctx.repoRoot)
    // A record whose workspace no longer exists is a ghost: adopting it
    // would point every git call at a deleted directory. It stays in the
    // store (data preservation) for /airlock-cleanup to prune; this session
    // opens its own transaction normally (the turn.start guard clears it).
    let adopt = false
    if (recovered) {
      try {
        adopt = await $.fs.exists(recovered.txRoot)
      } catch {
        adopt = false
      }
    }
    if (recovered && adopt) {
      // Cross-session recovery is the feature (plan §21: a crash or killed
      // terminal leaves the worktree and record behind; a later session
      // adopts them and can accept or reject). The status names the owner
      // when the record was left by a different session, so two live
      // sessions are honest about who is working where.
      ctx.tx = recovered
      let mine = false
      try {
        const sid = await $.session.id()
        mine = sid === recovered.sessionId
      } catch {
        mine = false
      }
      const owner = mine ? '' : ` — left open by session ${recovered.sessionId}`
      $.ui.status(`AIRLOCK ${recovered.transactionId} • RECOVERED${owner}`)
    } else {
      ctx.tx = null
    }
  }

  try {
    await $.command.register({ name: 'airlock-status', description: 'Show the open transaction' })
    await $.command.register({ name: 'airlock-diff', description: 'Show the transaction diff' })
    await $.command.register({ name: 'airlock-accept', description: 'Apply the transaction to the real worktree' })
    await $.command.register({ name: 'airlock-reject', description: 'Discard the transaction without applying it' })
    await $.command.register({ name: 'airlock-abort', description: 'Abort the in-flight transaction (discard without review)' })
    await $.command.register({ name: 'airlock-cleanup', description: 'List stale transaction workspaces (add "purge" to remove them)' })
    await $.command.register({ name: 'airlock-history', description: 'Show recent transaction history for this repository' })
    await $.command.register({ name: 'airlock-mode', description: 'Show or set this repository’s safety mode: strict, balanced, or permissive' })
    await $.command.register({ name: 'airlock-begin', description: 'Opt into a multi-turn transaction; use “end” to open it for review' })
    await $.command.register({ name: 'airlock-rejected', description: 'Show retained rejected transaction workspaces' })
    await $.command.register({ name: 'airlock-review', description: 'Open the interactive transaction review pane' })
    ctx.commandsRegistered = true
  } catch {
    // Command registration failing (e.g. an unusual host) must not break
    // the rest of the session; the /airlock-* hooks still answer if dispatched.
    ctx.commandsRegistered = false
  }
  return next(e)
}
