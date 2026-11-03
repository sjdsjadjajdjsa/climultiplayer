import { useEffect, useState } from 'react'
import { authAction, authStatus, type Session } from './api'

type Status = { id: string; name: string; signedIn: boolean; pending: boolean; models: number; error: string | null }
type Device = { userCode?: string; verificationURI?: string }

export const Accounts = ({ session, onChanged }: { session: Session; onChanged: () => void }) => {
  const [statuses, setStatuses] = useState<Status[]>([])
  const [device, setDevice] = useState<Record<string, Device>>({})
  const [paste, setPaste] = useState<Record<string, string>>({})
  const [showPaste, setShowPaste] = useState<Record<string, boolean>>({})
  const [note, setNote] = useState('')

  const refresh = () => authStatus(session).then(result => setStatuses(result.subscriptions)).catch(problem => setNote(problem.message))

  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, 4000)
    return () => clearInterval(timer)
  }, [])

  const start = async (id: string, kind: 'browser' | 'device') => {
    setNote('')
    try {
      if (kind === 'device') {
        const result = await authAction(session, { id, action: 'device' })
        if (result.error) return setNote(result.error)
        setDevice(current => ({ ...current, [id]: result }))
        poll(id)
        return
      }
      const result = await authAction(session, { id, action: 'browser' })
      if (result.error) return setNote(result.error)
      const opened = window.open(result.url, '_blank', 'noopener')
      if (opened) setNote('finish the sign-in in the tab that opened, this panel updates by itself')
      else setNote(`open this link to sign in: ${result.url}`)
    } catch (problem: any) {
      setNote(problem.message)
    }
  }

  const poll = async (id: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 4000))
      const result = await authAction(session, { id, action: 'poll' }).catch(() => null)
      if (!result) continue
      if (result.status === 'ok') {
        setNote(`signed in to ${id}`)
        await refresh()
        onChanged()
        return
      }
      if (result.status === 'error' || result.status === 'cancelled') {
        setNote(result.message ?? 'the sign-in stopped')
        return
      }
    }
  }

  const submitCode = async (id: string) => {
    try {
      const result = await authAction(session, { id, action: 'code', code: paste[id] ?? '' })
      if (result.error) return setNote(result.error)
      setNote('signed in')
      await refresh()
      onChanged()
    } catch (problem: any) {
      setNote(problem.message)
    }
  }

  return (
    <div className="settings-body">
        <p className="muted">
          Connect as many plans as you like; the model picker lists them all and each call bills the plan it runs on. Tokens stay in your own store on this server.
        </p>
        <p className="muted small">
          {statuses.filter(status => status.signedIn).length} connected
          {statuses.some(status => !status.signedIn) ? ', add another below' : ''}
        </p>
        {note && <p className="notice">{note}</p>}
        <ul className="accounts">
          {statuses.map(status => (
            <li key={status.id}>
              <div>
                <strong>{status.name}</strong>
                <span className={status.signedIn ? 'on' : 'off'}>{status.signedIn ? `connected · ${status.models} models` : status.pending ? 'waiting for you' : 'not connected'}</span>
                {status.error && <span className="error">{status.error}</span>}
              </div>
              <div className="row">
                {status.signedIn ? (
                  <button
                    onClick={async () => {
                      await authAction(session, { id: status.id, action: 'signOut' })
                      await refresh()
                      onChanged()
                    }}
                  >
                    sign out
                  </button>
                ) : (
                  <>
                    <button onClick={() => start(status.id, status.id === 'chatgpt' || status.id === 'claude' ? 'browser' : 'device')}>
                      {statuses.some(other => other.signedIn) ? 'connect another' : 'connect'}
                    </button>
                    <button className="link" onClick={() => setShowPaste(current => ({ ...current, [status.id]: !current[status.id] }))}>
                      paste link
                    </button>
                    {device[status.id]?.userCode && (
                      <span className="device">
                        code <code>{device[status.id].userCode}</code>
                        {device[status.id].verificationURI && (
                          <a href={device[status.id].verificationURI} target="_blank" rel="noreferrer">
                            open
                          </a>
                        )}
                      </span>
                    )}
                  </>
                )}
              </div>
              {!status.signedIn && showPaste[status.id] && (
                <div className="paste">
                  <input
                    value={paste[status.id] ?? ''}
                    onChange={event => setPaste(current => ({ ...current, [status.id]: event.target.value }))}
                    placeholder="or paste the redirected URL"
                  />
                  <button onClick={() => submitCode(status.id)}>use</button>
                </div>
              )}
            </li>
          ))}
        </ul>
    </div>
  )
}
