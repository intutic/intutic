import { execSync } from 'node:child_process'

const PROCESS_SIGNATURES: Array<{
  name: string
  patterns: RegExp[]
}> = [
  {
    name: 'Cursor',
    patterns: [/\/Cursor\.app\//i, /\bCursor\b.*--type=.*extensionHost/],
  },
  {
    name: 'VS Code',
    patterns: [/\/Visual Studio Code\.app\//i, /\bcode\b.*--extensions-dir/i],
  },
  {
    name: 'Claude Code',
    patterns: [/\bclaude\b(?!.*Claude\.app)/],
  },
  {
    name: 'Claude Desktop',
    patterns: [/\/Claude\.app\//i, /\bClaude\s/],
  },
  {
    name: 'Aider',
    patterns: [/\baider\b/],
  },
  {
    name: 'Codex',
    patterns: [/\bcodex\b/],
  },
  {
    name: 'Goose',
    patterns: [/\bgoose\b.*\b(run|session)\b/],
  },
  {
    name: 'OpenClaw',
    patterns: [/\bopenclaw\b/i],
  },
  {
    name: 'OpenWebUI',
    patterns: [/\bopen-webui\b/i, /\bopenwebui\b/i],
  },
  {
    name: 'JetBrains IDE',
    patterns: [/\b(idea|pycharm|webstorm|goland|rider|phpstorm|clion|rubymine)\b/i],
  },
  {
    name: 'OpenHands',
    patterns: [/\bopenhands\b/i],
  },
  {
    name: 'n8n',
    patterns: [/\bn8n\b/],
  },
  {
    name: 'Windsurf',
    patterns: [/\bwindsurf\b/i, /\/Windsurf\.app\//i],
  },
  {
    name: 'Antigravity',
    patterns: [/\bantigravity\b/i],
  },
  {
    name: 'Muse Code',
    patterns: [/\bmuse\b/],
  },
  {
    name: 'Grok Build',
    // `grok` is a short, common English word (and xAI's product name shows
    // up in unrelated contexts too — chat clients, browser tab titles), so
    // — the same false-positive concern `goose` required a qualifier for —
    // a bare `\bgrok\b` would trip on a ps line that merely mentions the
    // word. Anchored on "grok" appearing as an invoked COMMAND NAME: either
    // the whole line (interactive `grok`), the leading word of the line, or
    // right after a path separator (`/usr/local/bin/grok`), followed by
    // whitespace/end-of-string/an argument dash — never merely appearing as
    // a word inside a longer argument or unrelated sentence. Deliberately
    // NOT keyed on a specific subcommand the way `goose`'s
    // `.*\b(run|session)\b` is: Grok Build's subcommand vocabulary was not
    // confirmed (the binary was not installable in this environment), so a
    // keyword guess risked a false NEGATIVE on plain interactive `grok`
    // instead.
    patterns: [/(^|[/\\\s])grok(\s|$)/],
  },
  {
    name: 'dsh',
    // `dsh` is a two-letter... no, three-letter token — shorter and more
    // collision-prone than `grok` (which at least required a qualifier for
    // being a common English word). A bare `\bdsh\b` would trip on a `ps`
    // line mentioning it as an argument, a directory component, or a
    // coincidental fragment. Anchored the same way `grok`'s entry is: only
    // when `dsh` appears as an invoked COMMAND NAME — the whole line, the
    // leading word, or right after a path separator — followed by
    // whitespace/end-of-string/an argument dash, never merely present
    // inside a longer token. Also matches the npm package name directly
    // (`@deepseek-ai/dsh`), which `npx`/a locally-run bin often surfaces
    // verbatim in `ps` output before the resolved binary name does.
    patterns: [/(^|[/\\\s])dsh(\s|$)/, /@deepseek-ai\/dsh\b/],
  },
  {
    name: 'Xirp',
    // Xirp is a macOS `.app`, not a CLI binary invoked by name the way
    // `grok`/`muse` are — its `ps -ax -o args` entries are dominated by the
    // app bundle path, so that path fragment is the primary, most reliable
    // signal (mirrors `Cursor.app`/`Claude.app`/`Windsurf.app` above, not
    // the bare-word CLI pattern grok/muse needed). NOT independently
    // verified against a real Xirp install — see xirp.ts's module doc and
    // TD-390. The tmux-ancestry heuristic below is a separate, weaker
    // signal this single-line regex scan cannot produce on its own (it has
    // no parent-PID data).
    patterns: [/\/Xirp\.app\//i],
  },
]

/**
 * Command-name patterns for the CLI harnesses Xirp is known to spawn inside
 * its own tmux sessions (per its own FAQ): Claude Code, Codex, and Gemini
 * CLI. Deliberately a SEPARATE, narrower list from `PROCESS_SIGNATURES`
 * above — this exists only to recognise "one of the three agents Xirp
 * wraps" for `detectTmuxParentedAgents` below, not as a general-purpose
 * harness detector, and is matched against a short `comm` value (not a full
 * command line), so it does not need `grok`'s word-boundary-in-a-sentence
 * defenses — `comm` is already just the executable name.
 */
const XIRP_WRAPPED_AGENT_COMM_PATTERNS: RegExp[] = [/^claude$/, /^codex$/, /^gemini$/]

/** One row of `ps -ax -o pid,ppid,comm` output. */
export interface ProcessTreeEntry {
  pid: number
  ppid: number
  /** Short executable name (not the full command line). */
  comm: string
}

/**
 * Parses `ps -ax -o pid,ppid,comm` output into structured rows. A pure
 * function — no process spawning — so it can be exercised directly with a
 * captured fixture rather than mocking `execSync`.
 *
 * Format per line: `<PID> <PPID> <COMM>`, where `comm` may itself contain no
 * spaces (it is the short executable name column, unlike `args`).
 */
export function parseProcessTreeOutput(output: string): ProcessTreeEntry[] {
  const rows: ProcessTreeEntry[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number.parseInt(parts[0], 10)
    const ppid = Number.parseInt(parts[1], 10)
    const comm = parts[2]
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue
    rows.push({ pid, ppid, comm })
  }
  return rows
}

/** Ancestor-chain walk depth cap — a real process tree is a handful of
 *  levels deep; bounding this avoids a pathological loop if `ps` ever
 *  returns a cyclic or self-referential PPID (has happened on some
 *  container/namespace setups). */
const MAX_ANCESTRY_DEPTH = 32

/**
 * Best-effort, PROBABILISTIC signal that one or more of Claude Code/Codex/
 * Gemini CLI is running as a descendant of a `tmux` server process — i.e.
 * something is orchestrating multiple CLI agents via tmux, the exact shape
 * Xirp uses (tmux session + git worktree, per its own FAQ). This is NOT a
 * confirmation that Xirp specifically is the orchestrator: any hand-rolled
 * tmux-based multi-agent workflow (a personal dotfiles script, a different
 * tool) trips the identical signal, and this function cannot and does not
 * distinguish them. Treat it as corroborating evidence to combine with
 * `xirp.ts`'s own `~/.xirp`/`$XIRP_HOME`/`Xirp.app` detection — never as a
 * standalone "Xirp is running" claim.
 *
 * A pure function over an already-parsed process tree (see
 * `parseProcessTreeOutput`) so the ancestry-walk logic itself is testable
 * without mocking `execSync` or depending on the test machine's real
 * process table.
 */
export function hasTmuxParentedAgent(tree: readonly ProcessTreeEntry[]): boolean {
  const byPid = new Map<number, ProcessTreeEntry>(tree.map((p) => [p.pid, p]))
  const isTmux = (comm: string) => comm === 'tmux' || comm.startsWith('tmux:')

  for (const proc of tree) {
    if (!XIRP_WRAPPED_AGENT_COMM_PATTERNS.some((p) => p.test(proc.comm))) continue

    let current: ProcessTreeEntry | undefined = proc
    const seen = new Set<number>()
    for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth++) {
      if (seen.has(current.pid)) break // cyclic PPID chain — stop, not infinite-loop
      seen.add(current.pid)
      const parent = byPid.get(current.ppid)
      if (!parent) break
      if (isTmux(parent.comm)) return true
      current = parent
    }
  }
  return false
}

/**
 * Runs `ps -ax -o pid,ppid,comm` and checks for a tmux-parented agent. Wraps
 * `hasTmuxParentedAgent` with the real process table; see that function's
 * doc for what this signal does and does not confirm. Defaults to `false`
 * (a plain "no signal found", not "unknown") on any error — same
 * fail-to-empty posture `getActiveAgentProcesses` uses, since this is
 * best-effort telemetry, not a governance decision that needs to fail
 * closed.
 */
export function detectTmuxParentedAgents(): boolean {
  if (process.platform === 'win32') return false // tmux does not exist on Windows
  try {
    const rawOutput = execSync('ps -ax -o pid,ppid,comm', { encoding: 'utf-8', timeout: 3000 })
    return hasTmuxParentedAgent(parseProcessTreeOutput(rawOutput))
  } catch {
    return false
  }
}

export function getActiveAgentProcesses(): string[] {
  const isWindows = process.platform === 'win32'
  let rawOutput: string

  try {
    rawOutput = isWindows
      ? execSync('tasklist /FO CSV /NH', { encoding: 'utf-8', timeout: 3000 })
      : execSync('ps -ax -o args', { encoding: 'utf-8', timeout: 3000 })
  } catch {
    // Deliberate fail-open: the process table is best-effort telemetry, so a
    // missing/blocked `ps`/`tasklist` (or the 3 s timeout) reports "no agents"
    // rather than failing the poll. Nothing after this point can run without it.
    return []
  }

  const lines = rawOutput.split('\n').filter((line) => line.trim().length > 0)
  const active = new Set<string>()

  for (const line of lines) {
    for (const sig of PROCESS_SIGNATURES) {
      if (active.has(sig.name)) continue
      for (const pattern of sig.patterns) {
        if (pattern.test(line)) {
          active.add(sig.name)
          break
        }
      }
    }
  }

  return [...active]
}
