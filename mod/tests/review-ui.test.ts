import { test, expect, mock } from 'claude-code/testing'
import { activeKey } from '../hooks/tx/state.ts'

const REPO = '/repo/project'
const PANE = 'airlock-review'
const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n'
const TX = {
  transactionId: 'turn-review-01', sessionId: 'review-test-session', turnId: 'turn-review-01',
  repoRoot: REPO, txRoot: '/home/tester/.claude-airlock/project-turn-review-01',
  baseHead: '0123456789abcdef', baselineCommit: '0123456789abcdef', baselineFingerprint: {},
  state: 'REVIEW', changedFiles: ['src/app.ts', 'README.md'], skippedFiles: ['large.bin'],
  untrackedCopied: ['notes.txt'], stats: { files: 2, insertions: 7, deletions: 3 },
  sideEffectEvents: [{ pattern: 'git push', action: 'denied', reason: 'remote write' }],
  bashCalls: 0, rewrites: 2,
}

function setup(on: any, transaction: any = TX) {
  const map: Record<string, any> = transaction ? { [activeKey(REPO)]: { ...transaction } } : {}
  const runs: any[] = []
  const opened: any[] = []
  const registered: string[] = []
  const closed: string[] = []
  const toasts: string[] = []
  let paneResult: any = { isPlaced: true }
  mock.env(on, { HOME: '/home/tester' })
  on('store.get', (_$: any, e: any) => ({ value: map[e.key] }))
  on('store.set', (_$: any, e: any) => { map[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete map[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(map) }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'review-test-session' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.close', (_$: any, e: any) => { closed.push(e.id); return { value: undefined } })
  on('ui.open', (_$: any, e: any) => { opened.push(e); return { value: paneResult } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => { registered.push(e.name); return { value: e.name } })
  on('prompt.section', (_$: any, e: any) => ({ text: e.text }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path.startsWith('/home/tester/.claude-airlock/') && !e.path.includes('.backup') }))
  on('fs.stat', (_$: any, e: any) => ({ value: {
    kind: e.path === '/home/tester/.claude-airlock' || e.path.endsWith('.backup') || (e.path.startsWith('/home/tester/.claude-airlock/') && !e.path.slice('/home/tester/.claude-airlock/'.length).includes('/')) ? 'dir' : 'file',
    size: 0, isLink: false, realPath: e.path,
  } }))
  on('process.run', (_$: any, e: any) => {
    runs.push(e)
    let stdout = ''
    if (e.argv[1] === 'rev-parse' && e.argv[2] === '--show-toplevel') stdout = `${REPO}\n`
    else if (e.argv[1] === 'diff' && e.argv.includes('--name-only')) stdout = 'src/app.ts\n'
    else if (e.argv[1] === 'diff' && e.argv.includes('--numstat')) stdout = '7\t3\tsrc/app.ts\n'
    else if (e.argv[1] === 'diff') stdout = PATCH
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return { map, runs, opened, closed, toasts, registered, refusePane: (reason: string) => { paneResult = { isPlaced: false, reason } } }
}

async function start($: any, interactive = true) {
  await $.session.start({ cwd: REPO, surface: interactive ? 'terminal' : null, isInteractive: interactive })
}

async function mount($: any, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'airlock', surface, component: 'Pane', requestId: PANE,
    props: { title: 'Airlock review', isFocused: false, bodyColumns: 80,
      placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
}

test('review pane shows summary, pending checks, and the matching diff on both surfaces', async ($: any, on: any) => {
  const s = setup(on)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect((await ui.find({ type: 'Text', text: /turn-review-01/ }))?.text).toContain('REVIEW')
    expect((await ui.find({ type: 'Text', text: /\+7\/-3/ }))?.text).toContain('2 file(s)')
    expect((await ui.find({ type: 'Text', text: /Skipped files/ }))?.text).toContain('large.bin')
    expect(await ui.find({ type: 'Text', text: /does not run your project test suite/ })).toBeDefined()
    for (const key of ['review-diff', 'accept', 'reject']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    await ui.press({ key: 'review-diff' })
    await ui.redraw()
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(s.map[`airlock:${REPO}:review-diff`].text).toBe(PATCH)
    expect(s.map[`airlock:${REPO}:review-diff`].transactionId).toBe(TX.transactionId)
    await ui.unmount()
  }
  const diffs = s.runs.filter(r => r.argv[1] === 'diff')
  expect(diffs.length).toBe(2)
  expect(diffs.every(r => r.init.cwd === TX.txRoot)).toBe(true)
})

for (const command of ['accept', 'reject'] as const) {
  test(`pane ${command} uses the real command and closes after resolving on both surfaces`, async ($: any, on: any) => {
    const s = setup(on)
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      s.map[activeKey(REPO)] = { ...TX }
      const ui = await mount($, surface)
      await ui.press({ key: command })
      expect(s.map[activeKey(REPO)]).toBeUndefined()
      expect(s.closed[s.closed.length - 1]).toBe(PANE)
      await ui.unmount()
    }
    expect(s.runs.filter(r => r.argv[1] === 'worktree' && r.argv[2] === 'remove').length).toBe(2)
    expect(s.runs.filter(r => r.argv[1] === 'apply' && r.argv[2] !== '--check').length).toBe(command === 'accept' ? 2 : 0)
  })
}

test('stale pane actions cannot resolve a replacement transaction or display its old diff', async ($: any, on: any) => {
  const s = setup(on)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    s.map[activeKey(REPO)] = { ...TX }
    const ui = await mount($, surface)
    s.map[activeKey(REPO)] = { ...TX, transactionId: 'replacement-transaction' }
    await ui.press({ key: 'accept' })
    expect(s.map[activeKey(REPO)].transactionId).toBe('replacement-transaction')
    expect(s.runs.some(r => r.argv[1] === 'apply')).toBe(false)
    await ui.unmount()
    s.map[`airlock:${REPO}:review-diff`] = { transactionId: TX.transactionId, text: PATCH }
    const replacementUi = await mount($, surface)
    expect(await replacementUi.find({ type: 'Code' })).toBeUndefined()
    await replacementUi.unmount()
  }
})

test('prompt framing preserves the section and is omitted without an active transaction', async ($: any, on: any) => {
  const s = setup(on)
  await start($)
  const result: any = await $.prompt.section({ name: 'env_info_simple', text: 'Environment details.' })
  expect(result.text).toContain('Environment details.')
  expect(result.text).toContain('paths outside the repository pass through unchanged')
  expect(result.text).toContain('MCP tools are not routed through Airlock')
  expect(result.text).toContain('Background Bash is unavailable')
  delete s.map[activeKey(REPO)]
  const idle: any = await $.prompt.section({ name: 'env_info_simple', text: 'Environment details.' })
  expect(idle.text).toBe('Environment details.')
})

for (const interactive of [true, false]) {
  test(`turn completion opens the review pane only when interactive=${interactive}`, async ($: any, on: any) => {
    const s = setup(on, { ...TX, state: 'ACTIVE' })
    await start($, interactive)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: TX.turnId, reason: 'answer' })
    expect(s.map[activeKey(REPO)].state).toBe('REVIEW')
    expect(s.opened.length).toBe(interactive ? 1 : 0)
    if (interactive) expect(s.opened[0].id).toBe(PANE)
  })
}

test('explicit review command opens the pane with focus using the current stored transaction', async ($: any, on: any) => {
  const s = setup(on)
  await start($)
  // Simulate a store update since session recovery; the command must read the
  // latest repository record rather than rely on the in-memory transaction.
  s.map[activeKey(REPO)] = { ...TX, transactionId: 'fresh-review-record', state: 'CONFLICTED' }
  const result: any = await $.command.run({ command: 'airlock-review' })
  expect(s.registered).toContain('airlock-review')
  expect(s.opened.length).toBe(1)
  expect(s.opened[0]).toMatchObject({ id: PANE, title: 'Airlock review', focus: true, rows: 12 })
  expect(result.text).toContain('fresh-review-record')
  expect(result.text).toContain('does not run project tests')
})

test('explicit review opens APPLY_FAILED for inspection and warns to preserve recovery data', async ($: any, on: any) => {
  const s = setup(on, { ...TX, state: 'APPLY_FAILED' })
  await start($)
  const result: any = await $.command.run({ command: 'airlock-review' })
  expect(s.opened.length).toBe(1)
  expect(result.text).toContain('Keep the workspace and backup')
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /APPLY_FAILED: this transaction may be partially applied/ })).toBeDefined()
  await ui.unmount()
})

test('explicit review command gives useful no-transaction and headless guidance', async ($: any, on: any) => {
  const s = setup(on, null)
  await start($)
  const missing: any = await $.command.run({ command: 'airlock-review' })
  expect(missing.text).toContain('no open transaction')
  expect(s.opened.length).toBe(0)

  s.map[activeKey(REPO)] = { ...TX }
  // A new non-interactive session reflects a headless command invocation.
  await start($, false)
  const headless: any = await $.command.run({ command: 'airlock-review' })
  expect(headless.text).toContain('interactive session')
  expect(headless.text).toContain('/airlock-diff')
  expect(s.opened.length).toBe(0)
})

test('explicit review command leaves ACTIVE transactions untouched', async ($: any, on: any) => {
  const active = { ...TX, state: 'ACTIVE' }
  const s = setup(on, active)
  await start($)
  const result: any = await $.command.run({ command: 'airlock-review' })
  expect(result.text).toContain('/airlock-begin end')
  expect(s.map[activeKey(REPO)].state).toBe('ACTIVE')
  expect(s.opened.length).toBe(0)
  expect(s.runs.some(r => r.argv[1] === 'add')).toBe(false)
})

test('explicit review command reports when the engine cannot place the pane', async ($: any, on: any) => {
  const s = setup(on)
  s.refusePane('surface unavailable')
  await start($)
  const result: any = await $.command.run({ command: 'airlock-review' })
  expect(result.text).toContain('surface unavailable')
  expect(result.text).toContain('/airlock-diff')
})
