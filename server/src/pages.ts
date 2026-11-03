import { cp, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { dataDir } from './config.js'
import { RoomError } from './rooms.js'
import { resolveSafe } from './workspace.js'

// Public static sites, served on the same origin as the room app, which is what
// lets a tunnel make them reachable without CORS or a second hostname.
const root = () => join(dataDir, 'pages')

export type Page = { slug: string; size: number; files: number; updatedAt: number }

const slugify = (name: string) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

const walk = async (dir: string, found: string[] = []) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, found)
    else found.push(full)
  }
  return found
}

export const listPages = async (): Promise<Page[]> => {
  let entries
  try {
    entries = await readdir(root(), { withFileTypes: true })
  } catch {
    return []
  }
  const pages: Page[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(root(), entry.name)
    const files = await walk(full)
    const sizes = await Promise.all(files.map(async file => (await stat(file)).size))
    pages.push({ slug: entry.name, size: sizes.reduce((sum, size) => sum + size, 0), files: files.length, updatedAt: (await stat(full)).mtimeMs })
  }
  return pages.sort((a, b) => b.updatedAt - a.updatedAt)
}

// Publishing copies a source folder in. The workspace is the usual source, so
// what people see in the room is what goes out.
export const publishPage = async (name: string, source: string) => {
  const slug = slugify(name)
  if (!slug) throw new RoomError('give the site a name')
  const target = join(root(), slug)
  await mkdir(root(), { recursive: true })
  await rm(target, { recursive: true, force: true })
  await cp(source, target, {
    recursive: true,
    // Links are left out: one made in the room could point anywhere on the host.
    filter: async from => {
      const name = from.split(/[\\/]/).pop() ?? ''
      if (['node_modules', '.git', '.env', '.DS_Store'].includes(name) || name.startsWith('.env.')) return false
      return !(await lstat(from)).isSymbolicLink()
    },
  })
  const info = await stat(target)
  return { slug, updatedAt: info.mtimeMs }
}

export const deletePage = async (slug: string) => {
  const target = join(root(), slugify(slug))
  await rm(target, { recursive: true, force: true })
}

const types: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
}

export const readPageFile = async (slug: string, path: string): Promise<{ body: Buffer; type: string }> => {
  const siteRoot = join(root(), slugify(slug))
  const raw = String(path ?? '').replace(/^\/+/, '')
  if (!raw || raw.endsWith('/')) return readPageFile(slug, `${raw}index.html`)
  // Fastify does not collapse encoded `..`. Nothing above the site folder is
  // ever served: the data dir next to it holds rooms.json and sign-in tokens.
  const clean = posix.normalize(raw)
  if (clean.startsWith('..') || clean.includes(String.fromCharCode(0))) throw new RoomError('not found', 404)
  const full = await resolveSafe(siteRoot, clean)
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) throw new RoomError('not found', 404)
  const extension = clean.split('.').pop()?.toLowerCase() ?? ''
  return { body: await readFile(full), type: types[extension] ?? 'application/octet-stream' }
}
