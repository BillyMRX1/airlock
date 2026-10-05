import { test, expect, describe, mock } from 'claude-code/testing'
import { activeKey, historyKey, multiTurnKey } from '../hooks/tx/state.ts'

const REPO = '/repo/project'
const HOME = '/home/tester'
const TXROOT = `${HOME}/.claude-airlock/project-failure-test`
const HASH = '0123456789abcdef0123456789abcdef01234567'
const PATCH = 'diff --git a/src/file.txt b/src/file.txt\n--- a/src/file.txt\n+++ b/src/file.txt\n@@ -1 +1 @@\n-old\n+new\n'

type Run = { argv: string[]; cwd?: string; stdin?: string }
type Answer = { exitCode?: number; stdout?: string; stderr?: string; isStdoutTruncated?: boolean; throw?: boolean }

function fixture(on: any, options: { tx?: any; overrides?: (run: Run) => Answer | undefined; existing?: string[] } = {}) {
  const tx = options.tx ?? {
    transactionId: 'failure-test', sessionId: 'test-session', turnId: 'failure-turn', repoRoot: REPO,
    txRoot: TXROOT, startedAt: 1, baseHead: HASH, baselineCommit: HASH, baselineFingerprint: {},
    untrackedCopied: [], skippedFiles: [], state: 'REVIEW', changedFiles: ['src/file.txt'],
    stats: { files: 1, insertions: 1, deletions: 1 }, sideEffectEvents: [], bashCalls: 0, rewrites: 0,
  }
  const map: Record<string, any> = {}
  const runs: Run[] = []
  const existing = new Set(options.existing ?? [`${REPO}/src/file.txt`])
  const existsOverride: Record<string, boolean | 'throw'> = {}
  let override = options.overrides
  mock.env(on, { HOME })
  on('store.get', (_$: any, e: any) => ({ value: map[e.key] }))
  on('store.set', (_$: any, e: any) => { map[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete map[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(map) }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', (_$: any, e: any) => ({ value: e.name }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', (_$: any, e: any) => {
    if (existsOverride[e.path] === 'throw') throw new Error('scripted fs.exists failure')
    return { value: existsOverride[e.path] ?? (e.path !== `${TXROOT}.backup` && (existing.has(e.path) || e.path === TXROOT || e.path.startsWith(`${TXROOT}/`))) }
  })
  on('fs.stat', (_$: any, e: any) => {
    const path = e.path
    if (path === REPO) return { value: { kind: 'dir', size: 0, isLink: false, realPath: REPO } }
    if (path === `${HOME}/.claude-airlock`) return { value: { kind: 'dir', size: 0, isLink: false, realPath: `${HOME}/.claude-airlock` } }
    if (path === TXROOT) return { value: { kind: 'dir', size: 0, isLink: false, realPath: TXROOT } }
    if (path === `${TXROOT}.backup`) return { value: { kind: 'dir', size: 0, isLink: false, realPath: `${TXROOT}.backup` } }
    if (existing.has(path)) return { value: { kind: 'file', size: 12, isLink: false, realPath: path } }
    return { value: { kind: 'other', size: 0, isLink: false } }
  })
  on('process.run', (_$: any, e: any) => {
    const r: Run = { argv: [...e.argv], cwd: e.init?.cwd, stdin: e.init?.stdin }
    runs.push(r)
    const answer = override?.(r)
    if (answer?.throw) throw new Error('scripted process failure')
    if (answer) return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', isStdoutTruncated: answer.isStdoutTruncated ?? false } }
    const a = r.argv
    let stdout = ''
    if (a[1] === 'rev-parse' && a[2] === '--show-toplevel') stdout = `${REPO}\n`
    else if (a[1] === 'diff' && a.includes('--binary')) stdout = PATCH
    else if (a[1] === 'diff' && a.includes('--name-only')) stdout = 'src/file.txt\n'
    else if (a[1] === 'rev-parse' && a.includes('--verify')) stdout = `${HASH}\n`
    else if (a[1] === 'hash-object' && a[2] === '--') stdout = `${HASH}\n`
    else if (a[1] === 'ls-tree') stdout = `src/file.txt\0`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false } }
  })
  return { tx, map, runs, setOverride: (fn?: typeof override) => { override = fn }, setExists: (path: string, value: boolean | 'throw') => { existsOverride[path] = value }, start: async ($: any) => {
    if (tx.multiTurn === true) map[multiTurnKey(REPO)] = true
    await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
    map[activeKey(REPO)] = tx
  } }
}

async function start($: any, f: ReturnType<typeof fixture>) { await f.start($) }

describe('command failure handling', () => {
  for (const cause of ['exit', 'truncated'] as const) {
    test(`accept refuses ${cause} transaction patch output`, async ($: any, on: any) => {
      const f = fixture(on)
      await start($, f)
      // Override the patch call only (the first diff with --binary).
      const fail = cause === 'exit'
        ? { exitCode: 1, stderr: 'git diff failed' }
        : { stdout: PATCH.slice(0, 20), isStdoutTruncated: true }
      f.setOverride(r => r.argv[1] === 'diff' && r.argv.includes('--binary') ? fail : undefined)
      const result: any = await $.command.run({ command: 'airlock-accept' })
      expect(result.text).toContain('refusing to accept')
      expect(f.map[activeKey(REPO)].state).toBe('REVIEW')
      expect(f.runs.some(r => r.argv[1] === 'apply')).toBe(false)
      expect(f.map[historyKey(REPO)]).toBeUndefined()
    })
  }

  for (const [label, answer] of [
    ['failed', { exitCode: 1, stderr: 'git diff --name-only failed' }],
    ['truncated', { stdout: 'src/file', isStdoutTruncated: true }],
    ['traversal', { stdout: 'src/../../outside.txt\n' }],
    ['empty after a nonempty patch', { stdout: '' }],
  ] as const) {
    test(`accept refuses ${label} changed-path output`, async ($: any, on: any) => {
      const f = fixture(on)
      await start($, f)
      f.setOverride(r => r.argv[1] === 'diff' && r.argv.includes('--name-only') ? answer : undefined)
      const result: any = await $.command.run({ command: 'airlock-accept' })
      expect(result.text).toContain('safe')
      expect(f.runs.some(r => r.argv[1] === 'apply')).toBe(false)
      expect(f.runs.some(r => r.argv[0] === 'mkdir')).toBe(false)
    })
  }

  test('APPLY_FAILED cannot be accepted a second time', async ($: any, on: any) => {
    const f = fixture(on, { tx: { ...fixtureTx(), state: 'APPLY_FAILED' } })
    await start($, f)
    const result: any = await $.command.run({ command: 'airlock-accept' })
    expect(result.text).toContain('manual recovery')
    expect(f.runs.some(r => r.argv[1] === 'apply')).toBe(false)
    expect(f.map[activeKey(REPO)].state).toBe('APPLY_FAILED')
  })

  test('a missing baseline fingerprint hash is a conflict', async ($: any, on: any) => {
    const f = fixture(on, { tx: { ...fixtureTx(), baselineFingerprint: { 'src/file.txt': HASH } }, overrides: r => {
      if (r.argv[1] === 'hash-object' && r.argv[2] === '--') return { exitCode: 1, stderr: 'missing' }
      return undefined
    } })
    await start($, f)
    const result: any = await $.command.run({ command: 'airlock-accept' })
    expect(result.text).toContain('CONFLICT')
    expect(f.map[activeKey(REPO)].state).toBe('CONFLICTED')
    expect(f.runs.some(r => r.argv[1] === 'apply')).toBe(false)
  })

  test('backup path creation failure refuses apply', async ($: any, on: any) => {
    const f = fixture(on, { overrides: r => r.argv[0] === 'mkdir' ? { exitCode: 1, stderr: 'permission denied' } : undefined })
    await start($, f)
    const result: any = await $.command.run({ command: 'airlock-accept' })
    expect(result.text).toContain('could not back up')
    expect(f.runs.some(r => r.argv[1] === 'apply' && r.argv[2] !== '--check')).toBe(false)
  })

  for (const failure of ['present', 'exists throws'] as const) {
    test(`backup refuses a pre-existing or unverifiable backup path (${failure})`, async ($: any, on: any) => {
      const f = fixture(on)
      await start($, f)
      f.setExists(`${TXROOT}.backup`, failure === 'present' ? true : 'throw')
      const result: any = await $.command.run({ command: 'airlock-accept' })
      expect(result.text).toContain('could not back up')
      expect(f.runs.some(r => r.argv[1] === 'apply' && r.argv[2] !== '--check')).toBe(false)
      expect(f.runs.some(r => r.argv[0] === 'mkdir')).toBe(false)
    })
  }

  test('failed rollback restoration names the path and preserves APPLY_FAILED', async ($: any, on: any) => {
    const f = fixture(on, { overrides: r => {
      if (r.argv[1] === 'apply' && r.argv[2] !== '--check') return { exitCode: 1, stderr: 'partial apply' }
      if (r.argv[0] === 'cp' && r.argv[3] === `${TXROOT}.backup/src/file.txt`) return { exitCode: 1, stderr: 'restore failed' }
      return undefined
    } })
    await start($, f)
    const result: any = await $.command.run({ command: 'airlock-accept' })
    expect(result.text).toContain('rollback was incomplete')
    expect(result.text).toContain('manual recovery needed: restore src/file.txt')
    expect(f.map[activeKey(REPO)].state).toBe('APPLY_FAILED')
  })

  test('failed rollback removal names a newly-created path and preserves APPLY_FAILED', async ($: any, on: any) => {
    let f: ReturnType<typeof fixture>
    f = fixture(on, { existing: [], overrides: r => {
      if (r.argv[1] === 'rev-parse' && r.argv.includes('--verify')) return { exitCode: 1, stderr: 'path absent at baseline' }
      if (r.argv[1] === 'ls-tree') return { stdout: '' }
      if (r.argv[1] === 'hash-object' && r.argv[2] === '--') return { exitCode: 1, stderr: 'path absent' }
      if (r.argv[1] === 'apply' && r.argv[2] !== '--check') {
        f.setExists(`${REPO}/src/file.txt`, true)
        return { exitCode: 1, stderr: 'partial create' }
      }
      if (r.argv[0] === 'rm' && r.argv.includes(`${REPO}/src/file.txt`)) return { exitCode: 1, stderr: 'remove failed' }
      return undefined
    } })
    await start($, f)
    const result: any = await $.command.run({ command: 'airlock-accept' })
    expect(result.text).toContain('manual recovery needed: remove src/file.txt')
    expect(f.map[activeKey(REPO)].state).toBe('APPLY_FAILED')
  })

  test('successful apply with failed worktree removal records retained history', async ($: any, on: any) => {
    const f = fixture(on, { overrides: r => r.argv[1] === 'worktree' && r.argv[2] === 'remove' ? { exitCode: 1, stderr: 'busy' } : undefined })
    await start($, f)
    const result: any = await $.command.run({ command: 'airlock-accept' })
    const history = f.map[historyKey(REPO)]
    expect(result.text).toContain(`workspace is retained at ${TXROOT}`)
    expect(history[0].outcome).toBe('accepted')
    expect(history[0].retained).toBe(true)
    expect(history[0].txRoot).toBe(TXROOT)
  })

  test('APPLY_FAILED marker is persisted before git apply can run', async ($: any, on: any) => {
    let f: ReturnType<typeof fixture>
    let sawMarker = false
    f = fixture(on, { overrides: r => {
      if (r.argv[1] === 'apply' && r.argv[2] !== '--check') sawMarker = f.map[activeKey(REPO)]?.state === 'APPLY_FAILED'
      return undefined
    } })
    await start($, f)
    await $.command.run({ command: 'airlock-accept' })
    expect(sawMarker).toBe(true)
  })

  test('begin end staging failure leaves transaction ACTIVE and multi-turn enabled', async ($: any, on: any) => {
    const f = fixture(on, { tx: { ...fixtureTx(), state: 'ACTIVE', multiTurn: true }, overrides: r => r.argv[0] === 'git' && r.argv[1] === 'add' ? { exitCode: 1, stderr: 'stage failed' } : undefined })
    await start($, f)
    const result: any = await $.command.run({ command: 'airlock-begin', args: 'end' })
    expect(result.text).toContain('remains ACTIVE')
    expect(f.map[activeKey(REPO)].state).toBe('ACTIVE')
    expect(f.map[multiTurnKey(REPO)]).toBe(true)
  })

  for (const result of [{ exitCode: 1 }, { isStdoutTruncated: true }] as const) {
    test('begin end statistics failure leaves transaction ACTIVE', async ($: any, on: any) => {
      const f = fixture(on, { tx: { ...fixtureTx(), state: 'ACTIVE', multiTurn: true }, overrides: r => r.argv[1] === 'diff' && r.argv.includes('--numstat') ? result : undefined })
      await start($, f)
      const response: any = await $.command.run({ command: 'airlock-begin', args: 'end' })
      expect(response.text).toContain('remains ACTIVE')
      expect(f.map[activeKey(REPO)].state).toBe('ACTIVE')
      expect(f.map[multiTurnKey(REPO)]).toBe(true)
    })
  }
})

function fixtureTx(): any {
  return {
    transactionId: 'failure-test', sessionId: 'test-session', turnId: 'failure-turn', repoRoot: REPO,
    txRoot: TXROOT, startedAt: 1, baseHead: HASH, baselineCommit: HASH, baselineFingerprint: {},
    untrackedCopied: [], skippedFiles: [], state: 'REVIEW', changedFiles: ['src/file.txt'],
    stats: { files: 1, insertions: 1, deletions: 1 }, sideEffectEvents: [], bashCalls: 0, rewrites: 0,
  }
}
