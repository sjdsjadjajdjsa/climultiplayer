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
execFileSync('docker', ['exec', name, 'sh', '-c', 'pkill -f "[h]ttp.server 8000" || true; mkdir -p site && cd site && cat > srv.py <<PY\nimport http.server\nclass H(http.server.BaseHTTPRequestHandler):\n  def do_GET(self):\n    self.send_response(200); self.send_header("content-type","text/plain")\n    self.send_header("set-cookie","app=1; Path=/")\n    self.end_headers(); self.wfile.write(("cookies=" + self.headers.get("Cookie","(none)")).encode())\n  def log_message(self,*a): pass\nhttp.server.HTTPServer(("0.0.0.0",8000),H).serve_forever()\nPY\n(nohup python3 srv.py >/tmp/s.log 2>&1 &)'])
await new Promise(r => setTimeout(r, 2500))
const startRes = await fetch(`${base}/api/rooms/${room.code}/previews`, { method: 'POST', headers: { ...json, cookie: session }, body: JSON.stringify({ port: 8000 }) })
const started = await startRes.json()
console.log('start', startRes.status, JSON.stringify(started))
const openRes = await fetch(`${base}/api/rooms/${room.code}/previews/${started.id}/open`, { method: 'POST', headers: { cookie: session } })
const opened = await openRes.json()
console.log('open', openRes.status, JSON.stringify(opened))

const exchange = await fetch(opened.url, { redirect: 'manual' })
const pass = (exchange.headers.getSetCookie?.() ?? [exchange.headers.get('set-cookie')]).join('|')
const cookie = /climp_pv=[^;]+/.exec(pass)?.[0]
console.log('exchange', exchange.status, '| our cookie:', Boolean(cookie), '| app cookie kept:', /app=1/.test(pass))
const page = await fetch('http://127.0.0.1:8788/', { headers: { cookie: `${cookie}; climp=planted; keep=1` } })
console.log('proxied', page.status, '| upstream saw:', (await page.text()).slice(0, 60))
const bare = await fetch('http://127.0.0.1:8788/')
console.log('no pass', bare.status)
const reuse = await fetch(opened.url)
console.log('ticket reuse', reuse.status)

// ending the room kills the pass
await fetch(`${base}/api/rooms/${room.code}`, { method: 'DELETE', headers: { cookie: session } })
await new Promise(r => setTimeout(r, 500))
const after = await fetch('http://127.0.0.1:8788/', { headers: { cookie } })
console.log('after the room ends', after.status)
socket.close()
