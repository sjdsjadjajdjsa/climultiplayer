// Regenerates the README screenshots against a throwaway server and a room of
// its own. Run with: npm run docs:shots.
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const port = 9000 + Math.floor(Math.random() * 900)
const data = await mkdtemp(join(tmpdir(), 'climp-docs-'))
const server = spawn('node', ['server/dist/server.js'], { env: { ...process.env, CLIMP_DATA: data, PORT: String(port), CLIMP_SHELL: process.env.CLIMP_SHELL ?? 'docker', CLIMP_ROOM_NETWORK: process.env.CLIMP_ROOM_NETWORK ?? 'host' }, stdio: 'ignore' })
const base = `http://127.0.0.1:${port}`
for (let attempt = 0; attempt < 50; attempt++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
  await new Promise(resolve => setTimeout(resolve, 200))
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/chromium', args: ['--no-sandbox'] })
const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await hostCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
const host = await hostCtx.newPage()
const guest = await guestCtx.newPage()

try {
  await host.goto(base)
  await host.waitForSelector('.shell-badge')
  await host.screenshot({ path: 'docs/landing.png' })

  await host.fill('input[placeholder="alex"]', 'alex')
  await host.fill('input[placeholder="/home/you/project"]', process.cwd())
  await host.click('button:has-text("start room")')
  await host.waitForSelector('.room-code', { timeout: 40_000 })
  await host.click('.room-code')
  await host.waitForTimeout(400)
  const link = await host.evaluate(() => navigator.clipboard.readText())

  await guest.goto(link)
  await guest.fill('input[placeholder="alex"]', 'sam')
  await guest.click('button:has-text("join with invite")')
  await host.waitForSelector('.approval.join')
  await host.click('.approval.join button:has-text("allow")')
  await guest.waitForSelector('.room-code', { timeout: 20_000 })

  await host.click('.tree >> text=README.md')
  await host.waitForSelector('.cm-line')
  await host.waitForTimeout(1500)
  await host.evaluate(() => window.dispatchEvent(new Event('resize')))
  await host.waitForTimeout(500)
  await guest.click('.tree >> text=README.md')
  await guest.waitForSelector('.cm-line')
  await guest.waitForTimeout(500)
  await guest.click('.cm-line >> nth=11')
  await host.waitForTimeout(400)
  await guest.fill('textarea[placeholder^="message the room"]', 'this is so much faster than screen sharing')
  await guest.press('textarea[placeholder^="message the room"]', 'Enter')
  await host.waitForTimeout(800)
  console.log(await host.evaluate(() => ({
    editors: document.querySelectorAll('.cm-editor').length,
    x: Math.round(document.querySelector('.cm-line').getBoundingClientRect().x),
    gx: Math.round(document.querySelector('.cm-gutterElement').getBoundingClientRect().x),
    lh: getComputedStyle(document.querySelector('.cm-line')).lineHeight,
    scroll: document.querySelector('.cm-scroller').scrollLeft,
  })))
  await host.evaluate(() => { document.querySelector('.cm-scroller').scrollLeft = 0 })
  await host.waitForTimeout(400)
  await host.screenshot({ path: 'docs/room.png' })

  await host.click('button:has-text("terminal")')
  await guest.click('button:has-text("terminal")')
  await guest.waitForSelector('.card-term.shared')
  await guest.fill('input[placeholder="run a command everyone sees"]', 'git log --oneline -3')
  await guest.press('input[placeholder="run a command everyone sees"]', 'Enter')
  await host.waitForTimeout(3500)
  await host.screenshot({ path: 'docs/terminals.png' })
  console.log('wrote docs/landing.png, docs/room.png, docs/terminals.png')
} finally {
  await browser.close()
  server.kill()
}
