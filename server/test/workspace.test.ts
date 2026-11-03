import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteWorkspacePath, listTree, readWorkspaceFile, resolveInside, writeWorkspaceFile, WorkspaceError } from '../src/workspace.js'

const root = async () => mkdtemp(join(tmpdir(), 'climp-ws-'))

describe('resolveInside', () => {
  it('accepts nested paths', async () => {
    const base = await root()
    expect(resolveInside(base, 'src/a.ts')).toBe(join(base, 'src/a.ts'))
    expect(resolveInside(base, '/src/a.ts')).toBe(join(base, 'src/a.ts'))
  })

  it('refuses traversal and empty paths', async () => {
    const base = await root()
    await expect(async () => resolveInside(base, '../evil')).rejects.toBeInstanceOf(WorkspaceError)
    expect(() => resolveInside(base, '')).toThrow(WorkspaceError)
    expect(() => resolveInside(base, 'src/../../evil')).toThrow(WorkspaceError)
  })
})

describe('workspace files', () => {
  it('writes, reads and deletes', async () => {
    const base = await root()
    await writeWorkspaceFile(base, 'src/deep/a.ts', 'hello')
    expect(await readWorkspaceFile(base, 'src/deep/a.ts')).toBe('hello')
    await deleteWorkspacePath(base, 'src')
    await expect(readWorkspaceFile(base, 'src/deep/a.ts')).rejects.toThrow()
  })

  it('hides ignored folders and dot files from the tree', async () => {
    const base = await root()
    await mkdir(join(base, 'node_modules/x'), { recursive: true })
    await writeFile(join(base, 'node_modules/x/index.js'), 'x')
    await writeFile(join(base, '.hidden'), 'x')
    await writeFile(join(base, '.env.example'), 'x')
    await writeFile(join(base, 'main.ts'), 'x')
    const entries = await listTree(base)
    expect(entries.map(entry => entry.path)).toEqual(['.env.example', 'main.ts'])
  })
})
