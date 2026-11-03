import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { yCollab } from 'y-codemirror.next'
import { WebsocketProvider } from 'y-websocket'
import { Doc, UndoManager } from 'yjs'
import type { Session } from './api'
import { themeFor } from './theme'

const languageFor = (path: string) => {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return javascript({ typescript: /\.tsx?$/.test(path), jsx: /\.(tsx|jsx)$/.test(path) })
  if (/\.py$/.test(path)) return python()
  if (/\.rs$/.test(path)) return rust()
  if (/\.html?$/.test(path)) return html()
  if (/\.css$/.test(path)) return css()
  if (/\.json$/.test(path)) return json()
  if (/\.(md|markdown)$/.test(path)) return markdown()
  return []
}

export const Editor = ({ session, path, onSelection, onTyping }: { session: Session; path: string; onSelection: (text: string) => void; onTyping: () => void }) => {
  const holder = useRef<HTMLDivElement>(null)
  const selection = useRef(onSelection)
  selection.current = onSelection
  const typing = useRef(onTyping)
  typing.current = onTyping
  const lastTyped = useRef(0)

  useEffect(() => {
    if (!holder.current) return
    const doc = new Doc()
    const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${session.code}`
    const provider = new WebsocketProvider(base, path, doc)
    provider.awareness.setLocalStateField('user', { name: session.member.name, color: session.member.color, role: session.member.role })
    const undo = new UndoManager(doc.getText('text'), { captureTimeout: 400 })
    const language = new Compartment()
    const theme = new Compartment()
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => view.dispatch({ effects: theme.reconfigure(themeFor(dark.matches)) })
    dark.addEventListener('change', applyTheme)
    const view = new EditorView({
      parent: holder.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup,
          EditorView.contentAttributes.of({ 'aria-label': 'file contents' }),
          theme.of(themeFor(dark.matches)),
          language.of(languageFor(path)),
          yCollab(doc.getText('text'), provider.awareness, { undoManager: undo }),
          EditorView.updateListener.of(update => {
            if (update.docChanged && Date.now() - lastTyped.current > 1200) {
              lastTyped.current = Date.now()
              typing.current()
            }
            if (!update.selectionSet) return
            const range = update.state.selection.main
            selection.current(range.empty ? '' : update.state.sliceDoc(range.from, range.to))
          }),
        ],
      }),
    })
    provider.on('status', (event: { status: string }) => {
      const element = holder.current?.parentElement
      element?.classList.toggle('offline', event.status !== 'connected')
    })
    // Line metrics go stale when the pane is resized or the monospace face
    // arrives after the first paint, and the text drifts off its gutter.
    const measure = () => view.requestMeasure()
    const observer = new ResizeObserver(measure)
    observer.observe(holder.current)
    void document.fonts.ready.then(measure)
    return () => {
      observer.disconnect()
      dark.removeEventListener('change', applyTheme)
      view.destroy()
      undo.destroy()
      provider.destroy()
      doc.destroy()
    }
  }, [session.code, path])

  return <div className="editor" ref={holder} />
}
