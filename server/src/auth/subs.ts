// Subscription sign-in, ported from Prism (router/subs.mjs). Each room member
// gets their own store, so an AI call bills the person who asked for it.
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { port } from '../config.js'
import { grokFetch, grokRequestHeaders } from './wire.js'

export type Subscription = {
  id: string
  name: string
  kind?: 'browser' | 'device'
  deviceURL?: string
  tokenURL: string
  clientID: string
  clientSecret?: string
  authorizeURL?: string
  discoveryURL?: string
  redirectPort?: number
  redirectHost?: string
  redirectPath?: string
  scopes?: string
  extraAuth?: Record<string, string>
  stateInExchange?: boolean
  apiBase: string
  wire?: string
  apiHeaders?: Record<string, string>
  apiUserAgent?: string
  modelsQuery?: Record<string, string>
  onboard?: boolean
  exchangeURL?: string
  models: string[]
}

export const SUBSCRIPTIONS: Subscription[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT (Codex)',
    kind: 'browser',
    authorizeURL: 'https://auth.openai.com/oauth/authorize',
    tokenURL: 'https://auth.openai.com/oauth/token',
    clientID: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirectPort: 1455,
    redirectPath: '/auth/callback',
    scopes: 'openid profile email offline_access',
    extraAuth: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true' },
    apiBase: 'https://chatgpt.com/backend-api/codex',
    wire: 'codex',
    apiHeaders: { 'OpenAI-Beta': 'responses=experimental', originator: 'codex_cli_rs' },
    apiUserAgent: 'codex_cli_rs/0.175.0',
    modelsQuery: { client_version: '0.175.0' },
    models: ['gpt-6.1-sol', 'gpt-6-luna'],
  },
  {
    id: 'claude',
    name: 'Claude',
    kind: 'browser',
    authorizeURL: 'https://claude.ai/oauth/authorize',
    tokenURL: 'https://platform.claude.com/v1/oauth/token',
    clientID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    redirectPath: '/callback',
    scopes: 'user:inference user:profile user:sessions:claude_code',
    stateInExchange: true,
    apiBase: 'https://api.anthropic.com/v1',
    wire: 'anthropic',
    apiHeaders: {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
    },
    apiUserAgent: 'claude-cli/2.1.280 (external, cli)',
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  },
  {
    id: 'grok',
    name: 'Grok (xAI)',
    kind: 'device',
    discoveryURL: 'https://auth.x.ai/.well-known/openid-configuration',
    authorizeURL: 'https://auth.x.ai/oauth2/authorize',
    tokenURL: 'https://auth.x.ai/oauth2/token',
    deviceURL: 'https://auth.x.ai/oauth2/device/code',
    clientID: 'b1a00492-073a-47ea-816f-4c329264a828',
    redirectPort: 56121,
    redirectHost: '127.0.0.1',
    redirectPath: '/callback',
    scopes: 'openid profile email offline_access grok-cli:access api:access',
    apiBase: 'https://cli-chat-proxy.grok.com/v1',
    wire: 'grok',
    models: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    kind: 'device',
    deviceURL: 'https://github.com/login/device/code',
    tokenURL: 'https://github.com/login/oauth/access_token',
    clientID: 'Iv1.b507a08c87ecfe98',
    exchangeURL: 'https://api.github.com/copilot_internal/v2/token',
    apiBase: 'https://api.githubcopilot.com',
    models: [],
  },
]

export type StoredAccount = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenURL?: string
  scopes?: string
  accountId?: string
  deviceId?: string
  accountUuid?: string
  sessionId?: string
  models?: string[]
  loginError?: string
}

const HIDDEN: Record<string, RegExp[]> = {
  all: [/embed|whisper|tts|transcri|rerank|moderat|dall-e|image|voice|guard|audio|realtime|search-preview/i],
  chatgpt: [/^codex-auto-review$/, /^gpt-reserve$/, /^gpt-[1-4]/, /^o\d/],
  claude: [/-20\d{6}$/, /^claude-[0-3]-/, /^claude-haiku-4/],
  grok: [/^grok-[0-2]/, /video/i],
  copilot: [/^gpt-3/, /^gpt-4(?!\.1)/, /^o1/, /^text-/, /^copilot-/],
}

export const visibleModels = (id: string, list?: string[]) =>
  (list ?? []).filter(name => ![...HIDDEN.all, ...(HIDDEN[id] ?? [])].some(rule => rule.test(name)))

const GROK_CONSENT_ERROR = 'sign in to Grok again to let this app use your Grok plan'

export const subscriptionById = (id: string) => SUBSCRIPTIONS.find(sub => sub.id === id)

type PendingDevice = { deviceCode: string; tokenURL?: string; interval: number; until: number; generation: number }
type PendingBrowser = {
  sub: Subscription
  generation: number
  verifier: string
  state: string
  redirectURI: string
  url: string
  until: number
  server: Server | null
  cancelled: boolean
  usesAppPort: boolean
}

const escapeHTML = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const loginPage = (ok: boolean, message: string) =>
  `<html><body style="font-family:sans-serif;background:#16161e;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><p>${ok ? 'signed in, you can close this tab' : `sign-in failed: ${escapeHTML(message)}`}</p></body></html>`

export const createAuthStore = (file: string) => {
  const pending = new Map<string, PendingDevice>()
  const browserPending = new Map<string, PendingBrowser>()
  const generations = new Map<string, number>()
  const finishing = new Map<string, PendingBrowser>()
  const errors = new Map<string, string>()
  const apiTokens = new Map<string, { token: string; expiresAt: number }>()
  let cache = { stamp: '', data: {} as Record<string, StoredAccount> }

  const load = (): Record<string, StoredAccount> => {
    let stamp = 'missing'
    try {
      const info = statSync(file)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {}
    if (cache.stamp !== stamp) {
      let data: Record<string, StoredAccount> = {}
      if (stamp !== 'missing') {
        try {
          const parsed = JSON.parse(readFileSync(file, 'utf8'))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
        } catch {}
      }
      cache = { stamp, data }
    }
    return cache.data
  }

  const save = (data: Record<string, StoredAccount>) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {}
    cache = { stamp: '', data }
  }

  const needsConsent = (id: string) => {
    const account = load()[id]
    if (id !== 'grok' || !account?.accessToken) return false
    const scopes = Array.isArray(account.scopes) ? account.scopes : String(account.scopes ?? '').split(/\s+/)
    return !scopes.includes('grok-cli:access')
  }

  const cancel = (id: string) => {
    generations.set(id, (generations.get(id) ?? 0) + 1)
    for (const entry of browserPending.values()) if (entry.sub.id === id) closeBrowser(entry)
    pending.delete(id)
    finishing.delete(id)
    apiTokens.delete(id)
    return generations.get(id)!
  }

  const refresh = async (sub: Subscription) => {
    const generation = generations.get(sub.id)
    const stored = load()[sub.id]
    if (!stored?.refreshToken) throw new Error(`${sub.id} sign-in expired, sign in again`)
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: sub.clientID })
    if (sub.clientSecret) body.set('client_secret', sub.clientSecret)
    const res = await fetch(stored.tokenURL ?? sub.tokenURL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${sub.id} sign-in expired (${res.status}), sign in again`)
    const data = (await res.json()) as any
    if (!data?.access_token) throw new Error(`${sub.id} did not return a token`)
    const fresh: StoredAccount = {
      ...stored,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? stored.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
    if (generations.get(sub.id) !== generation) throw new Error('the sign-in was cancelled')
    save({ ...load(), [sub.id]: fresh })
    return fresh
  }

  // The bearer token for an account, refreshed when it is nearly expired.
  const token = async (sub: Subscription) => {
    const stored = load()[sub.id]
    if (!stored?.accessToken) throw new Error(`not signed in to ${sub.id}`)
    if (needsConsent(sub.id)) throw new Error(GROK_CONSENT_ERROR)
    if (sub.id === 'grok' && !stored.sessionId) {
      stored.sessionId = randomUUID()
      save({ ...load(), [sub.id]: stored })
    }
    if (sub.kind === 'browser' || sub.id === 'grok') {
      if (!stored.expiresAt || stored.expiresAt > Date.now() + 120_000) return stored.accessToken
      const fresh = await refresh(sub)
      return fresh.accessToken
    }
    const cached = apiTokens.get(sub.id)
    if (cached && cached.expiresAt > Date.now() + 120_000) return cached.token
    const res = await fetch(sub.exchangeURL!, {
      headers: { authorization: `Bearer ${stored.accessToken}`, accept: 'application/json', 'user-agent': sub.apiUserAgent ?? 'climultiplayer' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${sub.id} sign-in expired (${res.status}), sign in again`)
    const data = (await res.json()) as any
    if (!data?.token) throw new Error(`${sub.id} did not return an API token`)
    apiTokens.set(sub.id, { token: data.token, expiresAt: (data.expires_at ?? Date.now() / 1000 + 60) * 1000 })
    return data.token as string
  }

  const status = (sub: Subscription) => {
    for (const entry of browserPending.values()) if (Date.now() >= entry.until) expireBrowser(entry)
    if (pending.has(sub.id) && Date.now() >= pending.get(sub.id)!.until) {
      pending.delete(sub.id)
      errors.set(sub.id, 'the code expired, start again')
    }
    const waiting = pending.has(sub.id) || [...browserPending.values()].some(entry => entry.sub.id === sub.id)
    return {
      id: sub.id,
      name: sub.name,
      signedIn: !waiting && !finishing.has(sub.id) && !needsConsent(sub.id) && Boolean(load()[sub.id]?.accessToken),
      pending: waiting,
      finishing: finishing.has(sub.id),
      models: visibleModels(sub.id, load()[sub.id]?.models).length,
      error: needsConsent(sub.id) ? GROK_CONSENT_ERROR : errors.get(sub.id) ?? load()[sub.id]?.loginError ?? null,
    }
  }

  const statuses = () => SUBSCRIPTIONS.map(status)

  const closeBrowser = (entry: PendingBrowser) => {
    entry.cancelled = true
    entry.server?.close()
    entry.server = null
    if (browserPending.get(entry.state) === entry) browserPending.delete(entry.state)
  }

  const expireBrowser = (entry: PendingBrowser) => {
    if (browserPending.get(entry.state) !== entry) return
    errors.set(entry.sub.id, 'the sign-in timed out, start again')
    closeBrowser(entry)
  }

  const buildAuthorize = (sub: Subscription, redirectURI: string, state: string, challenge: string) => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: sub.clientID,
      redirect_uri: redirectURI,
      scope: sub.scopes ?? '',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(sub.extraAuth ?? {}),
    })
    return `${sub.authorizeURL}?${params}`
  }

  const startBrowser = async (sub: Subscription) => {
    const generation = cancel(sub.id)
    errors.delete(sub.id)
    const verifier = randomUUID() + randomUUID()
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomUUID()
    const callbackHost = sub.redirectHost ?? 'localhost'
    // Same redirect shape prism uses. If the vendor's fixed port is taken (prism
    // itself holds 1455), fall back to this app's port so sign-in still works,
    // since the callback route serves the same path.
    let redirectURI = `http://${callbackHost}:${sub.redirectPort || port}${sub.redirectPath}`
    const entry: PendingBrowser = {
      sub,
      generation,
      verifier,
      state,
      redirectURI,
      url: buildAuthorize(sub, redirectURI, state, challenge),
      until: Date.now() + 10 * 60_000,
      server: null,
      cancelled: false,
      usesAppPort: !sub.redirectPort,
    }
    browserPending.set(state, entry)

    if (sub.redirectPort) {
      const server = createServer(async (req, res) => {
        // Only loopback callbacks count, the same guard prism uses.
        const requestHost = String(req.headers.host ?? '').split(':')[0].toLowerCase()
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(requestHost)) {
          res.writeHead(403)
          return res.end('only local callbacks are accepted')
        }
        res.setHeader('x-content-type-options', 'nosniff')
        const requestURL = new URL(req.url ?? '/', 'http://localhost')
        if (requestURL.pathname !== sub.redirectPath) {
          res.writeHead(404)
          return res.end()
        }
        const result = await finishSafely(sub, requestURL)
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(loginPage(!result?.error, result?.error ?? ''))
      })
      entry.server = server
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(sub.redirectPort, sub.redirectHost ?? '127.0.0.1', resolve)
        })
      } catch (error: any) {
        server.close()
        entry.server = null
        if (error?.code === 'EADDRINUSE') {
          redirectURI = `http://${callbackHost}:${port}${sub.redirectPath}`
          entry.redirectURI = redirectURI
          entry.usesAppPort = true
          entry.url = buildAuthorize(sub, redirectURI, state, challenge)
        } else {
          closeBrowser(entry)
          const message = `could not start the sign-in: ${error.message}`
          errors.set(sub.id, message)
          return { error: message }
        }
      }
      setTimeout(() => expireBrowser(entry), 10 * 60_000).unref?.()
    }
    return { url: entry.url, state, expires: 600 }
  }

  const finishSafely = async (sub: Subscription, url: URL) => {
    try {
      return await finishBrowser(url.searchParams.get('code'), url.searchParams.get('state'), true)
    } catch (error: any) {
      const message = `sign-in could not be saved: ${error.message}`
      errors.set(sub.id, message)
      return { error: message }
    }
  }

  // Kept for the manual "paste the redirected URL or code" path.
  const submitCode = async (sub: Subscription, input: string) => {
    const invalid = 'that code did not work, copy it again'
    const entry = [...browserPending.values()].find(candidate => candidate.sub.id === sub.id)
    if (!entry) return { error: load()[sub.id]?.accessToken ? `already signed in to ${sub.id}` : `no sign-in is waiting for ${sub.id}` }
    const text = String(input ?? '').trim()
    let code: string | null = text
    let state: string | null = null
    try {
      const url = new URL(text)
      code = url.searchParams.get('code')
      state = url.searchParams.get('state')
    } catch {
      const split = text.indexOf('#')
      if (split >= 0) {
        code = text.slice(0, split)
        state = text.slice(split + 1)
      }
    }
    if (!code || (state !== null && state !== entry.state)) return { error: invalid }
    return finishBrowser(code, entry.state, true)
  }

  const finishBrowser = async (code: string | null, state: string | null, retry = false) => {
    const entry = state ? browserPending.get(state) : undefined
    if (!entry || !code || entry.cancelled) {
      if (entry) closeBrowser(entry)
      return { error: 'the sign-in was cancelled' }
    }
    const sub = entry.sub
    const current = () => !entry.cancelled && Date.now() < entry.until && generations.get(sub.id) === entry.generation
    finishing.set(sub.id, entry)
    let completed = false
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: entry.redirectURI,
        client_id: sub.clientID,
        code_verifier: entry.verifier,
      })
      if (sub.clientSecret) body.set('client_secret', sub.clientSecret)
      if (sub.stateInExchange) body.set('state', entry.state)
      const res = await fetch(sub.tokenURL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(sub.apiUserAgent && { 'user-agent': sub.apiUserAgent }) },
        body,
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const message = `${sub.name} refused the sign-in (${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`
        errors.set(sub.id, message)
        return { error: message }
      }
      const data = (await res.json()) as any
      if (data.error || !data.access_token) {
        const message = data.error_description ?? data.error ?? `${sub.name} returned no access token`
        errors.set(sub.id, message)
        return { error: message }
      }
      if (!current()) return { error: 'the sign-in was cancelled' }
      errors.delete(sub.id)
      const account: StoredAccount = {
        accessToken: data.access_token,
        scopes: data.scope ?? sub.scopes,
        tokenURL: sub.tokenURL,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
        accountId: accountIdOf(data.id_token),
        accountUuid: accountUuidOf(data.id_token) ?? randomUUID(),
        deviceId: randomUUID(),
        sessionId: randomUUID(),
        models: [],
      }
      save({ ...load(), [sub.id]: account })
      const models = await probe(sub)
      if (!current()) return { error: 'the sign-in was cancelled' }
      const list = models.models?.length ? models.models : sub.models
      save({ ...load(), [sub.id]: { ...account, models: list } })
      completed = true
      return { ok: true, models: visibleModels(sub.id, list), note: models.error }
    } finally {
      if (!retry || completed || !current()) closeBrowser(entry)
      if (finishing.get(sub.id) === entry) finishing.delete(sub.id)
    }
  }

  const accountUuidOf = (idToken?: string) => {
    if (!idToken) return undefined
    try {
      const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
      return claims['https://api.anthropic.com/auth']?.account_uuid ?? claims.account_uuid
    } catch {
      return undefined
    }
  }

  const accountIdOf = (idToken?: string) => {
    if (!idToken) return undefined
    try {
      const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
      return claims['https://api.openai.com/auth']?.chatgpt_account_id ?? claims.chatgpt_account_id
    } catch {
      return undefined
    }
  }

  const startDevice = async (sub: Subscription) => {
    const generation = cancel(sub.id)
    errors.delete(sub.id)
    let deviceURL = sub.deviceURL!
    let tokenURL = sub.tokenURL
    if (sub.id === 'grok' && sub.discoveryURL) {
      try {
        const discovery = await fetch(sub.discoveryURL, { signal: AbortSignal.timeout(10_000) })
        if (discovery.ok) {
          const data = (await discovery.json()) as any
          deviceURL = data.device_authorization_endpoint ?? deviceURL
          tokenURL = data.token_endpoint ?? tokenURL
        }
      } catch {}
    }
    const params = { client_id: sub.clientID, ...(sub.scopes && { scope: sub.scopes }) }
    let res: Response
    try {
      res = await fetch(deviceURL, {
        method: 'POST',
        headers: { 'content-type': sub.id === 'grok' ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json', 'user-agent': 'climultiplayer' },
        body: sub.id === 'grok' ? new URLSearchParams(params) : JSON.stringify(params),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      return { error: `could not reach ${sub.name}` }
    }
    if (!res.ok) return { error: `could not reach ${sub.name} (${res.status})` }
    const data = (await res.json().catch(() => ({}))) as any
    if (data.error) return { error: data.error_description ?? data.error }
    if (generations.get(sub.id) !== generation) return { error: 'the sign-in was cancelled' }
    const expires = Math.min(data.expires_in ?? 900, 1800)
    pending.set(sub.id, { deviceCode: data.device_code, tokenURL, interval: data.interval ?? 5, until: Date.now() + expires * 1000, generation })
    return { userCode: data.user_code, verificationURI: data.verification_uri_complete ?? data.verification_uri, expires }
  }

  const pollDevice = async (sub: Subscription) => {
    const state = pending.get(sub.id)
    if (!state) return { status: 'idle' as const }
    if (Date.now() > state.until) {
      pending.delete(sub.id)
      return { status: 'error' as const, message: 'the code expired, start again' }
    }
    const params = { client_id: sub.clientID, device_code: state.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }
    let res: Response
    try {
      res = await fetch(state.tokenURL ?? sub.tokenURL, {
        method: 'POST',
        headers: { 'content-type': sub.id === 'grok' ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json', 'user-agent': 'climultiplayer' },
        body: sub.id === 'grok' ? new URLSearchParams(params) : JSON.stringify(params),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      return { status: 'error' as const, message: `could not reach ${sub.name}` }
    }
    const data = (await res.json().catch(() => ({}))) as any
    if (generations.get(sub.id) !== state.generation) return { status: 'cancelled' as const }
    if (data.error === 'authorization_pending') return { status: 'pending' as const, interval: state.interval }
    if (data.error === 'slow_down') {
      state.interval += 5
      return { status: 'pending' as const, interval: state.interval }
    }
    if (data.error || !data.access_token) {
      pending.delete(sub.id)
      return { status: 'error' as const, message: data.error_description ?? data.error ?? 'no token returned' }
    }
    pending.delete(sub.id)
    save({ ...load(), [sub.id]: { accessToken: data.access_token, scopes: data.scope ?? sub.scopes, models: [], refreshToken: data.refresh_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000, sessionId: randomUUID() } })
    const models = await probe(sub)
    const list = models.models?.length ? models.models : sub.models
    save({ ...load(), [sub.id]: { ...load()[sub.id], models: list } })
    return { status: 'ok' as const, models: visibleModels(sub.id, list), note: models.error }
  }

  const probe = async (sub: Subscription): Promise<{ models?: string[]; error?: string }> => {
    try {
      const bearer = await token(sub)
      const stored = load()[sub.id] ?? ({} as StoredAccount)
      const res = await (sub.id === 'grok' ? grokFetch : fetch)(`${sub.apiBase}/models${sub.modelsQuery ? `?${new URLSearchParams(sub.modelsQuery)}` : ''}`, {
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          'user-agent': sub.apiUserAgent ?? 'climultiplayer',
          ...(sub.apiHeaders ?? {}),
          ...(sub.id === 'grok' && grokRequestHeaders({} as any, stored.sessionId)),
          ...(stored.accountId && { 'chatgpt-account-id': stored.accountId }),
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return { error: `the service answered ${res.status}` }
      const data = (await res.json()) as any
      const lists = Array.isArray(data) ? [data] : [data.models, data.data, data.items].filter(Array.isArray)
      const ids: string[] = []
      for (const list of lists) {
        for (const item of list) {
          const id = typeof item === 'string' ? item : String(item?.slug ?? item?.id ?? item?.name ?? '')
          if (id.trim()) ids.push(id.trim())
        }
      }
      const chat = ids.filter(id => !/embed|whisper|tts|transcri|rerank|moderat|dall-e|image|video|voice|guard/i.test(id))
      return chat.length ? { models: [...new Set(chat)].slice(0, 300) } : { error: 'the service listed no chat models' }
    } catch (error: any) {
      return { error: error.message }
    }
  }

  const signOut = (sub: Subscription) => {
    cancel(sub.id)
    const data = { ...load() }
    delete data[sub.id]
    apiTokens.delete(sub.id)
    errors.delete(sub.id)
    save(data)
  }

  const callbackPaths = new Set(SUBSCRIPTIONS.map(sub => sub.redirectPath).filter(Boolean) as string[])

  // Callback for providers that share the app port (Claude). Returns false when
  // the path is not a redirect we know.
  const handleCallback = async (url: URL, res: import('node:http').ServerResponse) => {
    for (const entry of browserPending.values()) {
      if (!entry.usesAppPort || url.pathname !== entry.sub.redirectPath) continue
      const result = await finishSafely(entry.sub, url)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(loginPage(!result?.error, result?.error ?? ''))
      return true
    }
    return false
  }

  return { file, load, token, status, statuses, startBrowser, startDevice, pollDevice, submitCode, handleCallback, signOut, callbackPaths, visibleModels }
}

export type AuthStore = ReturnType<typeof createAuthStore>
