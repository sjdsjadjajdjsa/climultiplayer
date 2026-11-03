const base = 'http://127.0.0.1:8787'
const json = { 'content-type': 'application/json' }
const room = await (await fetch(`${base}/api/rooms`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'host' }) })).json()
const auth = { ...json, 'x-climp-token': room.token }
const WebSocket = (await import('ws')).default
const socket = new WebSocket(`ws://127.0.0.1:8787/room/${room.code}?token=${encodeURIComponent(room.token)}`)
await new Promise(r => socket.on('open', r))
await new Promise(r => setTimeout(r, 5000))
const { execFileSync } = await import('node:child_process')
execFileSync('docker', ['exec', `climp-room-${room.code.toLowerCase()}`, 'sh', '-c', 'mkdir -p site && printf "<h1>preview ok</h1>" > site/index.html && cd site && (nohup python3 -m http.server 8000 --bind 0.0.0.0 >/tmp/s.log 2>&1 &)'])
await new Promise(r => setTimeout(r, 2500))
const started = await (await fetch(`${base}/api/rooms/${room.code}/previews`, { method: 'POST', headers: auth, body: JSON.stringify({ port: 8000 }) })).json()
const session = `climp=${room.code}.${room.token}`
const opened = await fetch(`${base}/api/rooms/${room.code}/previews/${started.id}/open`, { method: 'POST', headers: { cookie: session } })
console.log('open', opened.status, (await opened.text()).slice(0, 120))
socket.close()
