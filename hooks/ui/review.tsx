// Review pane and prompt framing for Airlock (M4).
// Every engine `$` call stays in this module, where the hook receives it.

import { ctx, activeKey } from '../tx/state.ts'

export const REVIEW_PANE = 'airlock-review'


const WORKTREE_NOTE =
  'Airlock is using a Git worktree for this turn. Supported file-tool paths inside the repository and foreground Bash are routed to that worktree; paths outside the repository pass through unchanged, and tool output may show the worktree path. Search tools are not virtualized and may see the real tree. MCP tools are not routed through Airlock, so their effects are outside its guarantees. Background Bash is unavailable during a transaction. Accept applies the reviewed patch after conflict checks; reject discards the transaction.'

async function storedTransaction($: any): Promise<{ transactionId?: string } | null> {
  if (!ctx.repoRoot) return null
  const value = await $.store.get(activeKey(ctx.repoRoot))
  return value && typeof value === 'object' ? value as { transactionId?: string } : null
}

export async function onAirlockPromptSection($: any, e: { name: string; text: string | null }, next: any): Promise<{ text: string | null }> {
  const base = await next(e)
  if (e.name !== 'env_info_simple') return base
  if (ctx.blockedByOtherSession) {
    const note = `Airlock found an open transaction awaiting resolution (${ctx.blockedByOtherSession}). This session's edits and Bash mutations are blocked until it is resolved with /airlock-accept or /airlock-abort in the owning session.`
    return { text: base.text ? `${base.text.trim()}\n\n${note}` : note }
  }
  if (!(await storedTransaction($))) return base
  if (base.text?.includes('Airlock is using a Git worktree for this turn.')) return base
  const existing = base.text?.trim() ?? ''
  return { text: existing === '' ? WORKTREE_NOTE : `${existing}\n\n${WORKTREE_NOTE}` }
}
