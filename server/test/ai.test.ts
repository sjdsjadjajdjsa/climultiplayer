import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelsFor, streamChat } from '../src/ai.js'

const account = (overrides: Record<string, any> = {}) => ({
  claude: { accessToken: 'token', expiresAt: Date.now() + 600_000, models: ['claude-sonnet-5-5'], ...overrides },
})

const store = (data: Record<string, any>) => ({ load: () => data, token: async () => 'token' }) as any

const sse = (events: any[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 })

const collect = async (iterator: AsyncGenerator<any>) => {
  const out: any[] = []
  for await (const part of iterator) out.push(part)
  return out
}

afterEach(() => vi.unstubAllGlobals())

describe('streamChat', () => {
  it('tells the caller to sign in when nothing is connected', async () => {
    const parts = await collect(streamChat(store({}), 'm1', { model: '', messages: [{ role: 'user', content: 'hi' }] }))
    expect(parts[0].error).toMatch(/sign in/)
  })

  it('streams text from the caller own plan through the anthropic wire', async () => {
    const requests: any[] = []
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return sse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 2 } },
      ])
    })
    const parts = await collect(streamChat(store(account()), 'm1', { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }))
    expect(parts.filter(part => part.text).map(part => part.text).join('')).toBe('hello world')
    expect(parts.at(-1)?.done).toBe(true)
    expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0].body.messages[0].content).toBe('hi')
  })

  it('falls back to the plan first model when the asked one is unknown', async () => {
    let sent: any
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      sent = JSON.parse(init.body)
      return sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }])
    })
    await collect(streamChat(store(account()), 'm1', { model: 'made-up', messages: [{ role: 'user', content: 'hi' }] }))
    expect(sent.model).toBe('claude-sonnet-5-5')
  })

  it('surfaces a provider refusal as an error', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }))
    const parts = await collect(streamChat(store(account()), 'm1', { model: '', messages: [{ role: 'user', content: 'hi' }] }))
    expect(parts[0].error).toMatch(/401/)
  })

  it('lists only models from connected plans', () => {
    expect(modelsFor(store(account())).map(entry => entry.model)).toEqual(['claude-sonnet-5-5'])
    expect(modelsFor(store({}))).toEqual([])
  })
})
