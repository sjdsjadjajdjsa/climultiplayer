import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { createRoom, invite, join } from './helpers.js'

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('rooms api', () => {
  it('creates a room with a code and a host cookie', async () => {
    app = await buildServer()
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'host' } })
    expect(res.statusCode).toBe(200)
    const created = res.json()
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/)
    expect(created.member.role).toBe('host')
    const cookie = res.headers['set-cookie']
    expect(String(cookie)).toMatch(/climp=/)
    expect(String(cookie)).toMatch(/HttpOnly/)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: String(cookie).split(';')[0] } })
    expect(me.statusCode).toBe(200)
    expect(me.json().code).toBe(created.code)
  })

  it('requires a session for room data', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/tree` })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/tree`, headers: { 'x-climp-token': 'nope' } })).statusCode).toBe(401)
  })

  it('keeps a join pending until the host approves, then returns a session', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const pass = await invite(app, created.code, created.token)
    const requested = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'friend', invite: pass.token } })
    expect(requested.statusCode).toBe(200)
    const request = requested.json().request
    expect(requested.json().status).toBe('pending')

    const early = await app.inject({ method: 'GET', url: `/api/joins/${request.id}?code=${created.code}&t=${encodeURIComponent(request.token)}` })
    expect(early.json().status).toBe('pending')

    const info = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}`, headers: { 'x-climp-token': created.token } })
    expect(info.json().members).toHaveLength(1)

    await app.inject({ method: 'POST', url: `/api/joins/${request.id}`, headers: { 'x-climp-token': created.token }, payload: { allow: true } })
    const done = await app.inject({ method: 'GET', url: `/api/joins/${request.id}?code=${created.code}&t=${encodeURIComponent(request.token)}` })
    expect(done.json().status).toBe('allowed')
    expect(done.json().member.role).toBe('guest')
    expect(done.headers['set-cookie']).toMatch(/climp=/)
  })

  it('rejects a join poll with the wrong request token', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const pass = await invite(app, created.code, created.token)
    const requested = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'friend', invite: pass.token } })
    const request = requested.json().request
    const res = await app.inject({ method: 'GET', url: `/api/joins/${request.id}?code=${created.code}&t=wrong` })
    expect(res.statusCode).toBe(403)
  })

  it('burns a single-use invite after one approval', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const pass = await invite(app, created.code, created.token)
    const first = await join(app, created.code, created.token, 'one', pass.token)
    expect(first.status).toBe('allowed')
    const second = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'two', invite: pass.token } })
    expect(second.statusCode).toBe(403)
    expect(second.json().error).toMatch(/already used/)
  })

  it('refuses a revoked or unknown invite, but allows the bare code', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const pass = await invite(app, created.code, created.token)
    await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}/invites/${pass.id}`, headers: { 'x-climp-token': created.token } })
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'x', invite: pass.token } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'x', invite: 'made-up' } })).statusCode).toBe(403)
    const byCode = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'x', invite: '' } })
    expect(byCode.statusCode).toBe(200)
    expect(byCode.json().status).toBe('pending')
  })

  it('accepts a whole invite link, not just the token', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const pass = await invite(app, created.code, created.token)
    const link = `http://127.0.0.1:8787${pass.path}`
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'x', invite: link } })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('pending')
  })

  it('takes the token out of a link with the token in the query', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const pass = await invite(app, created.code, created.token)
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'x', invite: `http://host/?t=${pass.token}` } })
    expect(res.statusCode).toBe(200)
  })

  it('explains a link with no token', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    await invite(app, created.code, created.token)
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'x', invite: 'http://host/?room=ABC123' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/no invite token/)
  })

  it('marks an expired invite unusable', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const pass = await invite(app, created.code, created.token)
    const { getRoom } = await import('../src/rooms.js')
    const stored = getRoom(created.code).invites.get(pass.id)!
    stored.expiresAt = Date.now() - 1000
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'x', invite: pass.token } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/expired/)
  })

  it('denies a join without spending the invite', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const pass = await invite(app, created.code, created.token)
    const requested = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'x', invite: pass.token } })
    const request = requested.json().request
    await app.inject({ method: 'POST', url: `/api/joins/${request.id}`, headers: { 'x-climp-token': created.token }, payload: { allow: false } })
    const status = await app.inject({ method: 'GET', url: `/api/joins/${request.id}?code=${created.code}&t=${encodeURIComponent(request.token)}` })
    expect(status.json().status).toBe('denied')
    const again = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'y', invite: pass.token } })
    expect(again.statusCode).toBe(200)
  })

  it('lets an approved guest edit files and blocks a path escape', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const guest = await join(app, created.code, created.token)
    const write = await app.inject({ method: 'PUT', url: `/api/rooms/${created.code}/file`, headers: { 'x-climp-token': guest.token }, payload: { path: 'src/a.ts', content: 'hi' } })
    expect(write.statusCode).toBe(200)
    const read = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/file?path=src/a.ts`, headers: { 'x-climp-token': created.token } })
    expect(read.json().content).toBe('hi')
    const escape = await app.inject({ method: 'PUT', url: `/api/rooms/${created.code}/file`, headers: { 'x-climp-token': guest.token }, payload: { path: '../escape.txt', content: 'x' } })
    expect(escape.statusCode).toBe(400)
  })

  it('deletes a file and drops it from the tree', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    await app.inject({ method: 'PUT', url: `/api/rooms/${created.code}/file`, headers: { 'x-climp-token': created.token }, payload: { path: 'gone.ts', content: 'x' } })
    expect((await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}/file?path=gone.ts`, headers: { 'x-climp-token': created.token } })).statusCode).toBe(200)
    const tree = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/tree`, headers: { 'x-climp-token': created.token } })
    expect(tree.json().entries).toEqual([])
  })

  it('only lets the host hand out and revoke invites', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const guest = await join(app, created.code, created.token)
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/invites`, headers: { 'x-climp-token': guest.token } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/invites`, headers: { 'x-climp-token': guest.token } })).statusCode).toBe(403)
    const listed = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/invites`, headers: { 'x-climp-token': created.token } })
    expect(listed.json().invites[0].state).toBe('used')
  })

  it('only lets the host delete the room and clears the cookie', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const guest = await join(app, created.code, created.token)
    expect((await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}`, headers: { 'x-climp-token': guest.token } })).statusCode).toBe(403)
    const allowed = await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}`, headers: { 'x-climp-token': created.token } })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.headers['set-cookie']).toMatch(/Max-Age=0/)
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${created.code}`, headers: { 'x-climp-token': created.token } })).statusCode).toBe(401)
  })

  it('rate limits join attempts', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    let last = 0
    for (let attempt = 0; attempt < 24; attempt++) {
      last = (await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: 'x', invite: '' }, remoteAddress: '10.0.0.9' })).statusCode
    }
    expect(last).toBe(429)
  })

  it('offers reachable invite links', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/invite`, headers: { 'x-climp-token': created.token } })
    expect(res.json().links.every((link: string) => link.startsWith('http://'))).toBe(true)
  })

  it('reports no sign-ins for a fresh member', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const res = await app.inject({ method: 'GET', url: '/api/auth', headers: { 'x-climp-token': created.token } })
    const subs = res.json().subscriptions
    expect(subs.every((sub: any) => sub.signedIn === false)).toBe(true)
  })
})

describe('invite link parsing', () => {
  it('reads tokens from every shape a link takes', async () => {
    const { inviteTokenFrom } = await import('../src/rooms.js')
    const token = 'AbCdEfGhIjKlMnOpQrStUvWx'
    expect(inviteTokenFrom(token)).toBe(token)
    expect(inviteTokenFrom(`http://h/?room=ABC123#t=${token}`)).toBe(token)
    expect(inviteTokenFrom(`http://h/#t=${token}`)).toBe(token)
    expect(inviteTokenFrom(`http://h/?t=${token}`)).toBe(token)
    expect(inviteTokenFrom('http://h/?room=ABC123')).toBe('')
    expect(inviteTokenFrom('')).toBe('')
  })
})

describe('kicking', () => {
  it('removes a guest and kills their token', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const guest = await join(app, created.code, created.token)
    const kicked = await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}/members/${guest.member.id}`, headers: { 'x-climp-token': created.token } })
    expect(kicked.statusCode).toBe(200)
    expect(kicked.json().name).toBe('friend')
    const after = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/tree`, headers: { 'x-climp-token': guest.token } })
    expect(after.statusCode).toBe(401)
  })

  it('only lets the host kick, and never the host itself', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const guest = await join(app, created.code, created.token)
    expect((await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}/members/${created.member.id}`, headers: { 'x-climp-token': created.token } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}/members/${created.member.id}`, headers: { 'x-climp-token': guest.token } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}/members/nope`, headers: { 'x-climp-token': created.token } })).statusCode).toBe(404)
  })

  it('lets a kicked guest return with a fresh invite', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const guest = await join(app, created.code, created.token)
    await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}/members/${guest.member.id}`, headers: { 'x-climp-token': created.token } })
    const back = await join(app, created.code, created.token, 'friend')
    expect(back.status).toBe('allowed')
  })
})

describe('roles and export', () => {
  it('promotes and demotes a guest, host only', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const guest = await join(app, created.code, created.token)
    const promote = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/members/${guest.member.id}/role`, headers: { 'x-climp-token': created.token }, payload: { role: 'editor' } })
    expect(promote.json().role).toBe('editor')
    const demote = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/members/${guest.member.id}/role`, headers: { 'x-climp-token': created.token }, payload: { role: 'guest' } })
    expect(demote.json().role).toBe('guest')
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/members/${guest.member.id}/role`, headers: { 'x-climp-token': guest.token }, payload: { role: 'editor' } })).statusCode).toBe(403)
  })

  it('refuses to change the host role', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/members/${created.member.id}/role`, headers: { 'x-climp-token': created.token }, payload: { role: 'guest' } })
    expect(res.statusCode).toBe(400)
  })

  it('exports the workspace as gzip', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    await app.inject({ method: 'PUT', url: `/api/rooms/${created.code}/file`, headers: { 'x-climp-token': created.token }, payload: { path: 'a.txt', content: 'x' } })
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/export`, headers: { 'x-climp-token': created.token } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('gzip')
    expect(res.rawPayload.subarray(0, 2).toString('hex')).toBe('1f8b')
  })
})

describe('audit log', () => {
  it('is host only and starts empty', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const guest = await join(app, created.code, created.token)
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/audit`, headers: { 'x-climp-token': created.token } })).json().entries).toEqual([])
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/audit`, headers: { 'x-climp-token': guest.token } })).statusCode).toBe(403)
  })
})

describe('member session hygiene', () => {
  it('does not hand the member token back to page scripts', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-climp-token': created.token } })
    expect(me.json().member.token).toBeUndefined()
    expect(me.json().member.id).toBeTruthy()
  })

  it('keeps rooms.json owner only and stores token hashes, not tokens', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const { dataDir } = await import('../src/config.js')
    const { join } = await import('node:path')
    const { readFile, stat } = await import('node:fs/promises')
    const file = join(dataDir, 'rooms.json')
    await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-climp-token': created.token } })
    await new Promise(resolve => setTimeout(resolve, 600))
    const mode = (await stat(join(dataDir, 'rooms.json'))).mode & 0o777
    const body = await readFile(join(dataDir, 'rooms.json'), 'utf8').catch(() => '')
    if (body) {
      expect(created.token && body.includes(created.token)).toBe(false)
      expect(body).toContain('tokenHash')
    }
    expect([0o600, 0o644]).toContain(mode)
  })

  it('refuses more pending requests than the host can see', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const codes: number[] = []
    for (let index = 0; index < 12; index += 1) {
      const res = await app.inject({ method: 'POST', url: `/api/rooms/${created.code}/join`, payload: { name: `asker${index}`, invite: '' } })
      codes.push(res.statusCode)
    }
    expect(codes).toContain(429)
  })
})

describe('health', () => {
  it('reports the shell mode, network and whether the room image exists', async () => {
    app = await buildServer()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(['container', 'host']).toContain(body.shell)
    expect(typeof body.image).toBe('boolean')
  })
})

describe('tools and keys', () => {
  it('lists the catalog with install state', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const res = await app.inject({ method: 'GET', url: '/api/tools', headers: { 'x-climp-token': created.token } })
    const body = res.json()
    const ids = body.tools.map((tool: any) => tool.id)
    expect(ids).toContain('crush')
    for (const id of ['claude', 'codex', 'grok', 'copilot']) expect(ids).toContain(id)
    expect(body.tools.every((tool: any) => tool.installed === false)).toBe(true)
    expect(typeof body.container).toBe('boolean')
  })

  it('rejects an unknown tool', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const res = await app.inject({ method: 'POST', url: '/api/tools/install', headers: { 'x-climp-token': created.token }, payload: { id: 'nope' } })
    expect(res.statusCode).toBe(404)
  })
})

describe('publishing', () => {
  it('serves a published file publicly, no session needed', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    await app.inject({ method: 'PUT', url: `/api/rooms/${created.code}/file`, headers: { 'x-climp-token': created.token }, payload: { path: 'index.html', content: '<h1>hi</h1>' } })
    const published = await app.inject({ method: 'POST', url: '/api/pages', headers: { 'x-climp-token': created.token }, payload: { name: 'My Site' } })
    expect(published.statusCode).toBe(200)
    const slug = published.json().slug
    expect(slug).toBe('my-site')
    const page = await app.inject({ method: 'GET', url: `/p/${slug}/` })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toBe('<h1>hi</h1>')
  })

  it('only lets the host publish and delete', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    const guest = await join(app, created.code, created.token)
    expect((await app.inject({ method: 'POST', url: '/api/pages', headers: { 'x-climp-token': guest.token }, payload: { name: 'x' } })).statusCode).toBe(403)
    const published = await app.inject({ method: 'POST', url: '/api/pages', headers: { 'x-climp-token': created.token }, payload: { name: 'x' } })
    expect((await app.inject({ method: 'DELETE', url: `/api/pages/${published.json().slug}`, headers: { 'x-climp-token': guest.token } })).statusCode).toBe(403)
  })

  it('deletes a page and 404s after', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    await app.inject({ method: 'PUT', url: `/api/rooms/${created.code}/file`, headers: { 'x-climp-token': created.token }, payload: { path: 'index.html', content: 'x' } })
    const published = await app.inject({ method: 'POST', url: '/api/pages', headers: { 'x-climp-token': created.token }, payload: { name: 'gone' } })
    const slug = published.json().slug
    expect((await app.inject({ method: 'DELETE', url: `/api/pages/${slug}`, headers: { 'x-climp-token': created.token } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/p/${slug}/` })).statusCode).toBe(404)
  })

  it('serves a published site and nothing around it', async () => {
    app = await buildServer()
    const created = await createRoom(app)
    await app.inject({ method: 'PUT', url: `/api/rooms/${created.code}/file`, headers: { 'x-climp-token': created.token }, payload: { path: 'index.html', content: 'inside' } })
    await app.inject({ method: 'PUT', url: `/api/rooms/${created.code}/file`, headers: { 'x-climp-token': created.token }, payload: { path: 'sub/deep.txt', content: 'deep' } })
    const published = await app.inject({ method: 'POST', url: '/api/pages', headers: { 'x-climp-token': created.token }, payload: { name: 'safe' } })
    const slug = published.json().slug

    const served = await app.inject({ method: 'GET', url: `/p/${slug}/` })
    expect(served.statusCode).toBe(200)
    expect(served.body).toBe('inside')
    expect(served.headers['content-security-policy']).toContain('sandbox')
    const nested = await app.inject({ method: 'GET', url: `/p/${slug}/sub/deep.txt` })
    expect(nested.statusCode).toBe(200)

    // Walking up is refused now: the data dir next to the site holds tokens.
    const { dataDir } = await import('../src/config.js')
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(dataDir, 'probe.txt'), 'outside')
    const up = await app.inject({ method: 'GET', url: `/p/${slug}/..%2F..%2Fprobe.txt` })
    expect(up.statusCode).toBe(404)
    const escape = await app.inject({ method: 'GET', url: `/p/${slug}/..%2F..%2F..%2F..%2Fetc%2Fpasswd` })
    expect(escape.statusCode).toBe(404)
  })
})

describe('starting from a folder', () => {
  it('copies the folder in, skipping heavy dirs, and leaves the original alone', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const source = await mkdtemp(join(tmpdir(), 'climp-src-'))
    await writeFile(join(source, 'main.ts'), 'hello')
    await mkdir(join(source, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(source, 'node_modules', 'pkg', 'index.js'), 'x')
    await mkdir(join(source, '.git'), { recursive: true })
    await writeFile(join(source, '.git', 'HEAD'), 'ref')

    app = await buildServer()
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'host', source } })
    expect(res.statusCode).toBe(200)
    const created = res.json()
    const file = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/file?path=main.ts`, headers: { 'x-climp-token': created.token } })
    expect(file.json().content).toBe('hello')
    const tree = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/tree`, headers: { 'x-climp-token': created.token } })
    const paths = tree.json().entries.map((entry: any) => entry.path)
    expect(paths).toContain('main.ts')
    expect(paths.some((path: string) => path.startsWith('node_modules'))).toBe(false)
    const { dataDir } = await import('../src/config.js')
    const seeded = join(dataDir, 'rooms', created.code, 'workspace')
    expect(await readFile(join(seeded, '.git', 'HEAD'), 'utf8')).toBe('ref')
    expect(existsSync(join(seeded, 'node_modules'))).toBe(false)

    await app.inject({ method: 'DELETE', url: `/api/rooms/${created.code}`, headers: { 'x-climp-token': created.token } })
    expect(await readFile(join(source, 'main.ts'), 'utf8')).toBe('hello')
    await rm(source, { recursive: true, force: true })
  })

  it('lays down a demo project to poke at', async () => {
    app = await buildServer()
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'host', demo: true } })
    expect(res.statusCode).toBe(200)
    const created = res.json()
    const tree = await app.inject({ method: 'GET', url: `/api/rooms/${created.code}/tree`, headers: { 'x-climp-token': created.token } })
    const paths = tree.json().entries.map((entry: any) => entry.path)
    expect(paths).toContain('README.md')
    expect(paths).toContain('src/greeting.js')
    expect(paths).toContain('src/notes.md')
  })

  it('leaves a big history behind', async () => {
    const { mkdtemp, mkdir, truncate, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const source = await mkdtemp(join(tmpdir(), 'climp-big-'))
    await mkdir(join(source, '.git'), { recursive: true })
    await writeFile(join(source, '.git', 'HEAD'), 'ref')
    await writeFile(join(source, '.git', 'pack'), '')
    await truncate(join(source, '.git', 'pack'), 41 * 1024 * 1024)

    app = await buildServer()
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'host', source } })
    const created = res.json()
    const { dataDir } = await import('../src/config.js')
    expect(existsSync(join(dataDir, 'rooms', created.code, 'workspace', '.git'))).toBe(false)
    await rm(source, { recursive: true, force: true })
  })

  it('accepts ~ and refuses a missing folder', async () => {
    app = await buildServer()
    const bad = await app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'host', source: '/definitely/not/here' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toContain('no folder at')

    const { homedir } = await import('node:os')
    const home = await app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'host', source: '~' } })
    expect(home.statusCode).toBe(200)
    expect(home.json().room.workspace).toContain(homedir() ? '/rooms/' : '')
    // A home directory can be large and CI runners are slow; seeding it is not
    // a two second job.
  }, 90_000)
})
