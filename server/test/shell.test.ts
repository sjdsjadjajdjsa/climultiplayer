import { afterEach, describe, expect, it, vi } from 'vitest'

const load = async (mode: 'host' | 'docker') => {
  vi.stubEnv('CLIMP_SHELL', mode)
  vi.resetModules()
  return { shell: await import('../src/shell.js'), container: await import('../src/container.js'), term: await import('../src/term.js') }
}

afterEach(() => vi.unstubAllEnvs())

describe('room shell plan', () => {
  it('uses the host shell when asked to', async () => {
    const { shell } = await load('host')
    const plan = shell.shellPlan('ABC123')
    expect(plan.mode).toBe('host')
    expect(plan.container).toBeNull()
    expect(plan.args).toEqual(['-l'])
  })

  it('execs into the room container for the shared shell', async () => {
    const { shell } = await load('docker')
    const plan = shell.shellPlan('ABC123')
    expect(plan.mode).toBe('container')
    expect(plan.file).toBe('docker')
    expect(plan.container).toBe('climp-room-abc123')
    expect(plan.args.slice(0, 3)).toEqual(['exec', '-it', '--user'])
    expect(plan.args.join(' ')).toContain('HOME=/homes/shared')
    expect(plan.args.at(-1)).toBe('-l')
  })
})

describe('room container', () => {
  it('mounts only the workspace and the room homes, and drops capabilities', async () => {
    const { container } = await load('docker')
    const args = container.containerRunArgs('ABC123', '/data/rooms/ABC123/workspace')
    expect(args).toContain('--cap-drop')
    expect(args).toContain('ALL')
    expect(args).toContain('no-new-privileges')
    expect(args).toContain('--pids-limit')
    expect(args.filter(entry => entry === '-v')).toHaveLength(2)
    expect(args.join(' ')).toContain('-v /data/rooms/ABC123/workspace:/workspace')
    expect(args.join(' ')).not.toContain('docker.sock')
    expect(args.at(-2)).toBe('sleep')
  })

  it('freezes the image and gives back only a writable /tmp', async () => {
    const { container } = await load('docker')
    const args = container.containerRunArgs('ABC123', '/ws')
    expect(args).toContain('--read-only')
    expect(args.join(' ')).toContain('--tmpfs /tmp:rw')
    expect(args).toContain('--ulimit')
  })

  it('can cut the network entirely, or use host networking', async () => {
    vi.stubEnv('CLIMP_ROOM_NETWORK', 'none')
    const none = (await load('docker')).container.containerRunArgs('X', '/ws')
    expect(none[none.indexOf('--network') + 1]).toBe('none')

    vi.stubEnv('CLIMP_ROOM_NETWORK', 'host')
    const host = (await load('docker')).container.containerRunArgs('X', '/ws')
    expect(host[host.indexOf('--network') + 1]).toBe('host')
  })

  it('runs as the server user so written files stay owned', async () => {
    const { container } = await load('docker')
    const args = container.containerRunArgs('X', '/ws')
    expect(args[args.indexOf('--user') + 1]).toMatch(/^\d+:\d+$/)
  })

  it('names the session home per member', async () => {
    const { container } = await load('docker')
    const plan = container.execPlan('X', 'member1', '/homes/member1')
    expect(plan.args.join(' ')).toContain('HOME=/homes/member1')
    expect(plan.args.at(-2)).toBe('/bin/bash')
  })
})

describe('shared terminal reuse', () => {
  it('hands two concurrent openers the same shell', async () => {
    const { term } = await load('host')
    const first = term.openTerminal('ROOM1', process.cwd())
    const second = term.openTerminal('ROOM1', process.cwd())
    const [one, two] = await Promise.all([first, second])
    expect(one).toBe(two)
    await one.ready
    term.closeTerminal('ROOM1')
    // The pty is native: give it a beat to unwind before the worker exits.
    await new Promise(resolve => setTimeout(resolve, 150))
  })
})
