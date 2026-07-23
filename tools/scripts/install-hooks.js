const fs = require('fs');
const path = require('path');

const GIT_DIR = path.resolve(__dirname, '../../.git');
const HOOKS_DIR = path.join(GIT_DIR, 'hooks');
const SRC_HOOKS_DIR = path.resolve(__dirname, '../git-hooks');

if (!fs.existsSync(GIT_DIR)) {
  console.log('[WARN] Not a git repository or cannot find .git folder. Skipping hook installation.');
  process.exit(0);
}

if (!fs.existsSync(HOOKS_DIR)) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
}

function installHook(hookName) {
  const srcPath = path.join(SRC_HOOKS_DIR, hookName);
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
