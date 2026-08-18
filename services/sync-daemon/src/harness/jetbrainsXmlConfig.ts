/**
 * jetbrainsXmlConfig.ts — narrow, dependency-free reader/writer for the
 * JetBrains Platform's `<application><component name="X">...</component>
 * </application>` settings-file shape.
 *
 * # Why this exists, and why it is not a general XML library
 *
 * `windsurfHooks.ts` needs to write into TWO files that live under a
 * JetBrains IDE's `options/` directory — `proxy.settings.xml` (the IDE
 * platform's own HTTP proxy setting) and `CodeiumSettings.xml` (the
 * Windsurf plugin's own settings, including its `detectProxy` toggle) —
 * and BOTH already exist on a real install, carrying settings this
 * codebase has no business touching (a user's proxy exceptions list, their
 * indexing path, dozens of unrelated plugin toggles, some of which — like
 * `customTrackedWorkspaces` — serialize as a NESTED element, not a simple
 * `<option name value/>` pair). A wholesale overwrite — the pattern
 * `atomicWriteJson` uses for files this codebase fully owns, like
 * `hooks.json` — would silently destroy those. This module instead
 * MERGES at two levels:
 *
 * - Every OTHER `<component>` in the file is passed through completely
 *   unchanged — this module never parses their contents.
 * - Within the ONE component the caller names, every simple self-closing
 *   `<option name="K" value="V" />` this module recognizes is
 *   added/overwritten by key; anything else inside that same component
 *   (a nested `<option name="X"><list>...</list></option>`, a comment,
 *   whatever) is preserved VERBATIM, appended after the merged simple
 *   options — never dropped, never guessed at.
 *
 * The only thing this module refuses outright (writes nothing, returns
 * `false`) is content it cannot even locate an `<application>` root and
 * `<component>` children in at all — a file this foreign is not this
 * module's to touch.
 *
 * @module
 */

/** One component's parsed simple `<option name value>` pairs, plus
 *  whatever else was inside it that this module does not try to
 *  understand (preserved verbatim). */
interface ParsedComponent {
  simpleOptions: Map<string, string>
  /** Trimmed leftover XML from inside the component, with every matched
   *  self-closing `<option name value/>` removed. Empty string if there
   *  was nothing else. */
  extra: string
}

interface ParsedApplicationXml {
  /** True iff the file parsed as `<application>` with only `<component>`
   *  children at the top level — the shape this module understands.
   *  `false` for anything else, including malformed markup between
   *  component blocks. */
  ok: boolean
  /** Every OTHER component's raw XML block, verbatim, keyed by its `name`
   *  attribute. Never re-serialized — passed through byte-for-byte. */
  otherComponents: Map<string, string>
  /** The target component's parsed contents, if that component existed. */
  target: ParsedComponent | undefined
}

const COMPONENT_RE = /<component\s+name="([^"]*)">([\s\S]*?)<\/component>/g
const SIMPLE_OPTION_RE = /<option\s+name="([^"]*)"\s+value="([^"]*)"\s*\/>/g

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function parseComponentInner(inner: string): ParsedComponent {
  const simpleOptions = new Map<string, string>()
  let extra = inner
  SIMPLE_OPTION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SIMPLE_OPTION_RE.exec(inner)) !== null) {
    const [full, key, value] = match
    if (key === undefined || value === undefined || full === undefined) continue
    simpleOptions.set(key, value)
    extra = extra.replace(full, '')
  }
  // Normalized to one trimmed line per non-empty line, deliberately
  // dropping the ORIGINAL indentation depth: re-applying a fixed indent
  // on top of already-indented text (rather than a normalized base) would
  // make the file's whitespace grow by one indent level on every sync
  // cycle this module runs in. XML semantics never depend on this
  // whitespace, so normalizing costs nothing real and keeps repeated
  // merges idempotent byte-for-byte.
  const normalizedExtra = extra
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
  return { simpleOptions, extra: normalizedExtra }
}

/** Parses `raw` (the file's current content, or `null`/empty if it does
 *  not exist yet) looking for the `<application>` shape this module
 *  understands. An absent/empty file is `ok: true` with no target —
 *  "create fresh," not a parse failure. */
function parseApplicationXml(raw: string | null, targetComponentName: string): ParsedApplicationXml {
  const otherComponents = new Map<string, string>()
  if (raw === null || raw.trim().length === 0) {
    return { ok: true, otherComponents, target: undefined }
  }
  const appMatch = /^\s*(?:<\?xml[^>]*\?>\s*)?<application>([\s\S]*)<\/application>\s*$/.exec(raw)
  if (!appMatch) {
    return { ok: false, otherComponents, target: undefined }
  }
  const body = appMatch[1] ?? ''
  let target: ParsedComponent | undefined
  let match: RegExpExecArray | null
  COMPONENT_RE.lastIndex = 0
  while ((match = COMPONENT_RE.exec(body)) !== null) {
    const [full, name, inner] = match
    if (name === undefined || inner === undefined || full === undefined) continue
    if (name === targetComponentName) {
      target = parseComponentInner(inner)
    } else {
      otherComponents.set(name, full)
    }
  }
  // Anything at the <application> level that is not whitespace and not one
  // of the <component> blocks just consumed is content this module does
  // not understand — refuse the whole file rather than silently drop it.
  // (Length-based, not substring-removal: two components could otherwise
  // have byte-identical bodies and make removal ambiguous.)
  const nonWhitespaceLength = body.replace(/\s/g, '').length
  const consumedNonWhitespaceLength = [...body.matchAll(COMPONENT_RE)]
    .map((m) => (m[0] ?? '').replace(/\s/g, '').length)
    .reduce((a, b) => a + b, 0)
  if (nonWhitespaceLength !== consumedNonWhitespaceLength) {
    return { ok: false, otherComponents, target: undefined }
  }
  return { ok: true, otherComponents, target }
}

/**
 * Merges `desiredOptions` into `filePath`'s `<component name=
 * componentName">` block as simple `<option name value/>` entries,
 * creating the file/component fresh if absent. Every other component,
 * and anything inside the target component this module does not
 * recognize as a simple option, is preserved unchanged (see module doc
 * comment). `desiredOptions` values are stringified as `"true"`/`"false"`
 * for booleans, matching JetBrains' own XML serialization convention.
 *
 * Returns `false` (and writes nothing) when the existing file does not
 * match the `<application><component>...` shape this module understands
 * at all — refusal, not a guess.
 */
export async function mergeXmlComponentOptions(
  filePath: string,
  componentName: string,
  desiredOptions: Readonly<Record<string, string | boolean>>,
  readFile: (path: string) => Promise<string | null>,
  writeFileAtomic: (path: string, content: string) => Promise<void>,
): Promise<boolean> {
  const existing = await readFile(filePath)
  const parsed = parseApplicationXml(existing, componentName)
  if (!parsed.ok) return false

  const options = parsed.target?.simpleOptions ?? new Map<string, string>()
  for (const [key, value] of Object.entries(desiredOptions)) {
    options.set(key, typeof value === 'boolean' ? String(value) : value)
  }

  const optionLines = [...options.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `    <option name="${escapeXmlAttr(key)}" value="${escapeXmlAttr(value)}" />`)
    .join('\n')
  const extra = parsed.target?.extra
  const componentBody = extra ? `${optionLines}\n${extra.split('\n').map((l) => `    ${l}`).join('\n')}` : optionLines
  const componentBlock = `  <component name="${escapeXmlAttr(componentName)}">\n${componentBody}\n  </component>`

  const otherBlocks = [...parsed.otherComponents.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, block]) => `  ${block}`)

  const body = [componentBlock, ...otherBlocks].join('\n')
  const serialized = `<application>\n${body}\n</application>\n`
  await writeFileAtomic(filePath, serialized)
  return true
}
