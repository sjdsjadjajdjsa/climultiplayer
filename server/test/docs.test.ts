import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireDoc, closeRoomDocs, flushRoomDocs, releaseDoc } from '../src/docs.js'

const room = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'climp-docs-'))
  return { code: `R${Math.random().toString(36).slice(2, 8)}`, dir }
}

afterEach(async () => {
  // Each test uses its own room code, so nothing leaks between them.
})

describe('live documents', () => {
  it('seeds once even when two clients open the same file together', async () => {
    const { code, dir } = await room()
    await writeFile(join(dir, 'a.txt'), 'seed\n')
    const [first, second] = await Promise.all([acquireDoc(code, dir, 'a.txt'), acquireDoc(code, dir, 'a.txt')])
    expect(first.doc).toBe(second.doc)
    expect(first.doc.getText('text').toString()).toBe('seed\n')
    expect(first.refs).toBe(2)
    await closeRoomDocs(code)
  })

  it('writes edits back to disk', async () => {
    const { code, dir } = await room()
    await writeFile(join(dir, 'a.txt'), 'one\n')
    const entry = await acquireDoc(code, dir, 'a.txt')
    entry.doc.getText('text').insert(4, 'two\n')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    await closeRoomDocs(code)
  })

  it('flushes pending writes on demand', async () => {
    const { code, dir } = await room()
    await writeFile(join(dir, 'a.txt'), 'x\n')
    const entry = await acquireDoc(code, dir, 'a.txt')
    entry.doc.getText('text').insert(2, 'y\n')
    await flushRoomDocs(code)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('x\ny\n')
    await closeRoomDocs(code)
  })

  it('keeps one reference per release', async () => {
    const { code, dir } = await room()
    await writeFile(join(dir, 'a.txt'), 'x')
    const entry = await acquireDoc(code, dir, 'a.txt')
    await acquireDoc(code, dir, 'a.txt')
    releaseDoc(code, 'a.txt')
    expect(entry.refs).toBe(1)
    releaseDoc(code, 'a.txt')
    expect(entry.refs).toBe(0)
    await closeRoomDocs(code)
  })
})
