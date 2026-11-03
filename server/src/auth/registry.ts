import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../config.js'
import { createAuthStore, type AuthStore } from './subs.js'

const stores = new Map<string, AuthStore>()

// Member ids are server-made, but they end up in a path, so keep one shape for
// writing and deleting alike.
export const safeMemberId = (memberId: string) => String(memberId).replace(/[^a-z0-9]/gi, '')

const authDir = () => join(dataDir, 'auth')

export const authFile = (memberId: string) => join(authDir(), `${safeMemberId(memberId)}.json`)

// Refresh tokens are the members' own credentials, so the directory is owner
// only as well as each file; a shared host account must not read them.
const ensureAuthDir = () => {
  mkdirSync(authDir(), { recursive: true, mode: 0o700 })
  try {
    chmodSync(authDir(), 0o700)
  } catch {}
}

// One credential store per member: their plans are theirs, so requests bill
// their own account, not the host's.
export const storeFor = (memberId: string) => {
  let store = stores.get(memberId)
  if (!store) {
    ensureAuthDir()
    store = createAuthStore(authFile(memberId))
    stores.set(memberId, store)
  }
  return store
}

export const dropStore = (memberId: string) => stores.delete(memberId)
