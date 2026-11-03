import { Doc } from 'yjs'
import { readWorkspaceFile, writeWorkspaceFile } from './workspace.js'

export type DocEntry = {
  doc: Doc
  path: string
  workspace: string
  refs: number
  dirty: boolean
  timer: NodeJS.Timeout | null
  idle: NodeJS.Timeout | null
  observer: (update: Uint8Array, origin: unknown) => void
}

const byRoom = new Map<string, Map<string, DocEntry>>()
const loading = new Map<string, Promise<DocEntry>>()
const PERSIST_MS = 400
const IDLE_MS = 5 * 60_000

const roomDocs = (roomCode: string) => {
  let map = byRoom.get(roomCode)
  if (!map) {
    map = new Map()
    byRoom.set(roomCode, map)
  }
  return map
}

const persist = async (entry: DocEntry) => {
  if (!entry.dirty) return
  entry.dirty = false
  try {
    await writeWorkspaceFile(entry.workspace, entry.path, entry.doc.getText('text').toString())
  } catch {
    entry.dirty = true
  }
}

const schedulePersist = (entry: DocEntry) => {
  if (entry.timer) return
  entry.timer = setTimeout(() => {
    entry.timer = null
    void persist(entry)
  }, PERSIST_MS)
  entry.timer.unref?.()
}

// One live CRDT document per room file, seeded from disk on first open. The
// disk copy is the seed only: from then on the document is the truth.
export const acquireDoc = async (roomCode: string, workspace: string, path: string) => {
  const map = roomDocs(roomCode)
  const existing = map.get(path)
  if (existing) return touch(existing)
  // Two clients can open the same file at once: both must wait for the same
  // seeded document, or each gets a copy and the seeds merge twice.
  const waitKey = `${roomCode}\u0000${path}`
  const pending = loading.get(waitKey)
  if (pending) return touch(await pending)
  const work = createDoc(map, roomCode, workspace, path)
  loading.set(waitKey, work)
  try {
    return touch(await work)
  } finally {
    loading.delete(waitKey)
  }
}

const touch = (entry: DocEntry) => {
  entry.refs += 1
  if (entry.idle) {
    clearTimeout(entry.idle)
    entry.idle = null
  }
  return entry
}

const createDoc = async (map: Map<string, DocEntry>, roomCode: string, workspace: string, path: string) => {
  const entry: DocEntry = {
    doc: new Doc(),
    path,
    workspace,
    refs: 0,
    dirty: false,
    timer: null,
    idle: null,
    observer: () => {},
  }
  const seed = await readWorkspaceFile(workspace, path).catch(() => '')
  if (seed) {
    entry.doc.transact(() => entry.doc.getText('text').insert(0, seed), 'seed')
  }
  entry.observer = (_update, origin) => {
    if (origin === 'seed') return
    entry.dirty = true
    schedulePersist(entry)
  }
  entry.doc.on('update', entry.observer)
  map.set(path, entry)
  return entry
}

export const releaseDoc = (roomCode: string, path: string) => {
  const entry = roomDocs(roomCode).get(path)
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.refs > 0) return
  if (entry.idle) clearTimeout(entry.idle)
  entry.idle = setTimeout(() => {
    void closeDoc(roomCode, path)
  }, IDLE_MS)
  entry.idle.unref?.()
}

export const closeDoc = async (roomCode: string, path: string) => {
  const entry = roomDocs(roomCode).get(path)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.idle) clearTimeout(entry.idle)
  await persist(entry)
  entry.doc.off('update', entry.observer)
  entry.doc.destroy()
  roomDocs(roomCode).delete(path)
}

export const closeRoomDocs = async (roomCode: string) => {
  for (const path of [...roomDocs(roomCode).keys()]) await closeDoc(roomCode, path)
  byRoom.delete(roomCode)
}

export const flushRoomDocs = async (roomCode: string) => {
  for (const entry of roomDocs(roomCode).values()) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    await persist(entry)
  }
}

export const flushAll = async () => {
  for (const code of [...byRoom.keys()]) await flushRoomDocs(code)
}
