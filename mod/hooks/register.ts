// Wiring only: register(on, options) connects the engine events to the
// hook functions. All on(event, matcher, hook) registrations live here.

import type { Register } from 'claude-code'
import { applyOptions } from './tx/state.ts'
import { onSessionStart } from './tx/recovery.ts'
import { onTurnStart, onTurnComplete, onTurnStartError } from './tx/lifecycle.ts'
import {
  onTxStatus, onTxDiff, onTxAccept, onTxReject, onTxAbort, onTxCleanup, onTxHistory,
  onTxMode, onTxBegin, onTxRejected, onTxReview, onReviewRender,
} from './tx/commands.tsx'
import { onReadCall, onEditCall, onWriteCall, onNotebookEditCall } from './tools/rewrite.ts'
import { onBashCall } from './tools/bash.ts'
import { onAgentCall, onEnterWorktreeCall, onExitWorktreeCall } from './tools/escape.ts'

import { onAirlockPromptSection, REVIEW_PANE } from './ui/review.tsx'

export const register: Register = (on, options) => {
  applyOptions((options ?? {}) as Record<string, unknown>)

  on('session.start', onSessionStart)
  on('turn.start', onTurnStart).catch(onTurnStartError)
  on('turn.complete', onTurnComplete)
  on('ui.render', { component: 'Pane', requestId: REVIEW_PANE }, onReviewRender)
  on('prompt.section', onAirlockPromptSection)

  on('tool.call', { tool: 'Read' }, onReadCall)
  on('tool.call', { tool: 'Edit' }, onEditCall)
  on('tool.call', { tool: 'Write' }, onWriteCall)
  on('tool.call', { tool: 'NotebookEdit' }, onNotebookEditCall)
  on('tool.call', { tool: 'Bash' }, onBashCall)
  on('tool.call', { tool: 'Agent' }, onAgentCall)
  on('tool.call', { tool: 'EnterWorktree' }, onEnterWorktreeCall)
  on('tool.call', { tool: 'ExitWorktree' }, onExitWorktreeCall)

  on('command.run', { command: 'airlock-status' }, onTxStatus)
  on('command.run', { command: 'airlock-diff' }, onTxDiff)
  on('command.run', { command: 'airlock-accept' }, onTxAccept)
  on('command.run', { command: 'airlock-reject' }, onTxReject)
  on('command.run', { command: 'airlock-abort' }, onTxAbort)
  on('command.run', { command: 'airlock-cleanup' }, onTxCleanup)
  on('command.run', { command: 'airlock-history' }, onTxHistory)
  on('command.run', { command: 'airlock-mode' }, onTxMode)
  on('command.run', { command: 'airlock-begin' }, onTxBegin)
  on('command.run', { command: 'airlock-rejected' }, onTxRejected)
  on('command.run', { command: 'airlock-review' }, onTxReview)
}
