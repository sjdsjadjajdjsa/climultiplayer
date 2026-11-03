// Records the README GIF: a room used the way a person would, then trims it to a
// looping clip. Run with: npm run docs:gif.
import { spawn, execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

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
const context = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  recordVideo: { dir: await mkdtemp(join(tmpdir(), 'climp-frames-')), size: { width: 1440, height: 810 } },
})
const page = await context.newPage()

try {
  await page.goto(base)
  await page.fill('input[placeholder="alex"]', 'alex')
  await page.fill('input[placeholder="/home/you/project"]', process.cwd())
  await page.click('button:has-text("start room")')
  await page.waitForSelector('.room-code', { timeout: 40_000 })
  await page.waitForTimeout(800)

  await page.click('.tree >> text=README.md')
  await page.waitForSelector('.cm-line')
  await page.waitForTimeout(600)
  const line = await page.locator('.cm-line >> nth=5').boundingBox()
  await page.mouse.click((line?.x ?? 260) + 8, (line?.y ?? 300) + 8)
  await page.keyboard.type('Made together, in one tab. ')
  await page.waitForTimeout(900)

  await page.fill('textarea[placeholder^="message the room"]', 'taking the intro, you do the shell')
  await page.press('textarea[placeholder^="message the room"]', 'Enter')
  await page.waitForTimeout(700)

  await page.click('button[title="terminal"]')
  await page.waitForSelector('.card-term.shared')
  await page.fill('input[placeholder="run a command everyone sees"]', 'git log --oneline -2')
  await page.press('input[placeholder="run a command everyone sees"]', 'Enter')
  await page.waitForTimeout(2600)
  await page.click('.card-term.shared')
  await page.waitForTimeout(1200)
} finally {
  await context.close()
  await browser.close()
  server.kill()
}

const video = await page.video().path()
const frames = await mkdtemp(join(tmpdir(), 'climp-png-'))
// Frames first, then ImageMagick: webm straight to a palettised gif loses the
// light background and hands back a green frame.
execFileSync('ffmpeg', ['-y', '-i', video, '-vf', 'fps=11,scale=900:-2', join(frames, '%03d.png')], { stdio: 'ignore' })
const out = 'docs/room.gif'
const shots = readdirSync(frames).sort().map(name => join(frames, name))
execFileSync('magick', ['-delay', '9', ...shots, '-layers', 'optimize', out], { stdio: 'ignore' })
await rm(data, { recursive: true, force: true })
await rm(frames, { recursive: true, force: true })
console.log(`wrote ${out}`)
