// Patch math (pure; the $.process calls that generate/apply patches live
// in the hook files that need them).

// `git diff HEAD --numstat` lines: "<ins>\t<del>\t<path>" (binary files
// show "-\t-\t<path>").
export function parseNumstat(stdout: string): { files: number; insertions: number; deletions: number; changedFiles: string[] } {
  const files: string[] = []
  let insertions = 0
  let deletions = 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m) continue
    files.push(unquoteGitPath(m[3]))
    if (m[1] !== '-') insertions += Number(m[1])
    if (m[2] !== '-') deletions += Number(m[2])
  }
  return { files: files.length, insertions, deletions, changedFiles: files }
}

export interface PatchOutcomeClass {
  outcome: 'applied' | 'conflict' | 'failed'
  stderr: string
}

// `git diff --name-only` output: one path per line; git quotes a path
// whose name needs it (spaces, non-ASCII under core.quotePath) in a
// C-style double-quoted form with octal escapes. Binary-safe callers
// should use -z in production; this parser keeps the common cases exact.
export function parseNameOnly(stdout: string): string[] {
  if (stdout.includes('\0')) return stdout.split('\0').filter(p => p !== '')
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    out.push(unquoteGitPath(line))
  }
  return out
}

// Unquote git's C-style quoted path form: "..." with \" \\ \n \t and
// \nnn octal escapes; octal runs are UTF-8 byte sequences.
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
  let out = ''
  let bytes: number[] = []
  const flush = () => {
    if (bytes.length) {
      try {
        out += new TextDecoder().decode(new Uint8Array(bytes))
      } catch {
        out += bytes.map(b => String.fromCharCode(b)).join('')
      }
      bytes = []
    }
  }
  for (let i = 1; i < path.length - 1; i++) {
    const c = path[i]
    if (c !== '\\') {
      flush()
      out += c
      continue
    }
    const n = path[i + 1]
    if (n === undefined) break
    if (n === '"' || n === '\\') {
      flush()
      out += n
      i++
    } else if ('abfrv'.includes(n ?? '')) {
      flush()
      const controls: Record<string, string> = { a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' }
      out += controls[n]
      i++
    } else if (n === 'n') {
      flush()
      out += '\n'
      i++
    } else if (n === 't') {
      flush()
      out += '\t'
      i++
    } else if (n >= '0' && n <= '7') {
      let oct = ''
      let j = i + 1
      while (j < path.length - 1 && oct.length < 3 && path[j] >= '0' && path[j] <= '7') {
        oct += path[j]
        j++
      }
      if (oct) {
        bytes.push(parseInt(oct, 8))
        i = j - 1
      } else {
        flush()
        out += '\\'
      }
    } else {
      flush()
      out += '\\'
    }
  }
  flush()
  return out
}

// Parent directory of a repo-relative path ('' when the path is at the root).
export function parentDirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}
