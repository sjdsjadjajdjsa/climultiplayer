import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

// Without a container the shell is the host user's own, so only the host types
// in it and only the host opens terminals. Guests are told why.
let app: any
let port = 0

const start = async () => {
  vi.stubEnv('CLIMP_SHELL', 'host')
  vi.resetModules()
  const { buildServer } = await import('../src/server.js')
  app = await buildServer()
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as any).port
  const created = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'host' }) })
  const room = await created.json()
  return { code: room.code, hostToken: room.token }
}

const joinGuest = async (code: string, hostToken: string) => {
  const json = { 'content-type': 'application/json' }
  const pass = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/invites`, { method: 'POST', headers: { ...json, 'x-climp-token': hostToken }, body: '{}' })).json()
  const asked = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'friend', invite: pass.token }) })).json()
  await fetch(`http://127.0.0.1:${port}/api/joins/${asked.request.id}`, { method: 'POST', headers: { ...json, 'x-climp-token': hostToken }, body: JSON.stringify({ allow: true }) })
  const polled = await (await fetch(`http://127.0.0.1:${port}/api/joins/${asked.request.id}?code=${code}&t=${encodeURIComponent(asked.request.token)}`)).json()
  return polled.token as string
}

const connect = (code: string, token: string) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/room/${code}?token=${encodeURIComponent(token)}`)
  const messages: any[] = []
  socket.on('message', data => messages.push(JSON.parse(String(data))))
  return { socket, messages, open: new Promise(resolve => socket.on('open', resolve)) }
}

const waitFor = async (messages: any[], predicate: (message: any) => boolean, timeout = 5000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const found = messages.find(predicate)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for a message')
}

afterEach(async () => {
  await app?.close()
  vi.unstubAllEnvs()
})

describe('host shell mode', () => {
  it('lets the host type and tells a guest why they cannot', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const guest = connect(code, await joinGuest(code, hostToken))
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')

    host.socket.send(JSON.stringify({ type: 'term:run', command: 'echo host-here' }))
    const run = await waitFor(host.messages, message => message.type === 'term:run')
    expect(run.command).toContain('host-here')

    guest.socket.send(JSON.stringify({ type: 'term:run', command: 'echo guest-here' }))
    const notice = await waitFor(guest.messages, message => message.type === 'notice')
    expect(notice.message).toMatch(/only the host can type/)
    expect(guest.messages.some(message => message.type === 'term:run' && message.memberName === 'friend')).toBe(false)

    host.socket.close()
    guest.socket.close()
  })

  it('refuses a guest terminal', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const guest = connect(code, await joinGuest(code, hostToken))
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')
    guest.socket.send(JSON.stringify({ type: 'term:open' }))
    const notice = await waitFor(guest.messages, message => message.type === 'notice')
    expect(notice.message).toMatch(/need the docker container/)
    host.socket.close()
    guest.socket.close()
  })
})
