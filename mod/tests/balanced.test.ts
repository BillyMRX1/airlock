import { test, expect, describe, mock } from 'claude-code/testing'

const REPO = '/repo/balanced'
const HOME = '/home/tester'
const ROOT = `${HOME}/.claude-airlock/balanced-tx`

function setup(on: any, interactive: boolean, answer: string | null) {
  const tx = {
    transactionId: 'balanced-tx', sessionId: 'test-session', turnId: 'turn01',
    repoRoot: REPO, txRoot: ROOT, startedAt: 1, baseHead: 'head', baselineCommit: 'head',
    baselineFingerprint: {}, untrackedCopied: [], skippedFiles: [], state: 'ACTIVE',
    changedFiles: [], stats: { files: 0, insertions: 0, deletions: 0 },
    sideEffectEvents: [] as any[], bashCalls: 0, rewrites: 0,
  }
  const map: Record<string, any> = { [`airlock:${REPO}:active`]: tx }
  const calls: any[] = []
  const questions: string[] = []
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
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_$: any, e: any) => {
    calls.push(e)
    return { value: { exitCode: 0, stdout: e.argv[0] === 'git' ? `${REPO}\n` : 'ran', stderr: '' } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    questions.push(e.questions[0].question)
    if (answer === null) throw new Error('dismissed')
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } }
  })
  return { map, calls, questions, tx, interactive }
}

async function start($: any, interactive: boolean) {
  await $.session.start({ cwd: REPO, surface: interactive ? 'terminal' : null, isInteractive: interactive })
}

describe('balanced side-effect confirmation', () => {
  for (const answer of ['Allow once', 'Deny', 'yes', null]) {
    test(`interactive answer ${answer}: only exact approval runs command`, { options: { mode: 'balanced' } }, async ($: any, on: any) => {
      const s = setup(on, true, answer)
      await start($, true)
      const result: any = await $.tool.call({ tool: 'Bash', command: 'npm publish --dry-run' })
      expect(s.questions.length).toBe(1)
      expect(s.questions[0]).toContain('cannot automatically be rolled back')
      expect(s.questions[0]).toContain('npm publish --dry-run')
      expect(s.calls.filter(e => e.argv[0] === 'bash').length).toBe(answer === 'Allow once' ? 1 : 0)
      expect(typeof result.deny).toBe(answer === 'Allow once' ? 'undefined' : 'string')
      const saved = s.map[`airlock:${REPO}:active`]
      expect(saved.sideEffectEvents.length).toBe(1)
      expect(saved.sideEffectEvents[0].action).toBe(answer === 'Allow once' ? 'recorded' : 'denied')
    })
  }

  test('headless balanced denies without opening a dialog', { options: { mode: 'balanced' } }, async ($: any, on: any) => {
    const s = setup(on, false, 'Allow once')
    await start($, false)
    const result: any = await $.tool.call({ tool: 'Bash', command: 'git fetch origin' })
    expect(result.deny).toContain('headless')
    expect(s.questions.length).toBe(0)
    expect(s.calls.some(e => e.argv[0] === 'bash')).toBe(false)
    expect(s.map[`airlock:${REPO}:active`].sideEffectEvents[0].action).toBe('denied')
  })

  test('balanced approval does not authorize a later command', { options: { mode: 'balanced' } }, async ($: any, on: any) => {
    const s = setup(on, true, 'Allow once')
    await start($, true)
    await $.tool.call({ tool: 'Bash', command: 'git fetch origin' })
    await $.tool.call({ tool: 'Bash', command: 'git fetch upstream' })
    expect(s.questions.length).toBe(2)
    expect(s.calls.filter(e => e.argv[0] === 'bash').length).toBe(2)
  })

  test('balanced local commands run; topology and background remain denied', { options: { mode: 'balanced' } }, async ($: any, on: any) => {
    const s = setup(on, true, 'Allow once')
    await start($, true)
    const local: any = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const topology: any = await $.tool.call({ tool: 'Bash', command: 'git commit -m test' })
    const background: any = await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true })
    expect(local.deny).toBeUndefined()
    expect(topology.deny).toContain('topology')
    expect(background.deny).toContain('background')
    expect(s.questions.length).toBe(0)
    expect(s.calls.filter(e => e.argv[0] === 'bash').length).toBe(1)
  })

  for (const mode of ['strict', 'permissive']) {
    test(`${mode} keeps its policy without a dialog`, { options: { mode } }, async ($: any, on: any) => {
      const s = setup(on, true, 'Allow once')
      await start($, true)
      const result: any = await $.tool.call({ tool: 'Bash', command: 'npm publish --dry-run' })
      expect(typeof result.deny).toBe(mode === 'strict' ? 'string' : 'undefined')
      expect(s.questions.length).toBe(0)
      expect(s.calls.filter(e => e.argv[0] === 'bash').length).toBe(mode === 'strict' ? 0 : 1)
    })
  }
})


test('review state denies file mutations and Bash even after a fresh command-store read', async ($: any, on: any) => {
  const s = setup(on, false, 'Allow once')
  await start($, false)
  s.map[`airlock:${REPO}:active`].state = 'REVIEW'
  await $.command.run({ command: 'airlock-status' })
  for (const input of [
    { tool: 'Write', file_path: `${REPO}/new.txt`, content: 'x' },
    { tool: 'Edit', file_path: `${REPO}/old.txt`, old_string: 'a', new_string: 'b' },
    { tool: 'NotebookEdit', notebook_path: `${REPO}/notes.ipynb`, new_source: 'x' },
    { tool: 'Bash', command: 'npm test' },
  ]) {
    const result: any = await $.tool.call(input)
    expect(result.deny).toContain('awaiting review')
  }
  expect(s.calls.some(e => e.argv[0] === 'bash')).toBe(false)
})

test('Bash refuses after repository detection fails even without a transaction', async ($: any, on: any) => {
  mock.store(on, {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_$: any, e: any) => ({ value: e.name }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no repository' } }))
  await start($, false)
  const result: any = await $.tool.call({ tool: 'Bash', command: 'touch real-file.txt' })
  expect(result.deny).toContain('fail-safe')
})


test('Bash honors a repository mode change made after this session started', { options: { mode: 'balanced' } }, async ($: any, on: any) => {
  const s = setup(on, true, 'Allow once')
  await start($, true)
  s.map[`airlock:${REPO}:mode`] = 'strict'
  const result: any = await $.tool.call({ tool: 'Bash', command: 'npm publish --dry-run' })
  expect(result.deny).toContain('mode: strict')
  expect(s.questions.length).toBe(0)
  expect(s.calls.some(e => e.argv[0] === 'bash')).toBe(false)
})
