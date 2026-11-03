// Records the README GIF: a room used the way a person would, then trims it to a
// looping clip. Run with: npm run docs:gif.
import { spawn, execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { ready } from './landing.mjs'

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
  // Start at the terminal landing and type, so the clip shows how you get in.
  await page.goto(base)
  await ready(page)
  await page.waitForTimeout(900)
  await page.type('.term-prompt input', 'alex', { delay: 110 })
  await page.press('.term-prompt input', 'Enter')
  await page.waitForSelector('.term-actions')
  await page.waitForTimeout(700)
  await page.type('.term-prompt input', 'demo', { delay: 110 })
  await page.waitForTimeout(300)
  await page.press('.term-prompt input', 'Enter')
  await page.waitForSelector('.cm-line', { timeout: 40_000 })
  await page.waitForTimeout(900)

  // The demo opens its notes file; add a line at the end of it.
  await page.click('.cm-line >> nth=2')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('- [x] typed this in the room', { delay: 45 })
  await page.waitForTimeout(700)

  await page.fill('textarea[placeholder^="message the room"]', 'running the sample from the shell')
  await page.press('textarea[placeholder^="message the room"]', 'Enter')
  await page.waitForTimeout(700)

  await page.click('button[title="terminal"]')
  await page.waitForSelector('.card-term.shared')
  await page.waitForTimeout(1200)
  await page.type('input[placeholder="run a command everyone sees"]', 'node src/greeting.js alex', { delay: 55 })
  await page.press('input[placeholder="run a command everyone sees"]', 'Enter')
  await page.waitForTimeout(2800)
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
