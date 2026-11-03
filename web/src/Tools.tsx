import { useEffect, useState } from 'react'
import { installTool, toolsList, type Member, type Session, type Tool } from './api'

export const Tools = ({ session, onNote }: { session: Session; onNote: (note: string) => void }) => {
  const [tools, setTools] = useState<Tool[]>([])
  const [available, setAvailable] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [output, setOutput] = useState<Record<string, string>>({})

  const refresh = () =>
    toolsList(session)
      .then(result => {
        setTools(result.tools)
        setAvailable(result.container)
      })
      .catch(() => {})

  useEffect(() => {
    void refresh()
  }, [])

  const install = async (tool: Tool) => {
    setBusy(tool.id)
    const result = await installTool(session, tool.id).catch((problem: any) => ({ ok: false, output: problem.message }))
    setOutput(current => ({ ...current, [tool.id]: result.output }))
    setBusy(null)
    onNote(result.ok ? `${tool.name} installed in your home` : `${tool.name} did not install`)
    await refresh()
  }

  return (
    <div className="settings-body">
        <p className="muted">
          Extra harnesses install into your own home, not the shared image, and only your terminals see them. Keys are written to <code>~/.env</code>, sourced by your shell.
        </p>
        {!available && <p className="error">installs need the room container; keys still save on disk</p>}
        <ul className="accounts">
          {tools.map(tool => (
            <li key={tool.id}>
              <div>
                <strong>{tool.name}</strong>
                <span className={tool.installed ? 'on' : 'off'}>{tool.installed ? 'installed' : tool.note}</span>
                <span className="muted package" title={`${tool.kind} · ${tool.package}`}>
                  {tool.kind}
                </span>
              </div>
              <div className="row">
                <button disabled={busy === tool.id || !available || tool.installed} onClick={() => install(tool)}>
                  {tool.installed ? 'ready' : busy === tool.id ? 'installing…' : 'install'}
                </button>
              </div>
              {output[tool.id] && <pre className="install-log">{output[tool.id].slice(-600)}</pre>}
            </li>
          ))}
        </ul>
    </div>
  )
}
