import { describe, expect, it } from 'vitest'
import { localAddresses, shareLinks } from '../src/addresses.js'

describe('share links', () => {
  it('formats every local address with the port', () => {
    const links = shareLinks(8787)
    expect(links).toEqual(localAddresses().map(address => `http://${address}:8787`))
  })

  it('never returns duplicates', () => {
    const list = localAddresses()
    expect(new Set(list).size).toBe(list.length)
  })
})
