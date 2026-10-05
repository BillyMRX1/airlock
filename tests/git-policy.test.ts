import { test, expect, describe } from 'claude-code/testing'
import { classifyGit } from '../hooks/tx/git-policy.ts'

describe('git policy', () => {
  test('read-only commands are readonly', () => {
    expect(classifyGit('git status')).toBe('readonly')
    expect(classifyGit('git diff HEAD --stat')).toBe('readonly')
    expect(classifyGit('git log --oneline -5')).toBe('readonly')
    expect(classifyGit('git show HEAD:src/a.ts')).toBe('readonly')
    expect(classifyGit('git rev-parse --show-toplevel')).toBe('readonly')
    expect(classifyGit('git branch --show-current')).toBe('readonly')
    expect(classifyGit('git config --get user.name')).toBe('readonly')
    expect(classifyGit('git ls-files')).toBe('readonly')
  })

  test('topology-mutating commands are mutating', () => {
    expect(classifyGit('git commit -m "x"')).toBe('mutating')
    expect(classifyGit('git stash')).toBe('mutating')
    expect(classifyGit('git checkout -b feature')).toBe('mutating')
    expect(classifyGit('git reset --hard HEAD~1')).toBe('mutating')
    expect(classifyGit('git add .')).toBe('mutating')
    expect(classifyGit('git clean -fd')).toBe('mutating')
    expect(classifyGit('git worktree list')).toBe('mutating')
    expect(classifyGit('git branch feature')).toBe('mutating')
  })

  test('remote operations are remote', () => {
    expect(classifyGit('git push origin main')).toBe('remote')
    expect(classifyGit('git fetch origin')).toBe('remote')
    expect(classifyGit('git pull --rebase')).toBe('remote')
    expect(classifyGit('git remote -v')).toBe('remote')
    expect(classifyGit('git clone https://example.com/repo')).toBe('remote')
  })

  test('unknown subcommands are treated as mutating (fail safe)', () => {
    expect(classifyGit('git frobnicate --everything')).toBe('mutating')
  })

  test('compound commands take the most severe class', () => {
    expect(classifyGit('git status && git push')).toBe('remote')
    expect(classifyGit('git log | grep fix')).toBe('readonly')
    expect(classifyGit('git add .; git commit -m x')).toBe('mutating')
  })

  test('non-git commands are null', () => {
    expect(classifyGit('ls -la')).toBe(null)
    expect(classifyGit('node test.js')).toBe(null)
    expect(classifyGit('echo hello')).toBe(null)
  })

  test('sudo/env-prefixed git is still classified', () => {
    expect(classifyGit('sudo git push')).toBe('remote')
    expect(classifyGit('GIT_DIR=/x git status')).toBe('readonly')
  })
})
