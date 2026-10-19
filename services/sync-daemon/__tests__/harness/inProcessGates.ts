/**
 * Drivers for the in-process gates — OpenCode's plugin (`plugin-throw`), Pi's
 * extension and OpenClaw's plugin (`plugin-block`) — which have no stdin
 * envelope or exit code for a spawn-and-pipe test to read. Each loads the
 * emitted file the way its host does, in a child process, and drives one tool
 * call through it. The same drivers `generatedGateBehaviour.test.ts` defines
 * inline, shared here so the hold and bypass suite (`reviewHoldBypass.test.ts`)
 * and the rule-record suite can drive these gates too.
 *
 * Asynchronous spawns only: a `spawnSync` inside a Vitest worker starves its
 * RPC on a long run.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GateEntry } from './gateRegistry.js'

export interface InProcessResult {
  refused: boolean
  stderr: string
  status: number
}

function run(args: string[], input: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ status: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    // The host's working directory is the project: the root.
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { stderr += d })
    child.stdout.resume()
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code === null ? -1 : code, stderr }) })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * One call through an in-process gate. `root` is the gate's HOME and
 * workspace; `env` is added to it (INTUTIC_SNAPSHOT_RULES and the like).
 * OpenCode is driven through its 1.x `tool.execute.before` hook.
 */
export async function runInProcessGate(
  g: GateEntry,
  root: string,
  tool: string,
  args: unknown,
  env: NodeJS.ProcessEnv,
): Promise<InProcessResult> {
  const driver = join(root, `in-process-drv-${g.name}.mjs`)
  const lines =
    g.contract === 'plugin-throw'
      ? [
          "import { pathToFileURL } from 'node:url';",
          'const [file, tool] = process.argv.slice(2);',
          "let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;",
          'const args = JSON.parse(stdin);',
          'const plugin = (await import(pathToFileURL(file).href)).default;',
          "if (typeof plugin !== 'function' || typeof plugin.server !== 'function') { console.error('wrong plugin shape'); process.exit(4); }",
          'const hooks = await plugin.server({ directory: process.cwd() });',
          "const hook = hooks && hooks['tool.execute.before'];",
          "if (typeof hook !== 'function') { console.error('no tool.execute.before hook'); process.exit(4); }",
          "Promise.resolve().then(() => hook({ tool, sessionID: 'sess_test', callID: 'call_1' }, { args })).then(() => process.exit(0),",
          '  (e) => { console.error(String((e && e.message) || e)); process.exit(3); });',
        ]
      : [
          "import { pathToFileURL } from 'node:url';",
          "import { createRequire } from 'node:module';",
          'const [file, host, tool] = process.argv.slice(2);',
          "let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;",
          'const args = JSON.parse(stdin);',
          'let handler, call;',
          "if (host === 'pi') {",
          '  const factory = (await import(pathToFileURL(file).href)).default;',
          "  await factory({ on(name, fn) { if (name === 'tool_call') handler = fn; } });",
          "  call = () => handler({ type: 'tool_call', toolName: tool, toolCallId: 'call_1', input: args },",
          "    { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => 'sess_test' } });",
          '} else {',
          '  const plugin = createRequire(import.meta.url)(file);',
          "  plugin.register({ on(name, fn) { if (name === 'before_tool_call') handler = fn; } });",
          "  call = () => handler({ toolName: tool, params: args, toolCallId: 'call_1', runId: 'run_1' },",
          "    { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sess_test', runId: 'run_1' });",
          '}',
          "if (typeof handler !== 'function') { console.error('no tool-call handler registered'); process.exit(4); }",
          'let res;',
          'try { res = await call(); } catch (e) { console.error(String((e && e.message) || e)); process.exit(6); }',
          "if (res && res.block === true) { console.error(String(res.reason || res.blockReason || '')); process.exit(3); }",
          "if (res && res.requireApproval) { console.error('ASKED ' + JSON.stringify(res)); process.exit(5); }",
          'process.exit(0);',
        ]
  writeFileSync(driver, lines.join('\n'))
  const argv = g.contract === 'plugin-throw' ? [driver, join(root, g.artifact), tool] : [driver, join(root, g.artifact), g.name, tool]
  const res = await run(argv, JSON.stringify(args), { ...process.env, HOME: root, USERPROFILE: root, ...env }, root)
  if (res.status === 4 || res.status === 6 || res.status === -1) {
    throw new Error(`${g.name}: the host could not drive the gate (exit ${res.status}): ${res.stderr}`)
  }
  return { refused: res.status === 3, stderr: res.stderr, status: res.status }
}

/** The host's own shell tool id: OpenCode's and Pi's `bash`, OpenClaw's `exec`. */
export function inProcessShellTool(g: GateEntry): string {
  return g.name === 'openclaw' ? 'exec' : 'bash'
}
