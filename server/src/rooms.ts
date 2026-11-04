import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { customAlphabet } from 'nanoid'
import type { WebSocket } from 'ws'
import { dataDir, roomIdleMinutes } from './config.js'
import { authFile, dropStore } from './auth/registry.js'
import { removeRoomContainer } from './container.js'

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const makeCode = customAlphabet(codeAlphabet, 6)
const makeToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 40)

export type Role = 'host' | 'guest' | 'editor'

export type Member = {
  id: string
  name: string
  // The raw token lives in memory only; the file keeps the hash, like invites.
  token: string
  tokenHash: string
  role: Role
  color: string
  online: number
  joinedAt: number
  activity?: string
  activityUntil?: number
}

// An invite is only ever stored hashed. The token itself exists once, in the
// link the host copies.
export type Invite = {
  id: string
  hash: string
  createdAt: number
  expiresAt: number
  usedAt: number | null
  revoked: boolean
}

export type JoinRequest = {
  id: string
  name: string
  hash: string
  inviteId: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  memberId: string | null
}

export type RoomMessage = { id: string; memberId: string; name: string; color: string; role: Role; text: string; at: number }

export type AuditEntry = { at: number; name: string; command: string; decision: 'ran' | 'asked' | 'allowed' | 'denied' | 'auto-expired' }

export type Room = {
  code: string
  workspace: string
  createdAt: number
  lastSeen: number
  hostId: string
  members: Map<string, Member>
  invites: Map<string, Invite>
  joins: Map<string, JoinRequest>
  audit: AuditEntry[]
  messages: RoomMessage[]
  sockets: Set<WebSocket>
}

const rooms = new Map<string, Room>()
const roomsFile = () => join(dataDir, 'rooms.json')

const palette = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e', '#c3e88d', '#ff9e64']
let colorCursor = 0

export const inviteLifetimeMinutes = 24 * 60
export const joinLifetimeMinutes = 5

export class RoomError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const pickColor = () => palette[colorCursor++ % palette.length]

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export const newInviteToken = () => randomBytes(24).toString('base64url')

// Clients may send a whole invite link instead of the bare token. Pull the token
// out of either the fragment or the query so a pasted link always works.
export const inviteTokenFrom = (value: string) => {
  const text = String(value ?? '').trim()
  if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return text
  const fragment = /#t=([A-Za-z0-9_-]{20,})/.exec(text)
  if (fragment) return fragment[1]
  const query = /[?&]t=([A-Za-z0-9_-]{20,})/.exec(text)
  return query ? query[1] : ''
}

// Short, unguessable-ish room codes: readable, no 0/O/1/I collisions.
const freshCode = () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = makeCode()
    if (!rooms.has(code)) return code
  }
  throw new RoomError('could not allocate a room code', 503)
}

const cleanName = (name: string) => {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
  return text || 'anonymous'
}

export const createMember = (name: string, role: Role): Member => {
  const token = makeToken()
  return {
    id: makeToken().slice(0, 12),
    name: cleanName(name),
    token,
    tokenHash: hashToken(token),
    role,
    color: pickColor(),
    online: 0,
    joinedAt: Date.now(),
  }
}

export const createInvite = (room: Room, minutes = inviteLifetimeMinutes) => {
  const token = newInviteToken()
  const invite: Invite = {
    id: makeToken().slice(0, 10),
    hash: hashToken(token),
    createdAt: Date.now(),
    expiresAt: Date.now() + Math.max(1, minutes) * 60_000,
    usedAt: null,
    revoked: false,
  }
  room.invites.set(invite.id, invite)
  void persist()
  return { invite, token }
}

export const inviteUsable = (invite: Invite) => !invite.revoked && invite.usedAt === null && invite.expiresAt > Date.now()

export const findInvite = (room: Room, token: string) => {
  const hash = hashToken(String(token ?? ''))
  for (const invite of room.invites.values()) if (invite.hash === hash) return invite
  return null
}

export const revokeInvite = (room: Room, id: string) => {
  const invite = room.invites.get(id)
  if (!invite) throw new RoomError('no such invite', 404)
  invite.revoked = true
  void persist()
}

// What ran, and who allowed it. Memory only: an audit trail for the session,
// not a durable log.
// Room chat: what people say to each other, kept for the session.
export const addMessage = (room: Room, member: Member, text: string) => {
  const message: RoomMessage = {
    id: makeToken().slice(0, 10),
    memberId: member.id,
    name: member.name,
    color: member.color,
    role: member.role,
    text,
    at: Date.now(),
  }
  room.messages.push(message)
  if (room.messages.length > 200) room.messages.shift()
  return message
}

export const recordAudit = (room: Room, entry: Omit<AuditEntry, 'at'>) => {
  room.audit.push({ ...entry, at: Date.now() })
  if (room.audit.length > 200) room.audit.shift()
}

export const publicInvite = (invite: Invite) => ({
  id: invite.id,
  createdAt: invite.createdAt,
  expiresAt: invite.expiresAt,
  used: invite.usedAt !== null,
  revoked: invite.revoked,
  state: invite.revoked ? 'revoked' : invite.usedAt ? 'used' : invite.expiresAt <= Date.now() ? 'expired' : 'open',
})

export const createRoom = async (hostName: string, source?: string) => {
  const code = freshCode()
  const workspace = join(dataDir, 'rooms', code, 'workspace')
  await mkdir(workspace, { recursive: true })
  if (source) await seedWorkspace(workspace, source)
  const host = createMember(hostName, 'host')
  const room: Room = {
    code,
    workspace,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    hostId: host.id,
    members: new Map([[host.id, host]]),
    invites: new Map(),
    joins: new Map(),
    audit: [],
    messages: [],
    sockets: new Set(),
  }
  rooms.set(code, room)
  await persist()
  return { room, member: host }
}

// Copies a local folder in. Heavy and machine-specific directories are skipped,
// and only regular files are copied, so pointing at a home directory (sockets,
// FIFOs, caches) does not throw.
const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.cache', '.local', '.npm', '.cargo', '.rustup', '.gradle', 'Library'])
const MAX_FILES = 5000
// A history makes git usable in the room, but a fat one would dominate the
// copy, so `.git` rides along only while it is small.
const MAX_GIT_BYTES = 40 * 1024 * 1024

const copyTree = async (from: string, to: string, state: { files: number }, keepSkipped = false) => {
  let entries
  try {
    entries = await readdir(from, { withFileTypes: true })
  } catch {
    return
  }
  await mkdir(to, { recursive: true })
  for (const entry of entries) {
    if (state.files >= MAX_FILES) return
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name) && !keepSkipped) continue
      await mkdir(target, { recursive: true })
      await copyTree(source, target, state)
      continue
    }
    if (!entry.isFile()) continue
    try {
      await copyFile(source, target)
      state.files += 1
    } catch {}
  }
}

const dirSize = async (dir: string, cap: number): Promise<number> => {
  let total = 0
  const walk = async (path: string): Promise<void> => {
    if (total > cap) return
    const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) total += (await stat(full).catch(() => null))?.size ?? 0
      if (total > cap) return
    }
  }
  await walk(dir)
  return total
}

const seedWorkspace = async (workspace: string, source: string) => {
  const state = { files: 0 }
  await copyTree(source, workspace, state)
  const git = join(source, '.git')
  if (state.files >= MAX_FILES) return
  if (await dirSize(git, MAX_GIT_BYTES) > MAX_GIT_BYTES) return
  await copyTree(git, join(workspace, '.git'), state, true)
}

export const getRoom = (code: string) => {
  const room = rooms.get(String(code ?? '').toUpperCase())
  if (!room) throw new RoomError('no room with that code', 404)
  room.lastSeen = Date.now()
  return room
}

// Non-throwing lookup, for callbacks that outlive a request.
export const peekRoom = (code: string) => rooms.get(String(code ?? '').toUpperCase())

export const findMember = (room: Room, token: string) => {
  if (!token) return null
  const hash = hashToken(token)
  for (const member of room.members.values()) if (member.tokenHash === hash) return member
  return null
}

// Token addressed lookup, for routes that have no room code (sign-in, health of
// the caller's own credentials).
export const findByToken = (token: string) => {
  if (!token) return null
  for (const room of rooms.values()) {
    const member = findMember(room, token)
    if (member) return { room, member }
  }
  return null
}

// Asking to join spends nothing: the invite is only marked used when the host
// says yes, so a sniped link does not burn it for a friend.
// A valid invite token is checked here. Knowing the room code alone also works
// as a fallback: it still lands in the host's approval queue, it just does not
// carry a revocable secret.
export const requestJoin = (code: string, name: string, inviteInput: string) => {
  const room = getRoom(code)
  const inviteToken = inviteTokenFrom(inviteInput)
  if (String(inviteInput ?? '').trim() && !inviteToken && room.invites.size) {
    throw new RoomError('that link has no invite token in it, copy the whole link', 403)
  }
  const invite = inviteToken ? findInvite(room, inviteToken) : null
  if (inviteToken && !invite) throw new RoomError('that invite is not valid', 403)
  if (invite) {
    if (!inviteUsable(invite)) throw new RoomError(invite.revoked ? 'that invite was revoked' : invite.usedAt ? 'that invite was already used' : 'that invite expired', 403)
    for (const existing of room.joins.values()) {
      if (existing.inviteId === invite.id && existing.status === 'pending' && existing.expiresAt > Date.now()) {
        throw new RoomError('someone is already using that invite', 409)
      }
    }
  }
  if (room.members.size >= 32) throw new RoomError('the room is full', 409)
  // A stranger who knows the code could otherwise bury the host in cards.
  const pending = [...room.joins.values()].filter(existing => existing.status === 'pending' && existing.expiresAt > Date.now()).length
  if (pending >= 8) throw new RoomError('too many requests are already waiting for the host', 429)
  const token = newInviteToken()
  const request: JoinRequest = {
    id: makeToken().slice(0, 10),
    name: cleanName(name),
    hash: hashToken(token),
    inviteId: invite?.id ?? '',
    createdAt: Date.now(),
    expiresAt: Date.now() + joinLifetimeMinutes * 60_000,
    status: 'pending',
    memberId: null,
  }
  room.joins.set(request.id, request)
  void persist()
  return { room, request, token }
}

export const findJoin = (room: Room, id: string) => room.joins.get(String(id ?? '')) ?? null

export const expireJoins = (room: Room) => {
  for (const request of room.joins.values()) {
    if (request.status === 'pending' && request.expiresAt <= Date.now()) request.status = 'expired'
  }
}

export const decideJoin = (room: Room, id: string, allow: boolean) => {
  const request = findJoin(room, id)
  if (!request) throw new RoomError('no such join request', 404)
  if (request.status !== 'pending') throw new RoomError(`that request is already ${request.status}`, 409)
  const invite = room.invites.get(request.inviteId)
  if (allow) {
    if (request.inviteId && (!invite || !inviteUsable(invite))) throw new RoomError('the invite is no longer valid', 409)
    const member = createMember(request.name, 'guest')
    room.members.set(member.id, member)
    if (invite) invite.usedAt = Date.now()
    request.status = 'allowed'
    request.memberId = member.id
    void persist()
    return member
  }
  request.status = 'denied'
  void persist()
  return null
}

// Plan sign-ins are the member's own refresh tokens. They leave with the member
// instead of sitting on the host's disk forever.
export const forgetSignIns = async (memberId: string) => {
  dropStore(memberId)
  await rm(authFile(memberId), { force: true })
}

export const removeMember = async (room: Room, memberId: string) => {
  if (memberId === room.hostId) return null
  const member = room.members.get(memberId) ?? null
  room.members.delete(memberId)
  if (member) await forgetSignIns(member.id)
  await persist()
  return member
}

export const publicMember = (member: Member) => ({
  id: member.id,
  name: member.name,
  role: member.role,
  color: member.color,
  online: member.online > 0,
  activity: member.activityUntil && member.activityUntil > Date.now() ? member.activity ?? null : null,
})

export const setActivity = (member: Member, activity: string | null, seconds = 8) => {
  member.activity = activity ?? undefined
  member.activityUntil = activity ? Date.now() + seconds * 1000 : 0
}

// An editor may run commands without asking. The host already can, and the host
// role itself never changes.
export const setRole = async (room: Room, memberId: string, role: 'guest' | 'editor') => {
  const member = room.members.get(memberId)
  if (!member) throw new RoomError('no such member', 404)
  if (member.id === room.hostId) throw new RoomError('the host keeps the host role', 400)
  member.role = role
  await persist()
  return member
}

export const publicRoom = (room: Room) => ({
  code: room.code,
  createdAt: room.createdAt,
  workspace: room.workspace,
  hostId: room.hostId,
  members: [...room.members.values()].map(publicMember),
})

export const closeRoom = async (room: Room) => {
  for (const socket of room.sockets) socket.close(1000, 'room closed')
  rooms.delete(room.code)
  await persist()
}

// Deleting the room also deletes its workspace copy; the host's own folder is
// untouched.
export const deleteRoom = async (room: Room) => {
  await closeRoom(room)
  for (const member of room.members.values()) await forgetSignIns(member.id)
  await removeRoomContainer(room.code).catch(() => {})
  await rm(join(dataDir, 'rooms', room.code), { recursive: true, force: true })
}

let saveTimer: NodeJS.Timeout | null = null
const persist = async () => {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    const snapshot = [...rooms.values()].map(room => ({
      code: room.code,
      workspace: room.workspace,
      createdAt: room.createdAt,
      lastSeen: room.lastSeen,
      hostId: room.hostId,
      members: [...room.members.values()].map(member => ({ ...member, token: '' })),
      invites: [...room.invites.values()],
      joins: [...room.joins.values()].filter(request => request.status === 'pending' || Date.now() - request.createdAt < 3_600_000),
    }))
    // Member tokens are as good as a session, so the file is owner only and
    // stores hashes, not the tokens themselves.
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    await writeFile(roomsFile(), JSON.stringify(snapshot, null, 2), { mode: 0o600 })
    await chmod(roomsFile(), 0o600).catch(() => {})
  }, 300)
  saveTimer.unref?.()
}

export const loadRooms = async () => {
  let parsed: any
  try {
    parsed = JSON.parse(await readFile(roomsFile(), 'utf8'))
  } catch {
    return
  }
  if (!Array.isArray(parsed)) return
  for (const entry of parsed) {
    if (!entry?.code || !entry?.workspace) continue
    if (!Array.isArray(entry.members) || !entry.hostId) continue
    const members = new Map<string, Member>()
    for (const member of entry.members) {
      const tokenHash = member?.tokenHash ?? (member?.token ? hashToken(member.token) : '')
      if (!member?.id || !tokenHash) continue
      members.set(member.id, { ...member, token: '', tokenHash, online: 0 })
    }
    if (!members.has(entry.hostId)) continue
    rooms.set(entry.code, {
      code: entry.code,
      workspace: entry.workspace,
      createdAt: entry.createdAt ?? Date.now(),
      lastSeen: entry.lastSeen ?? Date.now(),
      hostId: entry.hostId,
      members,
      invites: new Map((Array.isArray(entry.invites) ? entry.invites : []).map((invite: Invite) => [invite.id, invite])),
      joins: new Map((Array.isArray(entry.joins) ? entry.joins : []).map((request: JoinRequest) => [request.id, request])),
      audit: [],
      messages: [],
      sockets: new Set(),
    })
  }
}

export const sweepRooms = async () => {
  const cutoff = Date.now() - roomIdleMinutes * 60_000
  for (const room of rooms.values()) {
    expireJoins(room)
    if (room.sockets.size === 0 && room.lastSeen < cutoff) await deleteRoom(room)
  }
}

export const roomCount = () => rooms.size
export const allRooms = () => [...rooms.values()]
export const allMembers = () => allRooms().flatMap(room => [...room.members.values()])

// A visitor should be able to feel the room without a second person around, so
// an empty start lays down a small project worth opening and running.
const demoFiles: Array<[string, string]> = [
  ['README.md', `# a demo room

Two ways to try this:

- open \`src/notes.md\` and type. Everyone in the room sees it move under your cursor.
- open \`src/greeting.js\`, then press "terminal" and run \`node src/greeting.js\`.

Send this room's invite to a friend and the tree, the cursors and the shared
shell are one place for both of you. Risky shell commands wait for the host.

Delete the files if you would rather start clean.
`],
  ['src/greeting.js', `const who = process.argv[2] ?? 'you'

console.log(\`hey \${who}, this ran in the shared shell\`)
`],
  ['src/notes.md', `# notes

- [ ] invite someone
- [ ] type at the same time in this file
- [ ] run something risky in the shell and watch it wait
- [ ] ask the assistant for an edit

The assistant uses your own plan, not the host's.
`],
  ['styles.css', `:root {
  --ink: #17181d;
  --paper: #fcfcfd;
}

body {
  background: var(--paper);
  color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, sans-serif;
  margin: 0;
  display: grid;
  place-items: center;
  min-height: 100vh;
}
`],
]

export const seedDemo = async (workspace: string) => {
  for (const [path, body] of demoFiles) {
    const full = join(workspace, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }
}
