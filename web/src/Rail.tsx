import { useEffect, useRef, useState } from 'react'
import type { Session } from './api'
import { Chat, type ChatModel } from './Chat'

export type RoomMessage = { id: string; memberId: string; name: string; color: string; role: string; text: string; at: number }

type Props = {
  session: Session
  register: (handler: (message: any) => void) => () => void
  send: (data: unknown) => void
  models: ChatModel[]
  model: string
  onModel: (model: string) => void
  file: string | null
  selection: string
}

export const Rail = ({ session, register, send, models, model, onModel, file, selection }: Props) => {
  const [tab, setTab] = useState<'room' | 'assistant'>('room')
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [draft, setDraft] = useState('')
  const [seen, setSeen] = useState(0)
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = register((message: any) => {
      if (message.type === 'hello' && Array.isArray(message.messages)) setMessages(message.messages)
      if (message.type === 'say') {
        setMessages(current => [...current, message.message])
        if (tab !== 'room') setSeen(count => count + 1)
      }
    })
    return off
  }, [register, tab])

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [messages])

  const say = (event: React.FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    send({ type: 'say', text })
    setDraft('')
  }

  return (
    <div className="rail">
      <div className="rail-tabs">
        <button
          className={tab === 'room' ? 'rail-tab on' : 'rail-tab'}
          onClick={() => {
            setTab('room')
            setSeen(0)
          }}
        >
          room
          {seen > 0 && tab !== 'room' && <b>{seen}</b>}
        </button>
        <button className={tab === 'assistant' ? 'rail-tab on' : 'rail-tab'} onClick={() => setTab('assistant')}>
          assistant
        </button>
      </div>

      {tab === 'room' ? (
        <>
          <div className="chat-log" ref={log}>
            {!messages.length && <p className="chat-hint">Say hi. Everyone in the room sees this.</p>}
            {messages.map(message => (
              <div className="say" key={message.id}>
                <span className="say-name" style={{ color: message.color }}>
                  {message.memberId === session.member.id ? 'you' : message.name}
                </span>
                <p>{message.text}</p>
              </div>
            ))}
          </div>
          <form className="chat-input" onSubmit={say}>
            <textarea
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) say(event)
              }}
              placeholder="message the room…"
              rows={2}
            />
            <button type="submit" disabled={!draft.trim()}>
              send
            </button>
          </form>
        </>
      ) : (
        <Chat
          session={session}
          models={models}
          model={model}
          onModel={onModel}
          send={send}
          register={register}
          file={file}
          selection={selection}
        />
      )}
    </div>
  )
}
