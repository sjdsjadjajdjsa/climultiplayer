import { execFileSync } from 'node:child_process'
const base = 'http://127.0.0.1:8787'
const json = { 'content-type': 'application/json' }
const room = await (await fetch(`${base}/api/rooms`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'host' }) })).json()
const auth = { ...json, 'x-climp-token': room.token }
const name = `climp-room-${room.code.toLowerCase()}`

// start a terminal so the container exists, then serve a page inside it
const WebSocket = (await import('ws')).default
const socket = new WebSocket(`ws://127.0.0.1:8787/room/${room.code}?token=${encodeURIComponent(room.token)}`)
await new Promise(r => socket.on('open', r))
await new Promise(r => setTimeout(r, 5000))
execFileSync('docker', ['exec', name, 'sh', '-c', 'mkdir -p /workspace/site && printf "<h1>preview ok</h1>" > /workspace/site/index.html && cd /workspace/site && (nohup python3 -m http.server 8000 --bind 0.0.0.0 >/tmp/s.log 2>&1 &)'])
await new Promise(r => setTimeout(r, 2500))

const started = await fetch(`${base}/api/rooms/${room.code}/previews`, { method: 'POST', headers: auth, body: JSON.stringify({ port: 8000 }) })
console.log('start preview', started.status, (await started.text()).slice(0, 80))
const { id } = await (await fetch(`${base}/api/rooms/${room.code}/previews`, { method: 'POST', headers: auth, body: JSON.stringify({ port: 8000 }) })).json().catch(() => ({}))

const list = await (await fetch(`${base}/api/rooms/${room.code}/previews`, { headers: auth })).json()
console.log('listed previews', list.previews.length)
const opened = await (await fetch(`${base}/api/rooms/${room.code}/previews/${list.previews[0].id}/open`, { method: 'POST', headers: auth })).json()
console.log('url', opened.url?.replace(/t=.*/, 't=…'))

const first = await fetch(opened.url, { redirect: 'manual' })
const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]
console.log('ticket exchange', first.status, '| cookie set:', Boolean(cookie), '| location:', first.headers.get('location'))
const again = await fetch(opened.url, { redirect: 'manual' })
console.log('ticket reuse', again.status)

const page = await fetch(`http://127.0.0.1:8788/`, { headers: { cookie } })
console.log('gateway page with cookie', page.status, (await page.text()).slice(0, 40).replace(/\n/g, ' '))
const anon = await fetch(`http://127.0.0.1:8788/`)
console.log('gateway without cookie', anon.status, (await anon.text()).slice(0, 40).replace(/\n/g, ' '))

// cookie stripping: preview must not see our cookies
execFileSync('docker', ['exec', name, 'sh', '-c', 'pkill -f "http.server 8000" || true'])
execFileSync('docker', ['exec', name, 'sh', '-c', 'cd /workspace/site && cat > echo.py <<PY\nimport http.server\nclass H(http.server.BaseHTTPRequestHandler):\n  def do_GET(self):\n    body = self.headers.get("Cookie", "(none)")\n    self.send_response(200); self.send_header("content-type","text/plain"); self.end_headers(); self.wfile.write(body.encode())\n  def log_message(self,*a): pass\nhttp.server.HTTPServer(("0.0.0.0",8000),H).serve_forever()\nPY\n(nohup python3 echo.py >/tmp/e.log 2>&1 &)'])
await new Promise(r => setTimeout(r, 2000))
const echoed = await fetch(`http://127.0.0.1:8788/`, { headers: { cookie: `${cookie}; climp=planted; other=keep` } })
console.log('upstream saw cookies:', (await echoed.text()).slice(0, 80))
socket.close()
