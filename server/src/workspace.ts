import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
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

// Guests have a shell in the container, and the container writes into the same
// folder the server reads. A symlink made in there (`ln -s ~/.ssh/id_ed25519 x`)
// would otherwise be followed by the server, on the host, as the host user. So
// every file call checks the real path stays inside the workspace and refuses
// symlinks outright; the final open also refuses to follow one.
const inside = (root: string, full: string) => full === root || full.startsWith(root + sep)

const nearestExisting = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) throw new WorkspaceError('the path leaves the workspace')
    return nearestExisting(parent)
  }
}

export const resolveSafe = async (root: string, path: string, allowLink = false) => {
  const full = resolveInside(root, path)
  const realRoot = await realpath(root)
  // Every existing part of the path must resolve inside the workspace.
  if (!inside(realRoot, await nearestExisting(dirname(full)))) throw new WorkspaceError('the path leaves the workspace')
  const info = await lstat(full).catch(() => null)
  if (info?.isSymbolicLink()) {
    if (allowLink) return full
    throw new WorkspaceError('links are not opened by the server', 403)
  }
  if (info && !inside(realRoot, await realpath(full))) throw new WorkspaceError('the path leaves the workspace')
  return full
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export const readWorkspaceFile = async (root: string, path: string) => {
  const full = await resolveSafe(root, path)
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) throw new WorkspaceError(`${path} does not exist`, 404)
  if (info.size > maxFileBytes) throw new WorkspaceError(`${path} is larger than ${maxFileBytes} bytes`, 413)
  const handle = await open(full, constants.O_RDONLY | NOFOLLOW)
  try {
    const buffer = await handle.readFile()
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

export const writeWorkspaceFile = async (root: string, path: string, text: string) => {
  if (Buffer.byteLength(text) > maxFileBytes) throw new WorkspaceError(`${path} is too large`, 413)
  const full = await resolveSafe(root, path)
  await mkdir(dirname(full), { recursive: true })
  // Checked again after mkdir: a folder could have been swapped for a link.
  await resolveSafe(root, path)
  const handle = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o644)
  try {
    await handle.writeFile(text)
  } finally {
    await handle.close()
  }
}

export const deleteWorkspacePath = async (root: string, path: string) => {
  // A link itself may be removed (rm never follows the last part).
  const full = await resolveSafe(root, path, true)
  if (full === root) throw new WorkspaceError('cannot delete the workspace root')
  await rm(full, { recursive: true, force: true })
}
