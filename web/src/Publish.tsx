import { useEffect, useState } from 'react'
import { deletePage, listPages, publishPage, type Page, type Session } from './api'

export const Publish = ({ session, onClose, onNote }: { session: Session; onClose: () => void; onNote: (note: string) => void }) => {
  const [pages, setPages] = useState<Page[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = () => listPages(session).then(result => setPages(result.pages)).catch(() => {})

  useEffect(() => {
    void refresh()
  }, [])

  const publish = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      const page = await publishPage(session, name)
      await refresh()
      setName('')
      onNote(`published at /p/${page.slug}/`)
    } catch (problem: any) {
      onNote(problem.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={event => event.stopPropagation()}>
        <header>
          <h2>Publish a site</h2>
          <button className="link" onClick={onClose}>
            close
          </button>
        </header>
        <p className="muted">
          Copies the room's files to a public folder and serves it from this same address, so a tunnel makes it viewable by anyone with the link. No account, no CORS.
        </p>
        <form className="paste" onSubmit={publish}>
          <input value={name} onChange={event => setName(event.target.value)} placeholder="site name" />
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'publishing…' : 'publish'}
          </button>
        </form>
        <ul className="accounts">
          {pages.map(page => (
            <li key={page.slug}>
              <div>
                <a href={`/p/${page.slug}/`} target="_blank" rel="noreferrer">
                  /p/{page.slug}/
                </a>
                <span className="muted">
                  {page.files} files · {(page.size / 1024).toFixed(1)} kB · {new Date(page.updatedAt).toLocaleString()}
                </span>
              </div>
              <div className="row">
                <button
                  onClick={async () => {
                    await deletePage(session, page.slug).catch(() => {})
                    await refresh()
                  }}
                >
                  delete
                </button>
              </div>
            </li>
          ))}
          {!pages.length && <li className="muted">nothing published yet</li>}
        </ul>
      </div>
    </div>
  )
}
