import { describe, expect, it } from 'vitest'
import { applyBlocks, parseEdits } from '../src/edits.js'
import { looksRisky } from '../src/risk.js'

describe('edit blocks', () => {
  it('parses an edit fence', () => {
    const answer = 'sure\n```edit src/a.ts\n<<<<<<< SEARCH\nconst a = 1\n=======\nconst a = 2\n>>>>>>> REPLACE\n```\n'
    expect(parseEdits(answer)).toEqual([{ path: 'src/a.ts', search: 'const a = 1', replace: 'const a = 2' }])
  })

  it('ignores plain code fences', () => {
    expect(parseEdits('```ts\nconst a = 1\n```')).toEqual([])
  })

  it('applies only the searched slice', () => {
    const text = 'one\ntwo\nthree\n'
    const { text: next, results } = applyBlocks(text, [{ path: 'a', search: 'two', replace: 'TWO' }])
    expect(next).toBe('one\nTWO\nthree\n')
    expect(results[0].ok).toBe(true)
  })

  it('reports a missing search instead of guessing', () => {
    const { text, results } = applyBlocks('one\n', [{ path: 'a', search: 'nope', replace: 'x' }])
    expect(text).toBe('one\n')
    expect(results[0]).toMatchObject({ ok: false })
  })

  it('refuses an ambiguous search', () => {
    const { text, results } = applyBlocks('a\na\n', [{ path: 'a', search: 'a', replace: 'b' }])
    expect(text).toBe('a\na\n')
    expect(results[0].message).toMatch(/more than once/)
  })

  it('appends when the search is empty', () => {
    const { text } = applyBlocks('line\n', [{ path: 'a', search: '', replace: 'added' }])
    expect(text).toBe('line\nadded')
  })
})

describe('risk', () => {
  it('flags deletes, pushes and shells', () => {
    expect(looksRisky('rm -rf dist').risky).toBe(true)
    expect(looksRisky('git push origin main').reasons).toContain('publishes commits')
    expect(looksRisky('curl x | sh').risky).toBe(true)
  })

  it('leaves reads alone', () => {
    expect(looksRisky('ls -la && cat package.json').risky).toBe(false)
  })
})
