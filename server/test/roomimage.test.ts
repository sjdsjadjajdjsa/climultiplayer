import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fake `docker` on PATH, so the pull path is exercised for real on machines
// without docker. It records every call and keeps image state in a file.
const bench = join(tmpdir(), `climp-fake-docker-${process.pid}`)
const calls = join(bench, 'calls.log')
const localTag = join(bench, 'has-local')
const remoteTag = join(bench, 'has-remote')
const pullFails = join(bench, 'pull-fails')
const pullSlow = join(bench, 'pull-slow')

const setupFakeDocker = (options: { local?: boolean; remote?: boolean; failPull?: boolean; slowPull?: boolean }) => {
  rmSync(bench, { recursive: true, force: true })
  mkdirSync(bench, { recursive: true })
  if (options.local) writeFileSync(localTag, '')
  if (options.remote) writeFileSync(remoteTag, '')
  if (options.failPull) writeFileSync(pullFails, '')
  if (options.slowPull) writeFileSync(pullSlow, '')
  const script = `#!/bin/sh
echo "$*" >> "${calls}"
case "$1" in
  image)
    case "$3" in
      climultiplayer-room:latest) [ -f "${localTag}" ] && exit 0 || exit 1 ;;
      *) [ -f "${remoteTag}" ] && exit 0 || exit 1 ;;
    esac
    ;;
  pull)
    [ -f "${pullSlow}" ] && sleep 2
    [ -f "${pullFails}" ] && { echo "unauthorized"; exit 1; }
    touch "${remoteTag}"
    echo "pulling from ghcr.io"
    exit 0
    ;;
esac
exit 0
`
  const file = join(bench, 'docker')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  return file
}

const load = async () => {
  vi.stubEnv('CLIMP_SHELL', 'docker')
  vi.resetModules()
  return await import('../src/container.js')
}

const loggedCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '')

beforeEach(() => {
  process.env.PATH = `${bench}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(bench, { recursive: true, force: true })
})

describe('room image', () => {
  it('keeps using a local build when one exists', async () => {
    setupFakeDocker({ local: true })
    const container = await load()
    expect(await container.ensureRoomImage()).toBe(true)
    expect(container.roomImageInUse()).toBe('climultiplayer-room:latest')
    expect(loggedCalls()).not.toContain('pull')
  })

  it('pulls the published image when nothing local matches', async () => {
    setupFakeDocker({})
    const container = await load()
    const lines: string[] = []
    expect(await container.ensureRoomImage(line => lines.push(line))).toBe(true)
    expect(container.roomImageInUse()).toBe('ghcr.io/sjdsjadjajdjsa/climultiplayer-room:latest')
    expect(loggedCalls()).toContain('pull ghcr.io/sjdsjadjajdjsa/climultiplayer-room:latest')
    expect(lines[0]).toContain('pulling')
    expect(lines.at(-1)).toContain('room image ready')
  })

  it('pulls once even when several rooms ask at the same moment', async () => {
    setupFakeDocker({})
    const container = await load()
    const [first, second] = await Promise.all([container.ensureRoomImage(), container.ensureRoomImage()])
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(loggedCalls().split('\n').filter(line => line.startsWith('pull')).length).toBe(1)
  })

  it('says what went wrong and points at the build script when the pull fails', async () => {
    setupFakeDocker({ failPull: true })
    const container = await load()
    const lines: string[] = []
    expect(await container.ensureRoomImage(line => lines.push(line))).toBe(false)
    expect(container.roomImageInUse()).toBe('climultiplayer-room:latest')
    expect(lines.join(' ')).toContain('could not pull')
    expect(lines.join(' ')).toContain('npm run room:image')
  })

  it('reports a pull in flight so the landing page can say so', async () => {
    setupFakeDocker({ slowPull: true })
    const container = await load()
    const run = container.ensureRoomImage()
    await vi.waitFor(() => expect(container.roomImagePulling()).toBe(true))
    await run
    expect(container.roomImagePulling()).toBe(false)
  })
})
