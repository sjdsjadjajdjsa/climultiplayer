import { useEffect, useRef, useState } from 'react'
import type { Session } from './api'
import { parseEdits, withoutEdits } from './edits'

export type ChatModel = { model: string; provider: string; name: string }

type Message = { id: string; role: 'user' | 'assistant'; text: string; model?: string; streaming?: boolean; error?: string; edits?: ReturnType<typeof parseEdits>; applied?: string }

type Props = {
  session: Session
  models: ChatModel[]
  model: string
  onModel: (model: string) => void
  send: (data: unknown) => void
  register: (handler: (message: any) => void) => () => void
  file: string | null
  selection: string
}

export const Chat = ({ session, models, model, onModel, send, register, file, selection }: Props) => {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const streamingId = useRef<string | null>(null)

  useEffect(() => {
    const off = register((message: any) => {
      if (message.type === 'chat:start') {
        streamingId.current = message.id
        setMessages(current => [...current, { id: message.id, role: 'assistant', text: '', streaming: true }])
      }
      if (message.type === 'chat:delta') {
        setMessages(current => current.map(entry => (entry.id === message.id ? { ...entry, text: entry.text + (message.text ?? '') } : entry)))
      }
      if (message.type === 'chat:done') {
        streamingId.current = null
        setMessages(current =>
          current.map(entry =>
            entry.id === message.id
              ? { ...entry, streaming: false, model: message.model, edits: parseEdits(message.answer ?? entry.text), text: entry.text }
              : entry,
          ),
        )
      }
      if (message.type === 'chat:error') {
        const id = streamingId.current
        streamingId.current = null
        setMessages(current =>
          id && current.some(entry => entry.id === id)
            ? current.map(entry => (entry.id === id ? { ...entry, streaming: false, error: message.message } : entry))
            : [...current, { id: `err-${Date.now()}`, role: 'assistant', text: '', error: message.message }],
        )
      }
      if (message.type === 'edits') {
        setMessages(current => current.map(entry => (entry.applied ? entry : entry)))
        setMessages(current => {
          const next = [...current]
          for (const entry of next) if (!entry.applied && entry.edits?.some(block => block.path === message.path)) entry.applied = message.results.map((result: any) => result.message).join(', ')
          return next
        })
      }
    })
    return off
  }, [register])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages])

  // Plans can change while the panel is closed, so ask before showing a list.
  useEffect(() => {
    send({ type: 'models' })
  }, [])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (!models.length) return
    const history = [...messages.filter(entry => !entry.error && entry.text), { id: 'new', role: 'user' as const, text }].map(entry => ({ role: entry.role, content: entry.text }))
    setMessages(current => [...current, { id: 'new', role: 'user', text }])
    setDraft('')
    send({ type: 'chat', messages: history, model, file, selection })
  }

  const fileName = file?.split('/').pop()

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="chat-ctx" title={file ? 'the assistant can see this file and your selection' : 'no file is open, so the assistant answers without code context'}>
          {file ? (
            <>
              <code>{fileName}</code>
              {selection ? <em>{selection.length} selected</em> : null}
            </>
          ) : (
            <em>no file context</em>
          )}
        </span>
        {models.length ? (
          <select value={model} onChange={event => onModel(event.target.value)}>
            {models.map(entry => (
              <option key={`${entry.provider}:${entry.model}`} value={entry.model}>
                {entry.name.replace(' (Codex)', '').replace(' (xAI)', '')} · {entry.model}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted">no plan</span>
        )}
      </div>

      <div className="chat-log" ref={scroller}>
        {!messages.length && <p className="chat-hint">Ask about the project, or say what to change. Edits come back as blocks you apply with one click, on your own AI plan.</p>}
        {messages.map(entry => (
          <div key={entry.id} className={`bubble ${entry.role}`}>
            {entry.role === 'user' ? (
              <p>{entry.text}</p>
            ) : (
              <>
                {entry.text && <p className="prose">{withoutEdits(entry.text) || '…'}</p>}
                {entry.edits?.map((block, index) => (
                  <div className="edit-card" key={`${entry.id}-${index}`}>
                    <div className="edit-head">
                      <code>{block.path}</code>
                      <button
                        onClick={() => {
                          send({ type: 'apply', path: block.path, blocks: [block] })
                          setMessages(current => current.map(item => (item.id === entry.id ? { ...item, applied: 'sent' } : item)))
                        }}
                      >
                        apply
                      </button>
                    </div>
                    <pre className="diff">
                      {block.search ? (
                        <>
                          <span className="minus">{block.search}</span>
                          {'\n'}
                          <span className="plus">{block.replace}</span>
                        </>
                      ) : (
                        <span className="plus">{block.replace}</span>
                      )}
                    </pre>
                  </div>
                ))}
                {entry.applied && <p className="applied">applied: {entry.applied}</p>}
                {entry.error && <p className="error">{entry.error}</p>}
                {entry.streaming && <span className="caret" />}
              </>
            )}
          </div>
        ))}
      </div>

      <form className="chat-input" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) submit(event)
          }}
          placeholder={file ? `ask about ${fileName}, or describe a change…` : 'ask, or describe a change…'}
          rows={3}
        />
        <button type="submit" disabled={!draft.trim()}>
          send
        </button>
      </form>
      <p className="chat-note">
        running on <strong>{session.member.name}</strong>'s own plan
      </p>
    </div>
  )
}
