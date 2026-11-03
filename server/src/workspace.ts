import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { ignoredNames, ignoredSuffixes, maxFileBytes } from './config.js'

export class WorkspaceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

// Resolves a client supplied path inside the workspace and refuses escapes.
export const resolveInside = (root: string, path: string) => {
  const clean = String(path ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!clean) throw new WorkspaceError('a path is required')
  if (clean.split('/').some(part => part === '..')) throw new WorkspaceError('the path leaves the workspace')
  const full = resolve(root, clean)
  if (full !== root && !full.startsWith(root + sep)) throw new WorkspaceError('the path leaves the workspace')
  return full
}

export const isIgnored = (name: string, full: string) => ignoredNames.has(name) || ignoredSuffixes.some(suffix => full.toLowerCase().endsWith(suffix))

export type TreeEntry = { path: string; dir: boolean; size: number }

export const listTree = async (root: string, limit = 4000): Promise<TreeEntry[]> => {
  const entries: TreeEntry[] = []
  const walk = async (dir: string) => {
    if (entries.length >= limit) return
    let handle
    try {
      handle = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    handle.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of handle) {
      if (entries.length >= limit) return
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      const full = join(dir, entry.name)
      if (isIgnored(entry.name, full)) continue
      const path = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) {
        entries.push({ path, dir: true, size: 0 })
        await walk(full)
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null)
        if (!info) continue
        entries.push({ path, dir: false, size: info.size })
      }
    }
  }
  await walk(root)
  return entries
}

export const readWorkspaceFile = async (root: string, path: string) => {
  const full = resolveInside(root, path)
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) throw new WorkspaceError(`${path} does not exist`, 404)
  if (info.size > maxFileBytes) throw new WorkspaceError(`${path} is larger than ${maxFileBytes} bytes`, 413)
  const buffer = await readFile(full)
  return buffer.toString('utf8')
}

export const writeWorkspaceFile = async (root: string, path: string, text: string) => {
  const full = resolveInside(root, path)
  if (Buffer.byteLength(text) > maxFileBytes) throw new WorkspaceError(`${path} is too large`, 413)
  await mkdir(resolve(full, '..'), { recursive: true })
  await writeFile(full, text)
}

export const deleteWorkspacePath = async (root: string, path: string) => {
  const full = resolveInside(root, path)
  if (full === root) throw new WorkspaceError('cannot delete the workspace root')
  await rm(full, { recursive: true, force: true })
}
