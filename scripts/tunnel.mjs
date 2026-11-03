// Runs the server behind a public tunnel so a link works for someone on another
// network. Needs cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const port = process.env.PORT ?? '8787'

if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('cloudflared is not on PATH. Install it, then run this again:')
  console.error('  arch:  sudo pacman -S cloudflared')
  console.error('  apt:   see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
  process.exit(1)
}

const server = spawn('node', ['server/dist/server.js'], {
  env: { ...process.env, PORT: port, HOST: '127.0.0.1' },
  stdio: ['ignore', 'inherit', 'inherit'],
})

// The tunnel only speaks to loopback, so the port itself stays closed.
const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })

const watch = createInterface({ input: tunnel.stderr })
watch.on('line', (line) => {
  const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)
  if (!found) return
  console.log(`\n  public room link: ${found[0]}`)
  console.log('  open it, start a room, and send the invite from inside.\n')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    tunnel.kill()
    server.kill()
    process.exit(0)
  })
}

tunnel.on('exit', code => {
  server.kill()
  process.exit(code ?? 0)
})
