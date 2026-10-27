#!/usr/bin/env node
/**
 * Build the standalone `intutic` binaries: the built CLI (dist/cli.js) bundled into one
 * ES module with esbuild, then packaged with `pkg`.
 *
 * `pkg` on the tsc output alone cannot run most of the CLI. The commands are lazily
 * imported (`await import('./commands/x.js')`), and a dynamic import() of a file inside
 * pkg's snapshot fails with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, so a binary built
 * that way answered --version and --help and nothing else. Bundling inlines those
 * modules.
 *
 * Usage (after `pnpm --filter @intutic/cli run build`):
 *   node scripts/build-binary.mjs [--targets node22-linux-x64,node22-macos-arm64] [--out-dir <dir>]
 *
 * With no --targets it builds for this machine. Output: <out-dir>/cli-<platform>-<arch>[.exe],
 * the names the release job uploads.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = join(cliDir, 'dist/cli.js')
const requireFromCli = createRequire(join(cliDir, 'package.json'))

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 ? process.argv[at + 1] : fallback
}

const hostTarget = `node22-${{ darwin: 'macos', linux: 'linux', win32: 'win' }[platform()]}-${arch() === 'arm64' ? 'arm64' : 'x64'}`
const targets = option('targets', hostTarget)
const outDir = resolve(option('out-dir', join(cliDir, 'dist-binary')))
const stage = join(cliDir, '.build-binary')

if (!existsSync(cliEntry)) {
  console.error(`@intutic/cli is not built (${cliEntry} is missing). Run: pnpm --filter @intutic/cli run build`)
  process.exit(1)
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

/**
 * `createRequire(import.meta.url)('../package.json')` reads a file next to the source; bundled, the
 * file is not there, so it becomes a bundled require.
 */
const inlineJsonReads = {
  name: 'inline-json-reads',
  setup(b) {
    b.onLoad({ filter: /[\\/]dist[\\/].*\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8').replace(
        /createRequire\(import\.meta\.url\)\((['"][^'"]+\.json['"])\)/g,
        'require($1)',
      )
      return { contents: source, loader: 'js', resolveDir: dirname(args.path) }
    })
  },
}

const bundle = join(stage, 'intutic.mjs')
await build({
  entryPoints: [cliEntry],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // CommonJS dependencies (commander, ioredis, ws, ...) call require() for Node's built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  // Optional native accelerators of `ws`; it falls back to JavaScript without them.
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [inlineJsonReads],
  logLevel: 'warning',
})

const cliPackage = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'))
// The name sets the output file name: pkg writes <name>-<platform>-<arch>.
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({ name: 'cli', version: cliPackage.version, type: 'module', bin: { intutic: 'intutic.mjs' } }, null, 2),
)

mkdirSync(outDir, { recursive: true })
const pkgBin = requireFromCli.resolve('@yao-pkg/pkg/lib-es5/bin.js')
execFileSync(process.execPath, [pkgBin, join(stage, 'package.json'), '--targets', targets, '--out-path', outDir], { stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })
console.log(`\nBinaries are in ${outDir}.`)
