import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { buildServer } from '../src/server.js'
import { peekRoom } from '../src/rooms.js'
import { sessionMap } from '../src/sessions.js'

let app: any
let port = 0

afterEach(async () => {
  await app?.close()
})

const waitFor = async (messages: any[], predicate: (message: any) => boolean, timeout = 20_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const found = messages.find(predicate)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for a message')
}

// Server state lives in module-level maps, and the only thing keeping a dead
// room's sockets, docs and terminals from pinning memory is the teardown path
// remembering every one of them. This drives a room with everything open, then
// deletes it and checks the state actually went away.
describe('room teardown', () => {
  it('closes doc sockets, sessions and the room itself when the room is deleted', async () => {
    app = await buildServer()
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as any).port
    const created = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'host' }) })
    const room = await created.json()
    const auth = { 'x-climp-token': room.token }

    const control = new WebSocket(`ws://127.0.0.1:${port}/room/${room.code}?token=${encodeURIComponent(room.token)}`)
    const controlMessages: any[] = []
    control.on('message', data => controlMessages.push(JSON.parse(String(data))))
    await new Promise(resolve => control.on('open', resolve))

    const doc = new WebSocket(`ws://127.0.0.1:${port}/ws/${room.code}/notes.md?token=${encodeURIComponent(room.token)}`)
    await new Promise(resolve => doc.on('open', resolve))
    const docClosed = new Promise<number>(resolve => doc.on('close', resolve))
    const controlClosed = new Promise<number>(resolve => control.on('close', resolve))

    control.send(JSON.stringify({ type: 'term:open' }))
    await waitFor(controlMessages, message => message.type === 'term:session')
    expect(sessionMap(room.code).size).toBe(1)

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.code}`, { method: 'DELETE', headers: auth })
    expect(res.status).toBe(200)

    expect(await docClosed).toBe(4000)
    expect(await controlClosed).toBe(1000)
    expect(peekRoom(room.code)).toBeUndefined()
    expect(sessionMap(room.code).size).toBe(0)
  }, 30_000)
})
