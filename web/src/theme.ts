import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#a626a4' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#1f2328' },
  { tag: [t.function(t.variableName), t.labelName], color: '#2f6bff' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#b76b01' },
  { tag: [t.definition(t.name), t.separator], color: '#1f2328' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#b76b01' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#0184bc' },
  { tag: [t.meta, t.comment], color: '#8b8d95', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.heading, fontWeight: '600', color: '#1f2328' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#b76b01' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: '#12915b' },
  { tag: t.invalid, color: '#d64545' },
])

const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#c792ea' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#e8e9ec' },
  { tag: [t.function(t.variableName), t.labelName], color: '#6f9bff' },
  { tag: [t.definition(t.name), t.separator], color: '#e8e9ec' },
  { tag: [t.typeName, t.className, t.number], color: '#d8a657' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#7cc7e8' },
  { tag: [t.meta, t.comment], color: '#8b8d95', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: '#4fbf8a' },
  { tag: t.invalid, color: '#ef7070' },
])

const shared = {
  '&': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--dim)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 24%, transparent)' },
  '.cm-ySelectionCaret': { color: '#fff' },
}

export const themeFor = (dark: boolean) => [
  EditorView.theme(shared, { dark }),
  syntaxHighlighting(dark ? darkHighlight : lightHighlight),
]

export const termTheme = (dark: boolean) => ({
  background: dark ? '#111214' : '#ffffff',
  foreground: dark ? '#d6d7db' : '#1f2328',
  cursor: dark ? '#6f9bff' : '#2f6bff',
  selectionBackground: dark ? '#33467c' : '#cfe0ff',
  black: '#1f2328',
  red: '#d64545',
  green: '#12915b',
  yellow: '#b76b01',
  blue: '#2f6bff',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#e8e9ec',
  brightBlack: '#74757f',
})
