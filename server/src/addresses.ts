import { networkInterfaces } from 'node:os'

// Reachable IPv4 addresses for a host sharing their machine: LAN first, then
// Tailscale (100.64/10) and other overlays, so the printed invite is usable.
const rank = (address: string) => {
  const [first, second] = address.split('.').map(Number)
  if (first === 10) return 1
  if (first === 192 && second === 168) return 0
  if (first === 172 && second >= 16 && second <= 31) return 2
  if (first === 100 && second >= 64 && second <= 127) return 3
  return 4
}

export const localAddresses = () => {
  const found: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address)
    }
  }
  return [...new Set(found)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export const shareLinks = (port: number) => localAddresses().map(address => `http://${address}:${port}`)
