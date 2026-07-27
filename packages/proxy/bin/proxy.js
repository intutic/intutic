#!/usr/bin/env node
/**
 * Launcher for the native intutic-proxy binary.
 *
 * The npm package deliberately ships NO compiled binary. Publishing one would
 * mean shipping whichever platform the release runner happened to build on
 * (ubuntu-latest → linux-x64) to every consumer, so macOS and Windows installs
 * received an ELF binary that cannot exec. Instead the correct per-platform
 * asset is fetched on first run from the GitHub Release for this package's
 * version, which .github/workflows/publish.yml uploads for all five targets.
 *
 * The download mirrors tools/cli/src/commands/connect.ts: same asset names
 * (which MUST match the `artifact_name` values in the publish workflow's
 * build-rust-proxy matrix), same URL scheme, and the same ~/.intutic/bin cache
 * — so `intutic connect` and `npx @intutic/proxy` never download twice.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const isWindows = process.platform === 'win32';
const binaryName = isWindows ? 'intutic-proxy.exe' : 'intutic-proxy';

/** Asset names MUST match publish.yml's build-rust-proxy matrix artifact_name. */
function resolveAssetName() {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'intutic-proxy-darwin-arm64';
    if (arch === 'x64') return 'intutic-proxy-darwin-x64';
  } else if (platform === 'linux') {
    if (arch === 'x64') return 'intutic-proxy-linux-x64';
    if (arch === 'arm64') return 'intutic-proxy-linux-arm64';
  } else if (platform === 'win32') {
    if (arch === 'x64') return 'intutic-proxy-win32-x64.exe';
  }
  return null;
}

/**
 * Absolute path to the shared `~/.intutic/bin` cache.
 *
 * `os.homedir()` can return an empty string when HOME is unset or blank (some
 * CI images, `env -i`, certain daemon contexts). `path.join('', …)` yields a
 * RELATIVE path, which would silently write a ~39MB binary into whatever
 * directory the process happened to start in. Refuse that outright.
 */
function cacheDir() {
  const home = os.homedir();
  if (!home || !path.isAbsolute(home)) return null;
  return path.join(home, '.intutic', 'bin');
}

/**
 * Name the cached binary after the version that produced it.
 *
 * The cache used to be a single unversioned `intutic-proxy`, and nothing ever
 * checked what was in it — `findExistingBinary` returned the first path that
 * existed and `main` only downloaded when there was none. So upgrading the npm
 * package did not upgrade the binary: anyone who ran `intutic connect` or
 * `npx @intutic/proxy` before this kept executing whatever they first
 * downloaded, indefinitely. Combined with the release tag having been pinned to
 * a literal 1.6.0, that meant users stuck on a proxy that still required Valkey
 * no matter how many times they upgraded.
 *
 * Versioning the filename makes a stale cache unrepresentable: a new version
 * looks for a name that does not exist yet, so it downloads.
 */
function cachedBinaryName() {
  return isWindows ? `intutic-proxy-${version}.exe` : `intutic-proxy-${version}`;
}

/**
 * Search order matches `intutic connect`: a locally built binary wins (so repo
 * development never hits the network), then the version-specific global cache.
 */
function findExistingBinary() {
  const cache = cacheDir();
  const candidates = [
    path.join(__dirname, binaryName),
    path.resolve(__dirname, '..', 'target', 'release', binaryName),
    path.resolve(__dirname, '..', '..', '..', 'target', 'release', binaryName),
    ...(cache ? [path.join(cache, cachedBinaryName())] : []),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Remove the pre-1.7.1 unversioned cache entry if present. Its version is
 * unknowable, so it cannot be trusted or reused — and leaving it behind means
 * every upgraded user carries a dead 39MB file forever.
 */
function pruneLegacyCache() {
  const cache = cacheDir();
  if (!cache) return;
  const legacy = path.join(cache, binaryName);
  try {
    if (fs.existsSync(legacy)) {
      fs.unlinkSync(legacy);
      process.stderr.write('intutic-proxy: removed unversioned cached binary from a previous release\n');
    }
  } catch {
    // Best effort. A stale file we cannot delete is not a reason to fail.
  }
}

async function downloadBinary(destPath) {
  const assetName = resolveAssetName();
  if (!assetName) {
    throw new Error(
      `Unsupported platform/architecture: ${process.platform}-${process.arch}.\n` +
        `Build from source instead: cargo build --release --package intutic-proxy`
    );
  }

  const url = `https://github.com/intutic/intutic/releases/download/v${version}/${assetName}`;
  process.stderr.write(`intutic-proxy: downloading ${assetName} (v${version})…\n`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${assetName} (HTTP ${response.status} ${response.statusText}).\n` +
        `  URL: ${url}\n` +
        `Build from source instead: cargo build --release --package intutic-proxy`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // Write to a temp path and rename, so a partial download from an interrupted
  // run is never left behind looking like a usable binary.
  const tmpPath = `${destPath}.download`;
  fs.writeFileSync(tmpPath, buffer);
  if (!isWindows) fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, destPath);

  process.stderr.write(`intutic-proxy: installed to ${destPath}\n`);
  return destPath;
}

async function main() {
  pruneLegacyCache();
  let binaryPath = findExistingBinary();

  if (!binaryPath) {
    const cache = cacheDir();
    if (!cache) {
      process.stderr.write(
        'Error: cannot resolve a home directory to cache the intutic-proxy binary ' +
          '(HOME is unset or not absolute).\n' +
          'Set HOME, or build from source: cargo build --release --package intutic-proxy\n'
      );
      process.exit(1);
    }
    try {
      binaryPath = await downloadBinary(path.join(cache, cachedBinaryName()));
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }

  const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit' });

  child.on('error', (err) => {
    process.stderr.write(`Error: failed to start ${binaryPath}: ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (code !== null) {
      process.exit(code);
    } else if (signal) {
      process.kill(process.pid, signal);
    }
  });
}

main();
