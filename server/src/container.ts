import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir, roomCpus, roomImage, roomMemory, roomNetwork, roomPids, shellMode } from './config.js'

export const containerName = (code: string) => `climp-room-${code.toLowerCase()}`
// Homes live on the host next to the workspace, so the server user already owns
// them and nothing needs chowning inside the container.
export const homesDir = (code: string) => join(dataDir, 'rooms', code, 'homes')

const dockerSockets = ['/var/run/docker.sock', '/run/user/1000/docker.sock']

export const dockerAvailable = () =>
  process.env.CLIMP_SHELL === 'docker' || dockerSockets.some(path => existsSync(path)) || Boolean(process.env.DOCKER_HOST)

export const useDocker = () => (shellMode === 'host' ? false : shellMode === 'docker' ? true : dockerAvailable())

const uid = () => (typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid?.() ?? process.getuid()}` : '1000:1000')

const docker = (args: string[], timeout = 15_000) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile('docker', args, { timeout }, (error: any, stdout) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout: String(stdout ?? '') }))
  })

// A VPN on the host often kills the docker bridge while the host itself still
// has network. Rooms then boot fine and quietly fail every install, so the
// startup path checks once and points at the fix.
export const bridgeEgress = async () => {
  if (!useDocker() || roomNetwork !== 'bridge') return true
  const probe = await docker([
    'run', '--rm', '--network', 'bridge', roomImage,
    'node', '-e', "fetch('https://registry.npmjs.org', { signal: AbortSignal.timeout(2500) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
  ], 12_000)
  return probe.code === 0
}

// The run flags, kept separate so they can be asserted without docker.
export const containerRunArgs = (code: string, workspace: string) => [
  'run', '-d', '--rm', '--init',
  '--name', containerName(code),
  '--hostname', 'room',
  '--user', uid(),
  '-e', 'TERM=xterm-256color',
  '--memory', roomMemory,
  '--cpus', roomCpus,
  '--pids-limit', String(roomPids),
  '--ulimit', 'nofile=1024:2048',
  '--read-only',
  '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=256m',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  ...(roomNetwork === 'bridge' ? [] : ['--network', roomNetwork]),
  '-v', `${workspace}:/workspace`,
  '-v', `${homesDir(code)}:/homes`,
  '-w', '/workspace',
  roomImage,
  'sleep', 'infinity',
]

// One container per room, started detached so it outlives any single socket. The
// workspace and the room's home volume are the only mounts.
export const ensureRoomContainer = async (code: string, workspace: string) => {
  if (!useDocker()) return null
  const name = containerName(code)
  const running = await docker(['inspect', '-f', '{{.State.Running}}', name])
  if (running.code === 0 && running.stdout.trim() === 'true') return name
  await docker(['rm', '-f', name], 10_000)
  await mkdir(homesDir(code), { recursive: true })
  const started = await docker(containerRunArgs(code, workspace), 30_000)
  if (started.code !== 0) throw new Error(`could not start the room container: ${started.stdout.trim().slice(0, 200)}`)
  return name
}

// A member's persistent home inside the room volume, so CLI sign-ins survive a
// reconnect but never touch the host's home directory.
export const ensureHome = async (code: string, memberId: string) => {
  if (!useDocker()) return `/tmp/climp-home-${memberId}`
  const home = `/homes/${memberId}`
  await docker(['exec', containerName(code), 'mkdir', '-p', `${home}/.npm-global/bin`])
  // A login shell that picks up per-member keys and the tool path.
  await docker(['exec', containerName(code), 'sh', '-c', `[ -f ${home}/.bashrc ] || printf '%s\n' 'export npm_config_prefix="$HOME/.npm-global"' 'export PATH="$HOME/.npm-global/bin:$PATH"' '[ -f "$HOME/.env" ] && . "$HOME/.env"' > ${home}/.bashrc`])
  return home
}

// Extra PATH entries for a member's own tool installs, mirroring .bashrc.
export const memberPath = (memberId: string) => `/homes/${memberId}/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`

export const execPlan = (code: string, memberId: string, home: string) =>
  useDocker()
    ? {
        file: 'docker',
        args: ['exec', '-it', '--user', uid(), '-e', `HOME=${home}`, '-e', 'npm_config_prefix=' + home + '/.npm-global', '-e', `PATH=${memberPath(memberId)}`, '-e', 'TERM=xterm-256color', containerName(code), '/bin/bash', '-l'],
        mode: 'container' as const,
      }
    : { file: process.env.SHELL || '/bin/sh', args: ['-l'], mode: 'host' as const }

export const removeRoomContainer = async (code: string) => {
  if (!useDocker()) return
  await docker(['rm', '-f', containerName(code)])
}
