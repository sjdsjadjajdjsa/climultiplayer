import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { previewHours, previewPorts, previewUrl } from './config.js'
import { publishedPort, useDocker } from './container.js'
import { peekRoom, RoomError, type Member, type Room } from './rooms.js'

// A live preview: one member's dev server, running inside their own container,
// opened by anyone in the room. It is served by a separate gateway on its own
// port, so it is a different origin from the room app: the previewed app (which
// anyone in the room can write) never runs where the room session lives.
//
// Getting in: the room app mints a short single-use ticket for a member, the
// gateway trades it for its own cookie, and every request after that checks the
// member is still in the room and the preview is still live. Each browser gets
// its own cookie, so two people (or one person in two browser profiles) are two
// separate users of the previewed app: an admin and an end user at once.

export type Preview = {
  id: string
  code: string
  ownerId: string
  ownerName: string
  color: string
  source: 'mine' | 'shared'
  port: number
  hostPort: number
  createdAt: number
  expiresAt: number
}

type Pass = { previewId: string; code: string; memberId: string; until: number }

const previews = new Map<string, Preview>()
const tickets = new Map<string, Pass>()
const visits = new Map<string, Pass>()

export const previewCookie = 'climp_pv'
const TICKET_MS = 2 * 60_000
const VISIT_MS = 12 * 60 * 60_000
const MAX_PER_MEMBER = 3

const secret = () => randomBytes(24).toString('base64url')

export const publicPreview = (preview: Preview) => ({
  id: preview.id,
  ownerId: preview.ownerId,
  ownerName: preview.ownerName,
  color: preview.color,
  source: preview.source,
  port: preview.port,
  createdAt: preview.createdAt,
  expiresAt: preview.expiresAt,
})

export const listPreviews = (code: string) =>
  [...previews.values()].filter(preview => preview.code === code && preview.expiresAt > Date.now()).map(publicPreview)

// Nothing answering means a dev server bound to localhost inside the container,
// which docker cannot reach. Say how to fix it instead of showing a dead page.
const answers = (port: number) =>
  new Promise<boolean>(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1500, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })

export const startPreview = async (room: Room, member: Member, port: number, source: 'mine' | 'shared') => {
  if (!useDocker()) throw new RoomError('previews need the room container (docker) on the host', 409)
  if (!previewPorts.includes(port)) throw new RoomError(`previews can use ports ${previewPorts.join(', ')}`, 400)
  const owner = source === 'shared' ? 'shared' : member.id
  const hostPort = await publishedPort(room.code, owner, port)
  if (!hostPort) {
    throw new RoomError(source === 'mine' ? 'open a terminal of your own first, then start the dev server in it' : 'the shared shell is not running yet', 409)
  }
  if (!(await answers(hostPort))) {
    throw new RoomError(`nothing answers on port ${port}. Start the dev server listening on all addresses, e.g. npm run dev -- --host 0.0.0.0 --port ${port}`, 409)
  }
  // One preview per port per source; starting again replaces it.
  for (const existing of previews.values()) {
    if (existing.code === room.code && existing.ownerId === member.id && existing.port === port && existing.source === source) stopPreview(existing.id)
  }
  if ([...previews.values()].filter(preview => preview.code === room.code && preview.ownerId === member.id).length >= MAX_PER_MEMBER) {
    throw new RoomError(`stop one of your previews first (${MAX_PER_MEMBER} at most)`, 409)
  }
  const preview: Preview = {
    id: randomBytes(6).toString('hex'),
    code: room.code,
    ownerId: member.id,
    ownerName: member.name,
    color: member.color,
    source,
    port,
    hostPort,
    createdAt: Date.now(),
    expiresAt: Date.now() + previewHours * 60 * 60_000,
  }
  previews.set(preview.id, preview)
  return preview
}

export const findPreview = (code: string, id: string) => {
  const preview = previews.get(String(id ?? ''))
  return preview && preview.code === code ? preview : null
}

export const stopPreview = (id: string) => {
  previews.delete(id)
  for (const [key, pass] of tickets) if (pass.previewId === id) tickets.delete(key)
  for (const [key, pass] of visits) if (pass.previewId === id) visits.delete(key)
}

export const stopMemberPreviews = (code: string, memberId: string) => {
  for (const preview of [...previews.values()]) if (preview.code === code && preview.ownerId === memberId) stopPreview(preview.id)
}

export const stopRoomPreviews = (code: string) => {
  for (const preview of [...previews.values()]) if (preview.code === code) stopPreview(preview.id)
}

export const mintTicket = (preview: Preview, member: Member) => {
  const ticket = secret()
  tickets.set(ticket, { previewId: preview.id, code: preview.code, memberId: member.id, until: Date.now() + TICKET_MS })
  return ticket
}

// The address a browser should open. Behind a tunnel it is the preview tunnel;
// otherwise the same host the room app was reached on, on the preview port.
export const previewBase = (req: { headers: IncomingHttpHeaders; protocol?: string }, gatewayPort: number) => {
  if (previewUrl) return previewUrl.replace(/\/+$/, '')
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim()
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
  return `${secure ? 'https' : 'http'}://${hostname}:${gatewayPort}`
}

// A pass is good while its member is still in the room and the preview is live.
const valid = (pass: Pass | undefined) => {
  if (!pass || pass.until <= Date.now()) return null
  const preview = previews.get(pass.previewId)
  if (!preview || preview.expiresAt <= Date.now()) return null
  const room = peekRoom(pass.code)
  if (!room || !room.members.has(pass.memberId)) return null
  return preview
}

export const sweepPreviews = () => {
  const now = Date.now()
  for (const preview of [...previews.values()]) if (preview.expiresAt <= now || !peekRoom(preview.code)) stopPreview(preview.id)
  for (const [key, pass] of tickets) if (pass.until <= now) tickets.delete(key)
  for (const [key, pass] of visits) if (pass.until <= now || !previews.has(pass.previewId)) visits.delete(key)
}

// Cookies the previewed app must never see or set: the room session and the
// gateway's own pass. The app's own cookies pass through untouched.
const ours = (name: string) => name.trim().toLowerCase().startsWith('climp')

export const cleanCookieHeader = (header: string | string[] | undefined) => {
  const text = Array.isArray(header) ? header.join('; ') : String(header ?? '')
  const kept = text
    .split(';')
    .map(part => part.trim())
    .filter(part => part && !ours(part.split('=')[0]))
  return kept.length ? kept.join('; ') : null
}

export const cleanSetCookie = (header: string | string[] | undefined) => {
  const list = Array.isArray(header) ? header : header ? [header] : []
  return list.filter(entry => !ours(entry.split('=')[0]))
}

const readCookie = (header: string | undefined, name: string) => {
  let found = ''
  let count = 0
  for (const part of String(header ?? '').split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) {
      found = trimmed.slice(name.length + 1)
      count += 1
    }
  }
  // Two cookies of the same name means someone planted one; trust neither.
  return count === 1 ? found : ''
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'])

const upstreamHeaders = (req: IncomingMessage, preview: Preview, keepUpgrade: boolean) => {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (!keepUpgrade && HOP.has(lower)) continue
    if (lower === 'cookie' || lower === 'host' || lower.startsWith('x-forwarded-') || lower === 'forwarded' || lower.startsWith('cf-') || lower === 'x-climp-token') continue
    headers[lower] = value
  }
  const cookie = cleanCookieHeader(req.headers.cookie)
  if (cookie) headers.cookie = cookie
  // Dev servers (Vite especially) refuse unknown Host names; localhost is the
  // name they expect. The address people used rides along for apps that care.
  headers.host = `localhost:${preview.port}`
  if (req.headers.host) headers['x-forwarded-host'] = String(req.headers.host)
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  return headers
}

const deny = (res: ServerResponse, status: number, text: string) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(text)
}

const passFor = (req: IncomingMessage) => {
  const token = readCookie(req.headers.cookie, previewCookie)
  const pass = token ? visits.get(token) : undefined
  return valid(pass)
}

const enter = (req: IncomingMessage, res: ServerResponse, url: URL) => {
  const ticket = url.searchParams.get('t') ?? ''
  const pass = tickets.get(ticket)
  tickets.delete(ticket)
  if (!valid(pass)) return deny(res, 403, 'this preview link has expired or was already used. Open the preview again from the room.')
  const token = secret()
  visits.set(token, { ...pass!, until: Date.now() + VISIT_MS })
  const secure = req.headers['x-forwarded-proto'] === 'https'
  res.writeHead(302, {
    location: '/',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'set-cookie': `${previewCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${VISIT_MS / 1000}${secure ? '; Secure' : ''}`,
  })
  res.end()
}

const proxy = (req: IncomingMessage, res: ServerResponse, preview: Preview) => {
  const upstream = httpRequest(
    { host: '127.0.0.1', port: preview.hostPort, method: req.method, path: req.url, headers: upstreamHeaders(req, preview, false) },
    answer => {
      const headers: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value === undefined || HOP.has(name.toLowerCase())) continue
        headers[name] = value
      }
      const cookies = cleanSetCookie(answer.headers['set-cookie'])
      if (cookies.length) headers['set-cookie'] = cookies
      else delete headers['set-cookie']
      // A redirect to the dev server's own localhost address is useless to a
      // visitor; keep it on the gateway.
      const location = answer.headers.location
      if (typeof location === 'string') headers.location = location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):${preview.port}`), '') || '/'
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers)
      answer.pipe(res)
    },
  )
  upstream.setTimeout(60_000, () => upstream.destroy(new Error('timeout')))
  upstream.on('error', () => {
    if (!res.headersSent) deny(res, 502, `the dev server on port ${preview.port} stopped answering. Is it still running?`)
    else res.destroy()
  })
  req.pipe(upstream)
}

const tunnelUpgrade = (req: IncomingMessage, client: Socket, head: Buffer, preview: Preview) => {
  const target = connect({ host: '127.0.0.1', port: preview.hostPort })
  const fail = () => {
    client.destroy()
    target.destroy()
  }
  target.once('error', fail)
  client.once('error', fail)
  target.once('connect', () => {
    const headers = upstreamHeaders(req, preview, true)
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        if (/[\r\n]/.test(String(one))) continue
        lines.push(`${name}: ${one}`)
      }
    }
    target.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) target.write(head)
    target.pipe(client)
    client.pipe(target)
  })
}

export const startPreviewGateway = (port: number, host: string): Promise<Server> => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gateway')
    if (url.pathname === '/__climp/enter') return enter(req, res, url)
    const preview = passFor(req)
    if (!preview) return deny(res, 403, 'open this preview from the room: the link there signs you in. Only people in the room can see it.')
    proxy(req, res, preview)
  })
  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    const preview = passFor(req)
    if (!preview) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }
    tunnelUpgrade(req, socket, head, preview)
  })
  // Slow or idle clients must not pin sockets forever.
  server.headersTimeout = 20_000
  server.requestTimeout = 0
  setInterval(sweepPreviews, 60_000).unref()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}
