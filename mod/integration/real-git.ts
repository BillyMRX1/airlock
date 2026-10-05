// No-model integration host for Airlock's production hook handlers.
// Runs the handlers directly with real Git and filesystem calls. This is not
// a Claude engine, permission, UI, or model end-to-end test.
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { onTurnStart, onTurnComplete } from '../hooks/tx/lifecycle.ts'
import { onSessionStart } from '../hooks/tx/recovery.ts'
import { onTxAccept, onTxReject, onTxAbort } from '../hooks/tx/commands.tsx'
import { onWriteCall } from '../hooks/tools/rewrite.ts'
import { ctx, activeKey } from '../hooks/tx/state.ts'

type RunResult = { stdout: string; stderr: string; exitCode: number }
const store = new Map<string, unknown>()
let session = 'integration-session'

function run(argv: string[], cwd: string, stdin?: string): RunResult {
  const p = spawnSync(argv[0], argv.slice(1), { cwd, input: stdin, encoding: 'utf8' })
  return { stdout: p.stdout ?? '', stderr: p.stderr ?? '', exitCode: p.status ?? 1 }
}

const $: any = {
  env: { get: async (name: string) => name === 'HOME' ? process.env.HOME : undefined },
  process: { run: async (argv: string[], opts: any = {}) => run(argv, opts.cwd, opts.stdin) },
  session: { id: async () => session },
  store: {
    get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) }, keys: async () => [...store.keys()],
  },
  fs: {
    exists: async (path: string) => { try { await readFile(path); return true } catch { try { await (await import('node:fs/promises')).stat(path); return true } catch { return false } } },
    stat: async (path: string) => {
      const s = await (await import('node:fs/promises')).lstat(path)
      return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', size: s.size, isLink: s.isSymbolicLink(), realPath: await realpath(path) }
    },
  },
  ui: { status: () => {}, toast: () => {}, open: async () => ({ isPlaced: true }) },
  command: { register: async () => {} },
}

const pass = (e: unknown) => e
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
async function git(cwd: string, ...argv: string[]): Promise<string> {
  const r = run(['git', ...argv], cwd)
  assert(r.exitCode === 0, `git ${argv.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}
async function put(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, value)
}
async function start(repo: string, turn: string): Promise<any> {
  ctx.tx = null
  ctx.blockedByOtherSession = null
  await onSessionStart($, { cwd: repo, isInteractive: false }, pass)
  await onTurnStart($, { text: 'integration prompt', turnId: turn }, pass)
  assert(ctx.tx, `turn ${turn} did not create a transaction`)
  return ctx.tx
}
async function review(tx: any): Promise<void> {
  await onTurnComplete($, { turnId: tx.turnId }, pass)
  assert(tx.state === 'REVIEW', 'turn completion did not enter review')
}

const work = await mkdtemp(join(tmpdir(), 'airlock-real-git-'))
const originalHome = process.env.HOME
process.env.HOME = join(work, 'home')
await mkdir(process.env.HOME, { recursive: true })
try {
  const seed = resolve(import.meta.dir, '../../spike-sandbox/demo-project')
  const fixturePath = join(work, 'fixture')
  const cloned = run(['git', 'clone', '--local', '--no-hardlinks', seed, fixturePath], work)
  assert(cloned.exitCode === 0, `could not clone integration seed: ${cloned.stderr}`)
  const repo = await git(fixturePath, 'rev-parse', '--show-toplevel')
  await git(repo, 'config', 'user.name', 'Integration Fixture')
  await git(repo, 'config', 'user.email', 'integration@example.invalid')
  const head = await git(repo, 'rev-parse', 'HEAD')

  // Real dirty-index baseline: staged and unstaged tracked edits, untracked
  // Unicode/binary paths, and ignored data all coexist before turn.start.
  const math = join(repo, 'src/math.ts')
  const initial = await readFile(math, 'utf8')
  await writeFile(math, `${initial}\n// staged baseline marker\n`)
  await git(repo, 'add', 'src/math.ts')
  await writeFile(math, `${initial}\n// staged baseline marker\n// unstaged baseline marker\n`)
  await writeFile(join(repo, '.gitignore'), 'private.env\n')
  await git(repo, 'add', '.gitignore')
  await put(join(repo, '資料/naïve 🚪.txt'), 'baseline unicode\n')
  await put(join(repo, 'private.env'), 'SECRET\n')
  const outside = join(work, 'outside')
  await mkdir(outside, { recursive: true })
  await put(join(outside, 'secret.txt'), 'outside data\n')
  await symlink('README.md', join(repo, 'readme-link'))
  await symlink(outside, join(repo, 'outside-link'))
  const realIndex = await git(repo, 'diff', '--cached', '--name-only')
  const tx = await start(repo, 'dirty-accept')
  const txMath = await readFile(join(tx.txRoot, 'src/math.ts'), 'utf8')
  assert(txMath.includes('staged baseline marker') && txMath.includes('unstaged baseline marker'), 'tracked dirty baseline was not copied faithfully')
  assert(tx.untrackedCopied.includes('資料/naïve 🚪.txt'), 'Unicode untracked path was not copied')
  assert(tx.skippedFiles.includes('readme-link') && tx.skippedFiles.includes('outside-link'), 'symlink paths were not excluded from the baseline')
  assert(!(await $.fs.exists(join(tx.txRoot, 'private.env'))), 'ignored file leaked into transaction')
  assert((await git(tx.txRoot, 'rev-parse', 'HEAD')) !== head, 'dirty baseline commit was not created in worktree')
  await put(join(tx.txRoot, 'new/雪.bin'), new Uint8Array([0, 255, 1, 127]))
  await review(tx)
  const accepted = await onTxAccept($, {})
  assert(accepted.text.includes('applied transaction'), 'accept failed')
  assert((await readFile(join(repo, 'new/雪.bin'))).equals(Buffer.from([0, 255, 1, 127])), 'binary Unicode path was not applied byte-for-byte')
  assert((await git(repo, 'diff', '--cached', '--name-only')) === realIndex, 'accept changed the real index')
  assert((await git(repo, 'rev-parse', 'HEAD')) === head, 'accept committed to the real repository')
  console.log('PASS dirty baseline, unicode/binary paths, ignored exclusion, accept/index preservation')

  const linkTx = await start(repo, 'symlink-probes')
  let rewritten = ''
  const internalResult: any = await onWriteCall($, { file_path: join(repo, 'readme-link') }, async (e: any) => { rewritten = e.file_path; return { result: 'ok' } })
  assert(rewritten === join(await realpath(linkTx.txRoot), 'README.md'), `in-repository symlink did not route to the canonical worktree target: ${rewritten}`)
  const outsideResult: any = await onWriteCall($, { file_path: join(repo, 'outside-link/secret.txt') }, async (e: any) => ({ result: e.file_path }))
  assert(typeof outsideResult?.deny === 'string', 'symlink escape outside the repository was not denied')
  await onTxAbort($, {})
  console.log('PASS realpath-aware symlink routing and external symlink escape denial')

  // Conflict path: baseline tracked file changes after transaction start.
  const conflictTx = await start(repo, 'conflict')
  await put(join(conflictTx.txRoot, 'src/math.ts'), `${txMath}\ntransaction edit\n`)
  await review(conflictTx)
  await put(math, `${txMath}\nhuman concurrent edit\n`)
  const conflict = await onTxAccept($, {})
  assert(conflict.text.includes('CONFLICT'), 'concurrent real-tree edit was not detected')
  assert((await readFile(math, 'utf8')).includes('human concurrent edit'), 'conflict overwrote human edit')
  await onTxReject($, {})
  console.log('PASS conflict detection and reject')

  // The ordinary patch-fit check permits this disjoint-hunk update, so the
  // baseline blob comparison must catch the concurrent real-tree edit.
  const longPath = join(repo, 'long-baseline.txt')
  const lines = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`)
  await writeFile(longPath, `${lines.join('\n')}\n`)
  await git(repo, 'add', 'long-baseline.txt')
  const disjointTx = await start(repo, 'different-hunk-conflict')
  // Exercise the baseline-blob fallback used for clean tracked files and
  // legacy records, rather than relying on this dirty path's fingerprint.
  delete disjointTx.baselineFingerprint['long-baseline.txt']
  const txLines = lines.slice()
  txLines[2] = 'transaction line 3'
  await writeFile(join(disjointTx.txRoot, 'long-baseline.txt'), `${txLines.join('\n')}\n`)
  const disjointPatch = run(['git', 'diff', disjointTx.baselineCommit, '--binary'], disjointTx.txRoot).stdout
  const precheck = run(['git', 'apply', '--check', '-'], repo, disjointPatch)
  assert(precheck.exitCode === 0, `control patch unexpectedly failed before concurrent edit: ${precheck.stderr}\n${disjointPatch}`)
  lines[36] = 'human line 37'
  await writeFile(longPath, `${lines.join('\n')}\n`)
  const afterHuman = run(['git', 'apply', '--check', '-'], repo, disjointPatch)
  assert(afterHuman.exitCode === 0, 'control patch no longer fits after the distant concurrent edit')
  await review(disjointTx)
  const disjointConflict: any = await onTxAccept($, {})
  assert(disjointConflict.text.includes('CONFLICT'), 'different-hunk real-tree edit was not detected by baseline comparison')
  await onTxReject($, {})
  console.log('PASS baseline blob conflict check catches disjoint edits even when git apply --check passes')

  const newlineTx = await start(repo, 'newline-path')
  const newlinePath = 'new/line\nbreak 🚪.txt'
  await put(join(newlineTx.txRoot, newlinePath), 'newline path survives\n')
  await review(newlineTx)
  const newlineAccept: any = await onTxAccept($, {})
  assert(newlineAccept.text.includes('applied transaction'), 'accept rejected a newline filename')
  assert((await readFile(join(repo, newlinePath), 'utf8')) === 'newline path survives\n', 'newline filename did not apply exactly')
  console.log('PASS newline and Unicode transaction filename acceptance')

  // Abort is available while ACTIVE, before turn.complete/review.
  const abortTx = await start(repo, 'abort')
  const aborted = await onTxAbort($, {})
  assert(aborted.text.includes('aborted and destroyed'), 'abort failed')
  assert(!(await $.fs.exists(abortTx.txRoot)), 'abort left its worktree behind')
  console.log('PASS active transaction abort')

  // Reject path after review, plus store-backed crash/session recovery.
  const rejectTx = await start(repo, 'recovery-reject')
  await put(join(rejectTx.txRoot, 'src/rejected.txt'), 'discard me\n')
  await review(rejectTx)
  const saved = store.get(activeKey(repo))
  ctx.tx = null
  session = 'recovery-session'
  await onSessionStart($, { cwd: join(repo, 'src'), isInteractive: false }, pass)
  assert(ctx.repoRoot === repo, 'subdirectory session did not resolve repository root')
  assert(ctx.tx?.transactionId === rejectTx.transactionId, 'session did not recover saved transaction')
  assert(store.get(activeKey(repo)) === saved, 'recovery changed the saved transaction')
  await onTxReject($, {})
  assert(!(await $.fs.exists(rejectTx.txRoot)), 'reject left worktree behind')
  assert(!(await $.fs.exists(join(repo, 'src/rejected.txt'))), 'reject applied transaction changes')
  console.log('PASS subdirectory detection, stored transaction recovery, reject')

  // Detached and nested repository roots are detected using real Git.
  const detachedPath = join(work, 'detached')
  const dc = run(['git', 'clone', '--local', '--no-hardlinks', seed, detachedPath], work)
  assert(dc.exitCode === 0, `detached fixture clone failed: ${dc.stderr}`)
  const detached = await git(detachedPath, 'rev-parse', '--show-toplevel')
  await git(detached, 'checkout', '--detach', 'HEAD')
  session = 'detached-session'
  await onSessionStart($, { cwd: detached, isInteractive: false }, pass)
  assert(ctx.repoRoot === detached, 'detached HEAD repository was not detected')
  assert((await git(detached, 'symbolic-ref', '-q', 'HEAD').catch(() => '')) === '', 'detached fixture unexpectedly has a branch')

  const nested = join(repo, 'nested-repo')
  const nc = run(['git', 'clone', '--local', '--no-hardlinks', seed, nested], work)
  assert(nc.exitCode === 0, `nested fixture clone failed: ${nc.stderr}`)
  await onSessionStart($, { cwd: join(nested, 'src'), isInteractive: false }, pass)
  assert(ctx.repoRoot === nested, 'nested repository did not take precedence over its parent repository')
  console.log('PASS detached HEAD and nested repository root detection')
  console.log('Integration host complete. Claude engine, permission, UI, and model E2E: SKIPPED by design.')
} finally {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(work, { recursive: true, force: true })
}
