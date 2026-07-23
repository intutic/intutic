/**
 * Active process detection — detect running AI agent processes.
 *
 * Uses native platform commands (`ps` on macOS/Linux, `tasklist` on Windows)
 * to find running agent processes. No external dependencies.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { execSync } from 'node:child_process'

/** A detected running agent process. */
export interface ActiveProcess {
  /** Display name of the agent (e.g. "Cursor", "Claude Code") */
  name: string
  /** Process ID */
  pid: number
  /** Raw command/arguments from the process list */
  command: string
}

/**
 * Process signature definitions.
 * Each entry maps a human-readable name to regex patterns that match
 * against the process command line.
 */
const PROCESS_SIGNATURES: Array<{
  name: string
  /** Regex to match against process command/args. First match wins. */
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

/**
 * Get the raw process list from the operating system.
 *
 * @returns Array of { pid, command } tuples
 */
/**
 * Parse the output of system process commands.
 *
 * @param output - Raw stdout from ps or tasklist
 * @param platform - OS platform ('win32' or others)
 * @returns parsed list of { pid, command }
 */
export function parseProcessOutput(output: string, platform: string): Array<{ pid: number; command: string }> {
  const isWindows = platform === 'win32'
  const lines = output.split('\n').filter((line) => line.trim().length > 0)
  const results: Array<{ pid: number; command: string }> = []

  if (isWindows) {
    // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
    for (const line of lines) {
      const match = line.match(/"([^"]+)","(\d+)"/)
      if (match) {
        results.push({ pid: parseInt(match[2], 10), command: match[1] })
      }
    }
  } else {
    // Format: <PID> <ARGS>
    for (const line of lines) {
      const trimmed = line.trim()
      const spaceIdx = trimmed.indexOf(' ')
      if (spaceIdx === -1) continue
      const pidStr = trimmed.slice(0, spaceIdx).trim()
      const command = trimmed.slice(spaceIdx + 1).trim()
      const pid = parseInt(pidStr, 10)
      if (!isNaN(pid) && command) {
        results.push({ pid, command })
      }
    }
  }

  return results
}

function getRawProcessList(): Array<{ pid: number; command: string }> {
  const isWindows = process.platform === 'win32'

  try {
    const output = isWindows
      ? execSync('tasklist /FO CSV /NH', { encoding: 'utf-8', timeout: 5000 })
      : execSync('ps -ax -o pid,args', { encoding: 'utf-8', timeout: 5000 })

    return parseProcessOutput(output, process.platform)
  } catch {
    // Command failed (e.g. timeout, or no ps/tasklist available)
    return []
  }
}

/**
 * Detect currently running AI agent processes.
 *
 * Scans the system process list and matches against known agent signatures.
 * De-duplicates by agent name (reports only the first matching PID per agent).
 *
 * @returns Array of detected active processes
 */
export function getActiveAgentProcesses(): ActiveProcess[] {
  const rawProcesses = getRawProcessList()
  const seen = new Set<string>()
  const results: ActiveProcess[] = []

  for (const proc of rawProcesses) {
    for (const sig of PROCESS_SIGNATURES) {
      if (seen.has(sig.name)) continue
      for (const pattern of sig.patterns) {
        if (pattern.test(proc.command)) {
          seen.add(sig.name)
          results.push({
            name: sig.name,
            pid: proc.pid,
            command: proc.command.slice(0, 120), // Truncate for display
          })
          break
        }
      }
    }
  }

  return results
}

/**
 * Check if the Intutic sync daemon is currently running.
 *
 * Scans the process list for a running 'intutic connect' process,
 * excluding the current process PID.
 *
 * @returns boolean
 */
export function isSyncDaemonRunning(): boolean {
  const rawProcesses = getRawProcessList()
  const currentPid = process.pid
  const daemonRegex = /\b(intutic|cli\.js|cli\.ts)\b.*\bconnect\b/i

  for (const proc of rawProcesses) {
    if (proc.pid === currentPid) continue
    if (daemonRegex.test(proc.command)) {
      return true
    }
  }
  return false
}
