/**
 * The process-wide active gate (`install()` / `active()`).
 *
 * Kept in its own module, apart from `gate.ts`, because `gate.ts` imports
 * Node.js built-ins (`node:fs`) and this registry must not. Modules that
 * only need to LOOK UP the installed gate (`wrapTools.ts`, `workflow.ts`)
 * import it from here, so they stay loadable in a runtime without Node.js —
 * the Workflow DevKit's workflow VM bundles `@intutic/gate/workflow` into
 * every workflow, and one `require("node:fs")` there fails all of them at
 * load time. `gate.ts` re-exports both functions, so `install`/`active`
 * from `@intutic/gate` are unchanged.
 *
 * @module
 */

import type { Gate } from './gate.js'

// Module-level active gate, so wrapped tools do not need the instance
// threaded through every call site.
let _active: Gate | null = null

export function install(gate: Gate | null): void {
  _active = gate
}

export function active(): Gate | null {
  return _active
}
