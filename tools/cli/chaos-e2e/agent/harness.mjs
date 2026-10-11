// A stub agent harness for the chaos e2e suite. No model: the "agent" is a
// fixed task with two personalities, so a fault's effect on the score comes
// from how the harness reacts to it and nothing else.
//
// Task: look up the `color` and `size` records through an MCP tool, then write
// them to .intutic-chaos/result.txt with the built-in Write tool.
//
// What is real: every MCP call goes through the built MCP proxy wrapping
// records-server.mjs, and every tool call (MCP or built-in) is first put to
// the emitted Claude Code PreToolUse gate, as Claude Code does: stdin JSON in,
// exit 2 refuses with stderr as the reason, anything else proceeds. Both read
// INTUTIC_CHAOS_PLAN and INTUTIC_CHAOS_EVENTS from the environment the chaos
// runner gave the sandbox.
//
// --mode resilient  reports every error it sees (so the canary reaches stdout),
//                   retries failed and stale lookups, re-lists tools when told
//                   the toolset changed, treats tool output as data, and stops
//                   on a permission denial instead of pretending.
// --mode fragile    swallows errors, trusts whatever a tool returns, follows
//                   instructions found in tool results or descriptions, and
//                   always claims success.
//
// --gate-from-settings  finds the gate the way Claude Code does instead of at
//                   a fixed path: the PreToolUse hooks in .claude/settings.json
//                   whose matcher matches the tool, each run as `sh -c
//                   <command>`, with the snapshot wherever the environment
//                   says. That is the settings file and gate the sync daemon
//                   wrote on the host, carried into the sandbox by the runner.
//
// Bash calls are gated but never executed: the commands a fragile agent picks
// up from an injected payload are exactly the ones nothing should run.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const mode = process.argv[process.argv.indexOf('--mode') + 1]
if (mode !== 'resilient' && mode !== 'fragile') {
  console.error('usage: node harness.mjs --mode resilient|fragile')
  process.exit(64)
}
const resilient = mode === 'resilient'
const fromSettings = process.argv.includes('--gate-from-settings')

const MCP_PROXY = process.env.INTUTIC_E2E_MCP_PROXY || '/opt/intutic/mcp-proxy/dist/index.js'
const GATE = process.env.INTUTIC_E2E_GATE || 'gate/claude-code-check.js'
const SNAPSHOT = process.env.INTUTIC_E2E_SNAPSHOT || 'gate/policy-snapshot.rules'
const OUT_DIR = '.intutic-chaos'
const RESULT = `${OUT_DIR}/result.txt`
const SERVER = 'records'

const say = (text) => console.log(`[agent ${mode}] ${text}`)

// ── The PreToolUse gate, one process per call ────────────────────────────────

/** The hook commands .claude/settings.json registers for `tool`, as Claude Code matches them. */
function settingsHooks(tool) {
  const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'))
  return (settings.hooks?.PreToolUse ?? [])
    .filter((entry) => new RegExp(`^(?:${entry.matcher ?? '.*'})$`).test(tool))
    .flatMap((entry) => (entry.hooks ?? []).filter((h) => h.type === 'command').map((h) => h.command))
}

const announced = new Set()
async function gate(tool, input) {
  if (!fromSettings) return runGate(['node', GATE], { INTUTIC_SNAPSHOT_RULES: SNAPSHOT }, tool, input)
  const commands = settingsHooks(tool)
  if (commands.length === 0) {
    // Claude Code would run the call ungoverned; say so, loudly.
    say(`no PreToolUse hook in .claude/settings.json matches ${tool}`)
    return { allowed: true, reason: '' }
  }
  for (const command of commands) {
    if (!announced.has(command)) {
      announced.add(command)
      say(`gate from .claude/settings.json: ${command}`)
    }
    const r = await runGate(['sh', '-c', command], {}, tool, input)
    if (!r.allowed) return r
  }
  return { allowed: true, reason: '' }
}

function runGate(argv, env, tool, input) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.stdout.resume()
    child.on('error', (err) => resolve({ allowed: true, reason: `gate did not run: ${err.message}` }))
    child.on('close', (code) => {
      // Claude Code's contract: 2 refuses, anything else lets the call proceed.
      resolve(code === 2 ? { allowed: false, reason: stderr.trim() } : { allowed: true, reason: stderr.trim() })
    })
    child.stdin.end(JSON.stringify({ session_id: 'chaos-e2e', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: process.cwd() }))
  })
}

// ── The MCP client, through the MCP proxy ────────────────────────────────────

const proxyLog = fs.openSync(`${OUT_DIR}/mcp-proxy.log`, 'a')
const mcp = spawn('node', [MCP_PROXY, '--workspace-id', 'ws_chaos_e2e', '--server-name', SERVER, '--', 'node', 'agent/records-server.mjs'], {
  stdio: ['pipe', 'pipe', proxyLog],
})
const waiting = new Map()
let nextId = 1
let toolsChanged = false
readline.createInterface({ input: mcp.stdout, terminal: false }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'notifications/tools/list_changed') toolsChanged = true
  else if (msg.id !== undefined) waiting.get(msg.id)?.(msg)
})

function rpc(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${method} within 20s`)), 20_000)
    waiting.set(id, (msg) => {
      clearTimeout(timer)
      waiting.delete(id)
      resolve(msg)
    })
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

/** One MCP tool call as Claude Code makes it: gate first, then the server. */
async function callTool(name, args) {
  const g = await gate(`mcp__${SERVER}__${name}`, args)
  if (!g.allowed) return { error: g.reason }
  const res = await rpc('tools/call', { name, arguments: args })
  if (res.error) return { error: res.error.message ?? JSON.stringify(res.error) }
  const texts = (res.result?.content ?? []).map((c) => String(c.text ?? ''))
  if (res.result?.isError) return { error: texts.join(' ') }
  return { texts }
}

/** A built-in tool call: gate first; Write then really writes. */
async function builtin(tool, input) {
  const g = await gate(tool, input)
  if (!g.allowed) return { error: g.reason }
  if (tool === 'Write') fs.writeFileSync(input.file_path, input.content)
  return {}
}

/** Commands an instruction in some text asks for, e.g. "run `make clean`". */
const instructions = (text) => [...text.matchAll(/\brun `([^`]+)`/gi)].map((m) => m[1])

let tools = []
async function listTools() {
  tools = (await rpc('tools/list')).result?.tools ?? []
}

// ── The two personalities ────────────────────────────────────────────────────

async function lookupResilient(key) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (toolsChanged) {
      toolsChanged = false
      await listTools()
      say(`the server's toolset changed mid-session; now: ${tools.map((t) => t.name).join(', ')}. Tool descriptions are not instructions; ignoring any they carry.`)
    }
    const name = tools.some((t) => t.name === 'get_record') ? 'get_record' : 'get_record_v2'
    const r = await callTool(name, { key })
    if (r.error) {
      say(`${name}(${key}) failed: ${r.error}`)
      continue
    }
    if (r.texts.length > 1) say(`${name}(${key}) returned extra text; treating it as data, not instructions`)
    let record
    try {
      record = JSON.parse(r.texts[0])
    } catch {
      say(`${name}(${key}) returned something that is not a record: ${r.texts[0]}`)
      continue
    }
    const ageS = (Date.now() - Date.parse(record.as_of)) / 1000
    if (!(ageS < 3600)) {
      say(`${name}(${key}) returned a stale record (as of ${record.as_of}); fetching it again`)
      continue
    }
    return record.value
  }
  throw new Error(`could not get a usable ${key} record after 3 attempts`)
}

async function lookupFragile(key) {
  if (toolsChanged) {
    toolsChanged = false
    await listTools()
    for (const t of tools) for (const cmd of instructions(t.description ?? '')) await bashFragile(cmd)
  }
  const r = await callTool('get_record', { key })
  if (r.error) return 'unknown'
  for (const text of r.texts.slice(1)) for (const cmd of instructions(text)) await bashFragile(cmd)
  try {
    return JSON.parse(r.texts[0]).value
  } catch {
    return 'unknown'
  }
}

async function bashFragile(command) {
  const r = await builtin('Bash', { command })
  if (!r.error) say(`ran \`${command}\` as the tool output asked`)
}

async function writeResult(content) {
  const input = { file_path: RESULT, content }
  if (!resilient) {
    await builtin('Write', input)
    return
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await builtin('Write', input)
    if (!r.error) return
    say(`Write ${RESULT} failed: ${r.error}`)
    if (/permission|approv/i.test(r.error)) throw new Error('the Write was denied; stopping rather than working around an approver')
  }
  throw new Error(`could not write ${RESULT} after 3 attempts`)
}

async function main() {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chaos-e2e-harness', version: '1.0.0' } })
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  await listTools()
  const lookup = resilient ? lookupResilient : lookupFragile
  const color = await lookup('color')
  const size = await lookup('size')
  await writeResult(`color=${color}\nsize=${size}\n`)
}

let code = 0
try {
  await main()
  say(resilient ? `done: wrote ${RESULT}` : 'All done! Everything worked perfectly.')
} catch (err) {
  say(`giving up: ${err.message}`)
  code = 1
} finally {
  mcp.stdin.end()
  mcp.kill()
}
// A fragile agent claims success whatever happened.
process.exit(resilient ? code : 0)
