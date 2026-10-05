// Bash interception (plan §7 Option A): while a transaction is open the
// hook answers the call itself with $.process.run(argv, { cwd }) —
// structured working-directory control, no string surgery on the command.
// Before running, the command passes the side-effect classifier and the
// git policy (mode-dependent).
//
// The cwd is the session's own working directory mapped into the workspace
// (repoRoot→txRoot prefix rule), so a session started in a subdirectory
// behaves as the model expects. A session cwd outside the repo cannot be
// virtualized; the command then runs from the workspace root.
//
// SECURITY: self-execution bypasses the engine's Bash permission gate
// and sandbox; this hook IS the gate while a transaction is open (see
// docs/SECURITY.md, M6).

import { ctx, activeKey, modeKey } from '../tx/state.ts'
import type { SideEffectEvent } from '../tx/state.ts'
import { virtualize } from '../tx/paths.ts'
import { classifyGit } from '../tx/git-policy.ts'
import { classifySideEffect, SIDE_EFFECT_WARNING } from './side-effects.ts'

async function record($: any, event: SideEffectEvent): Promise<void> {
  if (ctx.tx) {
    const saved = await $.store.get(activeKey(ctx.tx.repoRoot))
    if (saved?.transactionId !== ctx.tx.transactionId || saved?.state !== 'ACTIVE') return
    ctx.tx.sideEffectEvents.push(event)
    await $.store.set(activeKey(ctx.tx.repoRoot), ctx.tx)
  }
}

export async function onBashCall($: any, e: any, next: any): Promise<unknown> {
  // The blocked check comes first: a blocked session has ctx.tx === null,
  // and a command let through there would run against the REAL tree.
  if (ctx.blockedByOtherSession) {
    return {
      deny: `airlock: ${ctx.blockedByOtherSession} holds the open transaction for this repository. Review or resolve it with /airlock-diff, /airlock-accept, or /airlock-abort before retrying. Command refused.`,
    }
  }
  if (ctx.isolationFailed) {
    return { deny: 'airlock: no transaction workspace (fail-safe); command refused.' }
  }
  if (!ctx.tx) return next(e)
  let savedActive: any
  try { savedActive = await $.store.get(activeKey(ctx.tx.repoRoot)) } catch { savedActive = null }
  if (ctx.tx.state !== 'ACTIVE' || savedActive?.transactionId !== ctx.tx.transactionId || savedActive?.state !== 'ACTIVE') {
    return { deny: 'airlock: this transaction is awaiting review or is no longer active. Resolve it before running another command.' }
  }
  if (e.run_in_background) {
    return {
      deny: 'airlock: background commands cannot be routed into the transaction workspace yet — the engine\'s background machinery is not mod-accessible. Re-run the command in the foreground (a timeout up to 600000 ms is supported).',
    }
  }

  const savedMode = await $.store.get(modeKey(ctx.tx.repoRoot))
  if (savedMode === 'strict' || savedMode === 'balanced' || savedMode === 'permissive') ctx.options.mode = savedMode
  const mode = ctx.options.mode
  const side = classifySideEffect(e.command)
  const git = classifyGit(e.command)

  if (side.matched || git === 'remote') {
    const what = side.matched ? side.pattern : 'remote git operation'
    const why = side.matched ? side.reason : 'remote git operations touch the shared repository'
    let confirmed = false
    let fallback = ''
    if (mode === 'balanced') {
      if (!ctx.isInteractive) {
        fallback = ' Confirmation is unavailable in headless mode; run this command in an interactive session.'
      } else {
        try {
          confirmed = await $.ui.ask(
            `airlock: ${what}: ${why}. Command: ${e.command}. ${SIDE_EFFECT_WARNING} Allow this command once?`,
            ['Deny', 'Allow once'],
          ) === 'Allow once'
        } catch {
          fallback = ' Confirmation was dismissed or unavailable; the command was not run.'
        }
      }
    }
    if (mode === 'strict' || (mode === 'balanced' && !confirmed)) {
      await record($, { at: Date.now(), command: e.command, pattern: what, reason: why, action: 'denied' })
      return {
        deny: `airlock (mode: ${mode}): refused «${e.command.slice(0, 200)}» — ${what}: ${why}. ${SIDE_EFFECT_WARNING}${fallback}`,
      }
    }
    await record($, { at: Date.now(), command: e.command, pattern: what, reason: why, action: 'recorded' })
  } else if (git === 'mutating') {
    if (mode !== 'permissive') {
      return {
        deny: `airlock (mode: ${mode}): git commands that change repository topology are denied inside a transaction (plan §15). Read-only git (status, diff, log…) is fine; the transaction diff is produced by the mod itself.`,
      }
    }
    await record($, {
      at: Date.now(), command: e.command, pattern: 'git-topology', reason: 'mutating git allowed in permissive mode', action: 'recorded',
    })
  }

  const t = ctx.tx
  const latest = await $.store.get(activeKey(t.repoRoot))
  if (latest?.transactionId !== t.transactionId || latest?.state !== 'ACTIVE') return { deny: 'airlock: the transaction was resolved while the command was pending; command refused.' }
  t.bashCalls++

  // Session-cwd virtualization: map the session's cwd into the workspace.
  let sessionCwd = ''
  try {
    sessionCwd = await $.session.cwd()
  } catch {
    sessionCwd = ''
  }
  const mapped = sessionCwd !== '' ? virtualize(sessionCwd, t.repoRoot, t.txRoot) : sessionCwd
  const cwd = mapped === sessionCwd ? t.txRoot : mapped

  let ran: { exitCode: number | null; stdout: string; stderr: string }
  try {
    ran = await $.process.run(['bash', '-c', e.command], {
      cwd,
      timeoutMs: Math.min(e.timeout ?? 120000, 600000),
    })
  } catch (err) {
    return {
      result: { stdout: '', stderr: `airlock: command could not run (${String(err)})`, interrupted: false },
      isError: true,
    }
  }
  const exitCode = ran.exitCode ?? -1
  const stderr = exitCode !== 0 ? `${ran.stderr}\n(exit code ${exitCode})` : ran.stderr
  const result = { stdout: ran.stdout, stderr, interrupted: false }
  if (exitCode !== 0) return { result, isError: true }
  return { result }
}
