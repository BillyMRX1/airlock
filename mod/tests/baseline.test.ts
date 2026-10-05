// Baseline subsystem (plan §10, §11, §12): dirty tracked changes
// reproduced into the worktree, untracked files copied (with skips), the
// ephemeral baseline commit, the accept-time fingerprint conflict layer,
// and the apply-failure rollback. Same kit pattern as lifecycle.test.ts:
// the test's own hooks are the engine bottom, git/cp/mkdir/rm are a
// scripted fake, and the fs noun is answered per-path.

import { test, expect, describe, mock } from 'claude-code/testing'

interface Run {
  argv: readonly string[]
  cwd?: string
  stdin?: string
}

type Entry = { match: (r: Run) => boolean; stdout?: string | ((r: Run) => string); exitCode?: number }

const REPO = '/repo/project'
const HOME = '/home/tester'

const DIRTY_PATCH = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n+user-work\n'
const TX_PATCH = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n+claude-work\n'
const A_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function isTxRootPath(p: string | undefined): boolean {
  return typeof p === 'string' && p.startsWith(`${HOME}/.claude-airlock/`)
}

// Engine-bottom hooks + full argv recording, with stateful stdout support.
function engineBottom(on: any, script: Entry[]): { runs: Run[] } {
  const runs: Run[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => ({ value: e.name }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('process.run', (_$: any, e: any) => {
    const r: Run = { argv: e.argv, cwd: e.init?.cwd, stdin: e.init?.stdin }
    runs.push(r)
    for (const s of script) {
      if (s.match(r)) {
        const out = typeof s.stdout === 'function' ? s.stdout(r) : s.stdout
        return { value: { exitCode: s.exitCode ?? 0, stdout: out ?? '', stderr: '' } }
      }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return { runs }
}

function fakeFs(on: any, stats: Record<string, any>, exists: Record<string, boolean>): void {
  on('fs.stat', (_$: any, e: any) => ({ value: stats[e.path] ?? {
    kind: e.path === `${HOME}/.claude-airlock` || (isTxRootPath(e.path) && !e.path.slice(`${HOME}/.claude-airlock/`.length).includes('/')) ? 'dir' : 'file',
    size: 0, mtimeMs: 0, isLink: false, realPath: e.path,
  } }))
  on('fs.exists', (_$: any, e: any) => ({ value: exists[e.path] ?? (isTxRootPath(e.path) ? !e.path.includes('.backup') : e.path.startsWith(`${REPO}/`)) }))
}

async function openTurn($: any, turnId: string): Promise<void> {
  await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
  await $.turn.start({ text: 'do work', turnId })
}

const GIT = (r: Run) => r.argv[0] === 'git'

describe('baseline subsystem', () => {
  test('dirty tree: user changes reproduced, ephemeral baseline commit, fingerprint, clean accept', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const hashInputs: string[] = []
    const { runs } = engineBottom(on, [
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === '--show-toplevel', stdout: `${REPO}\n` },
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD' && r.cwd === REPO, stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' },
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD' && isTxRootPath(r.cwd), stdout: 'baseline123\n' },
      { match: r => GIT(r) && r.argv[1] === 'worktree', stdout: '' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: DIRTY_PATCH },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--name-only', stdout: 'a.txt\n' },
      { match: r => GIT(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--stdin-paths', stdout: () => { hashInputs.push('call'); return `${A_HASH}\n` } },
      { match: r => GIT(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === 'a.txt', stdout: `${A_HASH}\n` },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === 'baseline123' && r.argv[3] === '--binary', stdout: TX_PATCH },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === '--name-only', stdout: 'a.txt\n' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[3] === '--numstat', stdout: '1\t1\ta.txt\n' },
      { match: r => GIT(r), stdout: '' }, // apply, add, commit, ls-files: success
    ])
    fakeFs(on, {}, {})

    await openTurn($, 'turndirty0001')

    // The user's dirty patch was applied INSIDE the worktree, not outside.
    const applyInTx = runs.find(r => r.argv[1] === 'apply' && r.argv[2] === '--binary' && isTxRootPath(r.cwd))
    expect(applyInTx).toBeDefined()
    expect(applyInTx!.stdin).toBe(DIRTY_PATCH)
    // The ephemeral baseline commit carries our own identity flags.
    const commit = runs.find(r => r.argv.includes('commit'))
    expect(commit).toBeDefined()
    expect(commit!.argv).toContain('airlock baseline')
    expect(commit!.argv).toContain('-c')
    expect(commit!.argv).toContain('user.name=airlock')
    expect(commit!.argv).toContain('user.email=airlock@localhost')
    expect(isTxRootPath(commit!.cwd)).toBe(true)
    // The fingerprint hashed the real dirty path at PREPARING.
    expect(runs.some(r => r.argv[1] === 'hash-object' && r.argv[2] === '--stdin-paths' && r.stdin === 'a.txt\n' && r.cwd === REPO)).toBe(true)

    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 'turndirty0001', reason: 'answer' })
    // Stats are measured against the ephemeral baseline, not HEAD.
    expect(runs.some(r => r.argv[1] === 'diff' && r.argv[2] === 'baseline123' && r.argv[3] === '--numstat' && isTxRootPath(r.cwd))).toBe(true)

    const acc: any = await $.command.run({ command: 'airlock-accept' })
    expect(acc.text.includes('applied')).toBe(true)
    // Accept verifies the real worktree path with an argv-safe per-file hash.
    expect(runs.some(r => r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === 'a.txt' && r.cwd === REPO)).toBe(true)
    const check = runs.find(r => r.argv[1] === 'apply' && r.argv[2] === '--check')
    expect(check).toBeDefined()
    expect(check!.stdin).toBe(TX_PATCH) // only Claude's delta, never the user's pre-existing work
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'remove')).toBe(true)
  })

  test('untracked files: copied with mkdir for nesting; oversized/symlink skipped and recorded', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = engineBottom(on, [
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === '--show-toplevel', stdout: `${REPO}\n` },
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD', stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' },
      { match: r => GIT(r) && r.argv[1] === 'worktree', stdout: '' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[3] === '--binary', stdout: '' }, // tracked tree clean
      { match: r => GIT(r) && r.argv[1] === 'ls-files' && r.argv[2] === '--others', stdout: 'new.txt\ndir/nested.txt\nbig.bin\nlink.txt\n' },
      { match: r => GIT(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--stdin-paths', stdout: 'h1\nh2\n' },
    ])
    fakeFs(on, {
      [`${REPO}/new.txt`]: { kind: 'file', size: 10, mtimeMs: 0, isLink: false },
      [`${REPO}/dir/nested.txt`]: { kind: 'file', size: 20, mtimeMs: 0, isLink: false },
      [`${REPO}/big.bin`]: { kind: 'file', size: 5 * 1024 * 1024, mtimeMs: 0, isLink: false },
      [`${REPO}/link.txt`]: { kind: 'file', size: 5, mtimeMs: 0, isLink: true },
    }, {})

    await openTurn($, 'turnuntr00001')
    const txRoot = (runs.find(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')!.argv.find(a => isTxRootPath(a)) as string)

    // The two sane files were copied by argv; parents created.
    expect(runs.some(r => r.argv[0] === 'cp' && r.argv[1] === '-p' && r.argv.includes(`${REPO}/new.txt`) && r.argv.includes(`${txRoot}/new.txt`))).toBe(true)
    expect(runs.some(r => r.argv[0] === 'cp' && r.argv.includes(`${REPO}/dir/nested.txt`) && r.argv.includes(`${txRoot}/dir/nested.txt`))).toBe(true)
    expect(runs.some(r => r.argv[0] === 'mkdir' && r.argv.includes(`${txRoot}/dir`))).toBe(true)
    // The oversized file and the symlink were never copied…
    expect(runs.some(r => r.argv[0] === 'cp' && r.argv.includes('big.bin'))).toBe(false)
    expect(runs.some(r => r.argv[0] === 'cp' && r.argv.includes('link.txt'))).toBe(false)
    // …the fingerprint covers exactly the copied files…
    expect(runs.some(r => r.argv[1] === 'hash-object' && r.stdin === 'new.txt\ndir/nested.txt\n' && r.cwd === REPO)).toBe(true)
    // …and the untracked copies are baked into a baseline commit.
    expect(runs.some(r => r.argv.includes('commit') && r.argv.includes('airlock baseline') && isTxRootPath(r.cwd))).toBe(true)

    const st: any = await $.command.run({ command: 'airlock-status' })
    expect(st.text.includes('untracked carried into baseline: 2')).toBe(true)
    expect(st.text.includes('big.bin')).toBe(true)
    expect(st.text.includes('link.txt')).toBe(true)
  })

  test('clean tree fast path: no baseline commit, no apply into the worktree', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = engineBottom(on, [
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === '--show-toplevel', stdout: `${REPO}\n` },
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD', stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' },
      { match: r => GIT(r) && r.argv[1] === 'worktree', stdout: '' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: '' },
    ])
    fakeFs(on, {}, {})

    await openTurn($, 'turnclean00001')
    expect(runs.some(r => r.argv.includes('commit'))).toBe(false)
    expect(runs.some(r => r.argv[1] === 'apply' && isTxRootPath(r.cwd))).toBe(false)
    // The baseline is HEAD itself.
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 'turnclean00001', reason: 'answer' })
    expect(runs.some(r => r.argv[1] === 'diff' && r.argv[2] === 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' && r.argv[3] === '--numstat')).toBe(true)
  })

  test('fingerprint conflict: concurrent real-tree edit is refused before any apply', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    let hashCalls = 0
    const { runs } = engineBottom(on, [
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === '--show-toplevel', stdout: `${REPO}\n` },
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD' && isTxRootPath(r.cwd), stdout: 'baseline123\n' },
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD', stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' },
      { match: r => GIT(r) && r.argv[1] === 'worktree', stdout: '' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: DIRTY_PATCH },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--name-only', stdout: 'a.txt\n' },
      {
        // The real tree's a.txt hash at PREPARING… and a different one at
        // accept time: a human edited the file while the transaction ran.
        match: r => GIT(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--stdin-paths',
        stdout: () => { hashCalls++; return hashCalls === 1 ? `${A_HASH}\n` : `${B_HASH}\n` },
      },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === 'baseline123' && r.argv[3] === '--binary', stdout: TX_PATCH },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === '--name-only', stdout: 'a.txt\n' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[3] === '--numstat', stdout: '1\t1\ta.txt\n' },
      { match: r => GIT(r), stdout: '' },
    ])
    fakeFs(on, {}, {})

    await openTurn($, 'turnconf100001')
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 'turnconf100001', reason: 'answer' })

    const acc: any = await $.command.run({ command: 'airlock-accept' })
    expect(acc.text.includes('CONFLICT')).toBe(true)
    expect(acc.text.includes('a.txt')).toBe(true)
    // Refused before any apply in the REAL tree, before even the --check.
    // (The apply that did run was PREPARING reproducing the user's dirty
    // patch inside the worktree — cwd txRoot, argv carries --binary.)
    expect(runs.some(r => r.argv[1] === 'apply' && r.cwd === REPO)).toBe(false)
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'remove')).toBe(false)
    const st: any = await $.command.run({ command: 'airlock-status' })
    expect(st.text.includes('CONFLICTED')).toBe(true)
  })

  test('apply fails midway: backup restored, created file removed, APPLY_FAILED kept', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const existsMap: Record<string, boolean> = {}
    existsMap[`${REPO}/b.txt`] = true // b.txt exists: backed up
    existsMap[`${REPO}/c.txt`] = false // c.txt is new: would be created by the patch
    const { runs } = engineBottom(on, [
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === '--show-toplevel', stdout: `${REPO}\n` },
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD', stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' },
      { match: r => GIT(r) && r.argv[1] === 'worktree', stdout: '' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: '' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[3] === '--numstat', stdout: '1\t0\tb.txt\n1\t0\tc.txt\n' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[3] === '--binary', stdout: 'diff --git a/b.txt b/b.txt\n' },
      { match: r => GIT(r) && r.argv[1] === 'diff' && r.argv[2] === '--name-only', stdout: 'b.txt\nc.txt\n' },
      { match: r => GIT(r) && r.argv[1] === 'rev-parse' && r.argv.includes('--verify') && r.argv.at(-1)?.endsWith(':b.txt') === true, stdout: `${'a'.repeat(40)}\n` },
      { match: r => GIT(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === 'b.txt', stdout: `${'a'.repeat(40)}\n` },
      { match: r => GIT(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === 'c.txt', exitCode: 1 },
      // The apply itself fails midway — and "creates" c.txt on the way out,
      // as a partial apply would.
      { match: r => GIT(r) && r.argv[1] === 'apply' && r.argv[2] !== '--check', exitCode: 1, stdout: () => { existsMap[`${REPO}/c.txt`] = true; return '' } },
    ])
    fakeFs(on, {}, existsMap)

    await openTurn($, 'turnfail000001')
    const txRoot = (runs.find(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')!.argv.find(a => isTxRootPath(a)) as string)
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 'turnfail000001', reason: 'answer' })

    const acc: any = await $.command.run({ command: 'airlock-accept' })
    expect(acc.text.includes('rolled back completely')).toBe(true)
    expect(acc.text.includes('APPLY_FAILED')).toBe(true)
    // b.txt was backed up before the apply and restored after it failed.
    expect(runs.some(r => r.argv[0] === 'cp' && r.argv.includes(`${REPO}/b.txt`) && r.argv.includes(`${txRoot}.backup/b.txt`))).toBe(true)
    expect(runs.some(r => r.argv[0] === 'cp' && r.argv.includes(`${txRoot}.backup/b.txt`) && r.argv.includes(`${REPO}/b.txt`))).toBe(true)
    // The file the partial apply created was removed.
    expect(runs.some(r => r.argv[0] === 'rm' && r.argv.includes(`${REPO}/c.txt`))).toBe(true)
    // The transaction (and its backup) are kept for manual recovery.
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'remove')).toBe(false)
    expect(runs.some(r => r.argv[0] === 'rm' && r.argv.includes('-rf'))).toBe(false)
    const st: any = await $.command.run({ command: 'airlock-status' })
    expect(st.text.includes('APPLY_FAILED')).toBe(true)
  })
})
