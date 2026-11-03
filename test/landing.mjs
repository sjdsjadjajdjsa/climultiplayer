// The landing page is a terminal, so tests drive it the way a person would:
// type a name at the prompt, then type a command.
const prompt = '.term-prompt input'

export const ready = page => page.waitForSelector(`${prompt}:not([disabled])`)

export const enterName = async (page, name) => {
  await ready(page)
  await page.fill(prompt, name)
  await page.press(prompt, 'Enter')
  await page.waitForSelector('.term-actions')
}

export const command = async (page, text) => {
  await ready(page)
  await page.fill(prompt, text)
  await page.press(prompt, 'Enter')
}

export const startRoom = async (page, name, folder = '') => {
  await enterName(page, name)
  await command(page, folder ? `start ${folder}` : 'start')
}

export const openDemo = async (page, name) => {
  await enterName(page, name)
  await command(page, 'demo')
}

// An invite link prefills `join` after the name, so entering it is one more Enter.
export const joinFromLink = async (page, link, name) => {
  await page.goto(link)
  await enterName(page, name)
  await page.waitForFunction(selector => document.querySelector(selector)?.value === 'join', prompt)
  await page.press(prompt, 'Enter')
}

export const lastBad = page => page.locator('.term-line.bad').last().textContent()
