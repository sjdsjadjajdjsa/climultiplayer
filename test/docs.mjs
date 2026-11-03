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
await hostCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
const host = await hostCtx.newPage()
const people = [{ page: host, name: 'alex' }]
for (const name of ['sam', 'robin']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  people.push({ page: await ctx.newPage(), name })
}

const lastLine = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.xterm-rows > div')].map(row => (row.textContent ?? '')).filter(line => line.trim())
  return rows.at(-1) ?? ''
})

const waitChange = async (page, before, timeout = 20_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await lastLine(page) !== before) return
    await page.waitForTimeout(200)
  }
}

const idle = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.xterm-rows > div')].map(row => (row.textContent ?? '').trim()).filter(Boolean)
  return /node@room:\/workspace\$$/.test(rows.at(-1) ?? '')
})

const waitIdle = async (page, timeout = 180_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await idle(page)) return
    await page.waitForTimeout(400)
  }
  throw new Error('the shell never came back')
}

const poster = async (page, text) => {
  const field = page.locator('textarea[placeholder^="message the room"]')
  await field.click()
  await field.fill(text)
  await page.waitForTimeout(150)
  await field.press('Enter')
  await page.waitForTimeout(700)
}

try {
  await host.goto(base)
  await host.waitForSelector('.shell-badge')
  await host.screenshot({ path: 'docs/landing.png' })

  await host.fill('input[placeholder="alex"]', 'alex')
  await host.fill('input[placeholder="/home/you/project"]', process.cwd())
  await host.click('button:has-text("start room")')
  await host.waitForSelector('.room-code', { timeout: 40_000 })

  for (const guest of people.slice(1)) {
    await host.click('.room-code')
    await host.waitForTimeout(400)
    const link = await host.evaluate(() => navigator.clipboard.readText())
    await guest.page.goto(link)
    await guest.page.fill('input[placeholder="alex"]', guest.name)
    await guest.page.click('button:has-text("join with invite")')
    await host.waitForSelector(`.notice.join:has-text("${guest.name}")`)
    await host.click(`.notice.join:has-text("${guest.name}") .notice-actions button`)
    await guest.page.waitForSelector('.room-code', { timeout: 20_000 })
  }

  await people[1].page.click('button[title="terminal"]')
  await people[1].page.waitForSelector('.card-term.shared')
  await people[1].page.fill('input[placeholder="run a command everyone sees"]', 'rm -rf dist && npm run build')
  await people[1].page.press('input[placeholder="run a command everyone sees"]', 'Enter')
  await host.waitForSelector('.notice.run', { timeout: 20_000 })
  await host.waitForTimeout(900)
  await host.screenshot({ path: 'docs/notice.png' })
  await host.click('.notice.run button:has-text("allow")')
  await people[1].page.click('button[title="terminal"]')
  await host.waitForTimeout(1500)

  for (const person of people) {
    await person.page.click('.tree >> text=README.md')
    await person.page.waitForSelector('.cm-line')
  }
  await host.waitForTimeout(900)

  await people[1].page.click('.cm-line >> nth=30')
  await people[1].page.keyboard.down('Shift')
  await people[1].page.click('.cm-line >> nth=32')
  await people[1].page.keyboard.up('Shift')
  await people[2].page.click('.cm-line >> nth=34')
  await people[1].page.click('textarea[placeholder^="message the room"]')

  await poster(people[1].page, 'the intro is doing too much, want to trim it?')
  await poster(people[2].page, 'line 34 is the stack, start there, I will take the intro')
  await poster(host, 'go for it, I will run the tests')
  await poster(people[2].page, 'pushing in a sec, give me two minutes')
  await poster(people[1].page, 'can we keep the screenshot in? it sells it')
  await host.waitForTimeout(1200)
  console.log('host chat lines:', (await host.locator('.chat-log li, .chat-log > *').allTextContents()).length, 'guest2:', await people[2].page.locator('textarea[placeholder^="message the room"]').inputValue())
  await host.evaluate(() => {
    const log = document.querySelector('.chat-log')
    if (log) log.scrollTop = log.scrollHeight
  })
  await host.waitForTimeout(300)
  await host.screenshot({ path: 'docs/room.png' })

  await host.click('button[title="terminal"]')
  await people[1].page.click('button[title="terminal"]')
  await people[1].page.waitForSelector('.card-term.shared')
  await people[1].page.fill('input[placeholder="run a command everyone sees"]', 'git log --oneline -3')
  await people[1].page.press('input[placeholder="run a command everyone sees"]', 'Enter')
  await people[1].page.waitForTimeout(1200)

  await people[2].page.click('button[title="terminal"]')
  await people[2].page.waitForTimeout(900)
  const opener = people[2].page.locator('button:has-text("open a terminal")')
  if (await opener.count()) await opener.click({ force: true })
  await people[2].page.waitForTimeout(2500)
  await people[2].page.click('.card-term:not(.shared)')
  await people[2].page.waitForTimeout(600)
  await people[2].page.keyboard.type('ls -1 web/src | head -4')
  await people[2].page.keyboard.press('Enter')
  await people[2].page.waitForTimeout(2000)

  await host.click('.card-term:not(.shared)', { force: true })
  await host.waitForTimeout(800)
  await people[2].page.keyboard.type('git log --oneline -2')
  await people[2].page.keyboard.press('Enter')
  await people[2].page.waitForTimeout(2500)

  await people[1].page.waitForTimeout(600)
  for (const command of ['npm install --silent', 'npm test 2>&1 | tail -6']) {
    const before = await lastLine(host)
    await host.fill('input[placeholder="run a command everyone sees"]', command)
    await host.press('input[placeholder="run a command everyone sees"]', 'Enter')
    await waitChange(host, before)
    await waitIdle(host)
  }
  await host.waitForTimeout(1500)
  await host.evaluate(() => {
    for (const viewport of document.querySelectorAll('.xterm-viewport')) viewport.scrollTop = viewport.scrollHeight
  })
  await host.waitForTimeout(600)
  await host.screenshot({ path: 'docs/terminals.png' })
  console.log('wrote docs/landing.png, docs/room.png, docs/terminals.png')
} finally {
  await browser.close()
  server.kill()
}
