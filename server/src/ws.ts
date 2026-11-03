import type { FastifyInstance } from 'fastify'
import { Awareness } from 'y-protocols/awareness'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { WebSocket } from 'ws'
import { acquireDoc, releaseDoc, type DocEntry } from './docs.js'
import { findMember, getRoom } from './rooms.js'
import { requestToken } from './session.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

type DocSockets = {
  awareness: Awareness
  sockets: Set<WebSocket>
  onAwareness: (event: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void
}

const byFile = new Map<string, DocSockets>()

const key = (code: string, path: string) => `${code}\u0000${path}`

const getSockets = (code: string, path: string, entry: DocEntry): DocSockets => {
  const id = key(code, path)
  const found = byFile.get(id)
  if (found) return found
  const created: DocSockets = { awareness: new Awareness(entry.doc), sockets: new Set(), onAwareness: () => {} }
  created.onAwareness = (event, origin) => {
    const changed = [...event.added, ...event.updated, ...event.removed]
    if (!changed.length || origin === 'local') return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(created.awareness, changed))
    broadcast(created.sockets, encoder)
  }
  created.awareness.on('update', created.onAwareness)
  byFile.set(id, created)
  return created
}

const broadcast = (sockets: Set<WebSocket>, encoder: encoding.Encoder) => {
  const payload = encoding.toUint8Array(encoder)
  for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(payload)
}

const send = (socket: WebSocket, encoder: encoding.Encoder) => {
  if (socket.readyState === socket.OPEN) socket.send(encoding.toUint8Array(encoder))
}

const releaseSockets = (code: string, path: string) => {
  const id = key(code, path)
  const state = byFile.get(id)
  if (!state) return
  if (state.sockets.size === 0) {
    state.awareness.off('update', state.onAwareness)
    state.awareness.destroy()
    byFile.delete(id)
  }
}

export const docRoutes = (app: FastifyInstance) => {
  app.get('/ws/:code/*', { websocket: true }, async (socket, req) => {
    const params = req.params as Record<string, string>
    const code = String(params['code'] ?? '')
    const path = String(params['*'] ?? '')
    const token = String((req.query as Record<string, string>)?.token ?? '') || requestToken(req)
    let room
    try {
      room = getRoom(code)
    } catch {
      socket.close(4404, 'no such room')
      return
    }
    if (!findMember(room, token)) {
      socket.close(4401, 'not a member of this room')
      return
    }
    if (!path) {
      socket.close(4400, 'a file path is required')
      return
    }

    ;(socket as any).__member = String((req.query as Record<string, string>)?.member ?? '') || token
    const entry = await acquireDoc(room.code, room.workspace, path)
    const state = getSockets(room.code, path, entry)
    state.sockets.add(socket)
    // Awareness client ids this socket introduced, so its cursors can be
    // cleared for everyone when it disconnects.
    const owned = new Set<number>()

    socket.on('message', (data: Uint8Array) => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data))
        const type = decoding.readVarUint(decoder)
        const encoder = encoding.createEncoder()
        if (type === MESSAGE_SYNC) {
          encoding.writeVarUint(encoder, MESSAGE_SYNC)
          syncProtocol.readSyncMessage(decoder, encoder, entry.doc, socket)
          // The reply carries step2 or the update itself, so every watcher of
          // the file needs it, not only the sender.
          if (encoding.length(encoder) > 1) broadcast(state.sockets, encoder)
        } else if (type === MESSAGE_AWARENESS) {
          const update = decoding.readVarUint8Array(decoder)
          awarenessProtocol.applyAwarenessUpdate(state.awareness, update, socket)
          const decoder2 = decoding.createDecoder(update)
          const count = decoding.readVarUint(decoder2)
          for (let index = 0; index < count; index++) {
            owned.add(decoding.readVarUint(decoder2))
            decoding.readVarUint(decoder2)
            decoding.readVarString(decoder2)
            decoding.readVarUint8Array(decoder2)
          }
        }
      } catch {
        // A malformed frame from one client must not drop the socket.
      }
    })

    socket.on('close', () => {
      state.sockets.delete(socket)
      if (owned.size) awarenessProtocol.removeAwarenessStates(state.awareness, [...owned], 'closed')
      else {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(state.awareness, []))
        broadcast(state.sockets, encoder)
      }
      releaseDoc(room.code, path)
      releaseSockets(room.code, path)
    })

    const step1 = encoding.createEncoder()
    encoding.writeVarUint(step1, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(step1, entry.doc)
    send(socket, step1)

    const states = state.awareness.getStates()
    if (states.size) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(state.awareness, [...states.keys()]))
      send(socket, encoder)
    }
  })
}

// A kicked member may still hold doc sockets; they would keep syncing with a
// session that no longer exists.
export const kickFileSockets = (token: string) => {
  for (const state of byFile.values()) {
    for (const socket of state.sockets) {
      if ((socket as any).__member !== token) continue
      socket.close(4403, 'removed from the room')
    }
  }
}

export const closeFileSockets = (code: string, path: string) => {
  const id = key(code, path)
  const state = byFile.get(id)
  if (!state) return
  for (const socket of state.sockets) socket.close(4000, 'file removed')
  state.sockets.clear()
  state.awareness.off('update', state.onAwareness)
  state.awareness.destroy()
  byFile.delete(id)
}
