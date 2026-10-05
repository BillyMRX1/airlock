// Containment (plan §21 'Agents'): while a transaction is open, tools that
// would move work outside the workspace are denied. A plain subagent is
// fine — its own tool calls flow through these same hooks — but an
// isolated subagent (its own worktree or a remote environment) would edit
// where the rewrites cannot follow, and a session worktree move (Enter/
// ExitWorktree) would leave the transaction or destroy its tracking.

import { ctx } from '../tx/state.ts'

export function onAgentCall(_$: any, e: any, next: any): unknown {
  if (!ctx.tx) return next(e)
  if (e.isolation === 'worktree' || e.isolation === 'remote') {
    return {
      deny: 'airlock: an isolated subagent (its own worktree or a remote environment) would leave the transaction, where its edits cannot be captured. Spawn the agent without isolation — its tool calls are routed into the transaction anyway.',
    }
  }
  return next(e)
}

export function onEnterWorktreeCall(_$: any, _e: any, next: any): unknown {
  if (!ctx.tx) return next(e)
  return {
    deny: 'airlock: entering a worktree would move the session out of the open transaction. Accept or reject it first (/airlock-accept, /airlock-reject).',
  }
}

export function onExitWorktreeCall(_$: any, _e: any, next: any): unknown {
  if (!ctx.tx) return next(e)
  return {
    deny: 'airlock: exiting a worktree would break the open transaction\'s tracking. Accept or reject it first (/airlock-accept, /airlock-reject).',
  }
}
