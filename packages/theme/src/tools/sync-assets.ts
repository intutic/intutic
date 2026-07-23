import * as fs from 'fs';
import * as path from 'path';

function copyDir(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Resolve paths relative to this file's compiled location in dist/tools/
const currentDir = path.dirname(new URL(import.meta.url).pathname);
const themeDir = path.resolve(currentDir, '../../');

const fontsSrc = path.resolve(themeDir, './fonts');
const brandSrc = path.resolve(themeDir, './assets/brand');
const bgSrc = path.resolve(themeDir, './assets/bg');

// Dest 1: apps/dashboard
const dashboardPublic = path.resolve(themeDir, '../../apps/dashboard/public');
if (fs.existsSync(dashboardPublic)) {
  copyDir(fontsSrc, path.join(dashboardPublic, './fonts'));
  copyDir(brandSrc, path.join(dashboardPublic, './assets/brand'));
  copyDir(bgSrc, path.join(dashboardPublic, './assets/bg'));
  
  const faviconSrc = path.join(brandSrc, 'logo-mark-white.svg');
  if (fs.existsSync(faviconSrc)) {
    fs.copyFileSync(faviconSrc, path.join(dashboardPublic, 'favicon.svg'));
  }
  console.log('Synced design assets to apps/dashboard/public/');
}

// Dest 2: apps/docs
const docsPublic = path.resolve(themeDir, '../../apps/docs/public');
const docsRoot = path.resolve(themeDir, '../../apps/docs');
if (fs.existsSync(docsRoot)) {
  fs.mkdirSync(docsPublic, { recursive: true });
  copyDir(fontsSrc, path.join(docsPublic, './fonts'));
  
  // Doc portal specifics
  const logoWhiteSrc = path.join(brandSrc, 'logo-white.svg');
  const logoBlackSrc = path.join(brandSrc, 'logo-black.svg');
  const faviconSrc = path.join(brandSrc, 'logo-mark-white.svg');

  if (fs.existsSync(logoWhiteSrc)) {
    fs.copyFileSync(logoWhiteSrc, path.join(docsPublic, 'logo-white.svg'));
    fs.copyFileSync(logoWhiteSrc, path.join(docsPublic, 'logo.svg')); // Fallback
  }
  if (fs.existsSync(logoBlackSrc)) {
    fs.copyFileSync(logoBlackSrc, path.join(docsPublic, 'logo-black.svg'));
  }
  if (fs.existsSync(faviconSrc)) {
    fs.copyFileSync(faviconSrc, path.join(docsPublic, 'favicon.svg'));
  }
  console.log('Synced design assets to apps/docs/public/');
}
