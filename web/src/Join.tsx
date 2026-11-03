import { useEffect, useRef, useState } from 'react'
import { createRoom, pollJoin, requestJoin, type JoinTicket, type Session } from './api'

type Waiting = { ticket: JoinTicket }

export const Join = ({ onSession, notice = '' }: { onSession: (session: Session) => void; notice?: string }) => {
  const opened = readInvite(`${location.origin}/${location.search}${location.hash}`)
  const [invite, setInvite] = useState(opened.token)
  const [code, setCode] = useState(opened.code)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState<Waiting | null>(null)
  const [linkReady, setLinkReady] = useState(opened.link && Boolean(opened.token))
  const [shell, setShell] = useState('')
  const [offline, setOffline] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    fetch('/api/health').then(response => response.json()).then(body => {
      setShell(String(body.shell ?? ''))
      setOffline(body.network === 'none')
    }).catch(() => {})
  }, [])

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current)
  }, [])

  const fromLink = invite.length > 20

  const start = async () => {
    if (!name.trim()) return setError('pick a display name first')
    setBusy(true)
    setError('')
    try {
      const result = await createRoom(name, source.trim() || undefined)
      history.replaceState(null, '', `/`)
      onSession({ code: result.code, member: { ...result.member, online: true } })
    } catch (problem: any) {
      setError(problem.message)
    } finally {
      setBusy(false)
    }
  }

  const join = async () => {
    if (!name.trim()) return setError('pick a display name first')
    if (!code.trim()) return setError('a room code is required')
    setBusy(true)
    setError('')
    try {
      const ticket = await requestJoin(code.trim().toUpperCase(), name, invite)
      setWaiting({ ticket })
      timer.current = window.setInterval(async () => {
        const result = await pollJoin(ticket).catch(() => null)
        if (!result) return
        if (result.status === 'pending') return
        if (timer.current) clearInterval(timer.current)
        if (result.status === 'allowed' && result.member) {
          history.replaceState(null, '', `/`)
          onSession({ code: ticket.code, member: { ...result.member, online: true } })
          return
        }
        setWaiting(null)
        setBusy(false)
        setError(result.status === 'denied' ? 'the host denied the join' : 'the request expired, try again')
      }, 1500)
    } catch (problem: any) {
      setError(problem.message)
    } finally {
      setBusy(false)
    }
  }

  // A pasted invite may be a whole link or just its token. Read both, fill the
  // code from the link when it is there, and keep the token as the token.
  const useInvite = (value: string) => {
    const parsed = readInvite(value)
    setInvite(parsed.token)
    if (parsed.code) setCode(parsed.code)
    setLinkReady(Boolean(parsed.token))
    setError(parsed.link && !parsed.token ? 'that link has no invite token in it, copy the whole link' : '')
  }

  if (waiting) {
    return (
      <div className="join">
        <div className="join-inner waiting">
          <h1>
            cli<span>multiplayer</span>
          </h1>
          <p className="tag">
            waiting for the host of <code>{waiting.ticket.code}</code> to let you in. Keep this tab open.
          </p>
          <div className="pulse" />
        </div>
      </div>
    )
  }

  return (
    <div className="join">
      <div className="join-inner">
        <header>
          <h1>
            cli<span>multiplayer</span>
          </h1>
          <p className="tag">One workspace, live. Friends in, cursors moving, terminal shared, your own AI plan on call.</p>
        </header>

        <label>
          your name
          <input value={name} onChange={event => setName(event.target.value)} placeholder="alex" maxLength={24} autoFocus />
        </label>

        <section className="join-cards">
          <div className="card">
            <h2>Start a room</h2>
            <p>Creates a private copy of a folder on this machine and lets you hand out single-use invites. Your own folder is never edited.</p>
            <label>
              copy a folder in (optional)
              <input value={source} onChange={event => setSource(event.target.value)} placeholder="/home/you/project" />
            </label>
            <button disabled={busy} onClick={start}>
              start room
            </button>
          </div>

          <div className="card">
            <h2>Join a room</h2>
            <p>Open an invite link, or paste one here. A bare room code works too, the host still approves.</p>
            {linkReady ? (
              <div className="chip">
                <span>room {code}</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setInvite('')
                    setLinkReady(false)
                  }}
                >
                  change link
                </button>
              </div>
            ) : (
              <>
                <label>
                  invite link
                  <input
                    value={invite}
                    onChange={event => useInvite(event.target.value)}
                    onPaste={event => useInvite(event.clipboardData.getData('text'))}
                    placeholder="paste the link a friend sent"
                  />
                </label>
                <label>
                  or the room code
                  <input
                    value={code}
                    onChange={event => setCode(event.target.value.toUpperCase())}
                    onPaste={event => useInvite(event.clipboardData.getData('text'))}
                    placeholder="K7M2QD"
                    maxLength={6}
                    className="code-input"
                  />
                </label>
              </>
            )}
            <button disabled={busy || !code || !name.trim()} onClick={join}>
              {fromLink ? 'join with invite' : 'ask to join'}
            </button>
          </div>
        </section>

        {notice && !error && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}
        {shell && (
          <p className={shell === 'container' ? 'shell-badge contained' : 'shell-badge loose'}>
            {shell === 'container'
              ? 'shells run in a throwaway container: only the room copy is mounted'
              : 'shells run as this user with no container: guests can reach your home folder'}
            {offline && ' and the container has no network'}
          </p>
        )}
        <footer>
          Invites are single use and revocable. Every join waits for the host, and risky shell commands ask first.
        </footer>
      </div>
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
