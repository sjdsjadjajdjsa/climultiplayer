import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { maxChatHistory } from './config.js'
import { modelsFor, streamChat, type ChatMessage } from './ai.js'
import { storeFor } from './auth/registry.js'
import { acquireDoc, releaseDoc } from './docs.js'
import { looksRisky } from './risk.js'
import { addMessage, decideJoin, expireJoins, findMember, getRoom, peekRoom, publicMember, recordAudit, setActivity, type Member, type Room } from './rooms.js'
import { requestToken } from './session.js'
import { useDocker } from './shell.js'
import { closeRoomShell, closeTerminal, openTerminal, resizeTerminal, runCommand } from './term.js'
import {
  attach as attachSession, closeSession, detach as detachSession, listSessions, onSessionChange,
  ownerLeft, resize as resizeSession, sessionMap, startSession, write as writeSession, kickSessions,
} from './sessions.js'
import { listTree, readWorkspaceFile, WorkspaceError } from './workspace.js'

type Client = { room: Room; member: Member; socket: WebSocket; file: string | null; lastSaid?: number; runs: number[]; chatting: boolean }

type Approval = { id: string; room: Room; member: Member; command: string; timer: NodeJS.Timeout }

const clients = new Map<string, Set<Client>>()
const approvals = new Map<string, Approval>()

const roomClients = (code: string) => {
  let set = clients.get(code)
  if (!set) {
    set = new Set()
    clients.set(code, set)
  }
  return set
}

const sendTo = (socket: WebSocket, data: unknown) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data))
}

const broadcast = (room: Room, data: unknown, filter?: (client: Client) => boolean) => {
  for (const client of roomClients(room.code)) {
    if (filter && !filter(client)) continue
    sendTo(client.socket, data)
  }
}

const presenceFor = (room: Room) =>
  [...room.members.values()].map(member => {
    const own = [...roomClients(room.code)].find(client => client.member.id === member.id && client.socket.readyState === client.socket.OPEN)
    return { ...publicMember(member), file: own?.file ?? null }
  })

const broadcastPresence = (room: Room) => broadcast(room, { type: 'presence', members: presenceFor(room), hostId: room.hostId })

// Files added or removed by one member must show up in everyone's tree without
// a reload.
export const notifyTree = (room: Room) => broadcast(room, { type: 'tree' })

// Previews changed: everyone's list updates, and the note says who shared what.
export const notifyPreviews = (room: Room, previews: unknown[], note?: string) => broadcast(room, { type: 'previews', previews, note: note ?? null })

// Roles live on the member pills, so a change has to reach everyone.
export const refreshPresence = (room: Room) => broadcastPresence(room)

const findSession = (room: Room, id: string) => sessionMap(room.code).get(id)
const ownSession = (room: Room, socket: WebSocket, id: string) => {
  const session = findSession(room, id)
  return session && session.owner === socket ? session : null
}

// Waiting joiners cannot hold a room socket yet, so the queue is pushed to
// whoever is already inside instead.
export const broadcastJoins = (room: Room) => {
  expireJoins(room)
  broadcast(room, {
    type: 'join:queue',
    joins: [...room.joins.values()].filter(request => request.status === 'pending').map(request => ({ id: request.id, name: request.name, createdAt: request.createdAt, expiresAt: request.expiresAt })),
  })
}

const systemPrompt = (room: Room, tree: string, file: string | null, selection: string) => `You are the shared assistant in a live multiplayer coding room.

Answer in short, concrete prose. When the user wants code changes, emit them as apply-able blocks and nothing else around them:

\`\`\`edit relative/path
<<<<<<< SEARCH
exact existing lines
=======
replacement lines
>>>>>>> REPLACE
\`\`\`

Rules for edit blocks:
- The SEARCH text must match the current file exactly, including indentation, and appear once.
- Use an empty SEARCH block to append a new file.
- One block per changed region. Do not rewrite a whole file just to change a line.
- If you are unsure what the file contains, say so instead of guessing.

Workspace files:
${tree || '(empty)'}
${file ? `\nThe user is looking at ${file}.` : ''}${selection ? `\nTheir selection:\n${selection.slice(0, 4000)}` : ''}`

const cleanMessages = (value: unknown): ChatMessage[] => {
  if (!Array.isArray(value)) return []
  return value
    .filter(entry => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string')
    .slice(-maxChatHistory)
    .map(entry => ({ role: entry.role, content: entry.content.slice(0, 20_000) }))
}

onSessionChange(code => {
  const room = peekRoom(code)
  if (room) broadcast(room, { type: 'term:list', sessions: listSessions(code) })
})

export const controlRoutes = (app: FastifyInstance) => {
  app.get('/room/:code', { websocket: true }, async (socket, req) => {
    const code = String((req.params as Record<string, string>)['code'] ?? '')
    const token = String((req.query as Record<string, string>)?.token ?? '') || requestToken(req)
    let room: Room
    try {
      room = getRoom(code)
    } catch {
      socket.close(4404, 'no such room')
      return
    }
    const member = findMember(room, token)
    if (!member) {
      socket.close(4401, 'not a member of this room')
      return
    }
    if (member.online === 0) member.online = 0
    member.online += 1
    const client: Client = { room, member, socket, file: null, runs: [], chatting: false }
    roomClients(room.code).add(client)
    room.sockets.add(socket)

    // The first container start can take seconds. Hold the terminal behind a
    // promise and register the message handler first, so commands typed while
    // the shell boots are answered instead of dropped.
    const terminalPromise = openTerminal(room.code, room.workspace)
    const print = (data: string) => sendTo(socket, { type: 'term:out', data })
    sendTo(socket, { type: 'hello', you: publicMember(member), hostId: room.hostId, models: modelsFor(storeFor(member.id)), shell: useDocker() ? 'container' : 'host', messages: room.messages.slice(-60) })
    broadcastJoins(room)
    broadcastPresence(room)

    socket.on('message', async (raw: Uint8Array) => {
      let message: any
      try {
        message = JSON.parse(new TextDecoder().decode(raw))
      } catch {
        return
      }
      try {
        switch (message?.type) {
          case 'file':
            client.file = typeof message.path === 'string' ? message.path : null
            if (client.file) setActivity(client.member, `editing ${client.file}`, 20)
            broadcastPresence(room)
            break
          case 'typing':
            setActivity(client.member, client.file ? `editing ${client.file}` : 'typing')
            broadcastPresence(room)
            break
          case 'term:run':
            await runShell(client, room, String(message.command ?? ''))
            break
          case 'term:resize':
            resizeTerminal(await terminalPromise, Number(message.cols) || 120, Number(message.rows) || 30)
            if (message.id) {
              const own = ownSession(room, socket, String(message.id))
              if (own) resizeSession(own, Number(message.cols) || 120, Number(message.rows) || 30)
            }
            break
          case 'term:history':
            sendTo(socket, { type: 'term:init', scrollback: (await terminalPromise).scrollback.slice(-400) })
            break
          case 'term:list':
            sendTo(socket, { type: 'term:list', sessions: listSessions(room.code) })
            break
          case 'term:open': {
            if (!useDocker() && client.member.role !== 'host') {
              sendTo(socket, { type: 'notice', level: 'error', message: 'terminals for guests need the docker container on the host' })
              break
            }
            setActivity(client.member, 'in a terminal', 900)
            broadcastPresence(room)
            const session = await startSession(room.code, room.workspace, client.member, socket)
            sendTo(socket, { type: 'term:session', id: session.id, replayed: session.scrollback.slice(-400) })
            broadcast(room, { type: 'term:list', sessions: listSessions(room.code) })
            break
          }
          case 'term:attach': {
            const session = findSession(room, String(message.id ?? ''))
            if (!session) break
            // Personal terminals show sign-in codes and tokens; only their owner
            // and the host may watch one.
            if (session.memberId !== client.member.id && client.member.role !== 'host') break
            attachSession(session, socket)
            sendTo(socket, { type: 'term:session', id: session.id, owner: session.owner === socket, replayed: session.scrollback.slice(-400) })
            break
          }
          case 'term:detach': {
            const session = findSession(room, String(message.id ?? ''))
            if (session) detachSession(session, socket)
            break
          }
          case 'term:data': {
            const session = ownSession(room, socket, String(message.id ?? ''))
            if (session) writeSession(session, String(message.data ?? ''))
            break
          }
          case 'term:close': {
            const session = ownSession(room, socket, String(message.id ?? ''))
            if (session) closeSession(session)
            break
          }
          case 'approval':
            // A guest cannot wave through their own risky command, or the gate
            // is decorative.
            if (client.member.role === 'guest') {
              sendTo(socket, { type: 'notice', level: 'error', message: 'only the host or an editor can approve a command' })
              break
            }
            await decideApproval(room, String(message.id ?? ''), Boolean(message.allow))
            break
          case 'join:decide':
            if (client.member.role === 'host') {
              try {
                decideJoin(room, String(message.id ?? ''), Boolean(message.allow))
              } catch (error: any) {
                sendTo(socket, { type: 'notice', level: 'error', message: error.message })
              }
              broadcastJoins(room)
              broadcastPresence(room)
            }
            break
          case 'say': {
            const text = String(message.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000)
            if (!text) break
            const sent = Date.now()
            if (sent - (client.lastSaid ?? 0) < 250) break
            client.lastSaid = sent
            broadcast(room, { type: 'say', message: addMessage(room, client.member, text) })
            break
          }
          case 'chat':
            await chat(client, room, message)
            break
          case 'apply':
            await applyEdits(room, member, message)
            break
          case 'models':
            sendTo(socket, { type: 'models', models: modelsFor(storeFor(member.id)) })
            break
          default:
            break
        }
      } catch (error: any) {
        sendTo(socket, { type: 'notice', level: 'error', message: error?.message ?? 'something went wrong' })
      }
    })

    const terminal = await terminalPromise
    terminal.listeners.add(print)
    if (terminal.scrollback.length) sendTo(socket, { type: 'term:init', scrollback: terminal.scrollback.slice(-400) })
    sendTo(socket, { type: 'term:list', sessions: listSessions(room.code) })

    let leaving = false
    socket.on('close', () => {
      if (leaving) return
      leaving = true
      for (const session of sessionMap(room.code).values()) {
        if (session.owner === socket) ownerLeft(session)
        detachSession(session, socket)
      }
      terminal.listeners.delete(print)
      roomClients(room.code).delete(client)
      room.sockets.delete(socket)
      member.online = Math.max(0, member.online - 1)
      if (!roomClients(room.code).size && !approvals.size) closeTerminal(room.code)
      broadcastPresence(room)
    })
  })
}

// Anyone in a room can type into the shared shell, so one held-down Enter key
// must not bury everyone else's command or drain a host's API credit.
const RUN_WINDOW_MS = 5_000
const RUN_MAX = 8

const runShell = async (client: Client, room: Room, raw: string) => {
  const command = raw.trim()
  if (!command) return
  // A newline or a control character would break out of the one-line check and
  // could interrupt or close the shared shell for everyone (Ctrl-C, Ctrl-D).
  if (/[\u0000-\u001f\u007f]/.test(command)) {
    sendTo(client.socket, { type: 'notice', level: 'error', message: 'a command cannot contain control characters or line breaks' })
    return
  }
  const now = Date.now()
  client.runs = client.runs.filter(at => now - at < RUN_WINDOW_MS)
  if (client.runs.length >= RUN_MAX) {
    sendTo(client.socket, { type: 'notice', level: 'error', message: `slow down: ${RUN_MAX} commands per ${RUN_WINDOW_MS / 1000}s` })
    return
  }
  client.runs.push(now)
  if (!useDocker() && client.member.role !== 'host') {
    sendTo(client.socket, { type: 'notice', level: 'error', message: 'the shared shell runs on the host itself (no docker), so only the host can type in it' })
    return
  }
  const terminal = await openTerminal(room.code, room.workspace)
  const risk = looksRisky(command)
  if (risk.risky && client.member.role === 'guest') {
    const id = randomUUID().slice(0, 8)
    recordAudit(room, { name: client.member.name, command, decision: 'asked' })
    broadcast(room, { type: 'term:approval', id, command, memberId: client.member.id, memberName: client.member.name, reasons: risk.reasons })
    const timer = setTimeout(() => void decideApproval(room, id, false, 'the host did not answer'), 90_000)
    approvals.set(id, { id, room, member: client.member, command, timer })
    return
  }
  recordAudit(room, { name: client.member.name, command, decision: 'ran' })
  broadcast(room, { type: 'term:run', command, memberId: client.member.id, memberName: client.member.name, risk: risk.reasons })
  await terminal.ready
  runCommand(terminal, command)
}

const decideApproval = async (room: Room, id: string, allow: boolean, note?: string) => {
  const pending = approvals.get(id)
  // Approvals are keyed globally; an editor in one room must not decide another's.
  if (!pending || pending.room !== room) return
  clearTimeout(pending.timer)
  approvals.delete(id)
  recordAudit(room, { name: pending.member.name, command: pending.command, decision: allow ? 'allowed' : note ? 'auto-expired' : 'denied' })
  broadcast(room, { type: 'term:decision', id, allow, note })
  if (!allow) return
  const terminal = await openTerminal(room.code, room.workspace)
  broadcast(room, { type: 'term:run', command: pending.command, memberId: pending.member.id, memberName: pending.member.name, risk: [] })
  await terminal.ready
  runCommand(terminal, pending.command)
}

const chat = async (client: Client, room: Room, message: any) => {
  if (client.chatting) {
    sendTo(client.socket, { type: 'chat:error', message: 'wait for your last answer to finish' })
    return
  }
  const store = storeFor(client.member.id)
  const account = store.load()
  if (!Object.values(account).some(entry => entry?.accessToken)) {
    sendTo(client.socket, { type: 'chat:error', message: 'sign in to your own plan first, then the assistant can help' })
    return
  }
  const history = cleanMessages(message.messages)
  if (!history.length) return
  const tree = await listTree(room.workspace, 400).then(entries => entries.map(entry => `${entry.dir ? 'dir ' : 'file'} ${entry.path}`).join('\n'))
  const file = typeof message.file === 'string' ? message.file : null
  const selection = typeof message.selection === 'string' ? message.selection : ''
  const id = randomUUID().slice(0, 8)
  client.chatting = true
  setActivity(client.member, 'asking the assistant', 60)
  broadcastPresence(room)
  sendTo(client.socket, { type: 'chat:start', id, by: client.member.name })

  let answer = ''
  try {
    for await (const part of streamChat(store, client.member.id, {
      model: String(message.model ?? ''),
      messages: [{ role: 'system', content: systemPrompt(room, tree, file, selection) }, ...history],
      max_tokens: 8192,
    })) {
      if (part.error) {
        sendTo(client.socket, { type: 'chat:error', message: part.error })
        return
      }
      if (part.reasoning) sendTo(client.socket, { type: 'chat:delta', id, reasoning: part.reasoning })
      if (part.text) {
        answer += part.text
        sendTo(client.socket, { type: 'chat:delta', id, text: part.text })
      }
      if (part.done) sendTo(client.socket, { type: 'chat:done', id, model: part.model, answer })
    }
  } finally {
    client.chatting = false
  }
}

const applyEdits = async (room: Room, member: Member, message: any) => {
  const path = String(message.path ?? '')
  const blocks = Array.isArray(message.blocks) ? message.blocks : []
  if (!path || !blocks.length) return
  const entry = await acquireDoc(room.code, room.workspace, path)
  try {
    const text = entry.doc.getText('text').toString()
    const splices: Array<{ index: number; length: number; replace: string }> = []
    let cursor = text
    const results = []
    for (const block of blocks) {
      const search = String(block.search ?? '')
      const replace = String(block.replace ?? '')
      if (!search.trim()) {
        const glue = cursor.endsWith('\n') || !cursor ? '' : '\n'
        splices.push({ index: cursor.length, length: 0, replace: glue + replace })
        cursor += glue + replace
        results.push({ ok: true, message: 'appended' })
        continue
      }
      const index = cursor.indexOf(search)
      if (index < 0) {
        results.push({ ok: false, message: 'the searched text is no longer in the file' })
        continue
      }
      if (cursor.indexOf(search, index + 1) >= 0) {
        results.push({ ok: false, message: 'the searched text appears more than once' })
        continue
      }
      splices.push({ index, length: search.length, replace })
      cursor = cursor.slice(0, index) + replace + cursor.slice(index + search.length)
      results.push({ ok: true, message: 'applied' })
    }
    if (splices.length) {
      entry.doc.transact(() => {
        const ytext = entry.doc.getText('text')
        for (const splice of [...splices].sort((a, b) => b.index - a.index)) {
          if (splice.length) ytext.delete(splice.index, splice.length)
          if (splice.replace) ytext.insert(splice.index, splice.replace)
        }
      }, member.id)
    }
    broadcast(room, { type: 'edits', path, by: member.name, results })
  } finally {
    releaseDoc(room.code, path)
  }
}

// A kicked member is told why before the socket goes, so their tab can say so.
export const kickSockets = (room: Room, memberId: string) => {
  kickSessions(room.code, memberId)
  for (const client of roomClients(room.code)) {
    if (client.member.id !== memberId) continue
    sendTo(client.socket, { type: 'kicked' })
    client.socket.close(4403, 'removed from the room')
  }
}

export const closeControl = (roomCode: string) => {
  clients.delete(roomCode)
  void closeRoomShell(roomCode)
}
