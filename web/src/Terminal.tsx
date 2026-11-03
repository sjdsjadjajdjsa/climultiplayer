import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Session } from './api'
import { termTheme } from './theme'

type Tab = { id: string; memberId: string; name: string; color: string; mine: boolean; live: boolean }
type Props = { session: Session; register: (handler: (message: any) => void) => () => void; send: (data: unknown) => void; mode: string; follow: string | null }

export const Terminal = ({ session, register, send, mode, follow }: Props) => {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string>('shared')
  const [pulsing, setPulsing] = useState<Set<string>>(new Set())
  const [command, setCommand] = useState('')
  const bodies = useRef(new Map<string, HTMLDivElement>())
  const terms = useRef(new Map<string, XTerm>())
  const attached = useRef(new Set<string>())

  const mount = (id: string) => {
    const host = bodies.current.get(id)
    if (!host || terms.current.has(id)) return
    const instance = new XTerm({
      fontSize: 12.5,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
      theme: termTheme(window.matchMedia('(prefers-color-scheme: dark)').matches),
      cursorBlink: true,
      scrollback: 4000,
      convertEol: true,
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(host)
    try {
      fit.fit()
    } catch {}
    instance.onData(data => send({ type: 'term:data', id, data }))
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const repaint = () => { instance.options.theme = termTheme(dark.matches) }
    dark.addEventListener('change', repaint)
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        send({ type: 'term:resize', id, cols: instance.cols, rows: instance.rows })
      } catch {}
    })
    observer.observe(host)
    instance.onResize(event => send({ type: 'term:resize', id, cols: event.cols, rows: event.rows }))
    terms.current.set(id, instance)
    instance.focus()
  }

  useEffect(() => {
    const off = register((message: any) => {
      if (message.type === 'term:list') {
        setTabs(previous => {
          const next = (message.sessions ?? []).map((entry: any) => ({ ...entry, mine: entry.memberId === session.member.id }))
          return next
        })
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
        setTabs(previous => previous.map(tab => (tab.id === message.id ? { ...tab, live: false } : tab)))
        terms.current.get(message.id)?.write('\r\n\x1b[38;5;244m[session ended]\x1b[0m\r\n')
      }
      if (message.type === 'kicked') {
        for (const instance of terms.current.values()) instance.dispose()
        terms.current.clear()
      }
    })
    return off
  }, [register, session.member.id])

  // Mount a terminal the first time its tab is shown.
  useEffect(() => {
    if (active === 'shared') return
    mount(active)
    setPulsing(previous => {
      if (!previous.has(active)) return previous
      const next = new Set(previous)
      next.delete(active)
      return next
    })
  }, [active])

  // Follow mode parks on the followed member's terminal when they open one.
  useEffect(() => {
    if (!follow) return
    const tab = tabs.find(entry => entry.memberId === follow && entry.live)
    if (tab) show(tab.id, tab.mine)
  }, [follow, tabs])

  useEffect(() => {
    const map = terms.current
    return () => {
      for (const instance of map.values()) instance.dispose()
      map.clear()
    }
  }, [])

  const openOwn = () => send({ type: 'term:open' })

  // A watcher has to ask for the stream; the owner already has it.
  const show = (id: string, mine: boolean) => {
    if (active !== 'shared' && active !== id) {
      send({ type: 'term:detach', id: active })
      attached.current.delete(active)
    }
    setActive(id)
    if (id !== 'shared' && !mine && !attached.current.has(id)) {
      attached.current.add(id)
      send({ type: 'term:attach', id })
    }
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!command.trim()) return
    send({ type: 'term:run', command })
    setCommand('')
  }

  const activeTab = tabs.find(tab => tab.id === active)
  const ended = activeTab && !activeTab.live
  const mine = activeTab?.mine

  return (
    <div className="terminal">
      <div className="terminal-head">
        <div className="tabs">
          <button className={active === 'shared' ? 'tab on' : 'tab'} onClick={() => show('shared', true)}>
            shared
          </button>
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`tab ${active === tab.id ? 'on' : ''} ${tab.live ? '' : 'dead'} ${pulsing.has(tab.id) ? 'pulse' : ''}`}
              onClick={() => show(tab.id, tab.mine)}
              title={`${tab.name}${tab.mine ? ' (you)' : ''}`}
            >
              <i style={{ background: tab.color }} />
              {tab.mine ? 'you' : tab.name}
            </button>
          ))}
        </div>
        <div className="head-actions">
          <b className={mode === 'container' ? 'on' : 'off'}>{mode === 'container' ? 'container' : 'host'}</b>
          {!tabs.some(tab => tab.mine && tab.live) && (
            <button className="link" onClick={openOwn}>
              + terminal
            </button>
          )}
        </div>
      </div>

      <div className={active === 'shared' ? 'terminal-body' : 'terminal-body hidden'} ref={element => {
        if (element) bodies.current.set('shared', element)
      }}>
        <SharedShell register={register} />
      </div>

      {tabs.map(tab => (
        <div
          key={tab.id}
          className={active === tab.id ? 'terminal-body' : 'terminal-body hidden'}
          ref={element => {
            if (element) {
              bodies.current.set(tab.id, element)
              if (active === tab.id) requestAnimationFrame(() => mount(tab.id))
            }
          }}
        />
      ))}

      {active === 'shared' ? (
        <form className="terminal-input" onSubmit={submit}>
          <span>$</span>
          <input value={command} onChange={event => setCommand(event.target.value)} placeholder="run a command in the shared shell" spellCheck={false} autoComplete="off" />
        </form>
      ) : (
        <div className="terminal-hint">
          {ended ? 'session ended' : mine ? 'you are driving, everyone watching can see it' : `watching ${activeTab?.name ?? ''}, read only`}
        </div>
      )}
    </div>
  )
}

// The shared command line keeps the old line-based behaviour and approvals.
const SharedShell = ({ register }: { register: (handler: (message: any) => void) => () => void }) => {
  const holder = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)

  useEffect(() => {
    if (!holder.current) return
    const instance = new XTerm({
      fontSize: 12.5,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
      theme: termTheme(window.matchMedia('(prefers-color-scheme: dark)').matches),
      scrollback: 3000,
      convertEol: true,
      disableStdin: true,
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(holder.current)
    fit.fit()
    term.current = instance
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {}
    })
    observer.observe(holder.current)
    const off = register((message: any) => {
      if (message.type === 'term:init') for (const part of message.scrollback) instance.write(part)
      if (message.type === 'term:out' && !message.id) instance.write(message.data)
      if (message.type === 'term:run') instance.write(`\r\n\x1b[38;5;111m${message.memberName}\x1b[0m $ ${message.command}\r\n`)
      if (message.type === 'term:decision') instance.write(message.allow ? '\x1b[38;5;150mapproved\x1b[0m\r\n' : `\x1b[38;5;203mdenied${message.note ? ` (${message.note})` : ''}\x1b[0m\r\n`)
    })
    return () => {
      off()
      observer.disconnect()
      instance.dispose()
      term.current = null
    }
  }, [register])

  return <div className="shared-shell" ref={holder} />
}
