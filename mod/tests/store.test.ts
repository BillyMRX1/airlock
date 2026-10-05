import { test, expect, describe, mock } from 'claude-code/testing'
import { activeKey, historyKey, modeKey, multiTurnKey, LEGACY_ACTIVE_KEY } from '../hooks/tx/state.ts'

const REPO = '/repo/alpha'
const OTHER_REPO = '/repo/beta'
const HOME = '/home/tester'
const ROOT = `${HOME}/.claude-airlock`

function tx(repoRoot: string, transactionId: string, state = 'ACTIVE'): any {
  return {
    transactionId, sessionId: 'test-session', turnId: 'turn-seed', repoRoot,
    txRoot: `${ROOT}/${transactionId}`, startedAt: 1, baseHead: 'head', baselineCommit: 'head',
    baselineFingerprint: {}, untrackedCopied: [], skippedFiles: [], state, changedFiles: [],
    stats: { files: 0, insertions: 0, deletions: 0 }, sideEffectEvents: [], bashCalls: 0, rewrites: 0,
  }
}

function setup(on: any, initial: Record<string, unknown> = {}, exists?: (path: string) => boolean, listEntries: Array<{ name: string }> = []) {
  const map: Record<string, any> = { ...initial }
  const runs: any[] = []
  mock.env(on, { HOME })
  on('store.get', (_$: any, e: any) => ({ value: map[e.key] }))
  on('store.set', (_$: any, e: any) => { map[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete map[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(map) }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: REPO }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => ({ value: e.name }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('fs.exists', (_$: any, e: any) => ({ value: exists ? exists(e.path) : e.path.startsWith(`${ROOT}/`) }))
  on('fs.list', (_$: any, _e: any) => ({ value: listEntries }))
  on('process.run', (_$: any, e: any) => {
    runs.push(e)
    const a = e.argv as string[]
    let stdout = ''
    if (a[0] === 'git' && a[1] === 'rev-parse' && a[2] === '--show-toplevel') stdout = `${REPO}\n`
    else if (a[0] === 'git' && a[1] === 'rev-parse' && a[2] === 'HEAD') stdout = 'head\n'
    else if (a[0] === 'git' && a[1] === 'diff' && a.includes('--numstat')) stdout = '2\t3\tfile.txt\n'
    else if (a[0] === 'git' && a[1] === 'diff' && a.includes('--binary') && a[2] !== 'HEAD') stdout = 'diff --git a/file.txt b/file.txt\n'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return { map, runs }
}

async function start($: any) {
  await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
}

describe('per-repository store and commands', () => {
  test('active, history, and mode keys are scoped to repository roots', () => {
    expect(activeKey(REPO)).toBe('airlock:/repo/alpha:active')
    expect(historyKey(REPO)).toBe('airlock:/repo/alpha:history')
    expect(modeKey(REPO)).toBe('airlock:/repo/alpha:mode')
    expect(activeKey(REPO)).not.toBe(activeKey(OTHER_REPO))
    expect(historyKey(REPO)).not.toBe(historyKey(OTHER_REPO))
  })

  test('session start migrates only a matching legacy active record and restores mode', async ($: any, on: any) => {
    const initial = { [LEGACY_ACTIVE_KEY]: tx(REPO, 'legacy-tx'), [modeKey(REPO)]: 'permissive' }
    const s = setup(on, initial)
    await start($)
    expect(s.map[activeKey(REPO)].transactionId).toBe('legacy-tx')
    expect(s.map[LEGACY_ACTIVE_KEY]).toBeUndefined()
    const mode: any = await $.command.run({ command: 'airlock-mode' })
    expect(mode.text).toContain('permissive')
    expect(s.map[activeKey(OTHER_REPO)]).toBeUndefined()
  })

  test('a mismatched legacy active record remains untouched', async ($: any, on: any) => {
    const legacy = tx(OTHER_REPO, 'other-legacy')
    const s = setup(on, { [LEGACY_ACTIVE_KEY]: legacy })
    await start($)
    expect(s.map[LEGACY_ACTIVE_KEY].transactionId).toBe('other-legacy')
    expect(s.map[activeKey(REPO)]).toBeUndefined()
  })

  test('status uses a fresh active record read from the plugin store', async ($: any, on: any) => {
    const s = setup(on)
    await start($)
    await $.turn.start({ text: 'work', turnId: 'turn-status' })
    const live = s.map[activeKey(REPO)]
    s.map[activeKey(REPO)] = { ...live, transactionId: 'updated-in-store', state: 'REVIEW' }
    const result: any = await $.command.run({ command: 'airlock-status' })
    expect(result.text.split('\n')[0]).toContain('updated-in-store')
    expect(result.text.split('\n')[0]).not.toContain(live.transactionId)
  })

  test('mode changes persist under the current repository key', async ($: any, on: any) => {
    const s = setup(on)
    await start($)
    const result: any = await $.command.run({ command: 'airlock-mode', args: 'balanced' })
    expect(result.text).toContain('balanced')
    expect(s.map[modeKey(REPO)]).toBe('balanced')
  })

  test('multi-turn opt-in reuses one worktree across turns and end enters review', async ($: any, on: any) => {
    const s = setup(on)
    await start($)
    await $.command.run({ command: 'airlock-begin' })
    await $.turn.start({ text: 'first part', turnId: 'turn-first' })
    const first = s.map[activeKey(REPO)]
    expect(first.multiTurn).toBe(true)
    await $.turn.complete({ answer: 'part one', durationMs: 1, isAborted: false, turnId: 'turn-first', reason: 'answer' })
    expect(s.map[activeKey(REPO)].state).toBe('ACTIVE')
    await $.turn.start({ text: 'second part', turnId: 'turn-second' })
    await $.turn.complete({ answer: 'part two', durationMs: 1, isAborted: false, turnId: 'turn-second', reason: 'answer' })
    expect(s.runs.filter(r => r.argv[0] === 'git' && r.argv[1] === 'worktree' && r.argv[2] === 'add').length).toBe(1)
    const ended: any = await $.command.run({ command: 'airlock-begin', args: 'end' })
    expect(ended.text).toContain('ready for review')
    expect(s.map[activeKey(REPO)].state).toBe('REVIEW')
    expect(s.map[activeKey(REPO)].multiTurn).toBe(false)
    expect(s.map[multiTurnKey(REPO)]).toBe(false)
  })

  test('abort clears a pending multi-turn opt-in when no workspace exists', async ($: any, on: any) => {
    const s = setup(on)
    await start($)
    await $.command.run({ command: 'airlock-begin' })
    expect(s.map[multiTurnKey(REPO)]).toBe(true)
    await $.command.run({ command: 'airlock-abort' })
    expect(s.map[multiTurnKey(REPO)]).toBe(false)
  })

  test('a pending review record survives another turn without a second worktree', async ($: any, on: any) => {
    const review = tx(REPO, 'review-pending', 'REVIEW')
    const s = setup(on, { [activeKey(REPO)]: review })
    await start($)
    await $.turn.start({ text: 'another change', turnId: 'turn-again' })
    expect(s.map[activeKey(REPO)].transactionId).toBe('review-pending')
    expect(s.runs.some(r => r.argv[0] === 'git' && r.argv[1] === 'worktree' && r.argv[2] === 'add')).toBe(false)
    const write: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/new.txt`, content: 'x' })
    expect(write.deny).toContain('review pending')
  })

  test('accept refuses an ACTIVE transaction and directs the user to end multi-turn work', async ($: any, on: any) => {
    const active = tx(REPO, 'active-tx')
    const s = setup(on, { [activeKey(REPO)]: active })
    await start($)
    const result: any = await $.command.run({ command: 'airlock-accept' })
    expect(result.text).toContain('/airlock-begin end')
    expect(s.runs.some(r => r.argv[0] === 'git' && r.argv[1] === 'apply')).toBe(false)
  })

  test('retained rejected command lists and shows a guarded diff from its saved baseline', { options: { retainRejectedTransactions: true } }, async ($: any, on: any) => {
    const s = setup(on)
    await start($)
    await $.turn.start({ text: 'create changes', turnId: 'turn-reject-kept' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn-reject-kept', reason: 'answer' })
    const transactionId = s.map[activeKey(REPO)].transactionId
    await $.command.run({ command: 'airlock-reject' })
    const listed: any = await $.command.run({ command: 'airlock-rejected' })
    expect(listed.text).toContain(transactionId)
    const result: any = await $.command.run({ command: 'airlock-rejected', args: transactionId })
    expect(result.text).toContain('diff --git')
    expect(s.map[historyKey(REPO)][0].baselineCommit).toBe('head')
    expect(s.runs.some(r => r.argv[0] === 'git' && r.argv[1] === 'diff' && r.argv[2] === 'head' && r.argv.includes('--binary'))).toBe(true)
  })

  test('cleanup preserves an active worktree when its existence check errors', async ($: any, on: any) => {
    const otherRoot = `${ROOT}/unknown-status`
    const s = setup(on, { [activeKey(OTHER_REPO)]: { ...tx(OTHER_REPO, 'unknown-status'), txRoot: otherRoot } }, path => {
      if (path === otherRoot) throw new Error('stat unavailable')
      return false
    }, [{ name: 'unknown-status' }])
    await start($)
    const result: any = await $.command.run({ command: 'airlock-cleanup', args: 'purge' })
    expect(result.text).toContain('no stale workspaces')
    expect(s.map[activeKey(OTHER_REPO)]).toBeDefined()
  })

  test('cleanup protects active workspace records belonging to another repository', async ($: any, on: any) => {
    const otherRoot = `${ROOT}/beta-open`
    const s = setup(on, { [activeKey(OTHER_REPO)]: { ...tx(OTHER_REPO, 'beta-open'), txRoot: otherRoot } }, path => path === otherRoot, [{ name: 'beta-open' }])
    await start($)
    const result: any = await $.command.run({ command: 'airlock-cleanup', args: 'purge' })
    expect(result.text).toContain('no stale workspaces')
    expect(s.runs.some(r => r.argv[0] === 'rm' && r.argv.includes(otherRoot))).toBe(false)
    expect(s.map[activeKey(OTHER_REPO)]).toBeDefined()
  })
})
