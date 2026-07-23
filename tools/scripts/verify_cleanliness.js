const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(process.cwd());
const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', '.dist', '.turbo', 'target', 'test-workspace-e2e', 'llm-bridge-study', '.intutic', '.claude', '.cline', '.cursor', '.openhands', '.windsurf'];
const EXCLUDE_FILES = ['pnpm-lock.yaml', 'verify_cleanliness.js', 'LICENSE', 'task.md', 'walkthrough.md', 'release_architecture_plan.md', 'final_release_audit.md'];

// Keywords that indicate residual product-specific or personal configuration code
const FORBIDDEN_KEYWORDS = [
  'ishangupta',
  'drizzle-kit',
  'pg-core',
  'stripe',
  'enterprise-install',
  'traces fork',
  'intutic benchmark',
  'intutic eval',
  'intutic mdm'
];

function getFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      if (EXCLUDE_DIRS.includes(file)) continue;
      results = results.concat(getFiles(filePath));
    } else {
      if (EXCLUDE_FILES.includes(file)) continue;
      results.push(filePath);
    }
  }
  return results;
}

function verifyFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(ROOT_DIR, filePath);
  const violations = [];

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (content.toLowerCase().includes(keyword.toLowerCase())) {
      violations.push(keyword);
    }
  }

  return {
    relativePath,
    clean: violations.length === 0,
    violations
  };
}

function main() {
  console.log('===================================================');
  console.log('   Intutic File-by-File Cleanliness Verification   ');
  console.log('===================================================');

  const files = getFiles(ROOT_DIR);
  console.log(`Scanning ${files.length} source and configuration files...\n`);

  let cleanCount = 0;
  let violationCount = 0;

  for (const file of files) {
    const status = verifyFile(file);
    if (status.clean) {
      cleanCount++;
    } else {
      violationCount++;
      console.log(`❌ VIOLATION in: ${status.relativePath}`);
      console.log(`   Found keywords: ${status.violations.join(', ')}`);
    }
  }

  console.log('\n===================================================');
  console.log(`Scan complete.`);
  console.log(`Clean files: ${cleanCount}`);
  console.log(`Violations: ${violationCount}`);
  console.log('===================================================');

  if (violationCount > 0) {
    process.exit(1);
  } else {
    console.log('🎉 Verification PASSED: Repository is 100% clean!');
  }
}

main();
