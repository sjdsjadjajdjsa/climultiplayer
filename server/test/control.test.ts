import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { buildServer } from '../src/server.js'

let app: any
let port = 0

const start = async () => {
  app = await buildServer()
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as any).port
  const created = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'host' }) })
  const room = await created.json()
  return { code: room.code, hostToken: room.token }
}

// Joining needs an invite and a host decision; this walks that whole path.
const joinGuest = async (code: string, hostToken: string, name = 'friend') => {
  const json = { 'content-type': 'application/json' }
  const pass = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/invites`, { method: 'POST', headers: { ...json, 'x-climp-token': hostToken }, body: '{}' })).json()
  const requested = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/join`, { method: 'POST', headers: json, body: JSON.stringify({ name, invite: pass.token }) })).json()
  await fetch(`http://127.0.0.1:${port}/api/joins/${requested.request.id}`, { method: 'POST', headers: { ...json, 'x-climp-token': hostToken }, body: JSON.stringify({ allow: true }) })
  const polled = await (await fetch(`http://127.0.0.1:${port}/api/joins/${requested.request.id}?code=${code}&t=${encodeURIComponent(requested.request.token)}`)).json()
  return polled.token as string
}

const connect = (code: string, token: string) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/room/${code}?token=${encodeURIComponent(token)}`)
  const messages: any[] = []
  socket.on('message', data => messages.push(JSON.parse(String(data))))
  return { socket, messages, open: new Promise(resolve => socket.on('open', resolve)) }
}

const waitFor = async (messages: any[], predicate: (message: any) => boolean, timeout = 4000) => {
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
})

describe('room socket', () => {
  it('shows members to each other', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const guest = connect(code, await joinGuest(code, hostToken))
    await guest.open
    const presence = await waitFor(host.messages, message => message.type === 'presence' && message.members.length === 2)
    expect(presence.members.map((member: any) => member.name).sort()).toEqual(['friend', 'host'])
    host.socket.close()
    guest.socket.close()
  })

  // Browsers never see the query token path; they ride on the climp cookie.
  it('accepts the session cookie in place of a query token', async () => {
    const { code, hostToken } = await start()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/room/${code}`, {
      headers: { cookie: `climp=${encodeURIComponent(`${code}.${hostToken}`)}` },
    })
    const messages: any[] = []
    socket.on('message', data => messages.push(JSON.parse(String(data))))
    await new Promise(resolve => socket.on('open', resolve))
    await waitFor(messages, message => message.type === 'hello')
    socket.close()
  })

  it('refuses a socket with no token at all', async () => {
    const { code } = await start()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/room/${code}`)
    const closed = await new Promise<number>(resolve => socket.on('close', resolve))
    expect(closed).toBe(4401)
  })

  it('pushes the join queue to the host', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const pass = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/invites`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-climp-token': hostToken }, body: '{}' })).json()
    await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'friend', invite: pass.token }) })
    const queue = await waitFor(host.messages, message => message.type === 'join:queue' && message.joins.length === 1)
    expect(queue.joins[0].name).toBe('friend')
    host.socket.close()
  })

  it('refuses a socket without a valid token', async () => {
    const { code } = await start()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/room/${code}?token=nope`)
    const code4001 = await new Promise<number>(resolve => socket.on('close', value => resolve(value)))
    expect(code4001).toBe(4401)
  })

  it('runs a harmless command for a guest and streams the output', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const guest = connect(code, await joinGuest(code, hostToken))
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')
    guest.socket.send(JSON.stringify({ type: 'term:run', command: 'echo hi-there' }))
    const run = await waitFor(host.messages, message => message.type === 'term:run')
    expect(run.command).toBe('echo hi-there')
    const output = await waitFor(host.messages, message => message.type === 'term:out' && String(message.data).includes('hi-there'))
    expect(output.data).toContain('hi-there')
    host.socket.close()
    guest.socket.close()
  })

  it('asks the host before a risky guest command, and runs it after approval', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const guest = connect(code, await joinGuest(code, hostToken))
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')
    guest.socket.send(JSON.stringify({ type: 'term:run', command: 'rm -f /tmp/climp-not-there' }))
    const approval = await waitFor(host.messages, message => message.type === 'term:approval')
    expect(approval.reasons.join(' ')).toMatch(/deletes/)
    expect(host.messages.some(message => message.type === 'term:run')).toBe(false)
    host.socket.send(JSON.stringify({ type: 'approval', id: approval.id, allow: true }))
    const decision = await waitFor(guest.messages, message => message.type === 'term:decision')
    expect(decision.allow).toBe(true)
    const run = await waitFor(host.messages, message => message.type === 'term:run')
    expect(run.command).toContain('rm -f')
    host.socket.close()
    guest.socket.close()
  })

  it('lets the host run risky commands without asking', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    await waitFor(host.messages, message => message.type === 'hello')
    host.socket.send(JSON.stringify({ type: 'term:run', command: 'mkdir -p /tmp/climp-made' }))
    const run = await waitFor(host.messages, message => message.type === 'term:run')
    expect(run.command).toContain('mkdir')
    host.socket.close()
  })

  it('does not let a guest approve their own risky command', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const guest = connect(code, await joinGuest(code, hostToken))
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')
    guest.socket.send(JSON.stringify({ type: 'term:run', command: 'rm -f /tmp/climp-self' }))
    const approval = await waitFor(host.messages, message => message.type === 'term:approval')
    guest.socket.send(JSON.stringify({ type: 'approval', id: approval.id, allow: true }))
    const notice = await waitFor(guest.messages, message => message.type === 'notice')
    expect(notice.message).toMatch(/host or an editor/)
    expect(host.messages.some(message => message.type === 'term:run')).toBe(false)
    host.socket.send(JSON.stringify({ type: 'approval', id: approval.id, allow: true }))
    await waitFor(host.messages, message => message.type === 'term:run')
    host.socket.close()
    guest.socket.close()
  })

  it('lets an editor approve a risky command', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const guestToken = await joinGuest(code, hostToken)
    const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { 'x-climp-token': guestToken } })).json()
    await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/members/${me.member.id}/role`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-climp-token': hostToken }, body: JSON.stringify({ role: 'editor' }) })
    const guest = connect(code, await joinGuest(code, hostToken, 'other'))
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')
    guest.socket.send(JSON.stringify({ type: 'term:run', command: 'rm -f /tmp/climp-editor' }))
    const approval = await waitFor(host.messages, message => message.type === 'term:approval')
    host.socket.send(JSON.stringify({ type: 'approval', id: approval.id, allow: true }))
    const run = await waitFor(guest.messages, message => message.type === 'term:run')
    expect(run.command).toContain('rm -f')
    host.socket.close()
    guest.socket.close()
  })

  it('refuses control characters, which would break out of the one line', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    await waitFor(host.messages, message => message.type === 'hello')
    host.socket.send(JSON.stringify({ type: 'term:run', command: 'echo one\u0004' }))
    const notice = await waitFor(host.messages, message => message.type === 'notice')
    expect(notice.message).toMatch(/control characters/)
    expect(host.messages.some(message => message.type === 'term:run')).toBe(false)
    host.socket.close()
  })

  it('caps a member at four terminals', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    await waitFor(host.messages, message => message.type === 'hello')
    for (let index = 0; index < 5; index += 1) {
      host.socket.send(JSON.stringify({ type: 'term:open' }))
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    const notice = await waitFor(host.messages, message => message.type === 'notice', 8000)
    expect(notice.message).toMatch(/four terminals/)
    host.socket.close()
  }, 30_000)

  it('slows down a member who floods the shell', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    await waitFor(host.messages, message => message.type === 'hello')
    for (let index = 0; index < 10; index += 1) host.socket.send(JSON.stringify({ type: 'term:run', command: `true ${index}` }))
    const notice = await waitFor(host.messages, message => message.type === 'notice')
    expect(notice.message).toMatch(/slow down/)
    host.socket.close()
  })
})

describe('kick socket', () => {
  it('tells the kicked member before closing', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const guestToken = await joinGuest(code, hostToken)
    const guest = connect(code, guestToken)
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')
    const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { 'x-climp-token': guestToken } })).json()
    await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/members/${me.member.id}`, { method: 'DELETE', headers: { 'x-climp-token': hostToken } })
    await waitFor(guest.messages, message => message.type === 'kicked')
    const closeCode = await new Promise<number>(resolve => guest.socket.on('close', resolve))
    expect(closeCode).toBe(4403)
    host.socket.close()
  })
})

describe('editor role', () => {
  it('runs risky commands without asking an editor', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    const guestToken = await joinGuest(code, hostToken)
    const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { 'x-climp-token': guestToken } })).json()
    await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/members/${me.member.id}/role`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-climp-token': hostToken }, body: JSON.stringify({ role: 'editor' }) })
    const guest = connect(code, guestToken)
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')
    guest.socket.send(JSON.stringify({ type: 'term:run', command: 'rm -f /tmp/climp-none' }))
    const run = await waitFor(host.messages, message => message.type === 'term:run')
    expect(run.memberName).toBe('friend')
    expect(host.messages.some(message => message.type === 'term:approval')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 700))
    const audit = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/audit`, { headers: { 'x-climp-token': hostToken } })).json()
    expect(audit.entries[0]).toMatchObject({ command: 'rm -f /tmp/climp-none', decision: 'ran' })
    host.socket.close()
    guest.socket.close()
  })
})

describe('member terminals', () => {
  it('streams an owner session to a watcher, read only', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    await waitFor(host.messages, message => message.type === 'hello')

    const guestToken = await joinGuest(code, hostToken)
    const guest = connect(code, guestToken)
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')

    guest.socket.send(JSON.stringify({ type: 'term:open' }))
    const opened = await waitFor(guest.messages, message => message.type === 'term:session')
    expect(opened.id).toBeTruthy()

    await waitFor(host.messages, message => message.type === 'term:list' && message.sessions.length === 1)
    host.socket.send(JSON.stringify({ type: 'term:attach', id: opened.id }))
    await waitFor(host.messages, message => message.type === 'term:session' && message.id === opened.id)

    guest.socket.send(JSON.stringify({ type: 'term:data', id: opened.id, data: 'echo session-ok\r' }))
    const seen = await waitFor(host.messages, message => message.type === 'term:out' && String(message.data).includes('session-ok'))
    expect(seen.data).toContain('session-ok')

    // A watcher's input is ignored while the owner drives.
    host.socket.send(JSON.stringify({ type: 'term:data', id: opened.id, data: 'echo watcher\r' }))
    await new Promise(resolve => setTimeout(resolve, 400))
    const afterWatcher = host.messages.filter(message => message.type === 'term:out').map(message => String(message.data)).join('')
    expect(afterWatcher).not.toContain('watcher')

    host.socket.close()
    guest.socket.close()
  })

  it('ends the session when the owner disconnects', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    await waitFor(host.messages, message => message.type === 'hello')
    const guestToken = await joinGuest(code, hostToken)
    const guest = connect(code, guestToken)
    await guest.open
    await waitFor(guest.messages, message => message.type === 'hello')
    guest.socket.send(JSON.stringify({ type: 'term:open' }))
    const opened = await waitFor(guest.messages, message => message.type === 'term:session')
    host.socket.send(JSON.stringify({ type: 'term:attach', id: opened.id }))
    await waitFor(host.messages, message => message.type === 'term:session' && message.id === opened.id)
    guest.socket.close()
    await waitFor(host.messages, message => message.type === 'term:end' && message.id === opened.id, 6000)
    host.socket.close()
  })
})

describe('member homes', () => {
  it('mounts only the member own home into their terminal container', async () => {
    const { code, hostToken } = await start()
    const host = connect(code, hostToken)
    await host.open
    await waitFor(host.messages, message => message.type === 'hello')
    host.socket.send(JSON.stringify({ type: 'term:open' }))
    const opened = await waitFor(host.messages, message => message.type === 'term:session', 20_000)
    const { execFileSync } = await import('node:child_process')
    const names = execFileSync('docker', ['ps', '--filter', 'name=climp-room-', '--format', '{{.Names}}']).toString().trim().split('\n')
    const mine = names.find(name => name.startsWith(`climp-room-${code.toLowerCase()}-`))
    expect(mine).toBeTruthy()
    const mounts = execFileSync('docker', ['inspect', mine!, '-f', '{{range .Mounts}}{{.Destination}} {{end}}']).toString()
    const homes = mounts.split(' ').filter(entry => entry.startsWith('/homes/'))
    expect(homes).toHaveLength(1)
    expect(opened.id).toBeTruthy()
    host.socket.close()
  })
})
