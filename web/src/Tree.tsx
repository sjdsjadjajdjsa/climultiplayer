import { useState } from 'react'
import type { Member, TreeEntry } from './api'

type Props = {
  entries: TreeEntry[]
  current: string | null
  members: Member[]
  you: string
  onOpen: (path: string) => void
  onCreate: (path: string) => void
  onDelete: (path: string) => void
}

export const Tree = ({ entries, current, members, you, onOpen, onCreate, onDelete }: Props) => {
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!path.trim()) return
    onCreate(path.trim())
    setPath('')
    setAdding(false)
  }

  return (
    <aside className="tree">
      <div className="tree-head">
        <strong>files</strong>
        <button className="link" onClick={() => setAdding(value => !value)}>
          {adding ? 'cancel' : '+ new'}
        </button>
      </div>
      {adding && (
        <form className="tree-new" onSubmit={submit}>
          <input value={path} onChange={event => setPath(event.target.value)} placeholder="src/thing.ts" autoFocus />
        </form>
      )}
      <ul>
        {entries.map(entry => {
          const watchers = members.filter(member => member.file === entry.path && member.id !== you)
          return (
            <li key={entry.path} className={`${entry.dir ? 'dir' : ''} ${current === entry.path ? 'active' : ''}`}>
              <button
                onClick={() => !entry.dir && onOpen(entry.path)}
                title={entry.path}
                style={{ paddingLeft: `${(entry.path.split('/').length - 1) * 10 + 8}px` }}
              >
                <span className="name">{entry.path.split('/').pop()}</span>
                <span className="dots">
                  {watchers.map(member => (
                    <i key={member.id} style={{ background: member.color }} title={member.name} />
                  ))}
                </span>
              </button>
              {!entry.dir && (
                <button
                  className="kill"
                  title={`delete ${entry.path}`}
                  onClick={() => {
                    if (confirm(`delete ${entry.path}?`)) onDelete(entry.path)
                  }}
                >
                  ×
                </button>
              )}
            </li>
          )
        })}
        {!entries.length && <li className="empty">no files yet</li>}
      </ul>
    </aside>
  )
}
