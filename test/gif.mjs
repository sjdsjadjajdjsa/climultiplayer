// Records the README GIF: a room used the way a person would, then trims it to a
// looping clip. Run with: npm run docs:gif.
import { spawn, execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { joinFromLink, ready } from './landing.mjs'

const port = 9000 + Math.floor(Math.random() * 900)
const data = await mkdtemp(join(tmpdir(), 'climp-gif-'))
const server = spawn('node', ['server/dist/server.js'], {
  env: { ...process.env, CLIMP_DATA: data, PORT: String(port), CLIMP_SHELL: 'docker', CLIMP_ROOM_NETWORK: 'host', CLIMP_ALLOW_HOST_NETWORK: '1' },
  stdio: 'ignore',
})

const base = `http://127.0.0.1:${port}`
for (let attempt = 0; attempt < 50; attempt++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
  await new Promise(resolve => setTimeout(resolve, 200))
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/chromium', args: ['--no-sandbox'] })
const hostContext = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  recordVideo: { dir: await mkdtemp(join(tmpdir(), 'climp-frames-')), size: { width: 1440, height: 810 } },
})
await hostContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
const page = await hostContext.newPage()

// Only the host is filmed. Two more people act in browsers of their own, and
// everything they do reaches the host's screen the way it would in real use:
// their cursors, their messages, their commands and their approval requests.
const people = {}
for (const name of ['sam', 'robin']) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  people[name] = { context, page: await context.newPage() }
}

const chat = 'textarea[placeholder^="message the room"]'
const say = async (who, text) => {
  await who.click(chat)
  await who.type(chat, text, { delay: 32 })
  await who.press(chat, 'Enter')
  await who.waitForTimeout(650)
}
const typeAt = async (who, line, text) => {
  await who.locator('.cm-line').nth(line).click()
  await who.keyboard.press('End')
  await who.keyboard.type(text, { delay: 70 })
}
const inviteLink = async () => {
  await page.click('.room-code')
  await page.waitForTimeout(500)
  return page.evaluate(() => navigator.clipboard.readText())
}

try {
  // Landing: type a name, then demo.
  await page.goto(base)
  await ready(page)
  await page.waitForTimeout(900)
  await page.type('.term-prompt input', 'alex', { delay: 110 })
  await page.press('.term-prompt input', 'Enter')
  await page.waitForSelector('.term-actions')
  await page.waitForTimeout(600)
  await page.type('.term-prompt input', 'demo', { delay: 110 })
  await page.waitForTimeout(250)
  await page.press('.term-prompt input', 'Enter')
  await page.waitForSelector('.cm-line', { timeout: 40_000 })
  await page.waitForTimeout(900)

  // Two invites, and two people ask in.
  const first = await inviteLink()
  await page.waitForTimeout(700)
  const second = await inviteLink()
  await Promise.all([joinFromLink(people.sam.page, first, 'sam'), joinFromLink(people.robin.page, second, 'robin')])
  for (const name of ['sam', 'robin']) {
    await page.waitForSelector(`.notice.join:has-text("${name}")`)
    await page.waitForTimeout(1100)
    await page.click(`.notice.join:has-text("${name}") .notice-actions button`)
    await page.waitForTimeout(500)
  }
  for (const { page: guest } of Object.values(people)) {
    await guest.waitForSelector('.room-code', { timeout: 30_000 })
    await guest.locator('.tree >> text=notes.md').click()
    await guest.waitForSelector('.cm-line')
  }
  await page.waitForTimeout(900)

  // Three cursors, one file, at the same time.
  await Promise.all([
    typeAt(page, 2, '  <- alex'),
    typeAt(people.sam.page, 3, '  <- sam is here'),
    typeAt(people.robin.page, 5, '  <- and robin'),
  ])
  await page.waitForTimeout(1300)

  // They talk in the room chat.
  await say(people.sam.page, 'all three of us are in the same file')
  await say(people.robin.page, 'cursors and everything, nice')
  await say(page, 'trying the shell next')

  // The shared shell: a safe command runs, a risky one asks the host first.
  await page.click('button[title="terminal"]')
  await page.waitForSelector('.card-term.shared')
  await page.waitForTimeout(900)
  for (const guest of Object.values(people)) await guest.page.click('button[title="terminal"]')
  const line = 'input[placeholder="run a command everyone sees"]'
  await people.sam.page.type(line, 'node src/greeting.js sam', { delay: 45 })
  await people.sam.page.press(line, 'Enter')
  await page.waitForTimeout(2600)
  await people.robin.page.type(line, 'rm -rf build dist', { delay: 45 })
  await people.robin.page.press(line, 'Enter')
  await page.waitForSelector('.notice.run')
  await page.waitForTimeout(2000)
  await page.click('.notice.run button:has-text("allow")')
  await page.waitForTimeout(2400)
} finally {
  await hostContext.close()
  for (const { context } of Object.values(people)) await context.close()
  await browser.close()
  server.kill()
}

const video = await page.video().path()
const frames = await mkdtemp(join(tmpdir(), 'climp-png-'))
// Frames first, then ImageMagick: webm straight to a palettised gif loses the
// light background and hands back a green frame.
execFileSync('ffmpeg', ['-y', '-i', video, '-vf', 'fps=10,scale=900:-2', join(frames, '%03d.png')], { stdio: 'ignore' })
const out = 'docs/room.gif'
const shots = readdirSync(frames).sort().map(name => join(frames, name))
execFileSync('magick', ['-delay', '10', ...shots, '-fuzz', '2%', '-layers', 'optimize', out], { stdio: 'ignore' })
await rm(data, { recursive: true, force: true })
await rm(frames, { recursive: true, force: true })
console.log(`wrote ${out}`)
