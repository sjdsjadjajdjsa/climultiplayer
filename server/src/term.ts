import { spawn as spawnPty, type IPty } from 'node-pty'
import { maxTerminalScrollback } from './config.js'
import { shellPlan } from './shell.js'
import { ensureRoomContainer, removeRoomContainer } from './container.js'

export type Terminal = {
  pty: IPty
  scrollback: string[]
  listeners: Set<(data: string) => void>
  idle: NodeJS.Timeout | null
  container: string | null
  mode: 'container' | 'host'
  ready: Promise<void>
}

const terminals = new Map<string, Terminal>()
const starting = new Map<string, Promise<Terminal>>()

const push = (terminal: Terminal, data: string) => {
  terminal.scrollback.push(data)
  let total = terminal.scrollback.reduce((sum, part) => sum + part.length, 0)
  while (terminal.scrollback.length > maxTerminalScrollback || total > 120_000) {
    const dropped = terminal.scrollback.shift()
    total -= dropped?.length ?? 0
    if (!terminal.scrollback.length) break
  }
  for (const listener of terminal.listeners) listener(data)
}

export const openTerminal = async (roomCode: string, cwd: string) => {
  const existing = terminals.get(roomCode)
  if (existing) {
    if (existing.idle) clearTimeout(existing.idle)
    existing.idle = null
    return existing
  }
  // Two sockets can arrive while a container is still booting. Without this
  // they each spawned a pty and the loser's output went nowhere.
  const pending = starting.get(roomCode)
  if (pending) return pending
  const work = start(roomCode, cwd)
  starting.set(roomCode, work)
  try {
    return await work
  } finally {
    starting.delete(roomCode)
  }
}

const start = async (roomCode: string, cwd: string) => {
  await ensureRoomContainer(roomCode, cwd)
  const plan = shellPlan(roomCode)
  const pty = spawnPty(plan.file, plan.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })
  const terminal: Terminal = { pty, scrollback: [], listeners: new Set(), idle: null, container: plan.container, mode: plan.mode, ready: Promise.resolve() }
  // Typing into a pty before its shell has printed a prompt loses the bytes,
  // so the first reader waits for the shell to speak (or give up shortly).
  terminal.ready = new Promise<void>((resolve) => {
    const done = setTimeout(resolve, 1200)
    pty.onData(() => {
      clearTimeout(done)
      resolve()
    })
  })
  pty.onData(data => push(terminal, data))
  pty.onExit(({ exitCode }) => {
    push(terminal, `\r\n[the shell exited${exitCode ? ` (${exitCode})` : ''}, reconnect to start a new one]\r\n`)
    terminals.delete(roomCode)
    // The room container is detached now, so it stays; only the shared session
    // is gone.
  })
  terminals.set(roomCode, terminal)
  return terminal
}

export const runCommand = (terminal: Terminal, command: string) => {
  terminal.pty.write(`${command}\r`)
}

export const resizeTerminal = (terminal: Terminal, cols: number, rows: number) => {
  try {
    terminal.pty.resize(Math.max(20, Math.min(cols, 400)), Math.max(5, Math.min(rows, 200)))
  } catch {}
}

export const closeTerminal = (roomCode: string) => {
  const terminal = terminals.get(roomCode)
  if (!terminal) return
  terminals.delete(roomCode)
  try {
    terminal.pty.kill()
  } catch {}
}

export const closeRoomShell = async (roomCode: string) => {
  closeTerminal(roomCode)
  await removeRoomContainer(roomCode)
}
