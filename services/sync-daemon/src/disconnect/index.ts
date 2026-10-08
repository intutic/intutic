/**
 * disconnect — undoes what `intutic connect` wrote to this machine's harness
 * configs. `planDisconnect` computes every change without making one; the
 * CLI prints the plan (`--dry-run`) or applies it.
 *
 * @module
 */

import * as node_path from 'node:path'
import * as node_os from 'node:os'
import * as node_fs from 'node:fs/promises'
import { DisconnectPlan } from './plan.js'
import { HARNESS_REVERSERS, type DisconnectContext } from './harnesses.js'
import { forgetOriginal, forgetProxyUrls, knownProxyUrls, pruneLedger, recordedFiles } from './originals.js'
import { proxyUrlMatcher, proxyUrlsInWorkspace } from './recognise.js'

export { DisconnectPlan, type PlannedChange, type PlanNote } from './plan.js'
export { HARNESS_REVERSERS } from './harnesses.js'
export { keepOriginal, noteWritten, noteProxyUrl, readOriginal, writeOwnedFile } from './originals.js'

export interface DisconnectOptions {
  /** Workspaces connect wrote into. */
  workspaceRoots: readonly string[]
  /** The harnesses to disconnect; every one when omitted. */
  harnesses?: readonly string[]
  /** Harnesses that stay connected (a `--harness` run leaves the others). */
  remaining?: readonly string[]
}

/** Gate caches connect refreshes for every harness's gate, in `~/.intutic/hooks/`. */
const GATE_CACHES = ['policy-snapshot.json', 'policy-snapshot.rules', 'approved-bypasses.jsonl', 'egress-policy.json']

/**
 * Every change disconnect would make, in the order it makes them. Nothing is
 * written until the plan's `apply()` runs.
 */
export async function planDisconnect(options: DisconnectOptions): Promise<DisconnectPlan> {
  const plan = new DisconnectPlan()
  const home = node_os.homedir()
  const roots = [...new Set(options.workspaceRoots.map((r) => node_path.resolve(r)))]
  const full = options.harnesses === undefined

  const proxyUrls = new Set(await knownProxyUrls())
  for (const root of roots) for (const url of await proxyUrlsInWorkspace(root)) proxyUrls.add(url)
  const ctx: DisconnectContext = {
    workspaceRoots: roots,
    isProxyUrl: proxyUrlMatcher([...proxyUrls]),
    remaining: new Set(full ? [] : options.remaining ?? []),
  }

  for (const harness of options.harnesses ?? Object.keys(HARNESS_REVERSERS)) {
    await HARNESS_REVERSERS[harness]?.(plan, ctx)
  }

  if (full) {
    const hooks = node_path.join(home, '.intutic', 'hooks')
    for (const name of GATE_CACHES) {
      const file = node_path.join(hooks, name)
      if (plan.claim(file)) plan.quiet(file, () => node_fs.rm(file, { force: true }))
    }
    // The copy of the API key the gate scripts read; nothing reads it once they are gone.
    const runtimeEnv = node_path.join(home, '.intutic', 'env', 'runtime.env')
    if (plan.claim(runtimeEnv)) {
      try {
        await node_fs.access(runtimeEnv)
        plan.change(runtimeEnv, 'delete (the API key copy the gate scripts read)', () => node_fs.rm(runtimeEnv, { force: true }))
      } catch {
        // Not written.
      }
    }
    // Directories connect's writers create for themselves; any still holding
    // something (logs, config, credentials) stays.
    for (const root of [...roots, home]) {
      for (const dir of ['events', 'env', 'hooks', 'n8n']) plan.removeIfEmpty(node_path.join(root, '.intutic', dir))
      plan.removeIfEmpty(node_path.join(root, '.intutic'))
    }
  }

  // Records no reverser claimed belong to files a full run has nothing left to
  // do for; a `--harness` run leaves the other harnesses' records alone.
  for (const root of [...roots, home]) {
    plan.quiet(node_path.join(root, '.intutic', 'originals'), async () => {
      if (full) {
        for (const record of await recordedFiles(root)) await forgetOriginal(record.path, root)
        if (root === home) await forgetProxyUrls()
      }
      await pruneLedger(root)
    })
  }
  return plan
}
