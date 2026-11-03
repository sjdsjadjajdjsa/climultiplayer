// Opens every surface in one run and writes a screenshot per step, for eyeballing
// a change across the whole app. Run with: npm run test:walk.
import { spawn } from 'node:child_process'
import { mkdir as mkdirRecursive, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { ready, startRoom } from './landing.mjs'

const port = 9000 + Math.floor(Math.random() * 900)
const data = await mkdtemp(join(tmpdir(), 'climp-walk-'))
const out = process.env.WALK_OUT ?? '/tmp/climp-walk'
const server = spawn('node', ['server/dist/server.js'], {
  env: { ...process.env, CLIMP_DATA: data, PORT: String(port), CLIMP_SHELL: process.env.CLIMP_SHELL ?? 'host', CLIMP_ROOM_NETWORK: process.env.CLIMP_ROOM_NETWORK ?? 'host' },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${port}`
for (let attempt = 0; attempt < 60; attempt++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
  await new Promise(resolve => setTimeout(resolve, 200))
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/chromium', args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
const page = await context.newPage()
const steps = []
const shot = async name => {
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' })
  steps.push(name)
}

try {
  await mkdirRecursive(out, { recursive: true })
  await page.goto(base)
  await ready(page)
  await shot('01-landing')

  await startRoom(page, 'alex', process.cwd())
  await page.waitForSelector('.room-code', { timeout: 40_000 })
  await shot('02-room-empty')

  await page.click('.tree >> text=README.md')
  await page.waitForSelector('.cm-line')
  await shot('03-editor')

  await page.fill('textarea[placeholder^="message the room"]', 'seeing the room as a guest would')
  await page.press('textarea[placeholder^="message the room"]', 'Enter')
  await page.locator('.rail-tab').nth(1).click()
  await shot('04-assistant')
  await page.locator('.rail-tab').nth(0).click()

  await page.click('button[title="terminal"]')
  await page.waitForSelector('.card-term.shared')
  await shot('05-terminals')
  await page.click('.stage-bar button:has-text("new")')
  await page.waitForTimeout(2500)
  await shot('06-terminal-personal')
  await page.click('.stage-bar button:has-text("close")')

  for (const [label, name] of [['Invites', '07-invites'], ['Publish site', '08-publish'], ['Settings', '09-settings'], ['Command log', '10-log']]) {
    await page.click('.menu > button')
    await page.click(`.menu-sheet button:has-text("${label}")`)
    await shot(name)
    // Escape is not bound on the modals; the close link is.
    const close = page.locator('.modal-card button:has-text("close")')
    if (await close.count()) await close.first().click()
    await page.waitForTimeout(300)
  }
  console.log(`wrote ${steps.length} shots to ${out}`)
} catch (problem) {
  await page.screenshot({ path: join(out, '99-failure.png') })
  console.log('stopped:', problem.message.split('\n')[0])
} finally {
  await browser.close()
  server.kill()
  await rm(data, { recursive: true, force: true })
}
