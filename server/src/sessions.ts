import { randomUUID } from 'node:crypto'
import { spawn as spawnPty, type IPty } from 'node-pty'
import type { WebSocket } from 'ws'
import { ensureHome, ensureRoomContainer, execPlan } from './container.js'

export type MemberSession = {
  id: string
  code: string
  memberId: string
  name: string
  color: string
  pty: IPty
  scrollback: string[]
  owner: WebSocket | null
  watchers: Set<WebSocket>
  ended: boolean
  expiry: NodeJS.Timeout | null
}

const byRoom = new Map<string, Map<string, MemberSession>>()
const MAX_SCROLLBACK = 4000
let changed: ((code: string) => void) | null = null

export const onSessionChange = (handler: (code: string) => void) => {
  changed = handler
}

const roomSessions = (code: string) => {
  let map = byRoom.get(code)
  if (!map) {
    map = new Map()
    byRoom.set(code, map)
  }
  return map
}

const send = (socket: WebSocket | null, payload: unknown) => {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
}

// Output goes to the owner and everyone watching. Input only travels back from
// the owner, so watchers stay read-only.
export const emit = (session: MemberSession, payload: unknown) => {
  send(session.owner, payload)
  for (const watcher of session.watchers) send(watcher, payload)
}

const appendScrollback = (session: MemberSession, data: string) => {
  session.scrollback.push(data)
  let total = session.scrollback.reduce((sum, part) => sum + part.length, 0)
  while (session.scrollback.length > MAX_SCROLLBACK || total > 200_000) {
    const dropped = session.scrollback.shift()
    total -= dropped?.length ?? 0
    if (!session.scrollback.length) break
  }
}

export const sessionMap = (code: string) => roomSessions(code)

export const listSessions = (code: string) =>
  [...roomSessions(code).values()].map(session => ({
    id: session.id,
    memberId: session.memberId,
    name: session.name,
    color: session.color,
    owner: session.owner !== null,
    live: !session.ended,
  }))

export const startSession = async (
  code: string,
  workspace: string,
  member: { id: string; name: string; color: string },
  owner: WebSocket,
) => {
  await ensureRoomContainer(code, workspace)
  const home = await ensureHome(code, member.id)
  const plan = execPlan(code, member.id, home)
  const pty = spawnPty(plan.file, plan.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: workspace,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })
  const session: MemberSession = {
    id: randomUUID().slice(0, 8),
    code,
    memberId: member.id,
    name: member.name,
    color: member.color,
    pty,
    scrollback: [],
    owner,
    watchers: new Set(),
    ended: false,
    expiry: null,
  }
  roomSessions(code).set(session.id, session)
  changed?.(code)
  pty.onData(data => {
    appendScrollback(session, data)
    emit(session, { type: 'term:out', id: session.id, data })
  })
  pty.onExit(() => {
    session.ended = true
    emit(session, { type: 'term:end', id: session.id })
    if (session.expiry) clearTimeout(session.expiry)
    session.expiry = setTimeout(() => dropSession(session.id, code), 60_000)
    session.expiry.unref?.()
    changed?.(code)
  })
  return session
}

export const attach = (session: MemberSession, socket: WebSocket) => {
  session.watchers.add(socket)
  if (session.expiry) {
    clearTimeout(session.expiry)
    session.expiry = null
  }
}

export const detach = (session: MemberSession, socket: WebSocket) => {
  session.watchers.delete(socket)
}

export const ownerLeft = (session: MemberSession) => {
  session.owner = null
  // No TTY owner, so the pty is of no use; keep the output briefly so the room
  // can still read it, then drop it.
  try {
    session.pty.kill()
  } catch {}
  if (session.expiry) clearTimeout(session.expiry)
  session.expiry = setTimeout(() => dropSession(session.id, session.code), 60_000)
  session.expiry.unref?.()
}

export const write = (session: MemberSession, data: string) => {
  if (!session.ended) session.pty.write(data)
}

export const resize = (session: MemberSession, cols: number, rows: number) => {
  if (session.ended) return
  try {
    session.pty.resize(Math.max(20, Math.min(cols, 400)), Math.max(5, Math.min(rows, 200)))
  } catch {}
}

export const closeSession = (session: MemberSession) => {
  try {
    session.pty.kill()
  } catch {}
}

const dropSession = (id: string, code: string) => {
  const map = byRoom.get(code)
  const session = map?.get(id)
  if (!session) return
  map?.delete(id)
  if (session.expiry) clearTimeout(session.expiry)
  changed?.(code)
}

export const kickSessions = (code: string, memberId: string) => {
  for (const session of roomSessions(code).values()) {
    if (session.memberId === memberId) closeSession(session)
  }
}
