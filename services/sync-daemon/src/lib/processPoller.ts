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
]

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
