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

// The fonts destinations hold nothing but this copy, so they are replaced rather
// than merged: a face dropped from fonts/ (the Grift files, 2026-10) must stop
// being served from an existing checkout's public/ too, not linger there and
// ride into the next image.
function replaceDir(src: string, dest: string) {
  fs.rmSync(dest, { recursive: true, force: true });
  copyDir(src, dest);
}

// Resolve paths relative to this file's compiled location in dist/tools/
const currentDir = path.dirname(new URL(import.meta.url).pathname);
const themeDir = path.resolve(currentDir, '../../');

const fontsSrc = path.resolve(themeDir, './fonts');
const brandSrc = path.resolve(themeDir, './assets/brand');

// Dest 1: apps/dashboard
//
// Guarded on the APP existing, not on `public/` existing, and the directory is
// created rather than required. Everything below is now generated — the tracked
// copies were 65 duplicates of files in this package — so `public/` may
// legitimately be absent on a clean checkout. The previous guard tested
// `public/` itself, which meant that in exactly that situation the sync
// silently did nothing and the dashboard built with no fonts and no logo, with
// nothing in the log to say so.
const dashboardRoot = path.resolve(themeDir, '../../apps/dashboard');
const dashboardPublic = path.join(dashboardRoot, 'public');
if (fs.existsSync(dashboardRoot)) {
  fs.mkdirSync(dashboardPublic, { recursive: true });
  replaceDir(fontsSrc, path.join(dashboardPublic, './fonts'));
  copyDir(brandSrc, path.join(dashboardPublic, './assets/brand'));

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
  replaceDir(fontsSrc, path.join(docsPublic, './fonts'));
  
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
