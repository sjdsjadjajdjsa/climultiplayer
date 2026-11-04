import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../src/config.js'
import { deleteRoom, findMember, hashToken, loadRooms, peekRoom } from '../src/rooms.js'

const CODE = 'RLDTEST'

afterEach(async () => {
  const room = peekRoom(CODE)
  if (room) await deleteRoom(room)
  await rm(join(dataDir, 'rooms.json'), { force: true })
})

const member = (over: Record<string, unknown>) => ({
  id: 'hostid1',
  name: 'host',
  token: '',
  tokenHash: hashToken('raw-token-1'),
  role: 'host',
  color: '#000000',
  online: 1,
  joinedAt: Date.now(),
  ...over,
})

const snapshot = (members: any[], hostId = 'hostid1') => [
  {
    code: CODE,
    workspace: join(dataDir, 'rooms', CODE, 'workspace'),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    hostId,
    members,
    invites: [],
    joins: [],
  },
]

// rooms.json outlives the process. After a restart the cookie a member holds
// must still open the room, even though the file itself only stores hashes.
describe('reload after restart', () => {
  it('reconnects a member from a stored token hash', async () => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'rooms.json'), JSON.stringify(snapshot([member({})])))
    await loadRooms()
    const room = peekRoom(CODE)
    expect(room).toBeTruthy()
    const found = findMember(room!, 'raw-token-1')
    expect(found?.name).toBe('host')
    // The raw token is never kept in memory after a reload.
    expect(found?.token).toBe('')
    // Everyone comes back offline until their socket arrives.
    expect(found?.online).toBe(0)
  })

  it('reads the old format that stored raw tokens', async () => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'rooms.json'), JSON.stringify(snapshot([member({ token: 'legacy-token-9', tokenHash: undefined })])))
    await loadRooms()
    const room = peekRoom(CODE)
    expect(room).toBeTruthy()
    expect(findMember(room!, 'legacy-token-9')?.tokenHash).toBe(hashToken('legacy-token-9'))
  })

  it('ignores a corrupt rooms.json', async () => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'rooms.json'), 'not json {')
    await expect(loadRooms()).resolves.toBeUndefined()
    expect(peekRoom(CODE)).toBeUndefined()
  })

  it('drops a room whose host member is missing', async () => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'rooms.json'), JSON.stringify(snapshot([member({ id: 'someone-else' })])))
    await loadRooms()
    expect(peekRoom(CODE)).toBeUndefined()
  })
})
