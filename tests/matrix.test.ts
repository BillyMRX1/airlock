// M5 transaction matrix: exercise the registered plugin through the test
// engine, with process/fs/store answers at the engine boundary.
import { test, expect, describe, mock } from 'claude-code/testing'
import { activeKey } from '../hooks/tx/state.ts'

type Run = { argv: readonly string[]; cwd?: string; stdin?: string }
type Rule = { match: (r: Run) => boolean; stdout?: string; stderr?: string; exitCode?: number; stdoutTruncated?: boolean }
const REPO = '/repo/project'
const HOME = '/home/tester'
const TXBASE = `${HOME}/.claude-airlock/`
const tx = (p?: string) => typeof p === 'string' && p.startsWith(TXBASE)
const git = (r: Run) => r.argv[0] === 'git'

function fixture(on: any, rules: Rule[], exists: (path: string) => boolean = path => !path.endsWith('.backup')) {
  const runs: Run[] = []
  const toolCalls: any[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'matrix-session' }))
  on('session.cwd', () => ({ value: REPO }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => ({ value: e.name }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('process.run', (_$: any, e: any) => {
    const r: Run = { argv: e.argv, cwd: e.init?.cwd, stdin: e.init?.stdin }
    runs.push(r)
    const rule = rules.find(x => x.match(r))
    return { value: { exitCode: rule?.exitCode ?? 0, stdout: rule?.stdout ?? '', stderr: rule?.stderr ?? '', isStdoutTruncated: rule?.stdoutTruncated ?? false } }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: exists(e.path) }))
  on('fs.stat', (_$: any, e: any) => ({ value: {
    kind: e.path === `${HOME}/.claude-airlock` || e.path === REPO || (tx(e.path) && !e.path.endsWith('.backup')) || e.path.endsWith('.backup') ? 'dir' : 'file',
    size: 0, mtimeMs: 0, isLink: false, realPath: e.path,
  } }))
  on('tool.call', (_$: any, e: any) => { toolCalls.push(e); return { result: { tool: e.tool, file_path: e.file_path } } })
  return { runs, toolCalls }
}

function clean(extra: Rule[] = []): Rule[] {
  return [
    ...extra,
    { match: r => git(r) && r.argv[1] === 'rev-parse' && r.argv[2] === '--show-toplevel', stdout: `${REPO}\n` },
    { match: r => git(r) && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD', stdout: 'head123\n' },
    { match: r => git(r) && r.argv[1] === 'worktree', stdout: '' },
    { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: '' },
  ]
}

async function begin($: any, id = 'matrix000001') {
  await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
  await $.turn.start({ text: 'make a change', turnId: id })
}

describe('M5 transaction matrix', () => {
  test('detached HEAD and subdirectory invocation still route repository paths into the detached worktree', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs, toolCalls } = fixture(on, clean())
    await $.session.start({ cwd: `${REPO}/src/deep`, surface: null, isInteractive: false })
    await $.turn.start({ text: 'edit', turnId: 'matrixdetach01' })
    const add = runs.find(r => git(r) && r.argv[1] === 'worktree' && r.argv[2] === 'add')!
    expect(add.argv).toContain('--detach')
    expect(add.cwd).toBe(REPO)
    const root = add.argv.find(tx)!
    await $.tool.call({ tool: 'Edit', file_path: `${REPO}/src/deep/a.ts`, old_string: 'x', new_string: 'y' })
    expect(toolCalls[toolCalls.length - 1].file_path).toBe(`${root}/src/deep/a.ts`)
  })

  test('binary transaction patches keep --binary and the complete patch on apply stdin', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const binaryPatch = 'diff --git a/image.bin b/image.bin\nGIT binary patch\nliteral 4\nAc$\n'
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'head123' && r.argv[3] === '--binary', stdout: binaryPatch },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[3] === '--name-only', stdout: 'image.bin\n' },
      { match: r => git(r) && r.argv[1] === 'hash-object', stdout: `${'a'.repeat(40)}\n` },
      { match: r => git(r) && r.argv[1] === 'rev-parse' && r.argv[2] === '--verify', stdout: `${'a'.repeat(40)}\n` },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === '--name-only', stdout: 'image.bin\n' },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === '--binary', stdout: binaryPatch },
    ]))
    await begin($, 'matrixbinary01')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'matrixbinary01', reason: 'answer' })
    const accepted: any = await $.command.run({ command: 'airlock-accept' })
    expect(accepted.text).toContain('applied transaction')
    const check = runs.find(r => git(r) && r.argv[1] === 'apply' && r.argv[2] === '--check')
    const apply = runs.find(r => git(r) && r.argv[1] === 'apply' && r.argv[2] === '-')
    expect(check?.stdin).toBe(binaryPatch)
    expect(apply?.stdin).toBe(binaryPatch)
  })

  test('baseline fingerprints filenames with embedded newlines through individual argv', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const newlinePath = 'line\nbreak.txt'
    const patchText = 'diff --git a/line\\nbreak.txt b/line\\nbreak.txt\npatch\n'
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: patchText },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--name-only', stdout: '"line\\nbreak.txt"\n' },
      { match: r => git(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === newlinePath, stdout: 'newline-blob\n' },
    ]))
    await begin($, 'matrixnewline01')
    expect(runs.some(r => git(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === newlinePath)).toBe(true)
  })

  test('deleted tracked baseline paths receive an explicit absent fingerprint', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    const saved: Record<string, any> = {}
    on('store.get', (_$: any, e: any) => ({ value: saved[e.key] }))
    on('store.set', (_$: any, e: any) => { saved[e.key] = e.value; return { value: undefined } })
    on('store.delete', (_$: any, e: any) => { delete saved[e.key]; return { value: undefined } })
    on('store.keys', () => ({ value: Object.keys(saved) }))
    const deleted = `${REPO}/deleted.txt`
    const deletePatch = 'diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\n'
    const readdPatch = 'diff --git a/deleted.txt b/deleted.txt\nnew file mode 100644\n'
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: 'diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\n' },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--name-only', stdout: 'deleted.txt\n' },
      { match: r => git(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === 'deleted.txt', exitCode: 1 },
      { match: r => git(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--stdin-paths', exitCode: 1 },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[3] === '--numstat', stdout: '1\t0\tdeleted.txt\n' },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'head123' && r.argv[3] === '--binary', stdout: readdPatch },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === '--name-only', stdout: 'deleted.txt\n' },
    ]), path => path !== deleted && !path.endsWith('.backup'))
    await begin($, 'matrixdeleted01')
    expect(saved[activeKey(REPO)].baselineFingerprint['deleted.txt']).toBe('airlock:absent')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'matrixdeleted01', reason: 'answer' })
    const accepted: any = await $.command.run({ command: 'airlock-accept' })
    expect(accepted.text).toContain('applied transaction')
    expect(runs.some(r => git(r) && r.argv[1] === 'apply' && r.argv[2] === '--check' && r.stdin === readdPatch)).toBe(true)
    expect(runs.some(r => git(r) && r.argv[1] === 'apply' && r.argv[2] === '-' && r.cwd === REPO && r.stdin === readdPatch)).toBe(true)
    // Fingerprinting used per-file argv, since hash-object reports a missing
    // path and the baseline stores it as explicitly absent.
    expect(runs.some(r => git(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === 'deleted.txt')).toBe(true)
  })

  test('filenames beginning with a quote use per-file argv for baseline hashing', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const path = '"leading-quote.txt'
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: 'diff --git a/"leading-quote.txt b/"leading-quote.txt\npatch\n' },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--name-only', stdout: '"\\"leading-quote.txt"\n' },
      { match: r => git(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === path, stdout: 'quoted-blob\n' },
    ]))
    await begin($, 'matrixquote0001')
    expect(runs.some(r => git(r) && r.argv[1] === 'hash-object' && r.argv[2] === '--' && r.argv[3] === path)).toBe(true)
  })

  test('main turn edits route while subagent turn completion leaves the shared transaction ACTIVE', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs, toolCalls } = fixture(on, clean())
    await begin($, 'matrixagents01')
    const root = runs.find(r => git(r) && r.argv[1] === 'worktree' && r.argv[2] === 'add')!.argv.find(tx)!
    await $.turn.complete({ answer: 'child', durationMs: 1, isAborted: false, turnId: 'childturn01', agentId: 'agent-7', reason: 'answer' })
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('ACTIVE')).toBe(true)
    await $.tool.call({ tool: 'Write', file_path: `${REPO}/agent.ts`, content: 'ok' })
    expect(toolCalls[toolCalls.length - 1].file_path).toBe(`${root}/agent.ts`)
    for (const name of ['space name.txt', '雪だるま.ts', 'line\nbreak.txt']) {
      await $.tool.call({ tool: 'Write', file_path: `${REPO}/${name}`, content: 'ok' })
      expect(toolCalls[toolCalls.length - 1].file_path).toBe(`${root}/${name}`)
    }
    expect(runs.some(r => git(r) && r.argv[1] === 'add' && r.argv[2] === '-A')).toBe(false)
  })

  test('failure to collect the real-tree binary diff fails closed and does not create an editable transaction', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', exitCode: 128, stderr: 'repository read error' },
    ]))
    await begin($, 'matrixgitfail01')
    const write: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/unsafe.txt`, content: 'must not reach real tree' })
    expect(runs.some(r => git(r) && r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes('--force'))).toBe(true)
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('no open transaction')).toBe(true)
    expect(typeof write.deny).toBe('string')
  })

  test('truncated git diff output cannot be accepted as a complete transaction patch', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: 'diff --git a/a b/a\npartial', stdoutTruncated: true },
    ]))
    await begin($, 'matrixtrunc001')
    const write: any = await $.tool.call({ tool: 'Write', file_path: `${REPO}/unsafe.txt`, content: 'x' })
    expect(runs.some(r => git(r) && r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes('--force'))).toBe(true)
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('no open transaction')).toBe(true)
    expect(typeof write.deny).toBe('string')
  })

  test('failed transaction staging cannot advance to REVIEW or accept', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'add' && r.argv[2] === '-A' && tx(r.cwd), exitCode: 1, stderr: 'index write failed' },
    ]))
    await begin($, 'matrixstage001')
    const completed: any = await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'matrixstage001', reason: 'answer' })
    expect(completed.text.includes('could not stage')).toBe(true)
    const accepted: any = await $.command.run({ command: 'airlock-accept' })
    expect(accepted.text.includes('applied')).toBe(false)
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('ACTIVE')).toBe(true)
    expect(runs.some(r => git(r) && r.argv[1] === 'apply' && r.cwd === REPO)).toBe(false)
  })

  test('failed stats leave the transaction ACTIVE and report why review did not open', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[3] === '--numstat', exitCode: 2, stderr: 'index unavailable' },
    ]))
    await begin($, 'matrixstats001')
    const completed: any = await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'matrixstats001', reason: 'answer' })
    expect(completed.text.includes('could not read complete transaction stats')).toBe(true)
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('ACTIVE')).toBe(true)
    expect(status.text.includes('REVIEW')).toBe(false)
    expect(runs.some(r => git(r) && r.argv[1] === 'apply' && r.cwd === REPO)).toBe(false)
  })

  test('turn completion does not resurrect a transaction removed by abort', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    const saved: Record<string, any> = {}
    on('store.get', (_$: any, e: any) => ({ value: saved[e.key] }))
    on('store.set', (_$: any, e: any) => { saved[e.key] = e.value; return { value: undefined } })
    on('store.delete', (_$: any, e: any) => { delete saved[e.key]; return { value: undefined } })
    on('store.keys', () => ({ value: Object.keys(saved) }))
    const { runs } = fixture(on, clean())
    await begin($, 'matrixabortrace')
    delete saved[activeKey(REPO)] // another command/session just resolved it
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'matrixabortrace', reason: 'answer' })
    expect(runs.some(r => git(r) && r.argv[1] === 'add' && r.argv[2] === '-A')).toBe(false)
    expect(saved[activeKey(REPO)]).toBeUndefined()
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('no open transaction')).toBe(true)
  })

  test('turn completion does not overwrite a transaction advanced in the store', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    const saved: Record<string, any> = {}
    on('store.get', (_$: any, e: any) => ({ value: saved[e.key] }))
    on('store.set', (_$: any, e: any) => { saved[e.key] = e.value; return { value: undefined } })
    on('store.delete', (_$: any, e: any) => { delete saved[e.key]; return { value: undefined } })
    on('store.keys', () => ({ value: Object.keys(saved) }))
    const { runs } = fixture(on, clean())
    await begin($, 'matrixadvanced1')
    saved[activeKey(REPO)] = { ...saved[activeKey(REPO)], state: 'REVIEW' }
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'matrixadvanced1', reason: 'answer' })
    expect(saved[activeKey(REPO)].state).toBe('REVIEW')
    expect(runs.some(r => git(r) && r.argv[1] === 'add' && r.argv[2] === '-A')).toBe(false)
  })

  test('failed changed-path and untracked-file listings fail setup closed', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: 'diff --git a/a b/a\npatch\n' },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--name-only', exitCode: 1 },
      { match: r => git(r) && r.argv[1] === 'ls-files', exitCode: 1 },
    ]))
    await begin($, 'matrixnames001')
    expect(runs.some(r => git(r) && r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes('--force'))).toBe(true)
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('no open transaction')).toBe(true)
  })

  test('truncated changed-path and untracked-file listings fail setup closed', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: 'diff --git a/a b/a\npatch\n' },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--name-only', stdout: 'a\n', stdoutTruncated: true },
    ]))
    await begin($, 'matrixnametrunc')
    expect(runs.some(r => git(r) && r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes('--force'))).toBe(true)
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('no open transaction')).toBe(true)
  })

  test('failed untracked-file listing fails setup closed', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'ls-files' && r.argv[2] === '--others', exitCode: 1 },
    ]))
    await begin($, 'matrixlsfail01')
    expect(runs.some(r => git(r) && r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes('--force'))).toBe(true)
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('no open transaction')).toBe(true)
  })

  test('truncated untracked-file listing fails setup closed', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'ls-files' && r.argv[2] === '--others', stdout: 'file\n', stdoutTruncated: true },
    ]))
    await begin($, 'matrixlstrunc01')
    expect(runs.some(r => git(r) && r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes('--force'))).toBe(true)
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('no open transaction')).toBe(true)
  })

  test('baseline staging failure destroys the incomplete workspace and blocks mutations', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = fixture(on, clean([
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--binary', stdout: 'diff --git a/a b/a\npatch\n' },
      { match: r => git(r) && r.argv[1] === 'diff' && r.argv[2] === 'HEAD' && r.argv[3] === '--name-only', stdout: 'a\n' },
      { match: r => git(r) && r.argv[1] === 'hash-object', stdout: 'blobhash\n' },
      { match: r => git(r) && r.argv[1] === 'add' && r.argv[2] === '-A' && tx(r.cwd), exitCode: 1, stderr: 'write failed' },
    ]))
    await begin($, 'matrixbaseadd01')
    expect(runs.some(r => git(r) && r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes('--force'))).toBe(true)
    const status: any = await $.command.run({ command: 'airlock-status' })
    expect(status.text.includes('no open transaction')).toBe(true)
  })
})
