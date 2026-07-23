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
]

export function getActiveAgentProcesses(): string[] {
  const isWindows = process.platform === 'win32'
  let rawOutput = ''

  try {
    rawOutput = isWindows
      ? execSync('tasklist /FO CSV /NH', { encoding: 'utf-8', timeout: 3000 })
      : execSync('ps -ax -o args', { encoding: 'utf-8', timeout: 3000 })
  } catch {
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
