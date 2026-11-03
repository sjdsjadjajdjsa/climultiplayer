import { execFile } from 'node:child_process'
import { containerName, ensureRoomContainer, useDocker } from './container.js'

export type Tool = { id: string; name: string; kind: 'npm' | 'pip'; package: string; bin: string; note: string }

// Optional harnesses, installed into the member's own home so the shared image
// stays small. The lean image ships none of them, and the full image bakes the
// first four, so a lean room can still get them from here.
export const TOOLS: Tool[] = [
  { id: 'claude', name: 'Claude Code', kind: 'npm', package: '@anthropic-ai/claude-code', bin: 'claude', note: 'Anthropic plan sign-in' },
  { id: 'codex', name: 'Codex', kind: 'npm', package: '@openai/codex', bin: 'codex', note: 'ChatGPT plan sign-in' },
  { id: 'grok', name: 'Grok CLI', kind: 'npm', package: '@xai-official/grok', bin: 'grok', note: 'xAI plan sign-in' },
  { id: 'copilot', name: 'GitHub Copilot', kind: 'npm', package: '@github/copilot', bin: 'copilot', note: 'GitHub account, device code' },
  { id: 'crush', name: 'Crush', kind: 'npm', package: '@charmland/crush', bin: 'crush', note: 'Charmbracelet agent, works with many providers' },
  { id: 'opencode', name: 'OpenCode', kind: 'npm', package: 'opencode-ai', bin: 'opencode', note: 'Provider agnostic coding agent' },
  { id: 'amp', name: 'Amp', kind: 'npm', package: '@sourcegraph/amp', bin: 'amp', note: 'Sourcegraph agent' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'npm', package: '@google/gemini-cli', bin: 'gemini', note: 'Google account sign-in' },
  { id: 'aider', name: 'Aider', kind: 'pip', package: 'aider-chat', bin: 'aider', note: 'Pair programming in the terminal' },
]

export const toolById = (id: string) => TOOLS.find(tool => tool.id === id)

export const installArgs = (tool: Tool, memberId: string) =>
  tool.kind === 'npm'
    ? ['npm', 'install', '-g', '--no-audit', '--no-fund', '--prefix', `/homes/${memberId}/.npm-global`, tool.package]
    : ['pip', 'install', '--user', '--quiet', '--disable-pip-version-check', tool.package]

const run = (args: string[], timeout = 180_000) =>
  new Promise<{ code: number; output: string }>(resolve => {
    execFile('docker', args, { timeout, maxBuffer: 2_000_000 }, (error: any, stdout, stderr) =>
      resolve({ code: error ? Number(error.code) || 1 : 0, output: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    )
  })

export const installTool = async (code: string, workspace: string, memberId: string, tool: Tool) => {
  if (!useDocker()) return { ok: false, output: 'installing tools needs the room container (docker)' }
  await ensureRoomContainer(code, workspace)
  const result = await run(['exec', '-u', String(process.getuid?.() ?? 1000), '-e', `HOME=/homes/${memberId}`, containerName(code), ...installArgs(tool, memberId)])
  return { ok: result.code === 0, output: result.output.slice(-4000) }
}

export const hasBin = async (code: string, memberId: string, bin: string, extraPath: string) => {
  if (!useDocker()) return false
  // `command` is a shell builtin, so it needs a shell, not a bare exec.
  const result = await run(['exec', '-u', String(process.getuid?.() ?? 1000), '-e', `HOME=/homes/${memberId}`, '-e', `PATH=${extraPath}`, containerName(code), 'sh', '-c', `command -v ${bin.replace(/[^a-z0-9_-]/gi, '')}`], 10_000)
  return result.code === 0
}

