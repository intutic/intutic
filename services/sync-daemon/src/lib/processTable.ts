import { readFileSync, readdirSync } from 'node:fs'

/**
 * Every process on a Linux machine, read from `/proc`: the fallback for an image
 * with no `ps`, such as `node:22-slim`. Empty where `/proc` cannot be read.
 */
export function readProcTable(root = '/proc'): Array<{ pid: number; command: string }> {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const table: Array<{ pid: number; command: string }> = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const command = readFileSync(`${root}/${entry}/cmdline`, 'utf-8').split('\0').filter(Boolean).join(' ')
      if (command) table.push({ pid: Number(entry), command })
    } catch {
      // The process exited between the listing and this read.
    }
  }
  return table
}
