// Real SIGKILL crash/recovery check for the production Airlock handlers.
// This exercises no Claude model or engine; child/parent processes share only
// a JSON-backed $.store adapter and a disposable cloned Git repository.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { onTurnStart, onTurnComplete } from '../hooks/tx/lifecycle.ts'
import { onSessionStart } from '../hooks/tx/recovery.ts'
import { onTxAbort, onTxAccept } from '../hooks/tx/commands.tsx'
import { activeKey, ctx } from '../hooks/tx/state.ts'

type RunResult = { stdout: string; stderr: string; exitCode: number; isStdoutTruncated: false; isStderrTruncated: false }

function run(argv: string[], cwd: string, stdin?: string): RunResult {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, input: stdin, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    isStdoutTruncated: false,
    isStderrTruncated: false,
  }
}

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = run(['git', ...args], cwd)
  assert(result.exitCode === 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function jsonStore(path: string) {
  let values: Record<string, unknown> = {}
  return {
    load: async () => {
      try { values = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; values = {} }
    },
    get: async (key: string) => values[key],
    set: async (key: string, value: unknown) => {
      values[key] = value
      await writeFile(path, JSON.stringify(values), 'utf8')
    },
    delete: async (key: string) => {
      delete values[key]
      await writeFile(path, JSON.stringify(values), 'utf8')
    },
    keys: async () => Object.keys(values),
  }
}

function host(home: string, store: ReturnType<typeof jsonStore>, sessionId: string) {
  const processCalls: Array<{ argv: string[]; cwd: string }> = []
  return {
    env: { get: async (name: string) => name === 'HOME' ? home : undefined },
    process: { run: async (argv: string[], init: any = {}) => {
      processCalls.push({ argv, cwd: init.cwd ?? process.cwd() })
      return run(argv, init.cwd ?? process.cwd(), init.stdin)
    } },
    session: { id: async () => sessionId },
    store: { get: store.get, set: store.set, delete: store.delete, keys: store.keys },
    fs: {
      exists: async (path: string) => { try { await stat(path); return true } catch { return false } },
      stat: async (path: string) => {
        const s = await stat(path)
        return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs, isLink: false, realPath: await realpath(path) }
      },
      list: async (path: string) => (await import('node:fs/promises')).readdir(path),
    },
    ui: { status: () => {}, toast: () => {}, open: async () => ({ isPlaced: true }) },
    command: { register: async () => {} },
    processCalls,
  }
}

const pass = (e: unknown) => e

async function childMain(repo: string, home: string, storePath: string): Promise<never> {
  process.env.HOME = home
  const store = jsonStore(storePath)
  await store.load()
  const $ = host(home, store, 'crash-child-session')
  ctx.tx = null
  ctx.blockedByOtherSession = null
  await onSessionStart($, { cwd: repo, isInteractive: false }, pass)
  await onTurnStart($, { text: 'prepare a crash-recovery transaction', turnId: 'crash-recovery-turn' }, pass)
  assert(ctx.tx, 'child did not create an active transaction')
  await writeFile(join(ctx.tx.txRoot, 'src', 'crash-child.txt'), 'kept only in the transaction worktree\n')
  process.stdout.write(`READY ${ctx.tx.txRoot}\n`)
  // Keep this process alive until the parent sends SIGKILL. No cleanup hooks
  // are registered: this reproduces a killed host, not a graceful exit.
  process.stdin.resume()
  await new Promise<never>(() => {})
}

async function childBeforeApply(repo: string, home: string, storePath: string): Promise<never> {
  process.env.HOME = home
  const store = jsonStore(storePath)
  await store.load()
  const $ = host(home, store, 'crash-apply-child-session')
  ctx.tx = null
  ctx.blockedByOtherSession = null
  await onSessionStart($, { cwd: repo, isInteractive: false }, pass)
  await onTurnStart($, { text: 'prepare an accept crash boundary', turnId: 'crash-before-apply-turn' }, pass)
  assert(ctx.tx, 'pre-apply child did not create a transaction')
  const txRoot = ctx.tx.txRoot
  const math = join(txRoot, 'src', 'math.ts')
  await writeFile(math, `${await readFile(math, 'utf8')}\n// transaction edit before crash\n`)
  await onTurnComplete($, { turnId: ctx.tx.turnId }, pass)
  const originalRun = $.process.run
  $.process.run = async (argv: string[], init: any = {}) => {
    if (argv[0] === 'git' && argv[1] === 'apply' && argv[2] === '-' && init.cwd === repo) {
      const persisted = JSON.parse(await readFile(storePath, 'utf8')) as Record<string, any>
      const record = persisted[activeKey(repo)]
      assert(record?.state === 'APPLY_FAILED', 'APPLY_FAILED marker was not persisted before real apply')
      const backup = `${record.txRoot}.backup/src/math.ts`
      await stat(backup)
      process.stdout.write(`PREAPPLY ${record.txRoot}\n`)
      process.stdin.resume()
      await new Promise<never>(() => {})
    }
    return originalRun(argv, init)
  }
  await onTxAccept($, {})
  throw new Error('accept returned instead of reaching the pre-apply crash boundary')
}

function spawnChild(script: string, mode: string, repo: string, home: string, storePath: string, cwd: string) {
  const child = spawn(process.execPath, ['run', script, mode, repo, home, storePath], {
    cwd,
    env: { ...process.env, HOME: home, NODE_PATH: import.meta.dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClose => {
    child.once('close', (code, signal) => resolveClose({ code, signal }))
  })
  return { child, closed, get stderr() { return stderr } }
}

async function waitForLine(child: ChildProcess, closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>, readStderr: () => string, prefix: string): Promise<string> {
  return new Promise<string>((resolveLine, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`child did not reach ${prefix}; stderr: ${readStderr()}`)), 30000)
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
      const line = output.split('\n').find(value => value.startsWith(`${prefix} `))
      if (line) { clearTimeout(timer); resolveLine(line.slice(prefix.length + 1)) }
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    void closed.then(exit => {
      clearTimeout(timer)
      reject(new Error(`child exited before ${prefix} (${exit.signal ?? exit.code}); stderr: ${readStderr()}`))
    })
  })
}

async function killAndReap(child: ChildProcess, closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  return closed
}

async function trackedHashes(repo: string): Promise<Record<string, string>> {
  const names = await git(repo, 'ls-files', '-z')
  const paths = names.split('\0').filter(Boolean)
  const hashes: Record<string, string> = {}
  for (const path of paths) {
    const bytes = await readFile(join(repo, path))
    hashes[path] = createHash('sha256').update(bytes).digest('hex')
  }
  return hashes
}

async function snapshot(repo: string) {
  return {
    head: await git(repo, 'rev-parse', 'HEAD'),
    index: createHash('sha256').update(await readFile(join(repo, '.git', 'index'))).digest('hex'),
    status: await git(repo, 'status', '--porcelain=v1', '--untracked-files=all'),
    tracked: await trackedHashes(repo),
    cached: await git(repo, 'diff', '--cached', '--binary'),
  }
}

async function parentMain(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'airlock-crash-recovery-'))
  const previousHome = process.env.HOME
  const home = join(root, 'home')
  let repo = join(root, 'fixture')
  const storePath = join(root, 'plugin-store.json')
  const children: Array<{ child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }> = []
  await mkdir(home, { recursive: true })
  process.env.HOME = home
  try {
    const seed = resolve(import.meta.dir, '../../spike-sandbox/demo-project')
    const cloned = run(['git', 'clone', '--local', '--no-hardlinks', seed, repo], root)
    assert(cloned.exitCode === 0, `could not clone demo fixture: ${cloned.stderr}`)
    repo = await realpath(repo)
    const baseline = await snapshot(repo)

    const script = resolve(import.meta.dir, 'crash-recovery.ts')
    const firstChild = spawnChild(script, '--child', repo, home, storePath, root)
    children.push(firstChild)
    const readyLine = await waitForLine(firstChild.child, firstChild.closed, () => firstChild.stderr, 'READY')
    const saved = JSON.parse(await readFile(storePath, 'utf8')) as Record<string, any>
    const transaction = saved[activeKey(repo)]
    assert(transaction?.txRoot === readyLine && transaction.state === 'ACTIVE', `child did not persist the active record before readiness (keys=${Object.keys(saved).join(',')}, txRoot=${transaction?.txRoot}, ready=${readyLine})`)
    assert(await readFile(join(readyLine, 'src', 'crash-child.txt'), 'utf8').then(text => text.includes('kept only')), 'child transaction edit was not written')

    const exit = await killAndReap(firstChild.child, firstChild.closed)
    assert(exit.signal === 'SIGKILL', `child was not killed by SIGKILL (signal=${exit.signal}, code=${exit.code})`)

    const store = jsonStore(storePath)
    await store.load()
    const $ = host(home, store, 'crash-recovery-parent-session')
    ctx.tx = null
    ctx.blockedByOtherSession = null
    await onSessionStart($, { cwd: repo, isInteractive: false }, pass)
    assert(ctx.tx?.transactionId === transaction.transactionId, 'new process did not recover the persisted transaction')
    assert(ctx.tx.state === 'ACTIVE', 'recovered transaction state changed unexpectedly')
    const aborted = await onTxAbort($, {})
    assert(aborted.text.includes('aborted and destroyed'), `recovered transaction abort failed: ${aborted.text}`)
    assert(!(await $.fs.exists(readyLine)), 'abort left the transaction worktree behind')

    const after = await snapshot(repo)
    assert(JSON.stringify(after) === JSON.stringify(baseline), 'SIGKILL recovery/abort changed real HEAD, index, status, or tracked file hashes')
    console.log('PASS SIGKILL transaction recovery and abort preserved real HEAD, index, status, and tracked files')

    // Second crash boundary: accept persists APPLY_FAILED and creates a
    // byte-faithful backup, then the child pauses immediately before the real
    // `git apply`. Killing there proves a fresh host refuses blind retry and
    // preserves both the transaction and backup for manual recovery.
    const second = spawnChild(script, '--child-preapply', repo, home, storePath, root)
    children.push(second)
    const preApplyRoot = await waitForLine(second.child, second.closed, () => second.stderr, 'PREAPPLY')
    const secondExit = await killAndReap(second.child, second.closed)
    assert(secondExit.signal === 'SIGKILL', `pre-apply child was not killed by SIGKILL (signal=${secondExit.signal}, code=${secondExit.code})`)
    const savedAfterCrash = JSON.parse(await readFile(storePath, 'utf8')) as Record<string, any>
    const interrupted = savedAfterCrash[activeKey(repo)]
    assert(interrupted?.txRoot === preApplyRoot && interrupted.state === 'APPLY_FAILED', 'crash marker was not persisted as APPLY_FAILED')
    const backupPath = join(`${preApplyRoot}.backup`, 'src', 'math.ts')
    assert((await readFile(backupPath, 'utf8')).includes('export'), 'pre-apply backup did not retain the original file')
    assert(await $.fs.exists(preApplyRoot), 'pre-apply crash lost its transaction worktree')

    const recoveryStore = jsonStore(storePath)
    await recoveryStore.load()
    const recoveredHost = host(home, recoveryStore, 'preapply-recovery-session')
    ctx.tx = null
    ctx.blockedByOtherSession = null
    await onSessionStart(recoveredHost, { cwd: repo, isInteractive: false }, pass)
    assert(ctx.tx?.transactionId === interrupted.transactionId && ctx.tx.state === 'APPLY_FAILED', 'new session did not recover APPLY_FAILED state')
    const refused = await onTxAccept(recoveredHost, {})
    assert(refused.text.includes('manual recovery'), `accept did not refuse an APPLY_FAILED transaction: ${refused.text}`)
    assert(!recoveredHost.processCalls.some(call => call.argv[0] === 'git' && call.argv[1] === 'apply'), 'recovery attempted a second git apply')
    assert(await $.fs.exists(backupPath), 'recovery removed the backup needed for manual recovery')
    assert(JSON.stringify(await snapshot(repo)) === JSON.stringify(baseline), 'pre-apply crash boundary changed the real repository')
    console.log('PASS pre-apply SIGKILL marker refused retry and preserved worktree/backup with real repository unchanged')
  } finally {
    await Promise.all(children.map(({ child, closed }) => killAndReap(child, closed)))
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
if (args[0] === '--child') {
  await childMain(args[1], args[2], args[3])
} else if (args[0] === '--child-preapply') {
  await childBeforeApply(args[1], args[2], args[3])
} else {
  await parentMain()
}
