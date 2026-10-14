/**
 * The hook script `intuticSandboxBootstrap()` writes into a sandbox, read
 * through its public `onBootstrap` with a fake session, so the tests that
 * run the script need nothing from the package beyond its documented surface.
 * The script reads `policy-snapshot.rules` from its own directory.
 */
import { intuticSandboxBootstrap } from '../../harness.js'

export async function sandboxGateScript(workspaceId = ''): Promise<string> {
  const written: Array<{ path: string; content: string }> = []
  await intuticSandboxBootstrap({ workspaceId }).onBootstrap({
    session: {
      writeTextFile: async (opts: { path: string; content: string }) => {
        written.push(opts)
      },
      readTextFile: async () => null,
      run: async () => ({ exitCode: 0, stdout: '/home/sandbox', stderr: '' }),
    },
    workDir: '/w',
  })
  const script = written.find((w) => w.path.endsWith('/claude-code-check.js'))
  if (!script) throw new Error('intuticSandboxBootstrap wrote no hook script')
  return script.content
}
