export type Member = { id: string; name: string; role: 'host' | 'guest' | 'editor'; color: string; online: boolean; file?: string | null; activity?: string | null }
export type TreeEntry = { path: string; dir: boolean; size: number }
export type Session = { code: string; member: Member }
export type Invite = { id: string; createdAt: number; expiresAt: number; used: boolean; revoked: boolean; state: 'open' | 'used' | 'revoked' | 'expired' }
export type JoinTicket = { id: string; token: string; code: string; expiresAt: number }

const request = async (path: string, options: RequestInit = {}) => {
  const headers: Record<string, string> = { ...(options.body ? { 'content-type': 'application/json' } : {}) }
  const res = await fetch(path, { ...options, credentials: 'same-origin', headers: { ...headers, ...(options.headers as Record<string, string>) } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error ?? `request failed (${res.status})`)
  return data
}

export const me = async (): Promise<Session | null> => {
  try {
    const data = await request('/api/me')
    return data?.code && data?.member ? data : null
  } catch {
    return null
  }
}

export const createRoom = (name: string, source?: string) =>
  request('/api/rooms', { method: 'POST', body: JSON.stringify({ name, source }) }) as Promise<{ code: string; member: Member }>

export const requestJoin = async (code: string, name: string, invite: string): Promise<JoinTicket> => {
  const result = await request(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: JSON.stringify({ name, invite }) })
  // The API nests the ticket under `request`; the poll needs it flat.
  return { id: result.request.id, token: result.request.token, code: result.code, expiresAt: result.request.expiresAt }
}

export const pollJoin = (ticket: JoinTicket) =>
  request(`/api/joins/${ticket.id}?code=${encodeURIComponent(ticket.code)}&t=${encodeURIComponent(ticket.token)}`) as Promise<{ status: 'pending' | 'allowed' | 'denied' | 'expired'; member?: Member }>

export const leaveRoom = () => request('/api/leave', { method: 'POST' })

export const tree = (session: Session) => request(`/api/rooms/${session.code}/tree`) as Promise<{ entries: TreeEntry[] }>

export const readFile = (session: Session, path: string) =>
  request(`/api/rooms/${session.code}/file?path=${encodeURIComponent(path)}`) as Promise<{ content: string }>

export const writeFile = (session: Session, path: string, content: string) =>
  request(`/api/rooms/${session.code}/file`, { method: 'PUT', body: JSON.stringify({ path, content }) })

export const createFile = (session: Session, path: string) =>
  request(`/api/rooms/${session.code}/file`, { method: 'POST', body: JSON.stringify({ path }) })

export const deleteFile = (session: Session, path: string) =>
  request(`/api/rooms/${session.code}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })

export const createInvite = (session: Session, minutes: number) =>
  request(`/api/rooms/${session.code}/invites`, { method: 'POST', body: JSON.stringify({ minutes }) }) as Promise<{ id: string; token: string; path: string; expiresAt: number }>

export const listInvites = (session: Session) =>
  request(`/api/rooms/${session.code}/invites`) as Promise<{ invites: Invite[] }>

export const revokeInvite = (session: Session, id: string) =>
  request(`/api/rooms/${session.code}/invites/${id}`, { method: 'DELETE' })

// The origin to put in an invite. Loopback-bound servers only answer on the
// address the host is already using; LAN or tunnel addresses only exist when the
// server is open to them.
export const inviteBase = async (session: Session) => {
  try {
    const result = await request(`/api/rooms/${session.code}/invite`)
    if (!result.local && Array.isArray(result.links) && result.links.length) return result.links[0] as string
  } catch {}
  return location.origin
}

export type Page = { slug: string; size: number; files: number; updatedAt: number }

export const listPages = (session: Session) => request('/api/pages') as Promise<{ pages: Page[] }>

export const publishPage = (session: Session, name: string) =>
  request('/api/pages', { method: 'POST', body: JSON.stringify({ name, from: 'workspace' }) }) as Promise<{ slug: string }>

export const deletePage = (session: Session, slug: string) => request(`/api/pages/${slug}`, { method: 'DELETE' })

export type Tool = { id: string; name: string; kind: string; package: string; bin: string; note: string; installed: boolean }

export const toolsList = (session: Session) => request(`/api/tools`) as Promise<{ tools: Tool[]; container: boolean }>

export const installTool = (session: Session, id: string) =>
  request('/api/tools/install', { method: 'POST', body: JSON.stringify({ id }) }) as Promise<{ ok: boolean; output: string }>

export const setKey = (session: Session, name: string, value: string) =>
  request('/api/keys', { method: 'POST', body: JSON.stringify({ name, value }) })

export const setRole = (session: Session, memberId: string, role: 'guest' | 'editor') =>
  request(`/api/rooms/${session.code}/members/${memberId}/role`, { method: 'POST', body: JSON.stringify({ role }) })

export type AuditEntry = { at: number; name: string; command: string; decision: 'ran' | 'asked' | 'allowed' | 'denied' | 'auto-expired' }

export const auditLog = (session: Session) => request(`/api/rooms/${session.code}/audit`) as Promise<{ entries: AuditEntry[] }>

export const exportUrl = (session: Session) => `/api/rooms/${session.code}/export`

export const kickMember = (session: Session, memberId: string) =>
  request(`/api/rooms/${session.code}/members/${memberId}`, { method: 'DELETE' }) as Promise<{ ok: boolean; name: string }>

export const endRoom = (session: Session) => request(`/api/rooms/${session.code}`, { method: 'DELETE' })

export const decideJoin = (session: Session, id: string, allow: boolean) =>
  request(`/api/joins/${id}`, { method: 'POST', body: JSON.stringify({ allow }) })

export const authStatus = (session: Session) =>
  request('/api/auth') as Promise<{ subscriptions: Array<{ id: string; name: string; signedIn: boolean; pending: boolean; models: number; error: string | null }> }>

export const authAction = (session: Session, body: Record<string, unknown>) =>
  request('/api/auth', { method: 'POST', body: JSON.stringify(body) }) as Promise<any>

export const wsUrl = (suffix: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${suffix}`
