import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Session } from './api'
import { termTheme } from './theme'

type Card = { id: string; memberId: string; name: string; color: string; mine: boolean; live: boolean }
type Props = {
  session: Session
  register: (handler: (message: any) => void) => () => void
  send: (data: unknown) => void
  mode: string
  follow: string | null
  onClose: () => void
}

// Terminals live on a tilted stage rather than a rail: each session is a card
// you can focus, watch, and close. The stage is summoned, so the editor keeps
// its width the rest of the time.
export const Terminals = ({ session, register, send, mode, follow, onClose }: Props) => {
  const [cards, setCards] = useState<Card[]>([])
  const [active, setActive] = useState('shared')
  const [pulsing, setPulsing] = useState<Set<string>>(new Set())
  const [command, setCommand] = useState('')
  const bodies = useRef(new Map<string, HTMLDivElement>())
  const terms = useRef(new Map<string, XTerm>())
  const attached = useRef(new Set<string>())

  const mount = (id: string) => {
    const host = bodies.current.get(id)
    if (!host || terms.current.has(id) || id === 'shared') return
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const instance = new XTerm({
      fontSize: 12.5,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
      theme: termTheme(dark.matches),
      cursorBlink: true,
      scrollback: 4000,
      convertEol: true,
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(host)
    const repaint = () => {
      instance.options.theme = termTheme(dark.matches)
    }
    dark.addEventListener('change', repaint)
    try {
      fit.fit()
    } catch {}
    instance.onData(data => send({ type: 'term:data', id, data }))
    instance.onResize(event => send({ type: 'term:resize', id, cols: event.cols, rows: event.rows }))
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {}
    })
    observer.observe(host)
    terms.current.set(id, instance)
    requestAnimationFrame(() => instance.focus())
  }

  const attach = (card: Card) => {
    setActive(card.id)
    setPulsing(previous => {
      if (!previous.has(card.id)) return previous
      const next = new Set(previous)
      next.delete(card.id)
      return next
    })
    requestAnimationFrame(() => mount(card.id))
    if (!card.mine && !attached.current.has(card.id)) {
      attached.current.add(card.id)
      send({ type: 'term:attach', id: card.id })
    }
  }

  useEffect(() => {
    // The stage can open long after hello, so ask for the current list.
    send({ type: 'term:list' })
    const off = register((message: any) => {
      if (message.type === 'term:list') {
        setCards((message.sessions ?? []).map((entry: any) => ({ ...entry, mine: entry.memberId === session.member.id })))
      }
      if (message.type === 'term:session') {
        attached.current.add(message.id)
        setActive(message.id)
        requestAnimationFrame(() => {
          mount(message.id)
          for (const part of message.replayed ?? []) terms.current.get(message.id)?.write(part)
        })
      }
      if (message.type === 'term:out' && message.id) {
        terms.current.get(message.id)?.write(message.data)
        if (message.id !== active) setPulsing(previous => new Set(previous).add(message.id))
      }
      if (message.type === 'term:end' && message.id) {
        setCards(previous => previous.map(card => (card.id === message.id ? { ...card, live: false } : card)))
        terms.current.get(message.id)?.write('\r\n\x1b[38;5;244m[session ended]\x1b[0m\r\n')
      }
    })
    return off
  }, [register, session.member.id, active])

  useEffect(() => {
    if (!follow) return
    const card = cards.find(entry => entry.memberId === follow && entry.live)
    if (card) attach(card)
  }, [follow, cards])

  useEffect(() => {
    const map = terms.current
    return () => {
      for (const instance of map.values()) instance.dispose()
      map.clear()
    }
  }, [])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const activeCard = cards.find(card => card.id === active)
  const sharedTerm = useRef<XTerm | null>(null)

  useEffect(() => {
    const host = bodies.current.get('shared')
    if (!host || sharedTerm.current) return
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const instance = new XTerm({
      fontSize: 12.5,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
      theme: termTheme(dark.matches),
      scrollback: 3000,
      convertEol: true,
      disableStdin: true,
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(host)
    try {
      fit.fit()
    } catch {}
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {}
    })
    observer.observe(host)
    sharedTerm.current = instance
    send({ type: 'term:history' })
    const off = register((message: any) => {
      if (message.type === 'term:init') for (const part of message.scrollback) instance.write(part)
      if (message.type === 'term:out' && !message.id) instance.write(message.data)
      if (message.type === 'term:run') instance.write(`\r\n\x1b[38;5;111m${message.memberName}\x1b[0m $ ${message.command}\r\n`)
      if (message.type === 'term:decision') {
        instance.write(message.allow ? '\x1b[38;5;150mapproved\x1b[0m\r\n' : `\x1b[38;5;203mdenied${message.note ? ` (${message.note})` : ''}\x1b[0m\r\n`)
      }
    })
    return () => {
      off()
      observer.disconnect()
      instance.dispose()
      sharedTerm.current = null
    }
  }, [register])

  const say = (event: React.FormEvent) => {
    event.preventDefault()
    if (!command.trim()) return
    send({ type: 'term:run', command })
    setCommand('')
  }

  return (
    <div className="stage" role="dialog" aria-label="terminals">
      <div className="stage-backdrop" onClick={onClose} />
      <div className="stage-bar">
        <strong>terminals</strong>
        <span className={mode === 'container' ? 'dot on' : 'dot off'} title={mode === 'container' ? 'containers' : 'host shells'} />
        <div className="spacer" />
        <button className="ghost" onClick={() => send({ type: 'term:open' })}>
          + new
        </button>
        <button className="ghost" onClick={onClose}>
          close
        </button>
      </div>

      <div className="stage-grid">
        <article className={active === 'shared' ? 'card-term shared on' : 'card-term shared'} onClick={() => setActive('shared')}>
          <header>
            <span className="who">
              <i style={{ background: 'var(--dim)' }} />
              shared shell
            </span>
            <em>everyone</em>
          </header>
          <div className="card-body" ref={element => { if (element) bodies.current.set('shared', element) }} />
          <form className="card-input" onSubmit={say}>
            <span>$</span>
            <input value={command} onChange={event => setCommand(event.target.value)} placeholder="run a command everyone sees" spellCheck={false} autoComplete="off" />
          </form>
        </article>

        {cards.map(card => (
          <article
            key={card.id}
            className={`card-term ${active === card.id ? 'on' : ''} ${card.live ? '' : 'dead'} ${pulsing.has(card.id) ? 'pulse' : ''}`}
            onClick={() => attach(card)}
          >
            <header>
              <span className="who">
                <i style={{ background: card.color }} />
                {card.mine ? 'you' : card.name}
              </span>
              {card.mine ? (
                <button className="ghost" title="close this terminal" onClick={event => { event.stopPropagation(); send({ type: 'term:close', id: card.id }) }}>
                  ×
                </button>
              ) : (
                <em>watching</em>
              )}
            </header>
            <div
              className="card-body"
              ref={element => {
                if (!element) return
                bodies.current.set(card.id, element)
                if (active === card.id) requestAnimationFrame(() => mount(card.id))
              }}
            />
          </article>
        ))}

        {cards.length === 0 && (
          <article className="card-term empty">
            <p>your own terminal, only visible to you until someone watches. Run an agent in it.</p>
            <button onClick={() => send({ type: 'term:open' })}>open a terminal</button>
          </article>
        )}
      </div>

      <p className="stage-hint">
        {activeCard ? (activeCard.mine ? 'you are driving, everyone can watch' : `watching ${activeCard.name}, read only`) : 'shared shell takes commands from everyone, risky ones ask the host or an editor'}
      </p>
    </div>
  )
}
