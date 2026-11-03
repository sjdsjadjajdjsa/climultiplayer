import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLIMP_DATA = mkdtempSync(join(tmpdir(), 'climp-test-'))
process.env.CLIMP_ROOM_IDLE_MINUTES = '600'

// Server tests stay on the host shell: deterministic and fast. The docker path
// is exercised by test/ui.mjs with CLIMP_SHELL=docker.
process.env.CLIMP_SHELL = 'host'
