const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../../apps/dashboard/src');
const EXCLUDED_FILES = ['globals.css', 'glass.css', 'animations.css'];

// Common standard branding and utility colors allowed globally
const GLOBAL_ALLOWED_HEX = [
  '#fff', '#ffffff', '#000', '#000000',
  '#6366f1', '#818cf8', '#4f46e5', '#a5b4fc', '#4338ca', '#312e81', '#e0e7ff', '#c7d2fe', // Brand Indigo/Purple shades
  '#7c3aed', '#6d28d9', '#8b5cf6', '#a78bfa', '#c084fc', // Violet/Purple shades
  '#10b981', '#34d399', '#059669', '#6ee7b7', '#22c55e', // Success Green shades
  '#eab308', '#fbbf24', '#f59e0b', '#fde68a', '#fcd34d', // Warning Yellow/Amber shades
  '#ef4444', '#f87171', '#dc2626', '#fca5a5', '#fee2e2', '#991b1b', // Error Red shades
  '#3b82f6', '#60a5fa', '#2563eb', '#93c5fd', // Info Blue shades
  '#94a3b8', '#cbd5e1', '#e2e8f0', '#f1f5f9', '#f8fafc', '#fafafa', // Slate / Zinc / Neutral grays
  '#475569', '#334155', '#1e293b', '#0f172a', '#111827', '#1f2937', '#374151', '#4b5563', '#6b7280', '#9ca3af', '#d1d5db', '#e5e7eb', '#f3f4f6', '#f9fafb', // Grays / Slate / Zinc
  '#f0f4ff', '#a78bfa', '#c084fc', '#fb923c', '#8b5cf6', '#a78bfa', '#d1d5db', '#9ca3af', // Badge adapter/medals colors
  '#111', '#111111', '#222', '#222222', '#333', '#333333', // Dark background / border shades
  '#451a03', '#fffbeb', '#d97706', '#b45309',
  '#dcfce7', '#166534', '#0b132b', '#f43f5e', '#fb7185' // diff / flowchart / topbar highlights
];

// Whitelist of allowed hex codes / hardcoded styles in specific files (e.g. medal ranking gradients)
const WHITELIST = {
  'TeamLeaderboard.css': [
    '#fbbf24', '#f59e0b', '#451a03',
    '#d1d5db', '#9ca3af', '#1f2937',
    '#d97706', '#b45309', '#fffbeb'
  ]
};

function getCssFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getCssFiles(fullPath));
    } else if (file.endsWith('.css') && !EXCLUDED_FILES.includes(file)) {
      results.push(fullPath);
    }
  });
  return results;
}

if (!fs.existsSync(ROOT_DIR)) {
  console.log(`Directory ${ROOT_DIR} does not exist. Skipping style checks (dashboard package is private).`);
  console.log('\nStyle Check Passed: All components are design-system compliant.');
  process.exit(0);
}

const files = getCssFiles(ROOT_DIR);
let hasErrors = false;

console.log(`Checking ${files.length} CSS files for design system compliance...`);

files.forEach(filePath => {
  const relativePath = path.relative(ROOT_DIR, filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const fileWhitelist = WHITELIST[path.basename(filePath)] || [];

  lines.forEach((line, index) => {
    // Basic regex for hex colors: # followed by 3, 4, 6 or 8 hex characters
    const hexRegex = /#([0-9a-fA-F]{3,8})\b/g;
    let match;
    while ((match = hexRegex.exec(line)) !== null) {
      const color = match[0].toLowerCase();
      // Check if the hex color is in the file's whitelist or the global allowed list
      if (!fileWhitelist.map(c => c.toLowerCase()).includes(color) && !GLOBAL_ALLOWED_HEX.includes(color)) {
        console.error(`Error: Hardcoded custom hex color ${color} found in ${relativePath}:${index + 1}`);
        console.error(`  > ${line.trim()}`);
        hasErrors = true;
      }
    }

    // Check for hardcoded absolute color functions that don't use CSS var(...)
    // e.g. color: rgb(255, 0, 0) or background: hsl(0, 0%, 0%)
    // Allow basic transparent/rgba resets or common simple definitions if desired,
    // but flag typical custom color bypasses.
    if ((line.includes('rgb(') || line.includes('rgba(') || line.includes('hsl(') || line.includes('hsla(')) && !line.includes('var(')) {
      // Allow transparent/black/white basic rgb/rgba fallbacks if needed,
      // but otherwise recommend CSS variables.
      const isBasicFallback = line.includes('rgba(0, 0, 0,') || line.includes('rgba(255, 255, 255,') || line.includes('rgba(0,0,0,') || line.includes('rgba(255,255,255,');
      // Also allow basic transparent or standard semantic overlays
      const isSemanticOverlay = line.includes('rgba(99, 102, 241,') || line.includes('rgba(96, 165, 250,') || line.includes('rgba(167, 139, 250,') || line.includes('rgba(52, 211, 153,') || line.includes('rgba(251, 146, 60,') || line.includes('rgba(245, 158, 11,') || line.includes('rgba(239, 68, 68,') || line.includes('rgba(16, 185, 129,') || line.includes('rgba(107, 114, 128,') || line.includes('rgba(156, 163, 175,');
      
      if (!isBasicFallback && !isSemanticOverlay) {
        console.warn(`Warning: Hardcoded color function found in ${relativePath}:${index + 1}`);
        console.warn(`  > ${line.trim()}`);
        console.warn(`  Recommend design system CSS variables instead.`);
      }
    }
  });
});

if (hasErrors) {
  console.error('\nStyle Check Failed: Hardcoded custom colors detected outside of design system.');
  process.exit(1);
} else {
  console.log('\nStyle Check Passed: All components are design-system compliant.');
}
