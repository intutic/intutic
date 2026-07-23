/**
 * Colorized console logger using picocolors.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import pc from 'picocolors'

export const log = {
  info(msg: string): void {
    console.log(`${pc.blue('ℹ')} ${msg}`)
  },

  success(msg: string): void {
    console.log(`${pc.green('✔')} ${msg}`)
  },

  warn(msg: string): void {
    console.log(`${pc.yellow('⚠')} ${msg}`)
  },

  error(msg: string): void {
    console.error(`${pc.red('✖')} ${msg}`)
  },

  dim(msg: string): void {
    console.log(pc.dim(msg))
  },

  /** Print a labeled key-value pair. */
  field(label: string, value: string): void {
    console.log(`  ${pc.dim(label + ':')} ${value}`)
  },

  /** Print a section header. */
  header(msg: string): void {
    console.log(`\n${pc.bold(pc.cyan(msg))}`)
  },
}
