export const sessionCookie = 'climp'

// The cookie is `<room code>.<member token>`, so the code travels with it.
// Cookies are shared across ports on one host, so a previewed app (served on the
// preview port) could plant a second `climp` cookie with a narrower path to pin
// a visitor to someone else's session. Two of the same name: trust neither.
export const cookieValue = (req: any, name: string) => {
  const found: string[] = []
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) found.push(trimmed.slice(name.length + 1))
  }
  if (found.length !== 1) return ''
  try {
    return decodeURIComponent(found[0])
  } catch {
    return ''
  }
}

export const cookieSession = (req: any) => {
  const raw = cookieValue(req, sessionCookie)
  const split = raw.indexOf('.')
  if (split < 0) return { code: '', token: '' }
  return { code: raw.slice(0, split), token: raw.slice(split + 1) }
}

// Header wins (tests, CLI); the cookie carries browsers, including the WS
// handshake, so tokens never appear in websocket URLs or access logs.
export const requestToken = (req: any) => {
  const header = req.headers?.['x-climp-token']
  if (header) return String(header)
  return cookieSession(req).token
}

export const cookieHeader = (code: string, token: string, secure: boolean) =>
  `${sessionCookie}=${encodeURIComponent(`${code}.${token}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`

export const clearedCookie = `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
