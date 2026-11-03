// Wire adapters, ported from Prism (router/wire.mjs). The app speaks OpenAI
// chat completions internally; each subscription backend speaks something else.
import { createHash, randomUUID } from 'node:crypto'

type Content = any
type Message = { role: string; content?: Content; tool_calls?: any[]; tool_call_id?: string }
export type ChatBody = {
  model: string
  messages: Message[]
  tools?: any[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  reasoning_effort?: string
  parallel_tool_calls?: boolean
  tool_choice?: any
  stream?: boolean
}

const decode = new TextDecoder()

const text = (value: Content) => (Array.isArray(value) ? value.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n') : String(value ?? ''))

const images = (value: Content) =>
  (Array.isArray(value) ? value : [])
    .filter((part: any) => part?.type === 'image_url')
    .map((part: any) => /^data:([^;]+);base64,(.*)$/s.exec(part.image_url?.url ?? ''))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ url: match[0], type: match[1], data: match[2] }))

const callId = (id: unknown) => text(id as Content).split('~')[0]
const callSignature = (id: unknown) => text(id as Content).split('~').slice(1).join('~')

export const toCodex = (body: ChatBody) => {
  let instructions: string | undefined
  const input: any[] = []
  for (const message of body.messages ?? []) {
    if (message.role === 'system') {
      instructions = [instructions, text(message.content)].filter(Boolean).join('\n\n')
      continue
    }
    if (message.role === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: text(message.content) }, ...images(message.content).map(image => ({ type: 'input_image', image_url: image.url }))] })
    } else if (message.role === 'assistant') {
      if (text(message.content)) input.push({ role: 'assistant', content: [{ type: 'output_text', text: text(message.content) }] })
      for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: callId(call.id), name: call.function?.name, arguments: text(call.function?.arguments) })
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: callId(message.tool_call_id), output: text(message.content) })
    }
  }
  const out: any = { model: body.model, input, stream: true, store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium', summary: 'auto' } }
  if (instructions) out.instructions = instructions
  if (body.tools?.length) out.tools = body.tools.map(tool => ({ type: 'function', name: tool.function?.name, description: tool.function?.description, parameters: tool.function?.parameters, strict: false }))
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls
  return out
}

export const toGrok = (body: ChatBody) => {
  const out = toCodex(body)
  delete out.include
  delete out.reasoning
  if (body.reasoning_effort) out.reasoning = { effort: body.reasoning_effort }
  if (body.max_tokens) out.max_output_tokens = body.max_tokens
  for (const field of ['temperature', 'top_p', 'parallel_tool_calls']) {
    if ((body as any)[field] !== undefined) out[field] = (body as any)[field]
  }
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice?.type === 'function' ? { type: 'function', name: body.tool_choice.function?.name } : body.tool_choice
  return out
}

const chunk = (id: string, delta: any, finish: string | null = null, usage?: any) =>
  `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage && { usage }) })}\n\n`

export class CodexStream {
  buffer = ''
  calls = 0
  done = false
  private decoder = new TextDecoder()
  write(chunkData: Uint8Array | string) {
    this.buffer += typeof chunkData === 'string' ? chunkData : this.decoder.decode(chunkData, { stream: true })
    const out: string[] = []
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let event: any
      try {
        event = JSON.parse(payload)
      } catch {
        continue
      }
      const push = (delta: any) => out.push(chunk('chatcmpl-codex', delta))
      if (event.type === 'response.output_text.delta' && event.delta) push({ content: event.delta })
      else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
        push({ tool_calls: [{ index: this.calls++, id: event.item.call_id, type: 'function', function: { name: event.item.name, arguments: event.item.arguments ?? '' } }] })
      } else if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type) && !this.done) {
        const failed = event.type === 'response.failed' || event.type === 'error'
        if (failed) out.push(`data: ${JSON.stringify({ error: event.response?.error ?? event.error ?? { message: event.message ?? 'the request failed' } })}\n\n`)
        const usage = event.response?.usage ? { prompt_tokens: event.response.usage.input_tokens ?? 0, completion_tokens: event.response.usage.output_tokens ?? 0 } : undefined
        out.push(chunk('chatcmpl-codex', {}, event.type === 'response.incomplete' ? 'length' : failed ? 'stop' : this.calls ? 'tool_calls' : 'stop', usage))
        out.push('data: [DONE]\n\n')
        this.done = true
      }
    }
    return out.join('')
  }
}

export const toAnthropic = (body: ChatBody) => {
  const system: string[] = []
  const messages: any[] = []
  for (const message of body.messages ?? []) {
    if (message.role === 'system') {
      system.push(text(message.content))
      continue
    }
    if (message.role === 'user') {
      const pictures = images(message.content)
      messages.push({ role: 'user', content: pictures.length ? [...pictures.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } })), { type: 'text', text: text(message.content) }] : text(message.content) })
    } else if (message.role === 'assistant') {
      const content: any[] = []
      if (text(message.content)) content.push({ type: 'text', text: text(message.content) })
      for (const call of message.tool_calls ?? []) {
        let input: any = {}
        try {
          input = JSON.parse(text(call.function?.arguments) || '{}')
        } catch {}
        content.push({ type: 'tool_use', id: callId(call.id), name: call.function?.name, input })
      }
      messages.push({ role: 'assistant', content })
    } else if (message.role === 'tool') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: callId(message.tool_call_id), content: text(message.content) }] })
    }
  }
  const out: any = { model: body.model, max_tokens: body.max_tokens ?? 8192, messages, stream: true }
  out.system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, ...system.map(entry => ({ type: 'text', text: entry }))]
  if (body.tools?.length) out.tools = body.tools.map(tool => ({ name: tool.function?.name, description: tool.function?.description, input_schema: tool.function?.parameters }))
  return out
}

export class AnthropicStream {
  buffer = ''
  calls = 0
  done = false
  write(chunkData: Uint8Array | string) {
    this.buffer += typeof chunkData === 'string' ? chunkData : decode.decode(chunkData)
    const out: string[] = []
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let event: any
      try {
        event = JSON.parse(payload)
      } catch {
        continue
      }
      const push = (delta: any) => out.push(chunk('chatcmpl-claude', delta))
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') push({ content: event.delta.text })
      else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        push({ tool_calls: [{ index: this.calls++, id: event.content_block.id, type: 'function', function: { name: event.content_block.name, arguments: '' } }] })
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        push({ tool_calls: [{ index: Math.max(0, this.calls - 1), function: { arguments: event.delta.partial_json ?? '' } }] })
      } else if (event.type === 'message_delta') {
        const reason = event.delta?.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
        const usage = event.usage ? { prompt_tokens: event.usage.input_tokens ?? 0, completion_tokens: event.usage.output_tokens ?? 0 } : undefined
        out.push(chunk('chatcmpl-claude', {}, reason, usage))
        out.push('data: [DONE]\n\n')
        this.done = true
      }
    }
    return out.join('')
  }
}

export const toGemini = (body: ChatBody) => {
  const contents: any[] = []
  let system: string | undefined
  for (const message of body.messages ?? []) {
    if (message.role === 'system') {
      system = [system, text(message.content)].filter(Boolean).join('\n\n')
      continue
    }
    if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: text(message.content) }, ...images(message.content).map(image => ({ inlineData: { mimeType: image.type, data: image.data } }))] })
    } else if (message.role === 'assistant') {
      const parts: any[] = []
      if (text(message.content)) parts.push({ text: text(message.content) })
      contents.push({ role: 'model', parts })
    } else if (message.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { response: { result: text(message.content) } } }] })
    }
  }
  const out: any = { contents }
  if (system) out.systemInstruction = { parts: [{ text: system }] }
  if (body.tools?.length) out.tools = [{ functionDeclarations: body.tools.map(tool => ({ name: tool.function?.name, description: tool.function?.description, parameters: tool.function?.parameters })) }]
  return out
}

export class GeminiStream {
  buffer = ''
  calls = 0
  done = false
  write(chunkData: Uint8Array | string) {
    this.buffer += typeof chunkData === 'string' ? chunkData : decode.decode(chunkData)
    const out: string[] = []
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let event: any
      try {
        event = JSON.parse(payload)
      } catch {
        continue
      }
      const push = (delta: any) => out.push(chunk('chatcmpl-gemini', delta))
      const candidate = event.candidates?.[0] ?? {}
      for (const part of candidate.content?.parts ?? []) {
        if (part.text && part.thought) push({ reasoning_content: part.text })
        else if (part.text) push({ content: part.text })
        if (part.functionCall) push({ tool_calls: [{ index: this.calls++, id: part.functionCall.id || `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } }] })
      }
      if (event.usageMetadata) (this as any).usage = event.usageMetadata
      if (candidate.finishReason) out.push(this.finish())
    }
    return out.join('')
  }
  finish() {
    if (this.done) return ''
    const usage = (this as any).usage ? { prompt_tokens: (this as any).usage.promptTokenCount ?? 0, completion_tokens: (this as any).usage.candidatesTokenCount ?? 0 } : undefined
    this.done = true
    return chunk('chatcmpl-gemini', {}, this.calls ? 'tool_calls' : 'stop', usage) + 'data: [DONE]\n\n'
  }
}

export const stableSessionId = (request: any) => {
  for (const content of request.contents ?? []) {
    if (content.role !== 'user') continue
    const first = content.parts?.[0]?.text
    if (!first) continue
    const hash = createHash('sha256').update(first).digest()
    return `-${BigInt(`0x${hash.subarray(0, 8).toString('hex')}`) & 0x7fffffffffffffffn}`
  }
  return `-${Math.floor(Math.random() * 9_000_000_000_000_000_000)}`
}

const GROK_FALLBACK_VERSION = '1.0.46'

export const createGrokFetch = ({ fetcher = (...args: any[]) => fetch(args[0], args[1]), now = Date.now } = {}) => {
  let version = GROK_FALLBACK_VERSION
  let checkedAt = -Infinity
  let checking: Promise<string> | null = null
  const resolveVersion = async (force: boolean) => {
    if (checking) return checking
    if (!force && now() - checkedAt < 3 * 60 * 60_000) return version
    checkedAt = now()
    checking = (async () => {
      try {
        const res = await fetcher('https://registry.npmjs.org/@xai-official/grok/latest', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) return version
        const data = (await res.json()) as any
        if (/^\d+\.\d+\.\d+$/.test(data.version)) {
          const [major, minor, patch] = data.version.split('.').map(Number)
          if (major > 1 || (major === 1 && (minor > 0 || patch >= 13))) version = data.version
        }
      } catch {}
      return version
    })()
    try {
      return await checking
    } finally {
      checking = null
    }
  }
  return async (url: string, options: any = {}) => {
    const send = async (force: boolean) => {
      const current = await resolveVersion(force)
      const headers = new Headers(options.headers)
      headers.set('x-xai-token-auth', 'xai-grok-cli')
      headers.set('x-grok-client-identifier', 'grok-shell')
      headers.set('x-authenticateresponse', 'authenticate-response')
      headers.set('x-grok-client-version', current)
      headers.set('user-agent', `xai-grok-workspace/${current}`)
      return fetcher(url, { ...options, headers })
    }
    let response = await send(false)
    if (response.status === 426) {
      await response.body?.cancel()
      response = await send(true)
    }
    return response
  }
}

export const grokFetch = createGrokFetch()

export const grokRequestHeaders = (body: ChatBody, sessionId?: string) => {
  const seed = JSON.stringify([sessionId, body.messages?.find(message => message.role === 'user') ?? null])
  const hex = createHash('sha256').update(seed).digest('hex')
  const convId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  return {
    accept: 'text/event-stream',
    'x-grok-session-id': sessionId ?? '',
    'x-grok-conv-id': convId,
    'x-grok-req-id': randomUUID(),
    'x-grok-model-override': body.model,
    'x-grok-agent-id': convId,
  }
}

export const wireFor = (name?: string) =>
  ({
    codex: { to: toCodex, Stream: CodexStream },
    grok: { to: toGrok, Stream: CodexStream },
    anthropic: { to: toAnthropic, Stream: AnthropicStream },
    gemini: { to: toGemini, Stream: GeminiStream },
  } as Record<string, { to: (body: ChatBody) => any; Stream: new () => { write: (data: any) => string; done: boolean } }>)[name ?? ''] ?? null
