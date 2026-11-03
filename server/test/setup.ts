import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLIMP_DATA = mkdtempSync(join(tmpdir(), 'climp-test-'))
process.env.CLIMP_ROOM_IDLE_MINUTES = '600'
// The room shell is the point of half the suite and only the container has
// guests' semantics, so run in it when the image exists. Fall back to the host
// shell on machines without docker; the host-mode rules get their own file.
const dockerReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', 'climultiplayer-room:latest'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
process.env.CLIMP_SHELL = dockerReady ? 'docker' : 'host'
process.env.CLIMP_ROOM_NETWORK = 'host'
process.env.CLIMP_ALLOW_HOST_NETWORK = '1'
