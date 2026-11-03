import { execFileSync } from 'node:child_process'
const base = 'http://127.0.0.1:8787'
const json = { 'content-type': 'application/json' }
const room = await (await fetch(`${base}/api/rooms`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'host' }) })).json()
const session = `climp=${room.code}.${room.token}`
const name = `climp-room-${room.code.toLowerCase()}`
const WebSocket = (await import('ws')).default
const socket = new WebSocket(`ws://127.0.0.1:8787/room/${room.code}?token=${encodeURIComponent(room.token)}`)
await new Promise(r => socket.on('open', r))
await new Promise(r => setTimeout(r, 5000))
execFileSync('docker', ['exec', name, 'sh', '-c', 'pkill -f "[h]ttp.server 8000" || true'])
execFileSync('docker', ['cp', '/tmp/echo.py', `${name}:/workspace/echo.py`])
execFileSync('docker', ['exec', '-d', name, 'python3', '/workspace/echo.py'])
await new Promise(r => setTimeout(r, 1500))
const started = await (await fetch(`${base}/api/rooms/${room.code}/previews`, { method: 'POST', headers: { ...json, cookie: session }, body: JSON.stringify({ port: 8000 }) })).json()
const opened = await (await fetch(`${base}/api/rooms/${room.code}/previews/${started.id}/open`, { method: 'POST', headers: { cookie: session } })).json()
const exchange = await fetch(opened.url, { redirect: 'manual' })
const setCookies = exchange.headers.getSetCookie?.() ?? []
const pass = /climp_pv=[^;]+/.exec(setCookies.join('|'))?.[0]
const page = await fetch('http://127.0.0.1:8788/', { headers: { cookie: `${pass}; climp=planted; keep=1` } })
console.log('upstream cookie header:', (await page.text()).slice(0, 80))
console.log('set-cookie back to browser:', (page.headers.getSetCookie?.() ?? []).join(' | '))
socket.close()
