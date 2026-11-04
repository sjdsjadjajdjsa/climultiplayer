import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createRoom, pollJoin, requestJoin, type JoinTicket, type Session } from './api'

type Tone = 'out' | 'cmd' | 'dim' | 'bad' | 'good'
type Line = { id: number; tone: Tone; text: string }

const maxName = 24
const repo = 'https://github.com/sjdsjadjajdjsa/climultiplayer'

const intro = [
  'one room, a few people, one project.',
  'everyone gets a cursor of their own, the shell is shared and runs in a',
  'container, and each person brings their own AI plan.',
]

const commands: Array<[string, string]> = [
  ['start [folder]', 'a new room, optionally with a copy of a folder in it'],
  ['join <link or code>', 'ask a host to let you in'],
  ['demo', 'a room with a small sample project to poke at'],
]

// The landing page is a terminal. The commands are real, and each has a button
// under the prompt so nobody has to know that.
export const Join = ({ onSession, notice = '' }: { onSession: (session: Session) => void; notice?: string }) => {
  const [opened] = useState(() => readInvite(`${location.origin}/${location.search}${location.hash}`))
  const [lines, setLines] = useState<Line[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState<JoinTicket | null>(null)
  const counter = useRef(0)
  const booted = useRef(false)
  const timer = useRef<number | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const recall = useRef<{ list: string[]; at: number }>({ list: [], at: 0 })

  const say = (tone: Tone, ...texts: string[]) => setLines(current => [...current, ...texts.map(text => ({ id: (counter.current += 1), tone, text }))])
  const label = name ? `${name} ›` : 'name ›'

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    say('out', ...intro)
    if (notice) say('bad', '', notice)
    fetch('/api/health')
      .then(response => response.json())
      .then(health => {
        const contained = health.shell === 'container'
        say(contained ? 'dim' : 'bad', '', contained
          ? 'shells run in a throwaway container with only the room copy mounted.'
          : 'shells run as this user with no container: guests could reach your home folder.')
        if (contained && health.image === false) say('bad', 'the room image is not built yet. in a terminal: npm run room:image')
        if (contained && health.network === 'none') say('dim', 'the container has no network.')
        if (opened.token) say('dim', `an invite for room ${opened.code || '(unknown)'} is in this link.`)
        say('out', '', 'what should we call you?')
      })
      .catch(() => say('out', '', 'what should we call you?'))
  }, [])

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current)
  }, [])

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [lines, waiting])

  useEffect(() => {
    if (!busy && !waiting) input.current?.focus()
  }, [busy, waiting, name])

  const showHelp = () => {
    const width = Math.max(...commands.map(([usage]) => usage.length)) + 3
    say('out', ...commands.map(([usage, about]) => `  ${usage.padEnd(width)}${about}`), `  ${'help'.padEnd(width)}this list`)
  }

  const start = async (folder: string, demo = false) => {
    setBusy(true)
    say('dim', folder ? `copying ${folder} into a new room...` : demo ? 'laying out a sample project...' : 'making a room...')
    try {
      const result = await createRoom(name, folder || undefined, demo)
      history.replaceState(null, '', '/')
      onSession({ code: result.code, member: { ...result.member, online: true }, demo })
    } catch (problem: any) {
      say('bad', problem.message)
      setBusy(false)
    }
  }

  const join = async (argument: string) => {
    const parsed = argument ? readInvite(argument) : opened
    let code = parsed.code
    if (!code && /^[A-Za-z0-9]{6}$/.test(argument)) code = argument.toUpperCase()
    if (!argument && !opened.token && !opened.code) return say('bad', 'join needs a room code or an invite link, like: join K7M2QD')
    if (!code) return say('bad', parsed.link ? 'that link has no room in it. paste the whole link, or use the six letter code.' : 'that is not a room code or a link.')
    setBusy(true)
    try {
      const ticket = await requestJoin(code, name, parsed.token)
      setWaiting(ticket)
      say('dim', `asking the host of ${code} to let you in. keep this tab open, or type cancel.`)
      timer.current = window.setInterval(async () => {
        const result = await pollJoin(ticket).catch(() => null)
        if (!result || result.status === 'pending') return
        if (timer.current) clearInterval(timer.current)
        timer.current = null
        if (result.status === 'allowed' && result.member) {
          history.replaceState(null, '', '/')
          onSession({ code: ticket.code, member: { ...result.member, online: true } })
          return
        }
        setWaiting(null)
        say('bad', result.status === 'denied' ? 'the host said no.' : 'the request expired. try again.')
      }, 1500)
    } catch (problem: any) {
      say('bad', problem.message)
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    setWaiting(null)
    say('dim', 'stopped asking.')
  }

  const run = (raw: string) => {
    const [first] = raw.split(/\s+/)
    const argument = raw.slice(first.length).trim()
    switch (first.toLowerCase()) {
      case 'start':
        return void start(argument)
      case 'demo':
        return void start('', true)
      case 'join':
        return void join(argument)
      case 'help':
        return showHelp()
      case 'cancel':
        return waiting ? cancel() : say('dim', 'nothing to cancel.')
      case 'clear':
        return setLines([])
      default:
        say('bad', `${first}: not a command. try help.`)
    }
  }

  const exec = (raw: string) => {
    say('cmd', `${label} ${raw}`)
    recall.current = { list: [...recall.current.list, raw], at: recall.current.list.length + 1 }
    if (raw.toLowerCase() === 'clear') return setLines([])
    run(raw)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const raw = value.trim()
    if (!raw || busy) return
    setValue('')
    if (waiting) {
      say('cmd', `${label} ${raw}`)
      return raw.toLowerCase() === 'cancel' ? cancel() : say('dim', 'still waiting for the host. type cancel to stop.')
    }
    if (!name) {
      say('cmd', `${label} ${raw}`)
      if (raw.length > maxName) return say('bad', `keep it to ${maxName} characters.`)
      setName(raw)
      say('out', `hi ${raw}.`, '')
      if (opened.token) {
        say('dim', 'press enter to use the invite, or type help.')
        setValue('join')
      } else showHelp()
      return
    }
    exec(raw)
  }

  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    const { list, at } = recall.current
    if (!list.length) return
    event.preventDefault()
    const next = Math.min(Math.max(at + (event.key === 'ArrowUp' ? -1 : 1), 0), list.length)
    recall.current.at = next
    setValue(list[next] ?? '')
  }

  const ready = Boolean(name) && !busy && !waiting

  return (
    <div className="desk">
      <header className="desk-bar">
        <b>climultiplayer</b>
        <a href={repo} target="_blank" rel="noreferrer">source</a>
      </header>
      <main className="desk-main">
        <section className="term" aria-label="start or join a room" onClick={() => !window.getSelection()?.toString() && input.current?.focus()}>
          <div className="term-title">room</div>
          <div className="term-body" ref={body}>
            <div role="log" aria-live="polite">
              {lines.map(line => (
                <p key={line.id} className={`term-line ${line.tone}`}>
                  {line.text || ' '}
                </p>
              ))}
              {waiting && <p className="term-line dim">waiting<span className="caret" aria-hidden /></p>}
            </div>
            <form className="term-prompt" onSubmit={submit}>
              <label htmlFor="command">{label}</label>
              <input
                id="command"
                ref={input}
                value={value}
                onChange={event => setValue(event.target.value)}
                onKeyDown={keys}
                placeholder={name ? '' : 'alex'}
                maxLength={400}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </form>
            {ready && (
              <div className="term-actions">
                <button type="button" onClick={() => exec('start')}>start</button>
                <button type="button" onClick={() => exec('demo')}>demo</button>
                <button type="button" onClick={() => { setValue('join '); input.current?.focus() }}>join</button>
                <button type="button" onClick={() => exec('help')}>help</button>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

// Accepts a full invite link, a bare token, or a link with the token in the
// query. Everything but the token is thrown away.
export const readInvite = (value: string) => {
  const text = String(value ?? '').trim()
  const room = /[?&]room=([A-Z0-9]{6})/i.exec(text)?.[1]?.toUpperCase() ?? ''
  const queryToken = /[?&]t=([A-Za-z0-9_-]{20,})/.exec(text)?.[1] ?? ''
  const hashToken = /#t=([A-Za-z0-9_-]{20,})/.exec(text)?.[1] ?? ''
  const bare = /^[A-Za-z0-9_-]{20,}$/.test(text) ? text : ''
  return { code: room, token: queryToken || hashToken || bare, link: text !== bare }
}
