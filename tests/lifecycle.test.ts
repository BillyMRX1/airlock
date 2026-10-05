// Transaction lifecycle through the real engine's event chains. The
// test's own hooks ARE the engine bottom (the kit's design), so
// `process.run` is a scripted fake git — real-git end-to-end behaviour
// was proven by the spike experiments; these tests pin the orchestration:
// worktree creation, path rewriting, Bash cwd routing, side-effect
// denial, stats, accept (incl. conflict) and reject.

import { test, expect, describe, mock } from 'claude-code/testing'

interface Run {
  argv: readonly string[]
  cwd?: string
  stdin?: string
}

// Registers the engine-bottom hooks the plugin's calls need, and records
// every process.run. `script` maps an argv signature to a result.
function engineBottom(on: any, script: Array<{ match: (r: Run) => boolean; stdout?: string; exitCode?: number }>, completion?: { text: string; usage?: any }): { runs: Run[] } {
  const runs: Run[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('fs.stat', (_$: any, e: any) => ({ value: {
    kind: e.path === '/home/tester/.claude-airlock' || e.path.endsWith('.backup') || (e.path.startsWith('/home/tester/.claude-airlock/') && !e.path.slice('/home/tester/.claude-airlock/'.length).includes('/')) ? 'dir' : 'file',
    size: 0, isLink: false, realPath: e.path,
  } }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path.startsWith('/home/tester/.claude-airlock/') && !e.path.includes('.backup') }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => ({ value: e.name }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => completion ?? { text: e.answer })
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
  return { runs }
}

const REPO = '/repo/project'
const HOME = '/home/tester'

function stdScript(txRoot: string): Array<{ match: (r: Run) => boolean; stdout?: string; exitCode?: number }> {
  return [
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'rev-parse' && r.argv[2] === '--show-toplevel', stdout: `${REPO}\n` },
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'rev-parse' && r.argv[2] === 'HEAD', stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' },
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'worktree', stdout: '' },
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'diff' && r.argv[3] === '--numstat', stdout: '1\t0\tb.txt\n' },
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'diff' && r.argv.includes('--name-only'), stdout: 'b.txt\n' },
    // The real tree is clean: the PREPARING dirty-capture (cwd REPO) is
    // empty; the transaction's own patch (cwd = the worktree) has content.
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'diff' && r.argv[3] === '--binary' && r.cwd === REPO, stdout: '' },
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'diff' && r.argv[3] === '--binary', stdout: 'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -0,0 +1 @@\n+tx-content\n' },
    { match: r => r.argv[0] === 'git' && r.argv[1] === 'apply', stdout: '' },
    { match: r => r.argv[0] === 'bash', stdout: `${txRoot}\n` },
  ]
}

describe('transaction lifecycle', () => {
  test('completion preserves a distinct downstream hook notice and usage without replaying the answer', async ($: any, on: any) => {
    mock.env(on, { HOME })
    mock.store(on, {})
    const usage = { model: 'test-model', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    engineBottom(on, stdScript('x'), { text: 'Another plugin notice.\nSecond line.', usage })
    await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
    await $.turn.start({ text: 'edit things', turnId: 'summarychain1' })
    const completed: any = await $.turn.complete({ answer: 'Unique assistant answer.', durationMs: 1, isAborted: false, turnId: 'summarychain1', reason: 'answer' })
    expect(completed.text).toContain('Another plugin notice. Second line.')
    expect(completed.text).toContain('awaiting review')
    expect(completed.text.includes('Unique assistant answer')).toBe(false)
    expect(completed.text.includes('\n')).toBe(false)
    expect(completed.usage).toEqual(usage)
  })

  for (const interactive of [true, false]) {
    test(`completion summary does not replay the answer or emit control characters (interactive=${interactive})`, async ($: any, on: any) => {
      mock.env(on, { HOME })
      mock.store(on, {})
      engineBottom(on, stdScript('x'))
      const toasts: string[] = []
      on('ui.open', () => ({ value: { isPlaced: false, reason: 'terminal below 144 columns' } }))
      on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
      await $.session.start({ cwd: REPO, surface: interactive ? 'terminal' : null, isInteractive: interactive })
      await $.turn.start({ text: 'edit things', turnId: 'summary000001' })
      const answer = 'Unique assistant answer.\nSecond line with Unicode: café.'
      const completed: any = await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 'summary000001', reason: 'answer' })
      expect(completed.text).toContain('awaiting review')
      expect(completed.text).toContain('1 file(s) changed, +1/-0')
      expect(completed.text).toContain('/airlock-review')
      expect(completed.text.includes('Unique assistant answer')).toBe(false)
      expect(/[^\x20-\x7e]/.test(completed.text)).toBe(false)
      expect(toasts.length).toBe(interactive ? 1 : 0)
      if (interactive) expect(toasts[0]).toContain('/airlock-review')
    })
  }

  for (const failure of ['stage', 'stats'] as const) {
    test(`completion ${failure} failure reports only the failure, without replaying the answer`, async ($: any, on: any) => {
      mock.env(on, { HOME })
      mock.store(on, {})
      const script = stdScript('x')
      script.unshift({ match: r => failure === 'stage' ? r.argv[1] === 'add' : r.argv.includes('--numstat'), exitCode: 1 })
      engineBottom(on, script)
      await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
      await $.turn.start({ text: 'edit things', turnId: 'summaryfail01' })
      const completed: any = await $.turn.complete({ answer: 'Unique assistant answer.\nMore text.', durationMs: 1, isAborted: false, turnId: 'summaryfail01', reason: 'answer' })
      expect(completed.text).toContain(failure === 'stage' ? 'could not stage' : 'could not read complete transaction stats')
      expect(completed.text.includes('Unique assistant answer')).toBe(false)
      expect(/[^\x20-\x7e]/.test(completed.text)).toBe(false)
      const status: any = await $.command.run({ command: 'airlock-status' })
      expect(status.text).toContain('ACTIVE')
    })
  }

  test('accept: creation, rewriting, routing, denial, apply, cleanup', { timeoutMs: 30000 }, async ($: any, on: any) => {
    const seen: string[] = []
    mock.env(on, { HOME })
    mock.store(on, {})
    const { runs } = engineBottom(on, stdScript('PLACEHOLDER')) // txRoot recorded below
    on('tool.call', (_$: any, e: any) => {
      seen.push(`${e.tool}:${e.file_path ?? ''}`)
      return { result: { observed: true } }
    })

    await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
    await $.turn.start({ text: 'edit things', turnId: 'turnaccept0001' })

    // The worktree was created, detached at HEAD, under our directory.
    const add = runs.find(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')
    expect(add).toBeDefined()
    expect(add!.argv).toContain('--detach')
    expect(add!.cwd).toBe(REPO)
    const txRoot = add!.argv.find(a => typeof a === 'string' && a.startsWith(`${HOME}/.claude-airlock/`)) as string
    expect(txRoot).toContain('/project-turnacce')

    // Read is rewritten into the worktree.
    const read: any = await $.tool.call({ tool: 'Read', file_path: `${REPO}/a.txt` })
    expect(read.deny).toBeUndefined()
    expect(seen[seen.length - 1]).toBe(`Read:${txRoot}/a.txt`)

    // Write is rewritten too.
    await $.tool.call({ tool: 'Write', file_path: `${REPO}/src/new.ts`, content: 'x' })
    expect(seen[seen.length - 1]).toBe(`Write:${txRoot}/src/new.ts`)

    // Bash is self-executed with cwd = the worktree (argv, no shell surgery).
    const bash: any = await $.tool.call({ tool: 'Bash', command: 'echo tx-content > b.txt && pwd' })
    expect(bash.deny).toBeUndefined()
    const bashRun = runs.find(r => r.argv[0] === 'bash' && r.argv[1] === '-c' && (r.argv[2] as string).includes('tx-content'))
    expect(bashRun).toBeDefined()
    expect(bashRun!.cwd).toBe(txRoot)
    expect(bashRun!.argv[2]).toBe('echo tx-content > b.txt && pwd')

    // Strict mode denies side-effect and topology-mutating commands.
    const denied: any = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(typeof denied.deny).toBe('string')
    expect(denied.deny.includes('cannot automatically be rolled back')).toBe(true)
    expect(runs.some(r => (r.argv[2] as string | undefined)?.includes('git push'))).toBe(false)
    const deniedGit: any = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
    expect(typeof deniedGit.deny).toBe('string')

    await $.turn.complete({
      answer: 'done', durationMs: 10, isAborted: false, turnId: 'turnaccept0001', reason: 'answer',
    })
    // Turn completion staged and gathered stats inside the worktree.
    expect(runs.some(r => r.argv[1] === 'add' && r.cwd === txRoot)).toBe(true)

    const acc: any = await $.command.run({ command: 'airlock-accept' })
    expect(acc.text.includes('applied')).toBe(true)
    // The patch was conflict-checked and applied in the REAL repo root.
    const check = runs.find(r => r.argv[1] === 'apply' && r.argv[2] === '--check')
    expect(check).toBeDefined()
    expect(check!.cwd).toBe(REPO)
    expect(check!.stdin).toContain('diff --git a/b.txt')
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes(txRoot))).toBe(true)
  })

  test('reject: nothing applied, worktree destroyed, store cleared', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    const store: Record<string, unknown> = {}
    mock.store(on, store)
    const { runs } = engineBottom(on, stdScript('x'))
    on('tool.call', (_$: any, _e: any) => ({ result: { observed: true } }))

    await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
    await $.turn.start({ text: 'edit things', turnId: 'turnreject0001' })
    const add = runs.find(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')
    const txRoot = add!.argv.find(a => typeof a === 'string' && a.startsWith(`${HOME}/.claude-airlock/`)) as string
    const st1: any = await $.command.run({ command: 'airlock-status' })
    expect(st1.text.includes('ACTIVE')).toBe(true)

    await $.tool.call({ tool: 'Bash', command: 'echo rejected > c.txt' })
    await $.turn.complete({
      answer: 'done', durationMs: 10, isAborted: false, turnId: 'turnreject0001', reason: 'answer',
    })

    const rej: any = await $.command.run({ command: 'airlock-reject' })
    expect(rej.text.includes('did not apply a patch')).toBe(true)
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'remove' && r.argv.includes(txRoot))).toBe(true)
    expect(runs.some(r => r.argv[1] === 'apply')).toBe(false) // nothing ever applied
    const st2: any = await $.command.run({ command: 'airlock-status' })
    expect(st2.text.includes('no open transaction')).toBe(true)
  })

  test('accept conflict: concurrent real-tree change is refused, tx kept', { timeoutMs: 30000 }, async ($: any, on: any) => {
    mock.env(on, { HOME })
    const store: Record<string, unknown> = {}
    mock.store(on, store)
    const script = stdScript('x')
    // The real tree moved on: the conflict check fails. (Unshifted: the
    // script is matched in order, and stdScript has a generic 'apply' entry.)
    script.unshift({ match: r => r.argv[1] === 'apply' && r.argv[2] === '--check', exitCode: 1, stdout: '' })
    const { runs } = engineBottom(on, script)
    on('tool.call', (_$: any, _e: any) => ({ result: { observed: true } }))

    await $.session.start({ cwd: REPO, surface: null, isInteractive: false })
    await $.turn.start({ text: 'edit things', turnId: 'turnconf00001' })
    await $.tool.call({ tool: 'Bash', command: 'echo conflict > b.txt' })
    await $.turn.complete({
      answer: 'done', durationMs: 10, isAborted: false, turnId: 'turnconf00001', reason: 'answer',
    })

    const acc: any = await $.command.run({ command: 'airlock-accept' })
    expect(acc.text.includes('CONFLICT')).toBe(true)
    // No apply, no worktree removal: the transaction is kept for review.
    expect(runs.some(r => r.argv[1] === 'apply' && r.argv[2] !== '--check')).toBe(false)
    expect(runs.some(r => r.argv[1] === 'worktree' && r.argv[2] === 'remove')).toBe(false)
    const st: any = await $.command.run({ command: 'airlock-status' })
    expect(st.text.includes('CONFLICTED')).toBe(true)
  })
})
