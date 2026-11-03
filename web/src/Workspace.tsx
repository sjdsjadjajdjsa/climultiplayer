import { useCallback, useEffect, useRef, useState } from 'react'
import {
  auditLog, createFile, createInvite, decideJoin, deleteFile, endRoom, exportUrl, installTool, inviteBase, kickMember, leaveRoom, listInvites, listPreviews, revokeInvite, setKey, setRole, toolsList, tree as fetchTree, wsUrl, type AuditEntry, type Tool,
  type Invite, type Member, type Preview, type Session, type TreeEntry,
} from './api'
import { Rail } from './Rail'
import type { ChatModel } from './Chat'
import { Editor } from './Editor'
import { Publish } from './Publish'
import { PreviewPanel } from './Preview'
import { Settings, type SettingsTab } from './Settings'
import { Terminals } from './Terminals'
import { Tree } from './Tree'

type Pending = { id: string; command: string; memberName: string; memberId: string; reasons: string[] }
type Waiting = { id: string; name: string; expiresAt: number }

// A command approval dies on its own after 90s, which the card shows as a
// shrinking bar rather than a sentence nobody reads.
const APPROVAL_MS = 90_000

const initials = (name: string) => name.trim().slice(0, 2).toUpperCase()

export const Workspace = ({ session, onLeave }: { session: Session; onLeave: (reason?: string) => void }) => {
  const socket = useRef<WebSocket | null>(null)
  const handlers = useRef(new Set<(message: any) => void>())
  const [entries, setEntries] = useState<TreeEntry[]>([])
  const [members, setMembers] = useState<Member[]>([{ ...session.member, online: true }])
  const [current, setCurrent] = useState<string | null>(null)
  const [selection, setSelection] = useState('')
  const [settings, setSettings] = useState<SettingsTab | null>(null)
  const [models, setModels] = useState<ChatModel[]>([])
  const [model, setModel] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [waiting, setWaiting] = useState<Waiting[]>([])
  const [invites, setInvites] = useState(false)
  const [log, setLog] = useState(false)

  const [publish, setPublish] = useState(false)
  const [previews, setPreviews] = useState<Preview[]>([])
  const [showPreviews, setShowPreviews] = useState(false)
  const [showChat, setShowChat] = useState(true)
  const [showTerm, setShowTerm] = useState(false)
  const [connected, setConnected] = useState(false)
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null)
  const [following, setFollowing] = useState<string | null>(null)
  const [shell, setShell] = useState('host')

  // A toast is stamped so that repeating the same sentence still restarts the
  // four second clock instead of leaving the old one on screen.
  const flash = (text: string) => setToast({ text, at: Date.now() })

  const isHost = session.member.role === 'host'
  const canApprove = session.member.role !== 'guest'

  const send = useCallback((data: unknown) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(data))
  }, [])

  const register = useCallback((handler: (message: any) => void) => {
    handlers.current.add(handler)
    return () => {
      handlers.current.delete(handler)
    }
  }, [])

  const refreshTree = useCallback(async () => {
    try {
      const result = await fetchTree(session)
      setEntries(result.entries)
    } catch {}
  }, [session])

  useEffect(() => {
    const ws = new WebSocket(wsUrl(`/room/${session.code}`))
    socket.current = ws
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = event => {
      let message: any
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === 'presence') {
        setMembers(message.members)
        const target = message.members.find((member: Member) => member.id === followingRef.current)
        if (target?.file && target.file !== currentRef.current) open(target.file)
      }
      if (message.type === 'tree') void refreshTree()
      if (message.type === 'previews') {
        setPreviews(message.previews ?? [])
        if (message.note) flash(message.note)
      }
      if (message.type === 'join:queue') setWaiting(message.joins ?? [])
      if (message.type === 'hello') {
        setShell(message.shell ?? 'host')
        setModels(message.models ?? [])
        setModel(current => current || message.models?.[0]?.model || '')
      }
      if (message.type === 'models') {
        setModels(message.models ?? [])
        setModel(current => (message.models ?? []).some((entry: ChatModel) => entry.model === current) ? current : message.models?.[0]?.model ?? '')
      }
      if (message.type === 'term:approval') setPending(current => [...current, message])
      if (message.type === 'term:decision') setPending(current => current.filter(entry => entry.id !== message.id))
      if (message.type === 'notice') flash(message.message)
      if (message.type === 'kicked') onLeave('the host removed you from that room')
      for (const handler of handlers.current) handler(message)
    }
    void refreshTree()
    listPreviews(session).then(result => setPreviews(result.previews)).catch(() => {})
    return () => {
      ws.close()
      socket.current = null
    }
  }, [session.code, refreshTree])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const previous = document.title
    document.title = `${session.code} · climultiplayer`
    return () => {
      document.title = previous
    }
  }, [session.code])

  const currentRef = useRef<string | null>(null)
  const followingRef = useRef<string | null>(null)
  followingRef.current = following

  const demoOpened = useRef(false)
  useEffect(() => {
    if (!session.demo || demoOpened.current) return
    if (!entries.some(entry => entry.path === 'src/notes.md')) return
    demoOpened.current = true
    open('src/notes.md')
  }, [entries.length, session.demo])

  const open = (path: string) => {
    currentRef.current = path
    setCurrent(path)
    setSelection('')
    send({ type: 'file', path })
  }

  const create = async (path: string) => {
    try {
      await createFile(session, path)
      await refreshTree()
      open(path)
    } catch {}
  }

  const remove = async (path: string) => {
    try {
      await deleteFile(session, path)
      if (current === path) setCurrent(null)
      await refreshTree()
    } catch {}
  }

  const copyLink = async (path: string, note: string) => {
    const base = await inviteBase(session)
    const sameMachine = ['127.0.0.1', 'localhost', '::1'].includes(new URL(base).hostname)
    const message = sameMachine ? `${note}, works on this machine only` : note
    try {
      await navigator.clipboard.writeText(`${base}${path}`)
      flash(message)
    } catch {
      flash(`${base}${path}`)
    }
  }

  const makeInvite = async (minutes: number) => {
    try {
      const invite = await createInvite(session, minutes)
      await copyLink(invite.path, 'single-use invite copied')
    } catch (problem: any) {
      flash(problem.message)
    }
  }

  const leave = async () => {
    await leaveRoom().catch(() => {})
    onLeave()
  }

  const refreshModels = async () => send({ type: 'models' })

  return (
    <div className="app">
      <header className="bar">
        <button
          className="room-code"
          onClick={() => makeInvite(1440)}
          aria-label={`room code ${session.code}, click to copy an invite`}
          title="click to copy an invite"
        >
          <span className="code">
            <span className="code-real">{session.code}</span>
            <span className="code-mask" aria-hidden>
              ••••••
            </span>
          </span>
          <b aria-hidden>+</b>
        </button>

        <div className="people">
          {members.map(member => (
            <button
              key={member.id}
              className={`person ${member.online ? 'on' : ''} ${following === member.id ? 'following' : ''}`}
              onClick={() => setFollowing(following === member.id ? null : member.id)}
              title={member.activity ?? member.name}
            >
              <i style={{ background: member.color }} />
              <span>{member.id === session.member.id ? 'you' : member.name}</span>
              {member.role !== 'guest' && <b>{member.role === 'host' ? 'host' : 'trusted'}</b>}
            </button>
          ))}
        </div>

        <div className="spacer" />

        <button className={showChat ? 'ghost on' : 'ghost'} onClick={() => setShowChat(value => !value)} title="room chat and assistant">
          panel
        </button>
        <button className={showTerm ? 'ghost on' : 'ghost'} onClick={() => setShowTerm(value => !value)} title="terminal">
          terminal
        </button>
        <button className={showPreviews ? 'ghost on' : 'ghost'} onClick={() => setShowPreviews(true)} title="live previews of dev servers in the room">
          {previews.length ? `previews ${previews.length}` : 'preview'}
        </button>
        <Menu
          isHost={isHost}
          onSettings={tab => setSettings(tab)}
          onPublish={() => setPublish(true)}
          onInvites={setInvites}
          onLog={setLog}
          onLeave={leave}
          exportHref={exportUrl(session)}
          onEnd={async () => {
            if (!confirm('end the room for everyone? the workspace copy is deleted.')) return
            await endRoom(session).catch(() => {})
            onLeave('you ended that room')
          }}
          onKick={member => async () => {
            if (!confirm(`remove ${member.name}?`)) return
            try {
              const result = await kickMember(session, member.id)
              flash(`${result.name} removed`)
            } catch (problem: any) {
              flash(problem.message)
            }
          }}
          onRole={member => async () => {
            try {
              await setRole(session, member.id, member.role === 'editor' ? 'guest' : 'editor')
            } catch (problem: any) {
              flash(problem.message)
            }
          }}
          others={members.filter(member => member.id !== session.member.id)}
          connected={connected}
          shell={shell}
        />
      </header>

      {(waiting.length > 0 || pending.length > 0) && (
        <div className="notices" role="status" aria-live="polite">
          {waiting.map(entry => (
            <article key={entry.id} className="notice join">
              <header>
                <i className="notice-avatar" aria-hidden>{initials(entry.name)}</i>
                <span><strong>{entry.name}</strong> wants to join</span>
              </header>
              <p className="notice-note">The invite is spent only if you allow.</p>
              {isHost ? (
                <div className="notice-actions">
                  <button onClick={() => decideJoin(session, entry.id, true)}>allow {entry.name}</button>
                  <button className="ghost" onClick={() => decideJoin(session, entry.id, false)}>deny</button>
                </div>
              ) : (
                <em className="notice-wait">waiting for the host</em>
              )}
            </article>
          ))}
          {pending.map(entry => (
            <article key={entry.id} className="notice run">
              <header>
                <i className="notice-avatar" style={{ background: members.find(member => member.id === entry.memberId)?.color ?? 'var(--dim)' }} aria-hidden>
                  {initials(entry.memberName)}
                </i>
                <span><strong>{entry.memberName}</strong> wants to run</span>
              </header>
              <code className="notice-command">{entry.command}</code>
              <div className="notice-reasons">
                {entry.reasons.map(reason => <span key={reason}>{reason}</span>)}
              </div>
              {canApprove ? (
                <div className="notice-actions">
                  <button onClick={() => send({ type: 'approval', id: entry.id, allow: true })}>allow</button>
                  <button className="ghost" onClick={() => send({ type: 'approval', id: entry.id, allow: false })}>deny</button>
                </div>
              ) : (
                <em className="notice-wait">waiting for the host</em>
              )}
              <div className="notice-timer" style={{ animationDuration: `${APPROVAL_MS}ms` }} />
            </article>
          ))}
        </div>
      )}

      {showTerm && (
        <Terminals session={session} register={register} send={send} mode={shell} follow={following} onClose={() => setShowTerm(false)} />
      )}

      <main>
        <Tree entries={entries} current={current} members={members} you={session.member.id} onOpen={open} onCreate={create} onDelete={remove} />

        <section className="pane">
          {current ? (
            <>
              <div className="file-tab">
                <code>{current}</code>
              </div>
              <Editor session={session} path={current} onSelection={setSelection} onTyping={() => send({ type: 'typing' })} />
            </>
          ) : (
            <div className="welcome">
              <h2>pick a file, or create one</h2>
              <p>Everything you type is live for the room. Everyone has their own cursor colour.</p>
            </div>
          )}
        </section>


        {showChat && (
          <section className={`side chat-side ${showChat ? "open" : ""}`}>
            <Rail
              session={session}
              register={register}
              send={send}
              models={models}
              model={model}
              onModel={setModel}
              file={current}
              selection={selection}
            />
          </section>
        )}
      </main>

      {toast && <div className="toast" key={toast.at}>{toast.text}</div>}
      {settings && <Settings session={session} tab={settings} onTab={setSettings} onClose={() => setSettings(null)} onNote={flash} onChanged={refreshModels} />}
      {invites && <Invites session={session} onClose={() => setInvites(false)} onCopied={flash} />}
      {log && <Audit session={session} onClose={() => setLog(false)} />}

      {publish && <Publish session={session} onClose={() => setPublish(false)} onNote={flash} />}
      {showPreviews && <PreviewPanel session={session} previews={previews} onPreviews={setPreviews} onClose={() => setShowPreviews(false)} onNote={flash} />}
    </div>
  )
}

const Invites = ({ session, onClose, onCopied }: { session: Session; onClose: () => void; onCopied: (note: string) => void }) => {
  const [list, setList] = useState<Invite[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = () => listInvites(session).then(result => setList(result.invites)).catch(() => {})

  useEffect(() => {
    void refresh()
  }, [])

  const make = async (minutes: number) => {
    setBusy(true)
    try {
      const invite = await createInvite(session, minutes)
      const base = await inviteBase(session)
      const sameMachine = ['127.0.0.1', 'localhost', '::1'].includes(new URL(base).hostname)
      await navigator.clipboard.writeText(`${base}${invite.path}`).catch(() => {})
      onCopied(sameMachine ? 'single-use invite copied, works on this machine only' : 'single-use invite copied')
      await refresh()
    } catch (problem: any) {
      onCopied(problem.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={event => event.stopPropagation()}>
        <header>
          <h2>Invites</h2>
          <button className="link" onClick={onClose}>
            close
          </button>
        </header>
        <p className="muted">Each invite works once, for one person, and can be revoked. The token sits in the link fragment, so the server never logs it.</p>
        <div className="row">
          <button disabled={busy} onClick={() => make(60)}>
            1 hour
          </button>
          <button disabled={busy} onClick={() => make(1440)}>
            24 hours
          </button>
          <button disabled={busy} onClick={() => make(10080)}>
            7 days
          </button>
        </div>
        <ul className="accounts">
          {list.map(invite => (
            <li key={invite.id}>
              <div>
                <strong className={invite.state === 'open' ? 'on' : 'off'}>{invite.state}</strong>
                <span className="muted">created {new Date(invite.createdAt).toLocaleString()}</span>
              </div>
              {invite.state === 'open' && (
                <div className="row">
                  <button
                    onClick={async () => {
                      await revokeInvite(session, invite.id).catch(() => {})
                      await refresh()
                    }}
                  >
                    revoke
                  </button>
                </div>
              )}
            </li>
          ))}
          {!list.length && <li className="muted">no invites yet</li>}
        </ul>
      </div>
    </div>
  )
}


const Audit = ({ session, onClose }: { session: Session; onClose: () => void }) => {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  useEffect(() => {
    void auditLog(session).then(result => setEntries(result.entries)).catch(() => {})
    const timer = setInterval(() => void auditLog(session).then(result => setEntries(result.entries)).catch(() => {}), 3000)
    return () => clearInterval(timer)
  }, [session])

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={event => event.stopPropagation()}>
        <header>
          <h2>Command log</h2>
          <button className="link" onClick={onClose}>
            close
          </button>
        </header>
        <p className="muted">What ran in this room and who allowed it. Kept for the session only.</p>
        <ul className="accounts">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <div>
                <code>{entry.command}</code>
                <span className="muted">
                  {entry.name} · {entry.decision} · {new Date(entry.at).toLocaleTimeString()}
                </span>
              </div>
            </li>
          ))}
          {!entries.length && <li className="muted">nothing has run yet</li>}
        </ul>
      </div>
    </div>
  )
}

type MenuProps = {
  isHost: boolean
  connected: boolean
  shell: string
  others: Member[]
  onSettings: (tab: SettingsTab) => void
  onPublish: () => void
  onInvites: (open: boolean) => void
  onLog: (open: boolean) => void
  onLeave: () => void
  onEnd: () => void
  exportHref: string
  onKick: (member: Member) => () => void
  onRole: (member: Member) => () => void
}

const Menu = (props: MenuProps) => {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <div className="menu">
      <button className="ghost" onClick={() => setOpen(value => !value)} title="more">
        ···
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className="menu-sheet">
            <span className={props.connected ? 'menu-state on' : 'menu-state off'}>{props.connected ? 'live' : 'reconnecting'}</span>
            <span className={props.shell === 'container' ? 'menu-state on' : 'menu-state warn'}>
              {props.shell === 'container' ? 'container shell' : 'host shell'}
            </span>
            <button onClick={() => { props.onSettings('accounts'); close() }}>Settings…</button>
            {props.isHost && <button onClick={() => { props.onInvites(true); close() }}>Invites</button>}
            {props.isHost && <button onClick={() => { props.onPublish(); close() }}>Publish site</button>}
            {props.isHost && <a href={props.exportHref} download onClick={close}>Download room</a>}
            {props.isHost && <button onClick={() => { props.onLog(true); close() }}>Command log</button>}
            {props.isHost && props.others.length > 0 && (
              <>
                <span className="menu-label">people</span>
                {props.others.map(member => (
                  <div className="menu-row" key={member.id}>
                    <span>{member.name}</span>
                    <button className="ghost" onClick={() => { props.onRole(member)(); close() }}>
                      {member.role === 'editor' ? 'untrust' : 'trust'}
                    </button>
                    <button className="ghost" onClick={() => { props.onKick(member)(); close() }}>
                      remove
                    </button>
                  </div>
                ))}
              </>
            )}
            <span className="menu-label">room</span>
            {props.isHost && <button onClick={() => { props.onEnd(); close() }}>End room</button>}
            <button onClick={() => { props.onLeave(); close() }}>Leave</button>
          </div>
        </>
      )}
    </div>
  )
}
