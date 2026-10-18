/**
 * `decide(state, questions, opts)`: ask a self-hosted model a few narrow
 * yes/no or pick-one questions about a state, for agents built on this SDK.
 * The engine comes from `~/.intutic/decide/engine.json` and the
 * `INTUTIC_DECIDE_*` environment unless `opts` names one, and its host must
 * pass the self-hosted guard: a hosted decision API is refused before
 * anything is sent. See `decideSdk.ts` for the result and the errors.
 *
 * `decide.ts`, `decideEngine.ts`, `decideHostGuard.ts` and `decideSdk.ts`
 * are byte-identical copies of the shared-types modules (this package has no
 * dependencies); `__tests__/decide.test.ts` holds them so.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DecideQuestion } from './decide.js'
import { DECIDE_ENGINE_FILE_PATH, decideQuestions, loadDecideEngineFile, type DecideSdkOptions, type DecideSdkResult } from './decideSdk.js'

/**
 * Asks `questions` (written as a decide rule's `questions`) about `state`.
 * With `opts.when` the result carries the outcome the rule would reach.
 * Throws a `TypeError` for questions a decide rule would refuse, and a
 * `DecideEngineError` when the engine is not configured, its host is
 * refused, or it cannot answer in time.
 */
export async function decide(state: string, questions: Record<string, DecideQuestion>, opts: DecideSdkOptions = {}): Promise<DecideSdkResult> {
  const env = opts.env ?? process.env
  const engineFile =
    opts.engine !== undefined || opts.engineFile !== undefined
      ? (opts.engineFile ?? null)
      : loadDecideEngineFile((p) => readFileSync(p, 'utf8'), join(homedir(), ...DECIDE_ENGINE_FILE_PATH))
  return decideQuestions(state, questions, { ...opts, env, engineFile })
}
