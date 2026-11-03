import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Doc } from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { buildServer } from '../src/server.js'

// Two people typing in one file: each edit has to reach the other while they
// are both connected, not only when someone opens the file later.
let app: any
const providers: WebsocketProvider[] = []

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy()
  await app?.close()
})

const until = async (check: () => boolean, ms = 4000) => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return check()
}

const setup = async () => {
  app = await buildServer()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as any).port
  const json = { 'content-type': 'application/json' }
  const room = await (await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'host' }) })).json()
  const host = { 'x-climp-token': room.token }
  const pass = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${room.code}/invites`, { method: 'POST', headers: { ...json, ...host }, body: '{}' })).json()
  const asked = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${room.code}/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'sam', invite: pass.token }) })).json()
  await fetch(`http://127.0.0.1:${port}/api/joins/${asked.request.id}`, { method: 'POST', headers: { ...json, ...host }, body: JSON.stringify({ allow: true }) })
  const polled = await (await fetch(`http://127.0.0.1:${port}/api/joins/${asked.request.id}?code=${room.code}&t=${encodeURIComponent(asked.request.token)}`)).json()

  const open = async (token: string) => {
    const doc = new Doc()
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws/${room.code}`, 'notes.txt', doc, { WebSocketPolyfill: WebSocket as any, params: { token } })
    providers.push(provider)
    expect(await until(() => provider.synced)).toBe(true)
    return doc.getText('text')
  }
  return { first: await open(room.token), second: await open(polled.token) }
}

describe('live sync between two connected people', () => {
  it('shows the host what a guest types, and the guest what the host types', async () => {
    const { first, second } = await setup()
    first.insert(0, 'from host. ')
    expect(await until(() => second.toString() === 'from host. ')).toBe(true)
    second.insert(second.length, 'from guest.')
    expect(await until(() => first.toString() === 'from host. from guest.')).toBe(true)
  })

  it('merges edits made at the same moment', async () => {
    const { first, second } = await setup()
    first.insert(0, 'A')
    second.insert(0, 'B')
    expect(await until(() => first.toString().length === 2 && first.toString() === second.toString())).toBe(true)
  })
})
