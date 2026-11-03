import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { command, enterName, lastBad } from './landing.mjs'

const port = 9000 + Math.floor(Math.random() * 900)
const data = await mkdtemp(join(tmpdir(), 'climp-audit-'))
const server = spawn('node', ['server/dist/server.js'], { env: { ...process.env, CLIMP_DATA: data, PORT: String(port), CLIMP_SHELL: 'host' }, stdio: 'ignore' })
const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/health')).ok) break } catch {} await new Promise(r => setTimeout(r, 200)) }

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => m.type() === 'error' && !m.text().includes('Failed to load resource') && errors.push(m.text()))


const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`) }

await page.goto(base)
await enterName(page, 'alex')
await command(page, 'start /definitely/missing')
await page.waitForSelector('.term-line.bad:has-text("no folder at")')
check('a bad folder path explains itself', (await lastBad(page)).includes('no folder at'))
await command(page, 'nonsense')
await page.waitForSelector('.term-line.bad:has-text("not a command")')
check('an unknown command points at help', (await lastBad(page)).includes('help'))
await command(page, 'start')
await page.waitForSelector('.room-code')
const openMenu = async () => page.click('.menu button.ghost')
const closeMenu = async () => page.click('.menu-backdrop')

// every menu item
const masked = await page.locator('.code-mask').evaluate(el => getComputedStyle(el).opacity)
await page.hover('.room-code')
await page.waitForTimeout(200)
const revealed = await page.locator('.code-mask').evaluate(el => getComputedStyle(el).opacity)
check('the room code is masked until hovered', masked === '1' && revealed === '0', `${masked} -> ${revealed}`)

await page.mouse.move(700, 400)
await openMenu(); await page.screenshot({ path: '/tmp/audit-menu.png' })
const items = await page.locator('.menu-sheet > button, .menu-sheet > a').allTextContents()
check('menu lists expected items', items.join('|').includes('Settings…') && items.join('|').includes('End room'), items.join('|'))
await closeMenu(); check('menu backdrop closes it', (await page.locator('.menu-sheet').count()) === 0)

await openMenu(); await page.click('.menu-sheet button:text("Settings…")')
await page.waitForSelector('.settings-body .accounts li')
check('accounts tab lists providers', (await page.locator('.accounts button:text("connect")').count()) >= 3)
await page.screenshot({ path: '/tmp/audit-accounts.png' })
await page.click('.settings-tabs button:text("tools and keys")')
await page.waitForSelector('.settings-body .accounts li')
check('tools tab opens', (await page.textContent('.settings-body')).includes('Crush'))

await page.screenshot({ path: '/tmp/audit-tools.png' })
await page.click('.modal-card button:text("close")')

await openMenu(); await page.click('.menu-sheet button:text("Invites")')
await page.waitForSelector('.modal-card')
check('invites panel opens', (await page.textContent('.modal-card')).includes('Each invite works once'))
await page.screenshot({ path: '/tmp/audit-invites.png' })
await page.click('.modal-card button:text("close")')

await openMenu(); await page.click('.menu-sheet button:text("Publish site")')
await page.waitForSelector('.modal-card')
check('publish panel opens', (await page.textContent('.modal-card')).includes('Copies the room'))
await page.screenshot({ path: '/tmp/audit-publish.png' })
await page.click('.modal-card button:text("close")')

await openMenu(); await page.click('.menu-sheet button:text("Command log")')
await page.waitForSelector('.modal-card')
check('log opens', (await page.textContent('.modal-card')).includes('nothing has run yet'))
await page.click('.modal-card button:text("close")')

await openMenu()
const dl = await page.locator('.menu-sheet a[download]').first().getAttribute('href')
await closeMenu()
const zip = await page.evaluate(async url => { const r = await fetch(url); return { ok: r.ok, type: r.headers.get('content-type') } }, dl)
check('download link streams the room', zip.ok && String(zip.type).includes('gzip'), JSON.stringify(zip))

// file + editor + toggles
await page.click('text=+ new'); await page.fill('input[placeholder="src/thing.ts"]', 'index.html'); await page.keyboard.press('Enter')
await page.waitForSelector('.cm-content')
check('file created and opened', (await page.textContent('.tree')).includes('index.html'))
await page.click('.cm-content'); await page.keyboard.type('<h1>audit</h1>')
await page.waitForTimeout(500)
await page.click('button:text("panel")'); await page.waitForTimeout(300)
check('panel toggles off', (await page.locator('.chat-side.open').count()) === 0)
await page.click('button:text("panel")'); await page.waitForTimeout(300)
check('chat toggles on', (await page.locator('.rail').count()) === 1)
await page.click('button:text("assistant")')
await page.waitForSelector('.chat-log')
check('assistant tab opens', (await page.textContent('.rail')).includes('Ask about the project'))
// Two connected plans must both reach the model picker.
const me = await (await page.evaluate(() => fetch('/api/me').then(r => r.json()))).member
await mkdir(join(data, 'auth'), { recursive: true })
await writeFile(join(data, 'auth', `${me.id}.json`), JSON.stringify({
  grok: { accessToken: 'x', expiresAt: Date.now() + 9e6, models: ['grok-4.7'], scopes: 'grok-cli:access' },
  chatgpt: { accessToken: 'y', expiresAt: Date.now() + 9e6, models: ['gpt-6.1-sol', 'gpt-6-luna'], accountId: 'acct' },
}))
check('assistant without a plan shows a muted state', (await page.textContent('.chat-head')).includes('no plan'))
await page.click('.rail-tab:text("room")')
await page.click('.rail-tab:text("assistant")')
await page.waitForSelector('.chat-head select')
await page.waitForTimeout(600)
const options = await page.locator('.chat-head option').allTextContents()
check('both plans appear in the model picker', options.some(o => o.includes('grok-4.7')) && options.some(o => o.includes('gpt-6.1-sol')), options.join(','))
await page.click('.rail-tab:text("room")')
await page.fill('.chat-input textarea', 'hello room'); await page.keyboard.press('Enter')
await page.waitForTimeout(400)
check('room chat posts locally', (await page.textContent('.chat-log')).includes('hello room'))

// publish for real
await openMenu(); await page.click('.menu-sheet button:text("Publish site")')
await page.waitForSelector('.paste input')
await page.fill('.paste input', 'audit-site'); await page.click('.paste button:text("publish")')
await page.waitForSelector('.accounts a')
const href = await page.getAttribute('.accounts a', 'href')
const served = await fetch(base + href)
check('published site is reachable', served.ok && (await served.text()).includes('audit'))
await page.click('.modal-card button:text("delete")'); await page.waitForTimeout(400)
check('page deletes', (await page.textContent('.accounts')).includes('nothing published'))

// narrow layout
await page.setViewportSize({ width: 900, height: 800 })
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/audit-narrow.png' })
check('chat becomes an overlay under 1080px', (await page.locator('.chat-side').evaluate(el => getComputedStyle(el).position)) === 'absolute')
await page.setViewportSize({ width: 1440, height: 900 })

check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
server.kill()
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
