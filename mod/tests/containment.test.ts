// Containment & robustness (M3 part 2): symlink-escape hardening of the
// file-tool rewrites, Agent/worktree escape denial, Bash session-cwd
// virtualization, the multi-session guard (block + self-heal), abort,
// cleanup (report + purge) and history. Same kit pattern: the test's own
// hooks are the engine bottom, git/cp/rm are a scripted fake, and the fs
// noun is answered per-path.

import { test, expect, describe, mock } from 'claude-code/testing'
import { activeKey } from '../hooks/tx/state.ts'

interface Run {
  argv: readonly string[]
  cwd?: string
  stdin?: string
}

const REPO = '/repo/project'
const HOME = '/home/tester'
const TXROOT_DIR = `${HOME}/.claude-airlock`

function isTxRootPath(p: string | undefined): boolean {
  return typeof p === 'string' && p.startsWith(`${TXROOT_DIR}/`)
}

// Engine-bottom hooks with the session cwd switchable per test.
function engineBottom(
  on: any,
  script: Array<{ match: (r: Run) => boolean; stdout?: string; exitCode?: number }>,
): { runs: Run[]; setSessionCwd: (c: string) => void } {
  const runs: Run[] = []
  let sessionCwd = REPO
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: sessionCwd }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => ({ value: e.name }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('process.run', (_$: any, e: any) => {
    const r: Run = { argv: e.argv, cwd: e.init?.cwd, stdin: e.init?.stdin }
    runs.push(r)
    for (const s of script) {
      if (s.match(r)) {
        return { value: { exitCode: s.exitCode ?? 0, stdout: s.stdout ?? '', stderr: '' } }
      }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return { runs, setSessionCwd: (c: string) => { sessionCwd = c } }
}

function fakeFs(
  on: any,
  stats: Record<string, any>,
  exists: Record<string, boolean>,
  list: Record<string, Array<{ name: string }>>,
): void {
  on('fs.stat', (_$: any, e: any) => ({ value: stats[e.path] ?? { kind: 'other', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.exists', (_$: any, e: any) => ({ value: exists[e.path] ?? isTxRootPath(e.path) }))
  on('fs.list', (_$: any, e: any) => ({ value: list[e.path] ?? [] }))
}

// A store the test controls and observes directly (mock.store copies its
// entries, so mid-test seeding needs the real bottoms; the noun's arg
// shapes — {key}, {key, value} — are in the generated typings).
function handStore(on: any, initial: Record<string, unknown>): { map: Record<string, unknown>; deleted: string[] } {
  const map: Record<string, unknown> = { ...initial }
  const deleted: string[] = []
  on('store.get', (_$: any, e: any) => ({ value: map[e.key] }))
  on('store.set', (_$: any, e: any) => { map[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { deleted.push(e.key); delete map[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(map) }))
  return { map, deleted }
}

// Clean-tree git script (the PREPARING fast path).
function stdScript(): Array<{ match: (r: Run) => boolean; stdout?: string; exitCode?: number }> {
  return [
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'rev-parse' && r.argv[2] === '--show-toplevel', stdout: `${REPO}\n` },
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD', stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' },
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'worktree', stdout: '' },
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: '' },
    { match: r => r.argv[0] === 'bash', stdout: '' },
  ]
}

function foreignRecord(sessionId: string, txRoot: string): any {
  return {
    transactionId: 'foreign01-xyz', sessionId, turnId: 'foreign0001', repoRoot: REPO, txRoot,
    startedAt: 1, baseHead: 'h', baselineCommit: 'h', baselineFingerprint: {}, untrackedCopied: [],
    skippedFiles: [], state: 'ACTIVE', changedFiles: [], stats: { files: 0, insertions: 0, deletions: 0 },
    sideEffectEvents: [], bashCalls: 0, rewrites: 0,
  }
}

async function openTurn($: any, turnId: string): Promise<void> {
  await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
  await $.turn.start({ text: 'do work', turnId })
}

function txRootOf(runs: Run[]): string {
  return runs.find(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')!.argv.find(a => isTxRootPath(a)) as string
}

describe('containment & robustness', () => {
  test('symlink escape: mutating tools denied, Read passes unmapped, normal paths still map', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = engineBottom(on, stdScript())
    const seen: string[] = []
    on('tool.call', (_$: any, e: any) => {
      seen.push(`${e.tool}:${e.file_path ?? ''}`)
      return { result: { observed: true } }
    })
    // A link inside the repo resolving outside, and an ordinary file whose
    // realPath is itself; an unknown path (a new file) falls back lexically.
    fakeFs(on, {
      [`${REPO}/escape-link`]: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: '/etc/passwd' },
      [`${REPO}/a.txt`]: { kind: 'file', size: 10, mtimeMs: 0, isLink: false, realPath: `${REPO}/a.txt` },
    }, {}, {})

    await openTurn($, 'turnlink0001')
    const txRoot = txRootOf(runs)

    const ed: any = await $.tool.call({ tool: 'Edit', file_path: `${REPO}/escape-link`, old_string: 'a', new_string: 'b' })
    expect(typeof ed.deny).toBe('string')
    expect(ed.deny.includes('outside the repository')).toBe(true)
    const wr: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/escape-link`, content: 'x' })
    expect(typeof wr.deny).toBe('string')

    // Read keeps the original spelling and passes unmapped (read-only).
    const rd: any = await $.tool.call({ tool: 'Read', file_path: `${REPO}/escape-link` })
    expect(rd.deny).toBeUndefined()
    expect(seen[seen.length - 1]).toBe(`Read:${REPO}/escape-link`)

    // A repo-internal realPath still maps; an unknown path falls back to the
    // lexical mapping (ENOENT for a file Write is about to create).
    await $.tool.call({ tool: 'Edit', file_path: `${REPO}/a.txt`, old_string: 'a', new_string: 'b' })
    expect(seen[seen.length - 1]).toBe(`Edit:${txRoot}/a.txt`)
    await $.tool.call({ tool: 'Write', file_path: `${REPO}/src/new.ts`, content: 'x' })
    expect(seen[seen.length - 1]).toBe(`Write:${txRoot}/src/new.ts`)
  })

  test('escape tools: isolated Agent, EnterWorktree, ExitWorktree denied during a transaction; plain Agent passes', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = engineBottom(on, stdScript())
    const seen: string[] = []
    on('tool.call', (_$: any, e: any) => {
      seen.push(e.tool)
      return { result: { observed: true } }
    })
    fakeFs(on, {}, {}, {})

    // Without a transaction everything passes (normal Claude Code).
    const plain0: any = await $.tool.call({ tool: 'EnterWorktree', name: 'w' })
    expect(plain0.deny).toBeUndefined()

    await openTurn($, 'turnesc00001')

    const iso: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', isolation: 'worktree' })
    expect(typeof iso.deny).toBe('string')
    expect(iso.deny.includes('isolated subagent')).toBe(true)
    const rem: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', isolation: 'remote' })
    expect(typeof rem.deny).toBe('string')

    const plain: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' })
    expect(plain.deny).toBeUndefined()
    expect(seen[seen.length - 1]).toBe('Agent')

    const enter: any = await $.tool.call({ tool: 'EnterWorktree', name: 'w' })
    expect(typeof enter.deny).toBe('string')
    const exit: any = await $.tool.call({ tool: 'ExitWorktree', action: 'remove' })
    expect(typeof exit.deny).toBe('string')
    expect(runs.length).toBeGreaterThan(0)
  })

  test('bash cwd: session cwd mapped into the workspace; outside the repo falls back to the workspace root', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs, setSessionCwd } = engineBottom(on, stdScript())
    on('tool.call', (_$: any, _e: any) => ({ result: { observed: true } }))
    fakeFs(on, {}, {}, {})

    await openTurn($, 'turncwd00001')
    const txRoot = txRootOf(runs)

    setSessionCwd(`${REPO}/src`)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    let bashRun = runs.filter(r => r.argv[0] === 'bash').pop()
    expect(bashRun!.cwd).toBe(`${txRoot}/src`)

    setSessionCwd('/tmp')
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    bashRun = runs.filter(r => r.argv[0] === 'bash').pop()
    expect(bashRun!.cwd).toBe(txRoot)
  })

  test('multi-session guard: foreign live transaction blocks mutations; self-heals when resolved', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    const store = handStore(on, {})
    const foreignRoot = `${TXROOT_DIR}/project-foreign01-xyz`
    const existsMap: Record<string, boolean> = { [foreignRoot]: true }
    const { runs } = engineBottom(on, stdScript())
    const seen: string[] = []
    on('tool.call', (_$: any, e: any) => {
      seen.push(`${e.tool}:${e.file_path ?? ''}`)
      return { result: { observed: true } }
    })
    fakeFs(on, {}, existsMap, {})

    // This session started before the other one opened its transaction…
    await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
    // …then session-A opened one for the same repo.
    store.map[activeKey(REPO)] = foreignRecord('session-A', foreignRoot)

    await $.turn.start({ text: 'edit things', turnId: 'turnguard0001' })
    // No second worktree was created.
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')).toBe(false)

    // Mutations are denied, naming the owning session…
    const ed: any = await $.tool.call({ tool: 'Edit', file_path: `${REPO}/a.txt`, old_string: 'a', new_string: 'b' })
    expect(typeof ed.deny).toBe('string')
    expect(ed.deny.includes('session-A')).toBe(true)
    const bash: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(typeof bash.deny).toBe('string')
    expect(bash.deny.includes('session-A')).toBe(true)
    // …while Read stays allowed (unmapped — no transaction here).
    const rd: any = await $.tool.call({ tool: 'Read', file_path: `${REPO}/a.txt` })
    expect(rd.deny).toBeUndefined()
    expect(seen[seen.length - 1]).toBe(`Read:${REPO}/a.txt`)

    // The owning session resolves its transaction: the next turn unblocks
    // and opens this session's own workspace.
    delete store.map[activeKey(REPO)]
    delete existsMap[foreignRoot]
    await $.turn.start({ text: 'edit again', turnId: 'turnguard0002' })
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')).toBe(true)
    const ed2: any = await $.tool.call({ tool: 'Edit', file_path: `${REPO}/a.txt`, old_string: 'a', new_string: 'b' })
    expect(ed2.deny).toBeUndefined()
    expect(seen[seen.length - 1]).toContain(`${TXROOT_DIR}/`)
  })

  test('abort: worktree destroyed, history records aborted, idempotent no-op', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = engineBottom(on, stdScript())
    on('tool.call', (_$: any, _e: any) => ({ result: { observed: true } }))
    fakeFs(on, {}, {}, {})

    await openTurn($, 'turnabort0001')
    const txRoot = txRootOf(runs)

    const ab: any = await $.command.run({ command: 'airlock-abort' })
    expect(ab.text.includes('aborted')).toBe(true)
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes(txRoot))).toBe(true)

    const st: any = await $.command.run({ command: 'airlock-status' })
    expect(st.text.includes('no open transaction')).toBe(true)

    const hi: any = await $.command.run({ command: 'airlock-history' })
    expect(hi.text.includes('aborted')).toBe(true)
    expect(hi.text.includes('turnabor')).toBe(true)

    const again: any = await $.command.run({ command: 'airlock-abort' })
    expect(again.text.includes('no open transaction')).toBe(true)
  })

  test('cleanup: report lists stale workspaces; purge removes ours only, never the active one', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const stale1 = `${TXROOT_DIR}/project-stale1`
    const oldBackup = `${TXROOT_DIR}/old.backup`
    const { runs } = engineBottom(on, [
      ...stdScript(),
      { match: r => r.argv[0] === 'git' && r.argv[1] === '-C' && r.argv[2] === stale1 && r.argv[3] === 'rev-parse', stdout: `${REPO}/.git\n` },
      { match: r => r.argv[0] === 'git' && r.argv[1] === '-C' && r.argv[2] === oldBackup && r.argv[3] === 'rev-parse', exitCode: 1 },
    ])
    on('tool.call', (_$: any, _e: any) => ({ result: { observed: true } }))

    // All bottom hooks are registered before the first $ call (the kit
    // forbids registering beneath the plugins afterwards); the maps they
    // answer from are filled in once the active workspace is known.
    const stats: Record<string, any> = {}
    const listMap: Record<string, Array<{ name: string }>> = {}
    fakeFs(on, stats, {}, listMap)

    await openTurn($, 'turnclean0002')
    const txRoot = txRootOf(runs)
    const activeName = txRoot.slice(TXROOT_DIR.length + 1)
    stats[stale1] = { kind: 'dir', size: 0, mtimeMs: Date.now() - 3600000, isLink: false }
    stats[oldBackup] = { kind: 'dir', size: 0, mtimeMs: Date.now() - 7200000, isLink: false }
    listMap[TXROOT_DIR] = [{ name: activeName }, { name: 'project-stale1' }, { name: 'old.backup' }]

    // Report mode: data-preserving — nothing removed.
    const rep: any = await $.command.run({ command: 'airlock-cleanup' })
    expect(rep.text.includes('stale')).toBe(true)
    expect(rep.text.includes('project-stale1')).toBe(true)
    expect(rep.text.includes('old.backup')).toBe(true)
    expect(rep.text.includes(txRoot)).toBe(false)
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'remove')).toBe(false)
    expect(runs.some(r => r.argv[0] === 'rm')).toBe(false)

    // Purge: the live worktree goes through its main repository (git cannot
    // remove the worktree the command itself runs in); the non-worktree
    // directory falls back to rm under the ownership guard. The active
    // workspace is untouched.
    const pur: any = await $.command.run({ command: 'airlock-cleanup', args: 'purge' })
    expect(pur.text.includes('removed 2')).toBe(true)
    expect(runs.some(r => r.argv[0] === 'git' && r.argv[1] === '-C' && r.argv[2] === REPO && r.argv[3] === 'worktree' && r.argv[4] === 'remove' && r.argv.includes(stale1))).toBe(true)
    expect(runs.some(r => r.argv[0] === 'rm' && r.argv.includes(oldBackup))).toBe(true)
    expect(runs.some(r => (r.argv.includes(txRoot) || r.argv.includes(activeName)) && (r.argv[0] === 'rm' || (r.argv[1] === 'worktree' && r.argv[2] === 'remove')))).toBe(false)
  })

  test('cleanup prunes a ghost active record whose workspace is gone', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    const ghostRoot = `${TXROOT_DIR}/project-ghost0001`
    const store = handStore(on, { [activeKey(REPO)]: foreignRecord('session-dead', ghostRoot) })
    const { runs } = engineBottom(on, stdScript())
    on('tool.call', (_$: any, _e: any) => ({ result: { observed: true } }))
    fakeFs(on, {}, { [ghostRoot]: false }, {})

    // session.start does NOT adopt a record whose workspace is gone…
    await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
    const st: any = await $.command.run({ command: 'airlock-status' })
    expect(st.text.includes('no open transaction')).toBe(true)

    // …and cleanup prunes the stale pointer.
    const cl: any = await $.command.run({ command: 'airlock-cleanup' })
    expect(cl.text.includes('no stale workspaces')).toBe(true)
    expect(store.deleted).toContain(activeKey(REPO))

    // The next turn opens normally (no ghost blocking it).
    await $.turn.start({ text: 'work', turnId: 'turnghost001' })
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')).toBe(true)
  })
})
