#!/usr/bin/env node
/**
 * Dashboard style gate: colours and custom properties come from the design
 * tokens, not from literals scattered through components.
 *
 * Seven checks, each over `apps/dashboard/src`:
 *
 *   css-raw-color          A hex colour, or an rgb()/rgba()/hsl()/hsla()/oklch()
 *                          call outside any var(…), in a .css file. (The
 *                          colour-function half used to be a warning that
 *                          nothing read; it is an error now.)
 *   ts-raw-color           A string or template literal in a .ts/.tsx file whose
 *                          text is a full hex colour (#rgb, #rgba, #rrggbb,
 *                          #rrggbbaa) or contains one of those colour functions
 *                          outside var(…). Only literals count: comments,
 *                          JSX text and `#123`-style prose are not colours.
 *   undefined-var          var(--x…) used in CSS or in a TS literal, where --x is
 *                          defined nowhere: not in the dashboard CSS, not in
 *                          `packages/theme/dist/variables.css`, and not set at
 *                          runtime through a `'--x'` style key/setProperty.
 *   var-fallback-mismatch  var(--x, <literal>) where --x is defined and the
 *                          fallback differs from every value --x is given
 *                          (either theme's value is fine). A fallback that
 *                          disagrees with its token is a second, silent theme.
 *   invalid-var            var(--x.y) or any other first argument that starts
 *                          with `--` but is not a valid custom-property name.
 *                          A browser drops the whole declaration, so the
 *                          style silently never applies (`var(--space-2.5)`
 *                          resolved to nothing in 95 places before PR 1b).
 *   no-glass               The retired glass look: a class name containing
 *                          `glass` (CSS selector or TS literal class list) or a
 *                          backdrop-filter (CSS property or TS style key).
 *   motion                 Motion timing that is not a token: `transition: all`
 *                          (or `transition-property: all`), or a literal duration
 *                          (`200ms`, `.3s`) or easing (`ease`, `linear`,
 *                          `cubic-bezier(…)`, `steps(…)`) in transition,
 *                          transition-duration, transition-timing-function,
 *                          animation, animation-duration or
 *                          animation-timing-function, in CSS or as the string
 *                          value of that key in a TS style object
 *                          (`{ transition: '…' }`, `el.style.transition = '…'`).
 *                          Timings come from `--duration-*` and `--ease-*` in
 *                          packages/theme. `0s`/`0ms` and anything inside var(…)
 *                          are fine. The one exemption is the reduced-motion
 *                          reset in styles/globals.css: inside
 *                          `@media (prefers-reduced-motion: reduce)`, the rule
 *                          for `*, *::before, *::after` may set
 *                          animation-duration and transition-duration to
 *                          `0.01ms !important`, and nothing else there is exempt.
 *
 * TS literals come from a full parse (`ts.createSourceFile`), not a bare
 * `ts.createScanner` loop: without parser context the scanner reads the
 * apostrophe in JSX text like `<p>Don't</p>` as the start of a string literal
 * and swallows the real literals after it, and it cannot tell a regex from a
 * division. The parser drives the same scanner with that context.
 *
 * ## The allowlist
 *
 * `check-styles.allowlist.json` lists, per check, the files that failed it when
 * the check was introduced. A listed file may keep failing that check; any
 * other file may not. A listed file that no longer fails is ALSO an error, so
 * the list can only shrink and never goes stale. The lists, GLOBAL_ALLOWED_HEX,
 * ALLOWED_COLOR_FUNCTION_PREFIXES and EXCLUDED_FILES are all deleted by the last
 * PR of the dashboard UI upgrade (5c), after which every check is unconditional.
 *
 * The theme must be built first (`pnpm turbo build --filter=@intutic/theme`):
 * its variables.css is generated, and without it every theme token would read
 * as undefined.
 *
 * Usage: node tools/scripts/check-styles.js [repo-root]
 *
 * Mirrored to the public repo, which has no apps/dashboard: there it skips.
 */
const fs = require('fs');
const path = require('path');

const DASHBOARD_SRC = 'apps/dashboard/src';
const THEME_CSS = 'packages/theme/dist/variables.css';
const ALLOWLIST = 'tools/scripts/check-styles.allowlist.json';

const CHECKS = {
  'css-raw-color': 'raw colour in CSS (use a design token)',
  'ts-raw-color': 'raw colour in a TS/TSX string literal (use a design token)',
  'undefined-var': 'CSS custom property used but defined nowhere',
  'var-fallback-mismatch': 'var() fallback disagrees with the token it falls back for',
  'invalid-var': 'var() names something that is not a valid custom property, so the declaration is dropped',
  'no-glass': 'glass look (glass class or backdrop-filter); use the card and surface tokens',
  'motion': 'motion timing not from the tokens (use --duration-* and --ease-*), or transition: all (name the properties)',
};

// Excluded from css-raw-color only: these files define the dashboard palette.
// They are still scanned for custom-property definitions and var() usage.
// Deleted in PR 5c.
const EXCLUDED_FILES = ['globals.css', 'animations.css'];

// Common standard branding and utility colors allowed globally in CSS.
// Deleted in PR 5c.
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

// Per-file additions to GLOBAL_ALLOWED_HEX (medal ranking gradients). Deleted in PR 5c.
const WHITELIST = {
  'TeamLeaderboard.css': [
    '#fbbf24', '#f59e0b', '#451a03',
    '#d1d5db', '#9ca3af', '#1f2937',
    '#d97706', '#b45309', '#fffbeb'
  ]
};

// Black/white overlays and the semantic overlays the old warning exempted,
// compared with whitespace removed. CSS only. Deleted in PR 5c.
const ALLOWED_COLOR_FUNCTION_PREFIXES = [
  'rgba(0,0,0,', 'rgba(255,255,255,',
  'rgba(99,102,241,', 'rgba(96,165,250,', 'rgba(167,139,250,', 'rgba(52,211,153,', 'rgba(251,146,60,',
  'rgba(245,158,11,', 'rgba(239,68,68,', 'rgba(16,185,129,', 'rgba(107,114,128,', 'rgba(156,163,175,',
];

const COLOR_FUNCTION = /(?<![\w-])(rgba?|hsla?|oklch)\(/gi;
const FULL_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CUSTOM_PROPERTY = /^--[\w-]+$/;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Replace every non-newline character of a match with a space, keeping offsets. */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/** CSS with comment bodies blanked, so `LLD #40, #135` in a comment is not a colour. */
function blankCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, blank);
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Index of the `)` closing the `(` at `open`, or -1 if the text ends first. */
function closingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Every `var(…)` call in `text`, outermost first, with nested calls included.
 * `name` is null when the first argument is not a plain `--ident` (a template
 * fragment such as `var(--color-` + `${tone}`); `complete` is false when the
 * text ends before the closing paren (the rest is in another template part).
 */
function findVarCalls(text) {
  const calls = [];
  const re = /(?<![\w-])var\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = m.index + 3;
    const close = closingParen(text, open);
    if (close === -1) {
      calls.push({ start: m.index, end: text.length, name: null, invalidName: null, fallback: null, complete: false });
      continue;
    }
    const inner = text.slice(open + 1, close);
    let depth = 0;
    let comma = -1;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { comma = i; break; }
    }
    const rawName = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const valid = CUSTOM_PROPERTY.test(rawName);
    calls.push({
      start: m.index,
      end: close + 1,
      name: valid ? rawName : null,
      invalidName: !valid && rawName.startsWith('--') ? rawName : null,
      fallback: comma === -1 ? null : inner.slice(comma + 1).trim(),
      complete: true,
    });
  }
  return calls;
}

/** `text` with every var(…) call blanked, so a colour inside one is not "raw". */
function blankVarCalls(text) {
  let out = text;
  for (const c of findVarCalls(text)) {
    out = out.slice(0, c.start) + blank(out.slice(c.start, c.end)) + out.slice(c.end);
  }
  return out;
}

/**
 * Colour-function calls in `text` that are neither inside a var(…) nor built
 * from one (`rgba(var(--color-accent-rgb), 0.1)` is a token with an alpha, not
 * a raw colour): [{ index, call }].
 */
function rawColorFunctions(text) {
  const visible = blankVarCalls(text);
  const found = [];
  let m;
  COLOR_FUNCTION.lastIndex = 0;
  while ((m = COLOR_FUNCTION.exec(visible)) !== null) {
    const open = m.index + m[1].length;
    const close = closingParen(text, open);
    const call = text.slice(m.index, close === -1 ? text.length : close + 1);
    if (/(?<![\w-])var\(/.test(call)) continue;
    found.push({ index: m.index, call });
  }
  return found;
}

/**
 * Normalise a CSS value for equality: case, whitespace, quotes, leading zeros,
 * short hex, and opaque rgb()/rgba() written as hex.
 */
function normalizeValue(value) {
  let v = value.replace(/!important\s*$/i, '').trim().toLowerCase();
  v = v.replace(/"/g, "'").replace(/\s+/g, ' ').replace(/\s*([(),/])\s*/g, '$1');
  v = v.replace(/(^|[^\d.])0\.(\d)/g, '$1.$2');
  v = v.replace(/(\d)\.0+(?!\d)/g, '$1').replace(/(\.\d*?[1-9])0+(?!\d)/g, '$1');
  v = v.replace(/#([0-9a-f]{3,4})\b/g, (_, h) => '#' + [...h].map((c) => c + c).join(''));
  v = v.replace(/#([0-9a-f]{6})ff\b/g, '#$1');
  v = v.replace(/rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})(?:,(1|1\.0*|100%))?\)/g, (_, r, g, b) =>
    '#' + [r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join(''));
  return v;
}

// ---------------------------------------------------------------------------
// Per-language scanners
// ---------------------------------------------------------------------------

/** css-raw-color findings for one CSS file's text: [{ line, message }]. */
function cssRawColors(css, basename) {
  const content = blankCssComments(css);
  const allowedHex = new Set([...GLOBAL_ALLOWED_HEX, ...(WHITELIST[basename] || [])].map((c) => c.toLowerCase()));
  const out = [];
  const hex = /#([0-9a-fA-F]{3,8})\b/g;
  let m;
  while ((m = hex.exec(content)) !== null) {
    const color = m[0].toLowerCase();
    if (!allowedHex.has(color)) out.push({ line: lineAt(content, m.index), message: `hex colour ${color}` });
  }
  for (const { index, call } of rawColorFunctions(content)) {
    const squashed = call.replace(/\s+/g, '').toLowerCase();
    if (ALLOWED_COLOR_FUNCTION_PREFIXES.some((p) => squashed.startsWith(p))) continue;
    out.push({ line: lineAt(content, index), message: `colour function ${call.replace(/\s+/g, ' ')}` });
  }
  return out;
}

/** Custom-property definitions in CSS text: [{ name, value, line }]. */
function cssDefinitions(css) {
  const content = blankCssComments(css);
  const defs = [];
  const decl = /(?<![\w-])(--[\w-]+)\s*:([^;}]*)/g;
  let m;
  while ((m = decl.exec(content)) !== null) {
    defs.push({ name: m[1], value: m[2].trim(), line: lineAt(content, m.index) });
  }
  const registered = /@property\s+(--[\w-]+)/g;
  while ((m = registered.exec(content)) !== null) {
    defs.push({ name: m[1], value: null, line: lineAt(content, m.index) });
  }
  return defs;
}

let tsModule;
function typescript() {
  if (!tsModule) tsModule = require('typescript');
  return tsModule;
}

/**
 * The style key a literal is the value of, kebab-cased (`transitionDuration` ->
 * `transition-duration`), or null: `{ transition: '…' }`, `{ 'animation': '…' }`
 * and `el.style.transition = '…'`, also through a template, parentheses, a
 * conditional branch or a `??`/`||` default.
 */
function styleKeyOf(ts, node) {
  const K = ts.SyntaxKind;
  let n = node;
  for (let p = n.parent; p; n = p, p = p.parent) {
    if (
      ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p)
      || (ts.isConditionalExpression(p) && p.condition !== n)
      || (ts.isBinaryExpression(p) && (p.operatorToken.kind === K.QuestionQuestionToken || p.operatorToken.kind === K.BarBarToken))
    ) continue;
    let key = null;
    if (ts.isPropertyAssignment(p) && p.initializer === n && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      key = p.name.text;
    } else if (ts.isBinaryExpression(p) && p.operatorToken.kind === K.EqualsToken && p.right === n && ts.isPropertyAccessExpression(p.left)) {
      key = p.left.name.text;
    }
    return key && key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  }
  return null;
}

/**
 * Every string and template-literal part in a TS/TSX source:
 * [{ text, line, key? }], `key` being the style key the literal is the value
 * of (styleKeyOf). Comments, JSX text and identifiers never appear.
 */
function tsLiterals(source, fileName) {
  const ts = typescript();
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const literalKinds = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
  ]);
  const out = [];
  const visit = (node) => {
    if (literalKinds.has(node.kind)) {
      const literal = { text: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 };
      const key = styleKeyOf(ts, node);
      if (key) literal.key = key;
      out.push(literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** ts-raw-color: is this literal's text a colour? Returns a message or null. */
function tsLiteralColor(text) {
  if (FULL_HEX.test(text.trim())) return `hex colour ${text.trim()}`;
  const fn = rawColorFunctions(text)[0];
  return fn ? `colour function ${fn.call.replace(/\s+/g, ' ')}` : null;
}

// "Break glass" (emergency overrides, /break-glass) is a product term, not the look.
const isGlassClass = (name) => /glass/i.test(name.replace(/break-?glass/gi, ''));

/** no-glass in CSS: glass selectors and backdrop-filter declarations. */
function cssGlass(css) {
  const content = blankCssComments(css);
  const out = [];
  const selector = /\.([\w-]*glass[\w-]*)/gi;
  let m;
  while ((m = selector.exec(content)) !== null) {
    if (isGlassClass(m[1])) out.push({ line: lineAt(content, m.index), message: `glass class .${m[1]}` });
  }
  const backdrop = /(?<![\w-])(?:-webkit-)?backdrop-filter\s*:/gi;
  while ((m = backdrop.exec(content)) !== null) {
    out.push({ line: lineAt(content, m.index), message: 'backdrop-filter' });
  }
  return out;
}

/** no-glass in TS: a class-list literal naming a glass class, or a backdropFilter style key. */
function tsGlass(source, literals) {
  const out = [];
  for (const lit of literals) {
    const cls = lit.text.split(/\s+/).find((token) => /^[\w-]+$/.test(token) && isGlassClass(token));
    if (cls) out.push({ line: lit.line, message: `glass class ${cls}` });
  }
  const key = /(?<![\w$])(?:Webkit|webkit)?[bB]ackdropFilter(?![\w$])/g;
  let m;
  while ((m = key.exec(source)) !== null) {
    out.push({ line: lineAt(source, m.index), message: 'backdropFilter' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

const MOTION_PROPERTIES = new Set([
  'transition', 'transition-property', 'transition-duration', 'transition-timing-function',
  'animation', 'animation-duration', 'animation-timing-function',
]);
const LITERAL_DURATION = /(?<![\w.-])(\d+(?:\.\d+)?|\.\d+)(ms|s)(?![\w-])/gi;
const NAMED_EASING = /(?<![\w-])(ease-in-out|ease-in|ease-out|ease|linear|step-start|step-end)(?![\w(-])/gi;
const EASING_FUNCTION = /(?<![\w-])(cubic-bezier|steps|linear)\(/gi;

// The reduced-motion reset in globals.css, and only it: these declarations,
// in the `*, *::before, *::after` rule directly inside this media query.
const REDUCED_MOTION_RESET = {
  file: `${DASHBOARD_SRC}/styles/globals.css`,
  media: /^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/i,
  selector: '*,*::before,*::after',
  properties: new Set(['animation-duration', 'transition-duration']),
  value: /^0?\.01ms\s*!important$/i,
};

/** Why a motion declaration's value is not from the tokens: string[] (empty when it is). */
function motionProblems(property, value) {
  const prop = property.toLowerCase();
  if (!MOTION_PROPERTIES.has(prop)) return [];
  const visible = blankVarCalls(value);
  const out = [];
  if ((prop === 'transition' || prop === 'transition-property') && /(?<![\w-])all(?![\w-])/i.test(visible)) {
    out.push(`${prop}: all (name the properties)`);
  }
  if (prop === 'transition-property') return out;
  for (const m of visible.matchAll(LITERAL_DURATION)) {
    if (Number(m[1]) !== 0) out.push(`literal duration ${m[0]} in ${prop} (use a --duration-* token)`);
  }
  for (const m of visible.matchAll(NAMED_EASING)) out.push(`literal easing ${m[1]} in ${prop} (use an --ease-* token)`);
  for (const m of visible.matchAll(EASING_FUNCTION)) out.push(`literal easing ${m[1]}() in ${prop} (use an --ease-* token)`);
  return out;
}

/**
 * Declarations in CSS whose comments are blanked, each with the preludes of
 * the blocks around it, outermost first: [{ property, value, index, preludes }].
 * Parentheses and strings are skipped, so `url(data:…;…)` is one value.
 */
function cssDeclarations(content) {
  const out = [];
  const stack = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === quote && content[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth > 0) continue;
    else if (c === '{') {
      stack.push(content.slice(start, i).trim().replace(/\s+/g, ' '));
      start = i + 1;
    } else if (c === ';' || c === '}') {
      const text = content.slice(start, i);
      const colon = text.indexOf(':');
      const property = colon === -1 ? '' : text.slice(0, colon).trim();
      if (stack.length > 0 && /^-{0,2}[a-zA-Z][\w-]*$/.test(property)) {
        out.push({
          property,
          value: text.slice(colon + 1).trim(),
          index: start + (text.length - text.trimStart().length),
          preludes: [...stack],
        });
      }
      if (c === '}') stack.pop();
      start = i + 1;
    }
  }
  return out;
}

function isReducedMotionReset(file, decl) {
  const r = REDUCED_MOTION_RESET;
  return file === r.file
    && decl.preludes.length === 2
    && r.media.test(decl.preludes[0])
    && decl.preludes[1].replace(/\s+/g, '') === r.selector
    && r.properties.has(decl.property.toLowerCase())
    && r.value.test(decl.value);
}

/** motion findings for one CSS file (repo-relative `file`): [{ line, message }]. */
function cssMotion(css, file) {
  const content = blankCssComments(css);
  const out = [];
  for (const decl of cssDeclarations(content)) {
    const problems = motionProblems(decl.property, decl.value);
    if (problems.length === 0 || isReducedMotionReset(file, decl)) continue;
    for (const message of problems) out.push({ line: lineAt(content, decl.index), message });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-tree collection
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const isTsSource = (f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !/\.(test|spec)\.tsx?$/.test(f);

/**
 * All violations under `root`, unfiltered by the allowlist:
 * { [check]: Map<repo-relative file, [{ line, message }]> }.
 */
function collectViolations(root) {
  const srcDir = path.join(root, DASHBOARD_SRC);
  const files = walk(srcDir).sort();
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  const result = Object.fromEntries(Object.keys(CHECKS).map((c) => [c, new Map()]));
  const add = (check, file, line, message) => {
    const list = result[check].get(file) || [];
    list.push({ line, message });
    result[check].set(file, list);
  };

  /** name -> [{ value: string|null }] ; null value = set at runtime or @property. */
  const definitions = new Map();
  const define = (name, value) => {
    const list = definitions.get(name) || [];
    list.push({ value });
    definitions.set(name, list);
  };
  /** [{ file, line, name, fallback }] */
  const usages = [];
  const collectUsages = (file, text, baseLine, lineOf) => {
    for (const c of findVarCalls(text)) {
      if (c.invalidName) add('invalid-var', file, lineOf ? lineOf(c.start) : baseLine, `var(${c.invalidName}) is not a valid custom property`);
      if (!c.complete || !c.name) continue;
      usages.push({ file, line: lineOf ? lineOf(c.start) : baseLine, name: c.name, fallback: c.fallback });
    }
  };

  for (const d of cssDefinitions(fs.readFileSync(path.join(root, THEME_CSS), 'utf8'))) define(d.name, d.value);

  for (const full of files) {
    const file = rel(full);
    if (full.endsWith('.css')) {
      const css = fs.readFileSync(full, 'utf8');
      if (!EXCLUDED_FILES.includes(path.basename(full))) {
        for (const v of cssRawColors(css, path.basename(full))) add('css-raw-color', file, v.line, v.message);
      }
      for (const v of cssGlass(css)) add('no-glass', file, v.line, v.message);
      for (const v of cssMotion(css, file)) add('motion', file, v.line, v.message);
      for (const d of cssDefinitions(css)) define(d.name, d.value);
      const content = blankCssComments(css);
      collectUsages(file, content, 0, (i) => lineAt(content, i));
    } else if (isTsSource(full)) {
      const source = fs.readFileSync(full, 'utf8');
      const literals = tsLiterals(source, full);
      for (const v of tsGlass(source, literals)) add('no-glass', file, v.line, v.message);
      for (const lit of literals) {
        const color = tsLiteralColor(lit.text);
        if (color) add('ts-raw-color', file, lit.line, color);
        if (lit.key) for (const message of motionProblems(lit.key, lit.text)) add('motion', file, lit.line, message);
        if (CUSTOM_PROPERTY.test(lit.text.trim())) define(lit.text.trim(), null);
        collectUsages(file, lit.text, lit.line);
      }
    }
  }

  const resolved = new Map();
  /** Every static value `name` can take, following `--a: var(--b)` chains. */
  const valuesOf = (name, seen = new Set()) => {
    if (resolved.has(name)) return resolved.get(name);
    if (seen.has(name)) return new Set();
    seen.add(name);
    const values = new Set();
    for (const { value } of definitions.get(name) || []) {
      if (value == null) continue;
      values.add(normalizeValue(value));
      const alias = /^var\((--[\w-]+)\s*(?:,[\s\S]*)?\)$/.exec(value.trim());
      if (alias) for (const v of valuesOf(alias[1], seen)) values.add(v);
    }
    resolved.set(name, values);
    return values;
  };

  for (const u of usages) {
    if (!definitions.has(u.name)) {
      add('undefined-var', u.file, u.line, `${u.name} is not defined`);
      continue;
    }
    if (u.fallback == null || u.fallback === '' || /(?<![\w-])var\(/.test(u.fallback)) continue;
    const values = valuesOf(u.name);
    if (values.size === 0) continue; // only set at runtime: nothing static to compare with
    if (!values.has(normalizeValue(u.fallback))) {
      add('var-fallback-mismatch', u.file, u.line,
        `var(${u.name}, ${u.fallback}) — ${u.name} is ${[...values].join(' / ')}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Allowlist and CLI
// ---------------------------------------------------------------------------

/** Validate the allowlist's shape; returns { lists, errors }. */
function loadAllowlist(root) {
  const file = path.join(root, ALLOWLIST);
  const errors = [];
  if (!fs.existsSync(file)) return { lists: {}, errors };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lists = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) continue;
    if (!CHECKS[key]) { errors.push(`${ALLOWLIST}: unknown check "${key}"`); continue; }
    if (!Array.isArray(value)) { errors.push(`${ALLOWLIST}: "${key}" must be an array of file paths`); continue; }
    const sorted = [...new Set(value)].sort();
    if (sorted.length !== value.length || sorted.some((v, i) => v !== value[i])) {
      errors.push(`${ALLOWLIST}: "${key}" must be sorted and free of duplicates`);
    }
    lists[key] = new Set(value);
  }
  return { lists, errors };
}

/**
 * Apply the allowlist. Returns { errors: string[], summary: string[] }.
 * An error is a violation in an unlisted file, or a listed file with none.
 */
function evaluate(violations, allowlist) {
  const errors = [...allowlist.errors];
  const summary = [];
  for (const check of Object.keys(CHECKS)) {
    const found = violations[check];
    const listed = allowlist.lists[check] || new Set();
    let tolerated = 0;
    for (const [file, list] of found) {
      if (listed.has(file)) { tolerated += list.length; continue; }
      for (const v of list) errors.push(`${check}: ${file}:${v.line} ${v.message}`);
    }
    for (const file of listed) {
      if (!found.has(file)) {
        errors.push(`${check}: ${file} is allowlisted but no longer fails this check — remove it from ${ALLOWLIST}`);
      }
    }
    summary.push(`${check}: ${tolerated} violation(s) in ${listed.size} allowlisted file(s)`);
  }
  return { errors, summary };
}

/**
 * Why the built theme no longer matches its sources, or null. build-tokens.ts
 * stamps a hash of tokens.ts + build-tokens.ts into variables.css.
 */
function themeIsStale(root) {
  const css = fs.readFileSync(path.join(root, THEME_CSS), 'utf8');
  const stamped = /source-hash: ([0-9a-f]{64})/.exec(css);
  if (!stamped) return 'it carries no source hash (built by an older build-tokens.ts)';
  const sources = ['packages/theme/src/tokens.ts', 'packages/theme/src/build-tokens.ts'];
  const hash = require('crypto').createHash('sha256')
    .update(sources.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\0'))
    .digest('hex');
  return hash === stamped[1] ? null : 'packages/theme/src changed after it was built';
}

function main(argv) {
  const root = path.resolve(argv[2] || path.join(__dirname, '..', '..'));
  if (!fs.existsSync(path.join(root, DASHBOARD_SRC))) {
    console.log(`Directory ${path.join(root, DASHBOARD_SRC)} does not exist. Skipping style checks (dashboard package is private).`);
    console.log('\nStyle Check Passed: All components are design-system compliant.');
    return 0;
  }
  if (!fs.existsSync(path.join(root, THEME_CSS))) {
    console.error(`[FAIL] ${THEME_CSS} is missing: it is generated, and without it every theme token reads as undefined.`);
    console.error('Build it first: pnpm turbo build --filter=@intutic/theme');
    return 1;
  }
  const stale = themeIsStale(root);
  if (stale) {
    console.error(`[FAIL] ${THEME_CSS} is stale: ${stale}. Every token would be checked against an old palette.`);
    console.error('Rebuild it: pnpm turbo build --filter=@intutic/theme');
    return 1;
  }
  const { errors, summary } = evaluate(collectViolations(root), loadAllowlist(root));
  for (const line of summary) console.log(`  ${line}`);
  if (errors.length > 0) {
    console.error(`\nStyle Check Failed: ${errors.length} problem(s):\n`);
    for (const e of errors) console.error(`  ${e}`);
    console.error('\nUse a design token (packages/theme or globals.css) instead of a literal colour or a guessed var().');
    return 1;
  }
  console.log('\nStyle Check Passed: All components are design-system compliant.');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = {
  CHECKS,
  blankCssComments,
  findVarCalls,
  rawColorFunctions,
  normalizeValue,
  cssRawColors,
  cssDefinitions,
  tsLiterals,
  tsLiteralColor,
  cssGlass,
  tsGlass,
  motionProblems,
  cssDeclarations,
  cssMotion,
  collectViolations,
  themeIsStale,
  loadAllowlist,
  evaluate,
  main,
};
