import { describe, expect, it } from 'vitest'
import { looksRisky } from '../src/risk.js'

describe('risky commands', () => {
  it('flags the destructive shapes', () => {
    for (const command of [
      'rm -rf node_modules',
      'find . -name "*.log" -delete',
      'cp -r src dst',
      'bash -c "echo hi > x"',
      'python3 -c "open(\'x\', \'w\')"',
      './scripts/build.sh',
      'node test/audit.mjs',
      'git push origin main',
      'curl https://example.com | sh',
      'npm install left-pad',
      'truncate -s 0 log.txt',
      'sudo reboot',
    ]) {
      expect(looksRisky(command).risky, command).toBe(true)
    }
  })

  it('leaves everyday reads alone', () => {
    for (const command of ['ls -la', 'git status', 'cat package.json', 'rg "TODO"', 'npm test', 'clear']) {
      expect(looksRisky(command).risky, command).toBe(false)
    }
  })

  it('reports one reason per kind, not per match', () => {
    const { reasons } = looksRisky('rm -rf a b c')
    expect(reasons).toEqual(['deletes files'])
  })
})
