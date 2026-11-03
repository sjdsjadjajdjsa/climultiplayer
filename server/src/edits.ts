export type EditBlock = { path: string; search: string; replace: string }

const FENCE = /```[ \t]*(?:edit|diff)[ \t]+([^\n`]+)\r?\n([\s\S]*?)```/g

// Assistant answers carry apply-able blocks in this shape:
// ```edit path/to/file
// <<<<<<< SEARCH
// old
// =======
// new
// >>>>>>> REPLACE
// ```
export const parseEdits = (answer: string): EditBlock[] => {
  const blocks: EditBlock[] = []
  for (const match of answer.matchAll(FENCE)) {
    const path = match[1].trim()
    const body = match[2]
    const marker = /<<<<<<<[^\n]*\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>[^\n]*/.exec(body)
    if (!path || !marker) continue
    blocks.push({ path, search: marker[1], replace: marker[2] })
  }
  return blocks
}

export type EditResult = { path: string; ok: boolean; message: string }

// Applying against the live document keeps concurrent typing intact: only the
// searched slice is replaced. A miss is reported instead of guessed at.
export const applyBlocks = (text: string, blocks: EditBlock[]): { text: string; results: EditResult[] } => {
  let current = text
  const results: EditResult[] = []
  for (const block of blocks) {
    if (!block.search.trim()) {
      const glue = current.endsWith('\n') || !current ? '' : '\n'
      current += glue + block.replace
      results.push({ path: block.path, ok: true, message: 'appended' })
      continue
    }
    const index = current.indexOf(block.search)
    if (index < 0) {
      results.push({ path: block.path, ok: false, message: 'the searched text is no longer in the file' })
      continue
    }
    if (current.indexOf(block.search, index + 1) >= 0) {
      results.push({ path: block.path, ok: false, message: 'the searched text appears more than once' })
      continue
    }
    current = current.slice(0, index) + block.replace + current.slice(index + block.search.length)
    results.push({ path: block.path, ok: true, message: 'applied' })
  }
  return { text: current, results }
}
