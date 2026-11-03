import { join } from 'node:path'
import { dataDir } from '../config.js'
import { createAuthStore, type AuthStore } from './subs.js'

const stores = new Map<string, AuthStore>()

// One credential store per member: their plans are theirs, so requests bill
// their own account, not the host's.
export const storeFor = (memberId: string) => {
  let store = stores.get(memberId)
  if (!store) {
    store = createAuthStore(join(dataDir, 'auth', `${memberId}.json`))
    stores.set(memberId, store)
  }
  return store
}

export const dropStore = (memberId: string) => stores.delete(memberId)
