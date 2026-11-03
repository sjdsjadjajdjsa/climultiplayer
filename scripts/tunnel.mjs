// Runs the server behind a public tunnel so a link works for someone on another
// network. Needs cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
//
// Two tunnels: one for the room, one for live previews. A preview is a separate
// origin on purpose, so it needs its own public address.
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const port = process.env.PORT ?? '8787'
const previewPort = process.env.CLIMP_PREVIEW_PORT ?? String(Number(port) + 1)

if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('cloudflared is not on PATH. Install it, then run this again:')
  console.error('  arch:  sudo pacman -S cloudflared')
  console.error('  apt:   see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
  process.exit(1)
}

const children = []
const stopAll = (code = 0) => {
  for (const child of children) child.kill()
  process.exit(code)
}

// The tunnels only speak to loopback, so the ports themselves stay closed.
const openTunnel = target =>
  new Promise(resolve => {
    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${target}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(tunnel)
    tunnel.on('exit', code => stopAll(code ?? 0))
    createInterface({ input: tunnel.stderr }).on('line', line => {
      const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)
      if (found) resolve(found[0])
    })
  })

const [roomLink, previewLink] = await Promise.all([openTunnel(port), openTunnel(previewPort)])

const server = spawn('node', ['server/dist/server.js'], {
  env: { ...process.env, PORT: port, HOST: '127.0.0.1', CLIMP_PREVIEW_PORT: previewPort, CLIMP_PREVIEW_URL: previewLink, CLIMP_PUBLIC_URL: roomLink },
  stdio: ['ignore', 'inherit', 'inherit'],
})
children.push(server)
server.on('exit', code => stopAll(code ?? 0))

console.log(`\n  start your room here: http://127.0.0.1:${port}`)
console.log(`  friends join through: ${roomLink} (invites use it)`)
console.log(`  previews:             ${previewLink} (room members only)`)
console.log('  rooms can only be started on this machine; everyone else comes in by invite.\n')

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopAll(0))
