export type Risk = { risky: boolean; reasons: string[] }

const RULES: Array<[RegExp, string]> = [
  [/\brm\b/, 'deletes files'],
  [/\brmdir\b/, 'deletes folders'],
  [/\bmv\b/, 'moves files'],
  [/\bgit\s+push\b/, 'publishes commits'],
  [/\bgit\s+(reset|checkout\s+--|clean)\b/, 'rewrites or discards local work'],
  [/\bgit\s+rebase\b/, 'rewrites history'],
  [/\bnpm\s+(publish|install)\b|\bpip\s+install\b|\bcargo\s+install\b/, 'installs packages'],
  [/\bcurl\b|\bwget\b/, 'fetches from the network'],
  [/(^|\s)>\s*\S|\btee\b/, 'writes through a redirect'],
  [/\bsed\s+-i\b/, 'edits files in place'],
  [/\bchmod\b|\bchown\b/, 'changes permissions'],
  [/\bsudo\b/, 'needs elevated rights'],
  [/\|\s*(ba|z|k|fi)?sh\b/, 'pipes into a shell'],
  [/\bdocker\b/, 'drives docker'],
  [/\bkill\b|\bpkill\b/, 'stops processes'],
  [/\bfind\b[^|]*\s-delete\b/, 'deletes matches'],
  [/\b(truncate|dd)\b/, 'writes raw data'],
  [/\bcp\b|\bln\s+-s/, 'copies over files'],
  [/\b(ba|z|k)?sh\s+-c\b|\beval\b|\bxargs\b/, 'runs a nested shell'],
  [/\b(python3?|node|perl|ruby|php)\s+(-c|-e)\b/, 'runs inline code'],
  [/(^|\s)(\.{0,2}\/)?\S+\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl)(\s|$)/, 'runs a script file'],
  [/\b(mkfs|mount|umount)\b|\bgit\s+commit\b/, 'touches the system'],
]

export const looksRisky = (command: string): Risk => {
  const reasons = RULES.filter(([pattern]) => pattern.test(command)).map(([, reason]) => reason)
  return { risky: reasons.length > 0, reasons: [...new Set(reasons)] }
}
