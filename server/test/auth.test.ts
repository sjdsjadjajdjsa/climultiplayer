import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthStore, SUBSCRIPTIONS, type Subscription } from '../src/auth/subs.js'

const provider: Subscription = {
  id: 'claude',
  name: 'Claude',
  kind: 'browser',
  deviceURL: 'https://auth.test/device',
  tokenURL: 'https://auth.test/token',
  clientID: 'client',
  apiBase: 'https://api.test/v1',
  models: [],
}

const file = async () => join(await mkdtemp(join(tmpdir(), 'climp-auth-')), 'subs.json')

afterEach(() => vi.unstubAllGlobals())

describe('subscription store', () => {
  it('stores an account from a device sign-in and probes its models', async () => {
    const store = createAuthStore(await file())
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('/device')) return new Response(JSON.stringify({ device_code: 'dev', user_code: 'ABCD', verification_uri: 'https://auth.test/verify', interval: 1 }))
      if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }))
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-4' }] }))
      return new Response('{}', { status: 404 })
    })

    const started = await store.startDevice(provider)
    expect(started.userCode).toBe('ABCD')
    const result = await store.pollDevice(provider)
    expect(result.status).toBe('ok')
    expect(result.models).toEqual(['claude-sonnet-5-5'])
    expect(store.status(provider).signedIn).toBe(true)
    expect(await store.token(provider)).toBe('access-1')
    expect(calls.some(url => url.includes('/models'))).toBe(true)
  })

  it('refreshes an expired token instead of failing', async () => {
    const store = createAuthStore(await file())
    const stored = { claude: { accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000, tokenURL: provider.tokenURL } }
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }))
      return new Response('{}', { status: 404 })
    })
    const { writeFile } = await import('node:fs/promises')
    await writeFile((store as any).file, JSON.stringify(stored))
    expect(await store.token(provider)).toBe('fresh')
    const saved = JSON.parse(await readFile((store as any).file, 'utf8'))
    expect(saved.claude.accessToken).toBe('fresh')
    expect(saved.claude.refreshToken).toBe('refresh-1')
  })

  it('says clearly when nobody is signed in', async () => {
    const store = createAuthStore(await file())
    await expect(store.token(provider)).rejects.toThrow(/not signed in/)
  })

  it('signs out and forgets the account', async () => {
    const store = createAuthStore(await file())
    const { writeFile } = await import('node:fs/promises')
    await writeFile((store as any).file, JSON.stringify({ claude: { accessToken: 'a', expiresAt: Date.now() + 100000 } }))
    expect(store.status(provider).signedIn).toBe(true)
    store.signOut(provider)
    expect(store.status(provider).signedIn).toBe(false)
  })

  it('keeps separate stores apart', async () => {
    const first = createAuthStore(await file())
    const second = createAuthStore(await file())
    const { writeFile } = await import('node:fs/promises')
    await writeFile((first as any).file, JSON.stringify({ claude: { accessToken: 'a', expiresAt: Date.now() + 100000 } }))
    expect(first.status(provider).signedIn).toBe(true)
    expect(second.status(provider).signedIn).toBe(false)
  })
})

describe('authorize urls', () => {
  it('builds a full loopback redirect and codex flags for chatgpt', async () => {
    const store = createAuthStore(await file())
    const sub = SUBSCRIPTIONS.find(entry => entry.id === 'chatgpt')!
    const started = await store.startBrowser(sub)
    const url = new URL(started.url!)
    expect(url.origin).toBe('https://auth.openai.com')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/)
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('falls back to the app port when the fixed port is taken', async () => {
    const sub = SUBSCRIPTIONS.find(entry => entry.id === 'chatgpt')!
    const first = await createAuthStore(await file()).startBrowser(sub)
    const second = await createAuthStore(await file()).startBrowser(sub)
    expect(second.error).toBeUndefined()
    const redirect = new URL(second.url!).searchParams.get('redirect_uri')!
    expect(redirect).toContain('/auth/callback')
    expect(redirect).not.toContain(':1455')
    expect(new URL(first.url!).searchParams.get('redirect_uri')).toContain('/auth/callback')
  })

  it('keeps claude on the app port with its own callback path', async () => {
    const store = createAuthStore(await file())
    const sub = SUBSCRIPTIONS.find(entry => entry.id === 'claude')!
    const started = await store.startBrowser(sub)
    const url = new URL(started.url!)
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/)
    expect(url.searchParams.get('state')).toBeTruthy()
  })
})
