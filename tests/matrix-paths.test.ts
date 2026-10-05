import { test, expect, describe } from 'claude-code/testing'
import { parseNameOnly } from '../hooks/tx/patch.ts'

describe('M5 git path matrix', () => {
  test('quoted paths preserve spaces, unicode, quotes, and embedded newlines', () => {
    // Git's core.quotePath form escapes special characters and represents
    // UTF-8 bytes with octal escapes.
    expect(parseNameOnly('"space name.txt"\n"\\351\\233\\252.ts"\n"line\\nbreak.txt"\n"say \\"hi\\".txt"\n'))
      .toEqual(['space name.txt', '雪.ts', 'line\nbreak.txt', 'say "hi".txt'])
  })
})
