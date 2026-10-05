// M5 adversarial probes. These go through the plugin test engine; the
// test-owned hooks below are the engine bottom and record actual rewrites.
import { test, expect, mock } from 'claude-code/testing'
import { activeKey } from '../hooks/tx/state.ts'

const REPO = '/repo/project'
const HOME = '/home/tester'
const ROOT = `${HOME}/.claude-airlock`

function setup(on: any) {
  mock.env(on, { HOME })
  const store: Record<string, any> = {}
  const runs: any[] = []
  const rewrites: string[] = []
  const stats = new Map<string, any>()
  const failures = new Map<string, string>()
  let txRootMissing = false
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete store[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(store) }))
  let txRoot = ''
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'adversarial-session' }))
  on('session.cwd', () => ({ value: REPO }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => ({ value: e.name }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('process.run', (_$: any, e: any) => {
    runs.push(e)
    const a = e.argv as string[]
    if (a[0] === 'git' && a[1] === 'worktree' && a[2] === 'add') txRoot = a[4]
    const stdout = a[1] === 'rev-parse' && a[2] === '--show-toplevel' ? `${REPO}\n`
      : a[1] === 'rev-parse' && a[2] === 'HEAD' ? 'deadbeef\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('fs.stat', (_$: any, e: any) => {
    // Returning a location-less `other` models `realPath` being absent.
    // A separately tracked permission failure is caught by the plugin's
    // realPathOf helper and likewise exercises its unresolved-path branch.
    if (failures.has(e.path)) return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }
    const value = stats.get(e.path)
    if (value !== undefined) return { value }
    if (e.path === txRoot && txRootMissing) return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }
    if (e.path === REPO || e.path === txRoot || e.path === '/') {
      return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
    }
    return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }
  })
  on('fs.exists', (_$: any, e: any) => ({ value:
    e.path === REPO || (e.path === txRoot && !txRootMissing) || e.path === '/' || stats.has(e.path) || failures.has(e.path),
  }))
  on('tool.call', (_$: any, e: any) => {
    rewrites.push(e.file_path)
    return { result: { observed: true } }
  })
  return { runs, rewrites, stats, failures, store, setTxRootMissing: (value: boolean) => { txRootMissing = value } }
}

async function openTransaction($: any, runs: any[], turnId: string): Promise<string> {
  await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
  await $.turn.start({ text: 'edit a file', turnId })
  const txRoot = runs.find(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')?.argv.find((x: string) => x.startsWith(`${ROOT}/`))
  expect(typeof txRoot).toBe('string')
  return txRoot
}

test('adversarial: before session.start, file mutation and Bash remain fail-closed', async ($: any, on: any) => {
  let processCalls = 0
  on('process.run', () => { processCalls++; return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('tool.call', (_$: any, e: any) => ({ result: { observed: e.tool } }))
  const write: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/early.txt`, content: 'x' })
  const bash: any = await $.tool.call({ tool: 'Bash', command: 'touch early.txt' })
  expect(typeof write.deny).toBe('string')
  expect(typeof bash.deny).toBe('string')
  expect(processCalls).toBe(0)
})

test('adversarial: new file below an escaping source symlink is denied', async ($: any, on: any) => {
  const s = setup(on)
  s.stats.set(`${REPO}/escape-link`, { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: '/outside' })
  const txRoot = await openTransaction($, s.runs, 'turn-symlink-new-file')
  const result: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/escape-link/new.txt`, content: 'escaped' })
  expect(typeof result.deny).toBe('string')
  expect(s.rewrites).toHaveLength(0)
  expect(txRoot).toContain(`${ROOT}/`)
})

test('adversarial: an absolute in-repo symlink maps through its canonical target', async ($: any, on: any) => {
  const s = setup(on)
  s.stats.set(`${REPO}/absolute-link`, { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: `${REPO}/real-dir` })
  s.stats.set(`${REPO}/real-dir/file.txt`, { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: `${REPO}/real-dir/file.txt` })
  const txRoot = await openTransaction($, s.runs, 'turn-absolute-symlink')
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${REPO}/absolute-link/file.txt`, old_string: 'a', new_string: 'b' })
  expect(result.deny).toBeUndefined()
  expect(s.rewrites[0]).toBe(`${txRoot}/real-dir/file.txt`)
})

test('adversarial: a transaction-introduced symlink cannot route a later edit outside the worktree', async ($: any, on: any) => {
  const s = setup(on)
  const txRoot = await openTransaction($, s.runs, 'turn-tx-symlink')
  // The repo-side spelling is new, but its mapped destination already points
  // outside after an earlier Bash `ln -s` in the transaction.
  s.stats.set(`${txRoot}/tx-link`, { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: '/outside' })
  const result: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/tx-link/new.txt`, content: 'escaped' })
  expect(typeof result.deny).toBe('string')
  expect(s.rewrites).toHaveLength(0)
})

test('adversarial: canonical transaction-root aliases still get destination containment checks', async ($: any, on: any) => {
  const s = setup(on)
  const txRoot = await openTransaction($, s.runs, 'turn-canonical-tx-alias')
  const canonicalTx = '/private/var/airlock-canonical/project-tx'
  s.stats.set(txRoot, { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: canonicalTx })
  s.stats.set(`${canonicalTx}/escape-link`, { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: '/outside' })
  const result: any = await $.tool.call({
    tool: 'Write', file_path: `${canonicalTx}/escape-link/new.txt`, content: 'escaped',
  })
  expect(typeof result.deny).toBe('string')
  expect(s.rewrites).toHaveLength(0)
})

test('adversarial: a transaction root replaced by a symlink to the real repository is rejected', async ($: any, on: any) => {
  const s = setup(on)
  const txRoot = await openTransaction($, s.runs, 'turn-txroot-replaced')
  const canonicalRepo = '/private/var/repo/project'
  s.stats.set(REPO, { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: canonicalRepo })
  s.stats.set(txRoot, { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: canonicalRepo })
  const lexical: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/new.txt`, content: 'escaped' })
  const aliased: any = await $.tool.call({ tool: 'Edit', file_path: `${canonicalRepo}/existing.txt`, old_string: 'a', new_string: 'b' })
  expect(typeof lexical.deny).toBe('string')
  expect(typeof aliased.deny).toBe('string')
  expect(s.rewrites).toHaveLength(0)
})

test('adversarial: broken symlink ancestors and unresolved paths fail closed', async ($: any, on: any) => {
  const s = setup(on)
  s.stats.set(`${REPO}/broken`, { kind: 'other', size: 0, mtimeMs: 0, isLink: true })
  s.failures.set(`${REPO}/unknown`, 'EACCES')
  await openTransaction($, s.runs, 'turn-unknown-path')
  const broken: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/broken/new.txt`, content: 'x' })
  const unknown: any = await $.tool.call({ tool: 'Edit', file_path: `${REPO}/unknown/file.txt`, old_string: 'a', new_string: 'b' })
  expect(typeof broken.deny).toBe('string')
  expect(typeof unknown.deny).toBe('string')
  expect(s.rewrites).toHaveLength(0)
})

test('adversarial: dot-dot stays in the canonical worktree or passes through once it leaves the repo', async ($: any, on: any) => {
  const s = setup(on)
  const txRoot = await openTransaction($, s.runs, 'turn-dotdot-paths')
  const inside: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/src/../inside.txt`, content: 'x' })
  expect(inside.deny).toBeUndefined()
  expect(s.rewrites[0]).toBe(`${txRoot}/inside.txt`)

  const outside: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/../../outside.txt`, content: 'x' })
  expect(outside.deny).toBeUndefined()
  expect(s.rewrites[1]).toBe(`${REPO}/../../outside.txt`)
})

test('adversarial: a disappeared transaction root fails closed for mutations', async ($: any, on: any) => {
  const s = setup(on)
  await openTransaction($, s.runs, 'turn-missing-tx-root')
  s.setTxRootMissing(true)
  const result: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/new.txt`, content: 'x' })
  expect(typeof result.deny).toBe('string')
  expect(s.rewrites).toHaveLength(0)
})

test('adversarial: a removed or replaced stored transaction cannot authorize a stale mutation', async ($: any, on: any) => {
  const s = setup(on)
  await openTransaction($, s.runs, 'turn-stale-active-record')
  const key = activeKey(REPO)
  delete s.store[key]
  const removed: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/removed.txt`, content: 'x' })
  expect(typeof removed.deny).toBe('string')
  const bashRemoved: any = await $.tool.call({ tool: 'Bash', command: 'touch removed.txt' })
  expect(typeof bashRemoved.deny).toBe('string')

  s.store[key] = { transactionId: 'replacement-tx', state: 'ACTIVE', repoRoot: REPO }
  const replaced: any = await $.tool.call({ tool: 'Edit', file_path: `${REPO}/replaced.txt`, old_string: 'a', new_string: 'b' })
  expect(typeof replaced.deny).toBe('string')
  const bashReplaced: any = await $.tool.call({ tool: 'Bash', command: 'touch replaced.txt' })
  expect(typeof bashReplaced.deny).toBe('string')
  expect(s.rewrites).toHaveLength(0)
})
