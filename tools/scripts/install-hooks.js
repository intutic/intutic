const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_HOOKS_DIR = path.resolve(__dirname, '../git-hooks');

/**
 * Resolves the git directory whose `hooks/` subfolder git actually reads.
 *
 * `path.resolve(__dirname, '../../.git')` is correct in an ordinary clone,
 * where `.git` is a directory — and wrong in a git WORKTREE, where `.git` is
 * a plain FILE containing `gitdir: <path>/.git/worktrees/<name>`. Treating
 * that file as a directory and `path.join`-ing `hooks` onto it produces a
 * path with a regular file in the middle, so `mkdirSync` fails with `ENOTDIR:
 * not a directory, mkdir '.../.git/hooks'` — which is silent in a normal
 * `pnpm install` (the `prepare` script's failure is easy to miss) and fatal
 * for a tool that is expected to build cleanly inside a worktree (e.g. the
 * isolated worktrees the Workflow tool creates for parallel agent work).
 *
 * Hooks are not per-worktree in git — every worktree of one repository
 * shares the SAME `hooks/` directory, in the common git dir, not a directory
 * this script should be creating fresh per worktree. `git rev-parse
 * --git-common-dir` is git's own answer to "where is that," and is correct
 * in both the ordinary-clone and worktree cases without this script having
 * to parse the `gitdir:` file format itself. Falls back to the old
 * directory-resolution path only if git itself is unavailable — the
 * `existsSync` check right after this call is what actually gates whether
 * hook installation proceeds, same as before.
 */
function resolveGitDir() {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return path.isAbsolute(out) ? out : path.resolve(REPO_ROOT, out);
  } catch {
    // git not on PATH, or REPO_ROOT is not a git repo at all — fall through
    // to the plain-directory guess, which existsSync below will reject.
  }
  return path.resolve(REPO_ROOT, '.git');
}

const GIT_DIR = resolveGitDir();
const HOOKS_DIR = path.join(GIT_DIR, 'hooks');
const SRC_HOOKS_DIR_RESOLVED = SRC_HOOKS_DIR;

if (!fs.existsSync(GIT_DIR) || !fs.statSync(GIT_DIR).isDirectory()) {
  console.log('[WARN] Not a git repository or cannot find the git common directory. Skipping hook installation.');
  process.exit(0);
}

if (!fs.existsSync(HOOKS_DIR)) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
}

function installHook(hookName) {
  const srcPath = path.join(SRC_HOOKS_DIR_RESOLVED, hookName);
  const destPath = path.join(HOOKS_DIR, hookName);

  if (!fs.existsSync(srcPath)) {
    console.error(`Source hook not found: ${srcPath}`);
    return;
  }

  console.log(`Installing hook: ${hookName}...`);
  fs.copyFileSync(srcPath, destPath);

  try {
    fs.chmodSync(destPath, '755');
  } catch (err) {
    console.warn(`Warning: Could not make ${hookName} executable automatically:`, err.message);
  }
}

installHook('pre-commit');
installHook('pre-push');

console.log('Git hooks successfully configured!');
