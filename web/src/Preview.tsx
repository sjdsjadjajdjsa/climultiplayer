import { useEffect, useState } from 'react'
import { listPreviews, previewLink, startPreview, stopPreview, type Preview, type Session } from './api'

type Props = {
  session: Session
  previews: Preview[]
  onPreviews: (previews: Preview[]) => void
  onClose: () => void
  onNote: (note: string) => void
}

const PORTS = [5173, 3000, 4173, 5000, 8000, 8080]

// The window opens before the request so a popup blocker sees a click, then it
// is pointed at the single-use sign-in link once that arrives.
const openPreview = async (session: Session, id: string, onNote: (note: string) => void) => {
  const tab = window.open('about:blank', '_blank')
  try {
    const { url } = await previewLink(session, id)
    if (tab) {
      tab.opener = null
      tab.location.href = url
    } else {
      location.assign(url)
    }
  } catch (problem: any) {
    tab?.close()
    onNote(problem.message)
  }
}

export const PreviewPanel = ({ session, previews, onPreviews, onClose, onNote }: Props) => {
  const [port, setPort] = useState(5173)
  const [from, setFrom] = useState<'mine' | 'shared'>('mine')
  const [busy, setBusy] = useState(false)

  const refresh = () => listPreviews(session).then(result => onPreviews(result.previews)).catch(() => {})

  useEffect(() => {
    void refresh()
  }, [])

  const share = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await startPreview(session, port, from)
      await refresh()
    } catch (problem: any) {
      onNote(problem.message)
    } finally {
      setBusy(false)
    }
  }

  // A second sign-in link, for a private window or another browser profile:
  // that window is a separate user of the app, so one person can be the admin
  // in one window and a customer in the other.
  const copyLink = async (id: string) => {
    try {
      const { url } = await previewLink(session, id)
      await navigator.clipboard.writeText(url)
      onNote('link copied. It works once, for two minutes: paste it in a private window to be a second user.')
    } catch (problem: any) {
      onNote(problem.message)
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={event => event.stopPropagation()}>
        <header>
          <h2>Previews</h2>
          <button className="link" onClick={onClose}>
            close
          </button>
        </header>
        <p className="muted">
          Run a dev server in your terminal, listening on all addresses (for Vite: <code>npm run dev -- --host 0.0.0.0</code>), then share its port. Everyone in the
          room can open it and use it as their own user. Nobody outside the room can.
        </p>
        <form className="paste" onSubmit={share}>
          <select value={from} onChange={event => setFrom(event.target.value as 'mine' | 'shared')} aria-label="where the dev server runs">
            <option value="mine">my terminal</option>
            <option value="shared">shared shell</option>
          </select>
          <select value={port} onChange={event => setPort(Number(event.target.value))} aria-label="port">
            {PORTS.map(value => (
              <option key={value} value={value}>
                port {value}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy}>
            {busy ? 'checking…' : 'share'}
          </button>
        </form>
        <ul className="accounts">
          {previews.map(preview => {
            const mine = preview.ownerId === session.member.id
            return (
              <li key={preview.id}>
                <div>
                  <span>
                    <b style={{ color: preview.color }}>{mine ? 'yours' : preview.ownerName}</b>, port {preview.port}
                    {preview.source === 'shared' ? ' (shared shell)' : ''}
                  </span>
                  <span className="muted">until {new Date(preview.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="row">
                  <button onClick={() => void openPreview(session, preview.id, onNote)}>open</button>
                  <button onClick={() => void copyLink(preview.id)}>link for a second user</button>
                  {(mine || session.member.role === 'host') && (
                    <button
                      onClick={async () => {
                        await stopPreview(session, preview.id).catch((problem: any) => onNote(problem.message))
                        await refresh()
                      }}
                    >
                      stop
                    </button>
                  )}
                </div>
              </li>
            )
          })}
          {!previews.length && <li className="muted">nothing shared yet</li>}
        </ul>
      </div>
    </div>
  )
}

export { openPreview }
