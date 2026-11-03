import { afterEach, describe, expect, it, vi } from 'vitest'

let app: any
afterEach(async () => {
  await app?.close()
  vi.unstubAllEnvs()
})

const boot = async (bind: string) => {
  vi.stubEnv('HOST', bind)
  vi.resetModules()
  const { buildServer } = await import('../src/server.js')
  app = await buildServer()
  const created = await app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'host' } })
  const room = created.json()
  return room as { code: string; token: string }
}

describe('invite base', () => {
  it('reports local and no links when bound to loopback', async () => {
    const room = await boot('127.0.0.1')
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.code}/invite`, headers: { 'x-climp-token': room.token } })
    const body = res.json()
    expect(body.local).toBe(true)
    expect(body.links).toEqual([])
  })

  it('offers links and says it is not local when open to the network', async () => {
    const room = await boot('0.0.0.0')
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.code}/invite`, headers: { 'x-climp-token': room.token } })
    const body = res.json()
    expect(body.local).toBe(false)
    expect(body.links.every((link: string) => link.startsWith('http://'))).toBe(true)
  })
})
