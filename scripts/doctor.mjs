// Checks what a first run needs and says how to fix what is missing.
// Run with: npm run doctor
import { execFileSync, spawnSync } from 'node:child_process'
import { connect } from 'node:net'

const port = Number(process.env.PORT ?? 8787)
const image = process.env.CLIMP_ROOM_IMAGE ?? 'climultiplayer-room:latest'
let failed = 0

const line = (state, text, fix = '') => {
  if (state === 'fail') failed += 1
  const mark = { ok: 'ok  ', fail: 'FIX ', note: 'note' }[state]
  console.log(`${mark} ${text}`)
  if (fix) console.log(`       ${fix}`)
}

const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 })

const major = Number(process.versions.node.split('.')[0])
major >= 20
  ? line('ok', `node ${process.versions.node}`)
  : line('fail', `node ${process.versions.node} is too old`, 'install Node 20 or newer: https://nodejs.org')

const dockerVersion = run('docker', ['--version'])
if (dockerVersion.error || dockerVersion.status !== 0) {
  line('fail', 'docker is not installed', 'install Docker: https://docs.docker.com/get-docker/ (without it only you can use the shell, with CLIMP_SHELL=host)')
} else {
  const daemon = run('docker', ['info', '--format', '{{.ServerVersion}}'])
  if (daemon.status !== 0) {
    line('fail', 'docker is installed but not running', 'start Docker Desktop, or on Linux: sudo systemctl start docker')
  } else {
    line('ok', `docker ${daemon.stdout.trim()} is running`)
    const found = run('docker', ['image', 'inspect', image])
    found.status === 0
      ? line('ok', `the room image ${image} is built`)
      : line('fail', `the room image ${image} is not built yet`, 'build it once: npm run room:image (about 870 MB, a few minutes)')
  }
}

const portFree = await new Promise(resolve => {
  const socket = connect({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve(false) })
  socket.once('error', () => resolve(true))
})
portFree
  ? line('ok', `port ${port} is free`)
  : line('fail', `something is already listening on port ${port}`, `stop it, or pick another: PORT=${port + 10} npm start`)

try {
  execFileSync('cloudflared', ['--version'], { stdio: 'ignore' })
  line('ok', 'cloudflared is installed, so npm run tunnel works')
} catch {
  line('note', 'cloudflared is not installed', 'only needed for friends on other networks (npm run tunnel): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
}

console.log(failed ? `\n${failed} thing${failed === 1 ? '' : 's'} to fix before npm start will work well.` : '\nready: run npm start, then open http://127.0.0.1:' + port)
process.exit(failed ? 1 : 0)
