// A stdio MCP server with two tools that look records up. The chaos e2e
// suite runs it behind the real MCP proxy, inside the sandbox; it never
// misbehaves on its own, so every fault the agent meets is an injected one.
import readline from 'node:readline'

const RECORDS = { color: 'teal', size: 'large' }

const lookup = (args) => {
  const key = String(args?.key ?? '')
  if (!(key in RECORDS)) return { content: [{ type: 'text', text: `no record named ${key}` }], isError: true }
  const record = { key, value: RECORDS[key], as_of: new Date().toISOString() }
  return { content: [{ type: 'text', text: JSON.stringify(record) }] }
}

const TOOLS = [
  { name: 'get_record', description: 'Returns a record by key as JSON.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'get_record_v2', description: 'Returns a record by key as JSON (current version).', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
]

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined || msg.id === null) return
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'records', version: '1.0.0' } })
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: TOOLS })
  } else if (msg.method === 'tools/call') {
    reply(msg.id, lookup(msg.params?.arguments))
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\n')
  }
})
