import { containerName, execPlan, useDocker } from './container.js'

export type ShellPlan = { file: string; args: string[]; container: string | null; mode: 'container' | 'host' }

export { useDocker }

// The shared command line runs inside the room container when there is one.
export const shellPlan = (code: string): ShellPlan => {
  if (!useDocker()) return { file: process.env.SHELL || '/bin/sh', args: ['-l'], container: null, mode: 'host' }
  return { ...execPlan(code, 'shared', '/homes/shared'), container: containerName(code) }
}

// Containers outlive a killed server, because the CLI is what dies with the
// room. Reap any whose room is no longer loaded.
export const reapOrphanContainers = async (knownCodes: string[]) => {
  if (!useDocker()) return 0
  const { execFile } = await import('node:child_process')
  const keep = new Set(knownCodes.map(containerName))
  const names = await new Promise<string[]>((resolve) => {
    execFile('docker', ['ps', '--filter', 'name=climp-room-', '--format', '{{.Names}}'], (error, stdout) => {
      resolve(error ? [] : stdout.split('\n').map(line => line.trim()).filter(Boolean))
    })
  })
  const orphans = names.filter(name => !keep.has(name))
  for (const name of orphans) execFile('docker', ['rm', '-f', name], () => {})
  return orphans.length
}
