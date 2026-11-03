export type EditBlock = { path: string; search: string; replace: string }

const FENCE = /```[ \t]*(?:edit|diff)[ \t]+([^\n`]+)\r?\n([\s\S]*?)```/g

export const parseEdits = (answer: string): EditBlock[] => {
  const blocks: EditBlock[] = []
  for (const match of answer.matchAll(FENCE)) {
    const path = match[1].trim()
    const marker = /<<<<<<<[^\n]*\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>[^\n]*/.exec(match[2])
    if (!path || !marker) continue
    blocks.push({ path, search: marker[1], replace: marker[2] })
  }
  return blocks
}

// Removes the edit fences from the prose so the answer reads normally.
export const withoutEdits = (answer: string) => answer.replace(FENCE, '').replace(/\n{3,}/g, '\n\n').trim()
