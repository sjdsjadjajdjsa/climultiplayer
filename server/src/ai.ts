import { randomUUID } from 'node:crypto'
import { grokFetch, grokRequestHeaders, wireFor, type ChatBody } from './auth/wire.js'
import { SUBSCRIPTIONS, subscriptionById, type AuthStore } from './auth/subs.js'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type ChatChunk = { text?: string; reasoning?: string; done?: boolean; error?: string; usage?: { prompt: number; completion: number }; model?: string }

const endpoint = (id: string, apiBase: string, modelsQuery?: Record<string, string>) => {
  const query = modelsQuery ? `?${new URLSearchParams(modelsQuery)}` : ''
  if (id === 'chatgpt' || id === 'grok') return `${apiBase}/responses${query}`
  if (id === 'claude') return `${apiBase}/messages`
  return `${apiBase}/chat/completions`
}

const parseChunk = (line: string) => {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

// Streams one assistant reply using the caller's own signed-in plan. The
// caller receives plain text deltas; provider formats stay in here.
export async function* streamChat(store: AuthStore, memberId: string, body: ChatBody): AsyncGenerator<ChatChunk> {
  const candidates = SUBSCRIPTIONS.filter(sub => store.load()[sub.id]?.accessToken)
  if (!candidates.length) {
    yield { error: 'sign in to a plan first, the assistant runs on your own subscription' }
    return
  }
  const account = store.load()
  const wanted = candidates.find(sub => (account[sub.id]?.models ?? []).includes(body.model)) ?? candidates.find(sub => sub.id === memberId)
  const sub = wanted ?? candidates[0]
  if (!sub) {
    yield { error: 'sign in to a plan first' }
    return
  }
  const models = (account[sub.id]?.models ?? []).filter(Boolean)
  const model = models.includes(body.model) ? body.model : models[0] ?? sub.models[0]
  if (!model) {
    yield { error: `your ${sub.name} plan has no models available, sign in again` }
    return
  }

  let bearer: string
  try {
    bearer = await store.token(sub)
  } catch (error: any) {
    yield { error: error.message }
    return
  }

  const stored = account[sub.id] ?? {}
  const wire = wireFor(sub.wire)
  const payload = { ...body, model }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'climultiplayer/0.1',
    authorization: `Bearer ${bearer}`,
    ...(sub.apiHeaders ?? {}),
  }
  let outgoing: any = payload
  let url = endpoint(sub.id, sub.apiBase, sub.modelsQuery)

  if (wire) {
    outgoing = wire.to(payload)
    if (sub.wire === 'anthropic') {
      headers['x-client-request-id'] = randomUUID()
      // Claude Code sends a stable device and account identity; Anthropic
      // throttles OAuth requests that look like a bare browser.
      if (stored.sessionId) {
        outgoing.metadata = {
          user_id: JSON.stringify({ device_id: stored.deviceId, account_uuid: stored.accountUuid, session_id: stored.sessionId }),
        }
      }
    }
    if (sub.wire === 'grok') Object.assign(headers, grokRequestHeaders(payload, stored.sessionId))
  } else if (stored.accountId) {
    headers['chatgpt-account-id'] = stored.accountId
  }

  let upstream: Response
  try {
    upstream = await (sub.id === 'grok' ? grokFetch : fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(outgoing),
      signal: AbortSignal.timeout(180_000),
    })
  } catch (error: any) {
    yield { error: `could not reach ${sub.name}: ${error.message}` }
    return
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    yield { error: `${sub.name} answered ${upstream.status}${detail ? `: ${detail.slice(0, 300)}` : ''}` }
    return
  }

  const stream = wire ? new wire.Stream() : null
  const decoder = new TextDecoder()
  let buffer = ''
  let failed = false

  const drain = async function* (data: string): AsyncGenerator<ChatChunk> {
    buffer += data
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const event = parseChunk(line)
      if (!event) continue
      if (event.error) {
        yield { error: String(event.error.message ?? event.error) }
        return
      }
      const choice = event.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (delta.reasoning_content) yield { reasoning: delta.reasoning_content }
      if (delta.content) yield { text: delta.content }
      if (event.usage) yield { usage: { prompt: event.usage.prompt_tokens ?? 0, completion: event.usage.completion_tokens ?? 0 } }
    }
  }

  for await (const raw of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    const data = stream ? stream.write(raw) : decoder.decode(raw, { stream: true })
    for await (const part of drain(data)) {
      if (part.error) failed = true
      yield part
    }
    if (failed) break
  }
  if (stream && !stream.done) {
    for (const line of stream.write('\n').split('\n')) {
      const event = parseChunk(line)
      if (event?.error) yield { error: String(event.error.message ?? event.error) }
      if (event?.choices?.[0]?.delta?.content) yield { text: event.choices[0].delta.content }
    }
  }
  yield { done: true, model }
}

export const modelsFor = (store: AuthStore) =>
  SUBSCRIPTIONS.flatMap(sub => {
    const account = store.load()[sub.id]
    if (!account?.accessToken) return []
    return (account.models ?? []).map(model => ({ model, provider: sub.id, name: sub.name }))
  })

export { subscriptionById }
