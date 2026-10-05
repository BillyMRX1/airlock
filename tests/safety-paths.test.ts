import { test, expect } from 'claude-code/testing'
import { isOurTxRoot } from '../hooks/tx/workspace.ts'
import { parseNumstat, parseNameOnly } from '../hooks/tx/patch.ts'

test('workspace deletion guard rejects dot segments, empty leaves and descendants', () => {
  for (const leaf of ['', '.', '..', 'tx/child', '../outside']) expect(isOurTxRoot('/home/u', '/home/u/.claude-airlock/' + leaf)).toBe(false)
  expect(isOurTxRoot('/home/u', '/home/u/.claude-airlock/repo-tx')).toBe(true)
})

test('numstat decodes quoted filenames and name-only accepts NUL records', () => {
  expect(parseNumstat('1\t2\t"line\\nbreak.txt"\n').changedFiles).toEqual(['line\nbreak.txt'])
  expect(parseNameOnly('line\nbreak.txt\0snow 雪.txt\0')).toEqual(['line\nbreak.txt', 'snow 雪.txt'])
})

test('git quoted control characters decode exactly', () => {
  expect(parseNameOnly('"carriage\\rreturn.txt"\n"bell\\a.txt"\n')).toEqual(['carriage\rreturn.txt', 'bell\x07.txt'])
})
