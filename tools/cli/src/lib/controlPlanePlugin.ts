/**
 * The control-plane commands are not in this package.
 *
 * `login`, `connect`, `guardrails`, `keys`, `org` and the rest only work
 * against a control plane, and their code reveals that control plane's API.
 * They live in `@intutic/cli-control-plane`, an optional package installed next
 * to this one. At startup `cli.ts` loads it and hands it the command tree; with
 * no plugin installed the CLI simply has no such commands, and one that is run
 * says what it is and where it comes from instead of "unknown command".
 *
 * What the plugin may rely on is `ControlPlanePluginContext` below and the
 * subpaths of this package's `exports` (package.json): each is a module the
 * plugin's commands build on (credentials, the API client, paths, ...). Add a
 * subpath only for a module the plugin needs, and bump {@link PLUGIN_API_VERSION}
 * when a change would break a plugin built against the old one.
 *
 * @module
 */
import type { Command } from 'commander'
import { NO_CONTROL_PLANE_MESSAGE } from '@intutic/shared-types'

/** The package that provides the control-plane commands. */
export const CONTROL_PLANE_PLUGIN = '@intutic/cli-control-plane'

/** The version of the contract between this CLI and the plugin's `register`. */
export const PLUGIN_API_VERSION = 1

/** What the CLI tells the plugin when it registers. */
export interface ControlPlanePluginContext {
  /** {@link PLUGIN_API_VERSION}: the plugin refuses a CLI whose contract it does not know. */
  apiVersion: number
  /** The running CLI's version (`intutic --version`). */
  cliVersion: string
}

/** The one thing the plugin package exports that the CLI uses. */
export interface ControlPlanePlugin {
  register(program: Command, ctx: ControlPlanePluginContext): void
}

/**
 * The commands the plugin provides: names only, so a CLI without the plugin can
 * say what a command is. A nested name (`budget set`) is a subcommand of an
 * open command. The plugin's own tests hold this list to what it registers, and
 * cliReference.test.ts holds it to the CLI reference.
 */
export const CONTROL_PLANE_COMMANDS: readonly string[] = [
  'judge',
  'login',
  'logout',
  'budget set',
  'budget keys',
  'budget key',
  'budget members',
  'budget member',
  'predict-cost',
  'sops',
  'optimizer',
  'policy snapshot',
  'policy replay',
  'guardrails',
  'whoami',
  'enforce report',
  'enterprise',
  'connect',
  'sync-context',
  'decisions-log-refresh',
  'findings',
  'incidents',
  'integrity',
  'routing',
  'loop',
  'decision',
  'gateway',
  'credentials',
  'attenuate',
  'keys',
  'org',
  'team',
  'settings',
  'mcp',
  'notifications',
  'siem',
  'tasks',
  'compliance',
  'usage',
  'github',
  'inventory',
  'gate-liveness',
]

/** The plugin command a command line names, if any: `whoami`, or `budget set` for `budget set --daily 5`. */
export function controlPlaneCommandIn(args: readonly string[]): string | undefined {
  // `intutic help whoami` asks about the command the same way `intutic whoami` runs it.
  const [first, second] = args[0] === 'help' ? args.slice(1) : args
  if (first === undefined) return undefined
  if (CONTROL_PLANE_COMMANDS.includes(first)) return first
  const nested = `${first} ${second}`
  return CONTROL_PLANE_COMMANDS.includes(nested) ? nested : undefined
}

/** What a plugin command says when the plugin is not installed. */
export function missingPluginMessage(command: string): string {
  return (
    `\`intutic ${command}\` is a control-plane command. The open-core CLI does not include it: ` +
    `it comes from the ${CONTROL_PLANE_PLUGIN} package, which is not installed alongside this CLI.\n` +
    NO_CONTROL_PLANE_MESSAGE
  )
}

/**
 * Whether an import error means there is no plugin here: Node's error for a
 * package that is not installed (not for one of that package's own imports),
 * or a single-file `pkg` binary, where a run-time import() of anything fails
 * with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.
 */
function isPluginUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return (
    code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING' ||
    (code === 'ERR_MODULE_NOT_FOUND' && err.message.includes(`'${CONTROL_PLANE_PLUGIN}'`))
  )
}

/**
 * Load the plugin and let it register its commands on `program`. False when there
 * is no plugin to load (see isPluginUnavailable). Any other failure (the plugin throws on load, one of
 * its own imports is missing, it exports no `register`) is thrown: a broken
 * plugin must not pass for an absent one.
 */
export async function loadControlPlanePlugin(
  program: Command,
  cliVersion: string,
  // The specifier is a variable so that tsc and bundlers do not resolve it:
  // this package builds and runs without the plugin. A parameter so a test can stand in for the import.
  importPlugin: () => Promise<unknown> = () => import(CONTROL_PLANE_PLUGIN),
): Promise<boolean> {
  let plugin: Partial<ControlPlanePlugin>
  try {
    plugin = (await importPlugin()) as Partial<ControlPlanePlugin>
  } catch (err) {
    if (isPluginUnavailable(err)) return false
    throw err
  }
  if (typeof plugin.register !== 'function') {
    throw new Error(`${CONTROL_PLANE_PLUGIN} is installed but exports no register(program, ctx).`)
  }
  plugin.register(program, { apiVersion: PLUGIN_API_VERSION, cliVersion })
  return true
}
