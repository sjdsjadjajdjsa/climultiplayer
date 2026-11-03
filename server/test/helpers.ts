import type { FastifyInstance } from 'fastify'

export const createRoom = async (app: FastifyInstance, name = 'host') => {
  const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { name } })
  return res.json() as { code: string; token: string; member: { id: string; role: string } }
}

export const invite = async (app: FastifyInstance, code: string, token: string) => {
  const res = await app.inject({ method: 'POST', url: `/api/rooms/${code}/invites`, headers: { 'x-climp-token': token }, payload: { minutes: 60 } })
  return res.json() as { id: string; token: string; path: string }
}

// Full join: request, host approval, then the member token.
export const join = async (app: FastifyInstance, code: string, hostToken: string, name = 'friend', inviteToken?: string) => {
  const created = inviteToken ? { token: inviteToken } : await invite(app, code, hostToken)
  const requested = await app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, payload: { name, invite: created.token } })
  const request = requested.json()
  await app.inject({ method: 'POST', url: `/api/joins/${request.request.id}`, headers: { 'x-climp-token': hostToken }, payload: { allow: true } })
  const polled = await app.inject({ method: 'GET', url: `/api/joins/${request.request.id}?code=${code}&t=${encodeURIComponent(request.request.token)}` })
  return { ...polled.json(), requestId: request.request.id, inviteToken: created.token }
}
