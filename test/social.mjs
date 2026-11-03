// Renders the GitHub social preview (1280x640) from the real landing page, after
// a name is typed so the commands show. Run with: npm run docs:social.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { enterName, ready } from './landing.mjs'

const port = 9000 + Math.floor(Math.random() * 900)
const data = await mkdtemp(join(tmpdir(), 'climp-social-'))
const server = spawn('node', ['server/dist/server.js'], {
  env: { ...process.env, CLIMP_DATA: data, PORT: String(port), CLIMP_SHELL: process.env.CLIMP_SHELL ?? 'docker', CLIMP_ROOM_NETWORK: process.env.CLIMP_ROOM_NETWORK ?? 'host', CLIMP_ALLOW_HOST_NETWORK: '1' },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${port}`
for (let attempt = 0; attempt < 60; attempt++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
  await new Promise(resolve => setTimeout(resolve, 200))
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/chromium', args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 640 }, colorScheme: 'light' })).newPage()
try {
  await page.goto(base)
  await ready(page)
  await enterName(page, 'alex')
  await page.waitForTimeout(500)
  await page.screenshot({ path: '.github/social-preview.png', animations: 'disabled' })
  console.log('wrote .github/social-preview.png')
} finally {
  await browser.close()
  server.kill()
  await rm(data, { recursive: true, force: true })
}
