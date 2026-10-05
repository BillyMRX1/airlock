// Transaction record (plan §9) and session context.
//
// Module-level context is acceptable for now: a session loads the module
// once and hot reloads re-run register(), which resets this state; the
// authoritative cross-session copy lives in $.store (the engine's static
// analysis requires $ to stay within one file, so every $.store /
// $.process call lives in the hook file that makes it — this module is
// pure data and logic only). Migration of live state to $.state remains
// outstanding; store-backed handlers cover persistent state today.

export type TxMode = 'strict' | 'balanced' | 'permissive'

export type TxState =
  | 'ACTIVE'
  | 'REVIEW'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'ABORTED'
  | 'CONFLICTED'
  | 'APPLY_FAILED'

export interface SideEffectEvent {
  at: number
  command: string
  pattern: string
  reason: string
  action: 'denied' | 'recorded'
}

export interface TxStats {
  files: number
  insertions: number
  deletions: number
}

export interface TransactionRecord {
  transactionId: string
  sessionId: string
  turnId: string
  repoRoot: string
  txRoot: string
  startedAt: number
  baseHead: string
  /** What the transaction's own diff is measured against (plan §10): the
   *  ephemeral baseline commit inside the worktree when the real tree was
   *  dirty, else baseHead (clean fast path). */
  baselineCommit: string
  /** Real-tree blob hashes of the paths the baseline touched, taken at
   *  PREPARING; ACCEPT compares them to detect concurrent human edits
   *  before any patch is applied (plan §11, conflict layer 1). */
  baselineFingerprint: Record<string, string>
  /** Non-ignored untracked files copied into the worktree. */
  untrackedCopied: string[]
  /** Untracked files deliberately not copied (too large, symlink, dir…). */
  skippedFiles: string[]
  state: TxState
  changedFiles: string[]
  stats: TxStats
  sideEffectEvents: SideEffectEvent[]
  bashCalls: number
  rewrites: number
  /** When true, each turn remains in this worktree until /airlock-begin end. */
  multiTurn?: boolean
}

export interface HistoryRecord {
  transactionId: string
  turnId: string
  repoRoot: string
  txRoot: string | null
  /** Baseline commit used for retained rejected-workspace inspection. */
  baselineCommit?: string
  startedAt: number
  endedAt: number
  outcome: 'accepted' | 'rejected' | 'aborted'
  stats: TxStats
  retained: boolean
}

export interface Ctx {
  repoRoot: string
  isInteractive: boolean
  multiTurn: boolean
  tx: TransactionRecord | null
  isolationFailed: boolean
  /** Session id of another session that owns the open transaction for this
   *  repo (multi-session guard): mutations are denied here until that
   *  session accepts/aborts. Null when this session may mutate. */
  blockedByOtherSession: string | null
  commandsRegistered: boolean
  options: {
    mode: TxMode
    includeUntracked: boolean
    retainRejectedTransactions: boolean
    maxStoredTransactions: number
  }
}

export const ctx: Ctx = {
  repoRoot: '',
  isInteractive: false,
  multiTurn: false,
  tx: null,
  // A fresh/hot-reloaded module must initialize through session.start before mutations.
  isolationFailed: true,
  blockedByOtherSession: null,
  commandsRegistered: false,
  options: {
    mode: 'strict',
    includeUntracked: true,
    retainRejectedTransactions: false,
    maxStoredTransactions: 50,
  },
}

export function activeKey(repoRoot: string): string { return `airlock:${repoRoot}:active` }
export function historyKey(repoRoot: string): string { return `airlock:${repoRoot}:history` }
export function modeKey(repoRoot: string): string { return `airlock:${repoRoot}:mode` }
export function multiTurnKey(repoRoot: string): string { return `airlock:${repoRoot}:multi-turn` }

// Legacy global keys are read only for a safe, repo-matched migration.
export const LEGACY_ACTIVE_KEY = 'airlock:active'
export const LEGACY_HISTORY_KEY = 'airlock:history'

// `options` arrives from the manifest's userConfig with defaults filled in,
// but a field can still be unset or invalid; read defensively.
export function applyOptions(options: Record<string, unknown>): void {
  const mode = options.mode
  if (mode === 'balanced' || mode === 'permissive' || mode === 'strict') ctx.options.mode = mode
  if (typeof options.includeUntracked === 'boolean') ctx.options.includeUntracked = options.includeUntracked
  if (typeof options.retainRejectedTransactions === 'boolean') {
    ctx.options.retainRejectedTransactions = options.retainRejectedTransactions
  }
  const max = Number(options.maxStoredTransactions)
  if (Number.isFinite(max) && max >= 1) ctx.options.maxStoredTransactions = Math.floor(max)
}

// Pure: is this store record a recoverable transaction for this repo?
export function recoverableRecord(saved: unknown, repoRoot: string): TransactionRecord | null {
  if (!saved || typeof saved !== 'object') return null
  const r = saved as TransactionRecord
  if (typeof r.txRoot !== 'string' || r.repoRoot !== repoRoot) return null
  // Records written before the baseline subsystem lack the new fields;
  // recover them against HEAD with an empty fingerprint rather than
  // breaking turn.complete / accept on undefined refs.
  if (typeof r.baselineCommit !== 'string' || r.baselineCommit === '') r.baselineCommit = r.baseHead
  if (r.baselineFingerprint === null || typeof r.baselineFingerprint !== 'object') r.baselineFingerprint = {}
  if (!Array.isArray(r.untrackedCopied)) r.untrackedCopied = []
  if (!Array.isArray(r.skippedFiles)) r.skippedFiles = []
  return r
}

// Pure: history list trimmed to the configured size.
export function trimHistory(list: unknown, max: number): HistoryRecord[] {
  const history = Array.isArray(list) ? list.filter((r): r is HistoryRecord => !!r && typeof r === 'object') : []
  const overflow = history.length - max
  return overflow > 0 ? history.slice(overflow) : history
}
