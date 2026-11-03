import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#a33a1a' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#1d1b16' },
  { tag: [t.function(t.variableName), t.labelName], color: '#2c5a7a' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#8a5a12' },
  { tag: [t.definition(t.name), t.separator], color: '#1d1b16' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#8a5a12' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#476572' },
  { tag: [t.meta, t.comment], color: '#8a8473', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.heading, fontWeight: '600', color: '#1d1b16' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#8a5a12' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: '#2d6a45' },
  { tag: t.invalid, color: '#b3321f' },
])

const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#ff8f66' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#ece7da' },
  { tag: [t.function(t.variableName), t.labelName], color: '#8ab4d0' },
  { tag: [t.definition(t.name), t.separator], color: '#ece7da' },
  { tag: [t.typeName, t.className, t.number], color: '#d9a85c' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#9fb8c4' },
  { tag: [t.meta, t.comment], color: '#8a8473', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: '#8fc79f' },
  { tag: t.invalid, color: '#ff8a78' },
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

export const termTheme = (_dark: boolean) => ({
  background: '#1b1914',
  foreground: '#ece7da',
  cursor: '#ff8f66',
  selectionBackground: '#4a3f33',
  black: '#4a463a',
  red: '#ff8a78',
  green: '#8fd0a0',
  yellow: '#e6c07b',
  blue: '#8ab4d0',
  magenta: '#d6a0c8',
  cyan: '#8fd0c8',
  white: '#ece7da',
  brightBlack: '#8a8473',
})
