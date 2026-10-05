import { test, expect, describe } from 'claude-code/testing'
import { contains, normalize, virtualize } from '../hooks/tx/paths.ts'
import { parseNameOnly, unquoteGitPath, parentDirOf } from '../hooks/tx/patch.ts'

describe('paths', () => {
  test('maps an inside-repo path into the worktree', () => {
    expect(virtualize('/repo/src/a.ts', '/repo', '/tx')).toBe('/tx/src/a.ts')
  })

  test('maps the repo root itself', () => {
    expect(virtualize('/repo', '/repo', '/tx')).toBe('/tx')
  })

  test('tolerates a trailing slash on the repo root', () => {
    expect(virtualize('/repo/x.ts', '/repo/', '/tx')).toBe('/tx/x.ts')
  })

  test('leaves outside paths unchanged', () => {
    expect(virtualize('/elsewhere/x.ts', '/repo', '/tx')).toBe('/elsewhere/x.ts')
    expect(virtualize('/etc/passwd', '/repo', '/tx')).toBe('/etc/passwd')
  })

  test('is idempotent for paths already inside the worktree', () => {
    expect(virtualize('/tx/src/a.ts', '/repo', '/tx')).toBe('/tx/src/a.ts')
  })

  test('resolves dot-dot inside the repo before mapping', () => {
    expect(virtualize('/repo/sub/../x.ts', '/repo', '/tx')).toBe('/tx/x.ts')
  })

  test('a dot-dot escape out of the repo is not mapped', () => {
    expect(virtualize('/repo/../elsewhere/x.ts', '/repo', '/tx')).toBe('/repo/../elsewhere/x.ts')
  })

  test('contains resists traversal out of the root', () => {
    expect(contains('/tx', '/tx/../../etc/passwd')).toBe(false)
    expect(contains('/tx', '/tx/sub/../../..')).toBe(false)
  })

  test('contains accepts root and nested paths only', () => {
    expect(contains('/tx', '/tx')).toBe(true)
    expect(contains('/tx', '/tx/a/b')).toBe(true)
    expect(contains('/tx', '/txfoo')).toBe(false)
  })

  test('normalize collapses segments lexically', () => {
    expect(normalize('/a/b/./c/../d')).toBe('/a/b/d')
    expect(normalize('/a/../../../../b')).toBe('/b')
  })
})

describe('name-only parsing (git diff --name-only)', () => {
  test('plain lines, empty lines dropped', () => {
    expect(parseNameOnly('a.txt\nsrc/b c.ts\n\n')).toEqual(['a.txt', 'src/b c.ts'])
  })

  test('quoted paths are unquoted with escapes', () => {
    expect(unquoteGitPath('"a \\"quoted\\" file.txt"')).toBe('a "quoted" file.txt')
    expect(unquoteGitPath('"tab\\there.txt"')).toBe('tab\there.txt')
  })

  test('quoted unicode is decoded from octal UTF-8 bytes', () => {
    // "ünit.ts" where ü is C3 BC
    expect(unquoteGitPath('"\\303\\274nit.ts"')).toBe('ünit.ts')
  })

  test('unquoted input passes through untouched', () => {
    expect(unquoteGitPath('plain.txt')).toBe('plain.txt')
    expect(parseNameOnly('"weird path.txt"')).toEqual(['weird path.txt'])
  })

  test('parent directory of a repo-relative path', () => {
    expect(parentDirOf('a.txt')).toBe('')
    expect(parentDirOf('src/lib/a.ts')).toBe('src/lib')
  })
})
