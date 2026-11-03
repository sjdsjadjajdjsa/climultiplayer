import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const port = Number(process.env.PORT ?? 8787)
// Local by default. `--lan` (npm run host) opens it to the network, which is how
// a host invites friends from their own machine.
export const lan = process.argv.includes('--lan')
export const host = process.env.HOST ?? (lan ? '0.0.0.0' : '127.0.0.1')
export const dataDir = resolve(process.env.CLIMP_DATA ?? join(homedir(), '.local', 'share', 'climultiplayer'))
export const webDir = process.env.CLIMP_WEB ?? resolve(import.meta.dirname, '..', '..', 'web', 'dist')
export const maxFileBytes = Number(process.env.CLIMP_MAX_FILE ?? 2 * 1024 * 1024)
export const maxTerminalScrollback = 2000
export const maxChatHistory = 40
export const roomIdleMinutes = Number(process.env.CLIMP_ROOM_IDLE_MINUTES ?? 180)

export const ignoredNames = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'target', '.next', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.idea', '.DS_Store', '.cache', '.turbo', 'coverage',
])

export const ignoredSuffixes = ['.pyc', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.mp4', '.mp3']

// Guests get a shell, so it runs in a throwaway container by default: only the
// workspace is mounted, no host home directory, capped CPU and memory.
export const shellMode = process.env.CLIMP_SHELL ?? 'auto'
export const roomImage = process.env.CLIMP_ROOM_IMAGE ?? 'climultiplayer-room:latest'
export const roomMemory = process.env.CLIMP_ROOM_MEMORY ?? '1g'
export const roomCpus = process.env.CLIMP_ROOM_CPUS ?? '1'
export const roomNetwork = process.env.CLIMP_ROOM_NETWORK ?? 'bridge'
export const roomPids = Number(process.env.CLIMP_ROOM_PIDS ?? 512)
