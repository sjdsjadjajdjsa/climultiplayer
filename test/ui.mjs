// Drives the real UI in a real browser: two contexts, one room, the whole join
// and edit path. Run with: npm run test:ui (needs a chromium binary).
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const port = 9000 + Math.floor(Math.random() * 900)
const data = await mkdtemp(join(tmpdir(), 'climp-ui-'))
const browserPath = process.env.CHROME_BIN ?? '/usr/bin/chromium'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

const server = spawn('node', ['server/dist/server.js'], {
  env: { ...process.env, CLIMP_DATA: data, PORT: String(port), CLIMP_SHELL: process.env.CLIMP_SHELL ?? 'host', CLIMP_ROOM_NETWORK: process.env.CLIMP_ROOM_NETWORK ?? 'host' },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${port}`

for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 200))
}

const browser = await chromium.launch({ executablePath: browserPath, args: ['--no-sandbox'] })
const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await hostCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
const host = await hostCtx.newPage()
const guest = await guestCtx.newPage()

const errors = []
for (const page of [host, guest]) page.on('pageerror', error => errors.push(error.message))

try {
  await host.goto(base)
  await host.fill('input[placeholder="alex"]', 'alex')
  await host.click('button:has-text("start room")')
  await host.waitForSelector('.room-code')
  const code = (await host.textContent('.room-code')).trim().slice(0, 6)

  await host.click('.room-code')
  await host.waitForTimeout(400)
  const link = await host.evaluate(() => navigator.clipboard.readText())
  check('an invite link is copied', link.includes(`#t=`), link.slice(0, 60))

  await guest.goto(link)
  await guest.waitForSelector('.chip')
  check('the link fills the room in for the guest', (await guest.textContent('.chip')).includes(code))
  check('the code field is gone when a link is used', (await guest.locator('input.code-input').count()) === 0)

  await guest.fill('input[placeholder="alex"]', 'sam')
  await guest.click('button:has-text("join with invite")')
  await guest.waitForSelector('.waiting')
  check('the guest waits instead of entering', true)

  await host.waitForSelector('.approval.join')
  check('the host sees the join queue', true)
  await host.click('.approval.join button:has-text("allow")')
  await guest.waitForSelector('.app', { timeout: 8000 })
  check('allowing lets the guest in', true)
  await guest.waitForSelector('.person', { timeout: 4000 })
  check('both members are listed', (await host.locator('.person').count()) === 2)

  await guest.fill('.chat-input textarea', 'hey alex')
  await guest.keyboard.press('Enter')
  await host.waitForSelector('.say:has-text("hey alex")', { timeout: 5000 })
  check('the room chat reaches the other person', true)

  await host.click('text=+ new')
  await host.fill('input[placeholder="src/thing.ts"]', 'notes.md')
  await host.keyboard.press('Enter')
  await host.waitForSelector('.cm-content')
  await host.click('.cm-content')
  await host.keyboard.type('hello from alex')
  await guest.click('.tree .name:text("notes.md")')
  await guest.waitForSelector('.cm-line')
  await guest.waitForTimeout(600)
  const guestText = await guest.textContent('.cm-content')
  check('typing syncs to the other browser', guestText.includes('hello from alex'), guestText.slice(0, 40))
  check('a remote cursor is drawn', (await guest.locator('.cm-ySelectionCaret').count()) > 0)

  await guest.click('button:text("terminal")')
  await guest.waitForSelector('.stage')
  await guest.fill('.card-input input', 'pwd')
  await guest.keyboard.press('Enter')
  await guest.waitForTimeout(1200)
  const terminal = await guest.textContent('.xterm-rows')
  check('the shared shell runs a harmless command', terminal.includes('/workspace'))

  await guest.fill('.card-input input', 'rm -rf nothing-here')
  await guest.keyboard.press('Enter')
  await host.waitForSelector('.approval:not(.join)', { timeout: 5000 })
  check('a risky guest command asks the host', true)
  await host.click('.approval:not(.join) button:has-text("deny")')
  await guest.waitForTimeout(800)
  check('denying reports back to the guest', (await guest.textContent('.xterm-rows')).includes('denied'))

  await guest.reload()
  await guest.waitForSelector('.app', { timeout: 8000 })
  check('a reload keeps the guest in the room', true)

  if ((await guest.locator('.stage').count()) === 0) await guest.click('button:text("terminal")')
  await guest.click('.stage-bar button:text("+ new")')
  await guest.waitForSelector('.card-term:has-text("you")', { timeout: 8000 })
  await guest.waitForTimeout(900)
  await guest.click('.card-term.on .card-body')
  await guest.keyboard.type('echo tty-works')
  await guest.keyboard.press('Enter')
  await guest.waitForTimeout(900)
  check('a member can open their own terminal', (await guest.textContent('.card-term.on .xterm-rows')).includes('tty-works'))

  if ((await host.locator('.stage').count()) === 0) await host.click('button:text("terminal")')
  await host.click('.card-term:has-text("sam")')
  await host.waitForTimeout(900)
  const watched = await host.textContent('.card-term.on .xterm-rows')
  check('others can watch that terminal read only', watched.includes('tty-works'), watched.slice(-40))

  await guest.keyboard.type('echo keep > ~/persisted')
  await guest.keyboard.press('Enter')
  await guest.waitForTimeout(700)
  await guest.reload()
  await guest.waitForSelector('.app')
  await guest.click('button:text("terminal")')
  await guest.click('.stage-bar button:text("+ new")')
  await guest.waitForSelector('.card-term:has-text("you")')
  await guest.waitForTimeout(1500)
  await guest.click('.card-term.on .card-body')
  await guest.keyboard.type('cat ~/persisted 2>/dev/null || echo missing')
  await guest.keyboard.press('Enter')
  await guest.waitForTimeout(1200)
  check('a home directory survives a reconnect', (await guest.textContent('.card-term.on .xterm-rows')).includes('keep'))

  await host.click('.person:has-text("sam")')
  await host.waitForTimeout(400)
  check('following a member works', (await host.locator('.person.following').count()) === 1)

  await host.waitForTimeout(1400)
  check('follow mode parks on their terminal', (await host.textContent('.card-term.on header')).includes('sam'))
  await host.click('.person.following')

  await guest.click('.menu button.ghost')
  await guest.click('.menu-sheet button:text("Settings…")')
  await guest.click('.settings-tabs button:text("tools and keys")')
  await guest.waitForSelector('.modal-card')
  await guest.waitForSelector('.accounts li', { timeout: 8000 }).catch(() => {})
  const toolsText = await guest.textContent('.modal-card')
  check('the tools catalog is listed', toolsText.includes('Crush'), toolsText.slice(0, 80).replace(/\s+/g, ' '))
  await guest.click('.modal-card button:text("close")')
  await guest.click('.card-term:has-text("shared shell")')

  await host.click('.menu button.ghost')
  await host.click('.menu-row:has-text("sam") button:text("trust")')
  await guest.waitForTimeout(500)
  check('the host can trust a guest', (await host.textContent('.person:has-text("sam")')).includes('trusted'))
  if ((await guest.locator('.stage').count()) === 0) await guest.click('button:text("terminal")')
  await guest.fill('.card-input input', 'rm -f also-nothing')
  await guest.keyboard.press('Enter')
  await guest.waitForTimeout(900)
  check('an editor runs risky commands without asking', !(await host.isVisible('.approval:not(.join)')))

  await host.click('.menu button.ghost')
  await host.click('.menu-sheet button:text("Command log")')
  await host.waitForSelector('.modal-card code')
  check('the log shows what ran', (await host.textContent('.modal-card')).includes('rm -f also-nothing'))
  await host.click('.modal-card button:text("close")')

  const exported = await host.evaluate(async url => {
    const res = await fetch(url)
    return { type: res.headers.get('content-type'), bytes: (await res.arrayBuffer()).byteLength }
  }, `${base}/api/rooms/${code}/export`)
  check('the host can download the room', exported.type.includes('gzip') && exported.bytes > 20, JSON.stringify(exported))

  host.on('dialog', dialog => dialog.accept())
  await host.click('.menu button.ghost')
  await host.click('.menu-row:has-text("sam") button:text("remove")')
  await guest.waitForSelector('.join-inner', { timeout: 6000 })
  check('a kicked guest is put back on the landing page', (await guest.textContent('.join-inner')).includes('removed'))
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 120))
} catch (problem) {
  check(`flow aborted: ${problem.message.slice(0, 100)}`, false)
  await host.screenshot({ path: '/tmp/climp-host-fail.png' }).catch(() => {})
  await guest.screenshot({ path: '/tmp/climp-guest-fail.png' }).catch(() => {})
} finally {
  await browser.close()
  server.kill()
  // Room containers are detached, so the test has to clear its own.
  const { execFileSync } = await import('node:child_process')
  try {
    const names = execFileSync('docker', ['ps', '--filter', 'name=climp-room-', '--format', '{{.Names}}']).toString()
    for (const name of names.split('\n').map(line => line.trim()).filter(Boolean)) execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  } catch {}
  await rm(data, { recursive: true, force: true })
}

const failed = checks.filter(entry => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
