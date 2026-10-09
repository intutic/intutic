/**
 * How much a gate will evaluate, and for how long, before it refuses.
 *
 * Several harnesses treat a hook that runs past its timeout as having
 * allowed the call: Grok Build after 5 s, the GitHub Copilot CLI and cloud
 * agent after 30 s (admin policy hooks included), VS Code agent hooks after
 * 30 s, Goose after 30 s, OpenHands after 60 s, Hermes after 60 s. A gate
 * that is slow on a crafted call is therefore no gate. Two bounds keep every
 * gate inside the shortest of those deadlines:
 *
 * - **Size.** A command over {@link COMMAND_SIZE_LIMIT} bytes, or tool
 *   arguments over {@link ARGUMENTS_SIZE_LIMIT} bytes (serialized as compact
 *   JSON), are refused as `COMMAND_TOO_LARGE` before any rule runs. The limits
 *   come from 85,314 tool calls in real coding-agent transcripts: the largest
 *   shell command was 38.5 KB (99.9th percentile 13 KB), the largest file
 *   write 120 KB, the largest arguments of any tool 418 KB (a plan). So the
 *   command limit is six times the largest seen and the arguments limit more
 *   than twice.
 * - **Time.** The hook gates stop at {@link GATE_DEADLINE_MS} after they
 *   start and refuse with a `GATE_DEADLINE` reason, a second under Grok
 *   Build's 5 s. Every built-in rule is linear in the text (sequence.ts, the
 *   phrase matcher, regexLinearity.ts in the sync daemon), so only a
 *   workspace's own WHERE patterns can get there.
 *
 * Sizes are UTF-8 bytes, which every gate can count the same way.
 *
 * @module
 */

/** The largest shell command, in UTF-8 bytes, a gate evaluates. */
export const COMMAND_SIZE_LIMIT = 256 * 1024

/** The largest tool arguments, in UTF-8 bytes of compact JSON, a gate evaluates. */
export const ARGUMENTS_SIZE_LIMIT = 1024 * 1024

/** How long a hook gate may run, from process start, before it refuses. */
export const GATE_DEADLINE_MS = 4000
