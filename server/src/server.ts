import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { host, lan, port, dataDir, roomNetwork, webDir } from './config.js'
import { shareLinks } from './addresses.js'
import { reapOrphanContainers, useDocker } from './shell.js'
import { bridgeEgress, containerName, memberPath } from './container.js'
import { hasBin, installTool, TOOLS, toolById } from './tools.js'
import { deletePage, listPages, publishPage, readPageFile } from './pages.js'
import { clearedCookie, cookieHeader, cookieSession, requestToken } from './session.js'
import { storeFor } from './auth/registry.js'
import { SUBSCRIPTIONS, subscriptionById } from './auth/subs.js'
import { closeFileSockets, docRoutes, kickFileSockets } from './ws.js'
import { broadcastJoins, closeControl, controlRoutes, kickSockets, notifyTree, refreshPresence } from './control.js'
import {
  allMembers, allRooms, createInvite, createRoom, decideJoin, removeMember, setRole, deleteRoom, expireJoins, findByToken, findJoin, findMember, getRoom,
  hashToken, inviteLifetimeMinutes, loadRooms, publicInvite, publicRoom, requestJoin, revokeInvite, RoomError, sweepRooms,
  type Member, type Room,
} from './rooms.js'
import { closeDoc, closeRoomDocs, flushAll, flushRoomDocs } from './docs.js'
import {
  deleteWorkspacePath, listTree, readWorkspaceFile, writeWorkspaceFile, WorkspaceError,
} from './workspace.js'

const fail = (reply: any, error: unknown) => {
  if (error instanceof WorkspaceError || error instanceof RoomError) return reply.code(error.status).send({ error: error.message })
  return reply.code(500).send({ error: (error as Error)?.message ?? 'something went wrong' })
}

const setSession = (req: any, reply: any, code: string, token: string) => {
  const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
  reply.header('set-cookie', cookieHeader(code, token, secure))
}

const clearSession = (reply: any) => {
  reply.header('set-cookie', clearedCookie)
}

const memberOf = (req: any): { room: Room; member: Member } | null => {
  const session = { code: cookieSession(req).code, token: requestToken(req) }
  if (!session.token) return null
  const code = String((req.params as any)?.code ?? session.code ?? '')
  if (!code) return findByToken(session.token)
  let room: Room
  try {
    room = getRoom(code)
  } catch {
    return null
  }
  const member = findMember(room, session.token)
  return member ? { room, member } : null
}

const requireMember = (req: any, reply: any) => {
  const found = memberOf(req)
  if (!found) {
    reply.code(401).send({ error: 'join the room first' })
    return null
  }
  return found
}

// Small in-memory gate so a code can be hammered only so fast.
const attempts = new Map<string, { count: number; reset: number }>()
const limited = (key: string, max = 10, windowMs = 60_000) => {
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.reset <= now) {
    attempts.set(key, { count: 1, reset: now + windowMs })
    return false
  }
  entry.count += 1
  return entry.count > max
}

const requireHost = (req: any, reply: any) => {
  const found = requireMember(req, reply)
  if (!found) return null
  if (found.member.role !== 'host') {
    reply.code(403).send({ error: 'only the host can do that' })
    return null
  }
  return found
}

export const buildServer = async () => {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024, trustProxy: true })
  await mkdir(dataDir, { recursive: true })
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } })
  docRoutes(app)
  controlRoutes(app)

  app.get('/api/health', async () => ({ ok: true, shell: useDocker() ? 'container' : 'host', network: useDocker() ? roomNetwork : 'host' }))

  app.post('/api/rooms', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; source?: string }
    const source = body.source ? resolve(String(body.source).replace(/^~(?=\/|$)/, homedir())) : undefined
    if (source && !existsSync(source)) return reply.code(400).send({ error: `no folder at ${source}` })
    const { room, member } = await createRoom(body.name ?? 'host', source)
    setSession(req, reply, room.code, member.token)
    return reply.send({ code: room.code, token: member.token, member, room: publicRoom(room) })
  })

  // A 200 with a null cohort keeps the browser console quiet on the landing page.
  app.get('/api/me', async (req, reply) => {
    const found = memberOf(req)
    if (!found) return reply.send({ code: null, member: null })
    return reply.send({ code: found.room.code, member: { ...found.member, online: true } })
  })

  app.post('/api/leave', async (_req, reply) => {
    clearSession(reply)
    return reply.send({ ok: true })
  })

  app.post('/api/rooms/:code/invites', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    const minutes = Number((req.body as any)?.minutes ?? inviteLifetimeMinutes)
    const { invite, token } = createInvite(found.room, Number.isFinite(minutes) ? minutes : inviteLifetimeMinutes)
    return reply.send({ id: invite.id, token, expiresAt: invite.expiresAt, path: `/?room=${found.room.code}#t=${token}` })
  })

  app.get('/api/rooms/:code/invites', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    return reply.send({ invites: [...found.room.invites.values()].reverse().map(publicInvite) })
  })

  app.delete('/api/rooms/:code/invites/:inviteId', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    try {
      revokeInvite(found.room, String((req.params as any).inviteId ?? ''))
      broadcastJoins(found.room)
      return reply.send({ ok: true })
    } catch (error) {
      return fail(reply, error)
    }
  })

  // Joining is a request: the invite is checked now, the host decides after.
  app.post('/api/rooms/:code/join', async (req, reply) => {
    if (limited(`join:${req.ip}:${(req.params as any).code}`, 20)) return reply.code(429).send({ error: 'too many join attempts, wait a minute' })
    try {
      const body = (req.body ?? {}) as { name?: string; invite?: string }
      const { room, request, token } = requestJoin(String((req.params as any).code), body.name ?? 'guest', String(body.invite ?? ''))
      broadcastJoins(room)
      return reply.send({ status: 'pending', request: { id: request.id, token, expiresAt: request.expiresAt }, code: room.code })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get('/api/joins/:id', async (req, reply) => {
    const code = String((req.query as any)?.code ?? '')
    const room = getRoom(code)
    expireJoins(room)
    const request = findJoin(room, String((req.params as any).id ?? ''))
    if (!request) return reply.code(404).send({ error: 'no such join request' })
    if (hashToken(String((req.query as any)?.t ?? '')) !== request.hash) return reply.code(403).send({ error: 'that request token is not valid' })
    if (request.status !== 'allowed' || !request.memberId) return reply.send({ status: request.status })
    const member = room.members.get(request.memberId)!
    setSession(req, reply, room.code, member.token)
    return reply.send({ status: 'allowed', token: member.token, member, room: publicRoom(room) })
  })

  app.post('/api/joins/:id', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    try {
      decideJoin(found.room, String((req.params as any).id ?? ''), Boolean((req.body as any)?.allow))
      broadcastJoins(found.room)
      return reply.send({ ok: true })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get('/api/rooms/:code', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    return reply.send(publicRoom(found.room))
  })

  app.delete('/api/rooms/:code', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    closeControl(found.room.code)
    await closeRoomDocs(found.room.code)
    await deleteRoom(found.room)
    clearSession(reply)
    return reply.send({ ok: true })
  })

  app.post('/api/rooms/:code/members/:memberId/role', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    try {
      const role = (req.body as any)?.role === 'editor' ? 'editor' : 'guest'
      const member = await setRole(found.room, String((req.params as any).memberId ?? ''), role)
      refreshPresence(found.room)
      return reply.send({ ok: true, role: member.role })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.delete('/api/rooms/:code/members/:memberId', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    const memberId = String((req.params as any).memberId ?? '')
    if (memberId === found.room.hostId) return reply.code(400).send({ error: 'the host cannot be removed' })
    const member = await removeMember(found.room, memberId)
    if (!member) return reply.code(404).send({ error: 'no such member' })
    kickSockets(found.room, memberId)
    kickFileSockets(member.token)
    broadcastJoins(found.room)
    return reply.send({ ok: true, name: member.name })
  })

  app.get('/api/rooms/:code/audit', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    return reply.send({ entries: [...found.room.audit].reverse() })
  })

  // Public sites, no session needed: the tunnel is what keeps them reachable.
  app.get('/p/:site/*', async (req, reply) => {
    const site = String((req.params as any).site ?? '')
    const path = String((req.params as any)['*'] ?? '')
    if (process.env.CLIMP_DEBUG_PAGES) console.log('page', JSON.stringify({ site, path, url: req.url }))
    try {
      const file = await readPageFile(site, path)
      reply.header('content-type', file.type)
      reply.header('x-content-type-options', 'nosniff')
      reply.header('cache-control', 'public, max-age=60')
      return reply.send(file.body)
    } catch {
      return reply.code(404).type('text/plain').send('no such page')
    }
  })

  app.get('/api/pages', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    return reply.send({ pages: await listPages() })
  })

  app.post('/api/pages', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    try {
      const body = (req.body ?? {}) as { name?: string; from?: string }
      const source = body.from === 'workspace' ? found.room.workspace : String(body.from ?? found.room.workspace)
      const page = await publishPage(String(body.name ?? ''), source)
      return reply.send(page)
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.delete('/api/pages/:site', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    await deletePage(String((req.params as any).site ?? ''))
    return reply.send({ ok: true })
  })

  // Download the room as an archive before the room is ended.
  app.get('/api/rooms/:code/export', async (req, reply) => {
    const found = requireHost(req, reply)
    if (!found) return
    await flushRoomDocs(found.room.code)
    const { spawn } = await import('node:child_process')
    const tar = spawn('tar', ['-czf', '-', '-C', found.room.workspace, '.'])
    reply.header('content-type', 'application/gzip')
    reply.header('content-disposition', `attachment; filename="${found.room.code}.tar.gz"`)
    return reply.send(tar.stdout)
  })

  // The host may be looking at 127.0.0.1, which is useless in an invite. This
  // hands back addresses friends can actually reach.
  app.get('/api/rooms/:code/invite', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    // A loopback bind means the LAN addresses have nothing listening, so say so
    // and let the client keep its own origin.
    const local = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    return reply.send({ code: found.room.code, local, links: local ? [] : shareLinks(port) })
  })

  app.get('/api/rooms/:code/tree', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    try {
      return reply.send({ entries: await listTree(found.room.workspace) })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get('/api/rooms/:code/file', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    try {
      const path = String((req.query as any)?.path ?? '')
      return reply.send({ path, content: await readWorkspaceFile(found.room.workspace, path) })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.put('/api/rooms/:code/file', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    try {
      const body = req.body as { path?: string; content?: string }
      await writeWorkspaceFile(found.room.workspace, String(body.path ?? ''), String(body.content ?? ''))
      return reply.send({ ok: true })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.post('/api/rooms/:code/file', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    try {
      const body = req.body as { path?: string }
      await writeWorkspaceFile(found.room.workspace, String(body.path ?? ''), '')
      notifyTree(found.room)
      return reply.send({ ok: true })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.delete('/api/rooms/:code/file', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    try {
      const path = String((req.query as any)?.path ?? '')
      closeFileSockets(found.room.code, path)
      await closeDoc(found.room.code, path)
      await deleteWorkspacePath(found.room.workspace, path)
      notifyTree(found.room)
      return reply.send({ ok: true })
    } catch (error) {
      return fail(reply, error)
    }
  })

  // Optional harnesses, installed into the member's own home.
  app.get('/api/tools', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    const list = await Promise.all(TOOLS.map(async tool => ({
      ...tool,
      installed: await hasBin(found.room.code, found.member.id, tool.bin, memberPath(found.member.id)),
    })))
    return reply.send({ tools: list, container: useDocker() })
  })

  app.post('/api/tools/install', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    const tool = toolById(String((req.body as any)?.id ?? ''))
    if (!tool) return reply.code(404).send({ error: 'no such tool' })
    const result = await installTool(found.room.code, found.room.workspace, found.member.id, tool)
    return reply.code(result.ok ? 200 : 500).send(result)
  })

  // Plan sign-in. Each member has their own store, so tokens never mix.
  app.get('/api/auth', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    return reply.send({ subscriptions: storeFor(found.member.id).statuses() })
  })

  app.post('/api/auth', async (req, reply) => {
    const found = requireMember(req, reply)
    if (!found) return
    const body = (req.body ?? {}) as { id?: string; action?: string; code?: string }
    const sub = subscriptionById(String(body.id ?? ''))
    if (!sub) return reply.code(404).send({ error: `no provider called ${body.id}` })
    const store = storeFor(found.member.id)
    const action = String(body.action ?? (sub.kind === 'device' ? 'device' : 'browser'))
    if (action === 'signOut') {
      store.signOut(sub)
      return reply.send({ ok: true })
    }
    if (action === 'device') {
      const started = await store.startDevice(sub)
      return reply.code(started.error ? 502 : 200).send(started)
    }
    if (action === 'poll') return reply.send(await store.pollDevice(sub))
    if (action === 'code') return reply.send(await store.submitCode(sub, String(body.code ?? '')))
    const started = await store.startBrowser(sub)
    return reply.code(started.error ? 502 : 200).send(started)
  })

  app.get('/api/auth/providers', async () => SUBSCRIPTIONS.map(sub => ({ id: sub.id, name: sub.name, kind: sub.kind })))

  // Providers without their own redirect port bounce through the app port. The
  // state parameter is unique, so at most one member store accepts the callback.
  const callbackPaths = new Set(SUBSCRIPTIONS.map(sub => sub.redirectPath).filter(Boolean) as string[])
  for (const path of callbackPaths) {
    app.get(path, async (req, reply) => {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
      for (const member of allMembers()) {
        const handled = await storeFor(member.id).handleCallback(url, reply.raw)
        if (handled) return reply
      }
      return reply.code(404).send({ error: 'no pending sign-in for this callback' })
    })
  }

  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      const reserved = ['/api', '/ws', '/room', '/p/']
      if (req.method !== 'GET' || reserved.some(prefix => req.url.startsWith(prefix))) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}

export const startServer = async () => {
  const app = await buildServer()
  await loadRooms()
  const reaped = await reapOrphanContainers(allRooms().map(room => room.code))
  if (reaped) console.log(`removed ${reaped} shell container(s) left by an earlier run`)
  setInterval(() => void sweepRooms(), 60_000).unref()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      await flushAll()
      await app.close()
      process.exit(0)
    })
  }
  await app.listen({ port, host })
  console.log(`room shells: ${useDocker() ? 'container' : 'host process (docker not found, or CLIMP_SHELL=host)'}`)
  if (!useDocker() && (host === '0.0.0.0' || host === '::')) {
    console.log('  warning: shells run as this user with no container. Guests can reach your home directory.')
  }
  if (useDocker()) {
    void bridgeEgress().then(ok => {
      if (!ok) console.log('  warning: room containers cannot reach the network over the docker bridge (a VPN often blocks it).\n  run with CLIMP_ROOM_NETWORK=host so installs and fetches work.')
    })
  }
  if (host === '0.0.0.0' || host === '::') {
    console.log(`climultiplayer on http://127.0.0.1:${port} (local)`)
    for (const link of shareLinks(port)) console.log(`  on your network: ${link}`)
    if (!shareLinks(port).length) console.log('  no network address found; use a tunnel')
    console.log('  behind a tunnel, bind loopback instead and the port stays closed')
  } else {
    console.log(`climultiplayer on http://${host}:${port}`)
    console.log('  local only: fine for browsers on this machine')
    if (!lan) console.log('  for another device, stop this and run: npm run host')
  }
  return app
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) await startServer()
