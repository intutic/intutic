/**
 * OPA builtins a compiled Rego policy asks the host to run — the TypeScript
 * twin of `packages/proxy/src/wasm/opa_builtins.rs`.
 *
 * `opa build -t wasm` compiles most builtins into the module; the ones it
 * imports through `opa_builtinN` are listed by name in the module's `builtins`
 * export. These follow OPA's documented semantics (Go's `fmt`, `regexp`,
 * `strings` and RFC 6902) and are checked against `opa eval` on the same
 * inputs as the Rust host (`packages/proxy/tests/fixtures/rego/conformance.*`),
 * so a policy decides the same way in the proxy, the MCP proxy and
 * `intutic rules test`.
 *
 * Arguments arrive and results leave as JSON, so a Rego set reaches a builtin
 * as an array. A thrown error makes the result undefined, as `opa eval` does
 * outside strict mode.
 *
 * Differences from OPA, all also true of the Rust host unless noted:
 * - a number written in exponent notation is formatted by `sprintf` as a float
 *   (OPA passes its source text);
 * - `sprintf` refuses a field width or precision over 4096;
 * - regular expressions run on JavaScript's engine here, with Go's `(?P<name>)`
 *   groups and leading `(?i)`/`(?s)`/`(?m)` flags translated; other RE2-only
 *   syntax is refused, and the MCP proxy's per-rule deadline bounds a pattern
 *   that backtracks;
 * - integers beyond 2^53 lose precision here, where JSON numbers are doubles.
 *
 * @module
 */

/** Hash functions the host supplies; browser-safe callers may omit them. */
export interface RegoDigest {
  (algorithm: 'sha1' | 'sha256', data: string): string
}

export interface RegoBuiltinContext {
  /** `time.now_ns()`: fixed for one evaluation, as in OPA. */
  nowNs: bigint
  digest?: RegoDigest
}

export type RegoBuiltin = (ctx: RegoBuiltinContext, args: unknown[]) => unknown

const fail = (message: string): never => {
  throw new Error(message)
}

function str(args: unknown[], i: number): string {
  const v = args[i]
  return typeof v === 'string' ? v : fail(`operand ${i + 1} must be a string`)
}

function int(args: unknown[], i: number): number {
  const v = args[i]
  return typeof v === 'number' && Number.isInteger(v) ? v : fail(`operand ${i + 1} must be an integer`)
}

/** A string, or an array of strings (how a set of strings arrives). */
function strs(args: unknown[], i: number): string[] {
  const v = args[i]
  if (typeof v === 'string') return [v]
  if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return v as string[]
  return fail(`operand ${i + 1} must be a string, array or set of strings`)
}

/** `v` with every object's keys sorted, as Go writes a map. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

// ── regex ──────────────────────────────────────────────────────────────

/** Translate RE2 syntax JavaScript spells differently, refusing what it lacks. */
function compile(pattern: string): RegExp {
  let source = pattern
  let flags = 'gu'
  const leading = /^\(\?([ims]+)\)/.exec(source)
  if (leading) {
    flags += leading[1]
    source = source.slice(leading[0].length)
  }
  if (/\(\?[a-zA-Z-]+[:)]/.test(source) || /\[\[:/.test(source) || /\\[zAQE]/.test(source)) {
    fail(`regular expression uses RE2 syntax this host does not support: ${pattern}`)
  }
  source = source.replace(/\(\?P</g, '(?<')
  try {
    return new RegExp(source, flags)
  } catch (err) {
    return fail(`invalid regular expression: ${(err as Error).message}`)
  }
}

/** Go's `FindAllString(s, n)`: an empty match abutting the previous match is skipped. */
function findAll(re: RegExp, s: string, n: number): RegExpExecArray[] {
  const out: RegExpExecArray[] = []
  re.lastIndex = 0
  let prevEnd = -1
  for (;;) {
    if (n >= 0 && out.length >= n) break
    const m = re.exec(s)
    if (!m) break
    const end = m.index + m[0].length
    if (m[0].length === 0) {
      // Step past the empty match by one code point, as `u` mode requires.
      const cp = s.codePointAt(m.index)
      re.lastIndex = m.index + (cp !== undefined && cp > 0xffff ? 2 : 1)
      if (m.index === prevEnd) continue
      if (m.index > s.length) break
    }
    out.push(m)
    prevEnd = end
  }
  return out
}

/** Go's `Regexp.Expand` template: `$1`, `${1}`, `$name`, `${name}`, `$$`. */
function expand(template: string, m: RegExpExecArray): string {
  let out = ''
  for (let i = 0; i < template.length; i++) {
    const c = template[i]
    if (c !== '$' || i + 1 >= template.length) {
      out += c
      continue
    }
    if (template[i + 1] === '$') {
      out += '$'
      i += 1
      continue
    }
    let name: string
    if (template[i + 1] === '{') {
      const close = template.indexOf('}', i + 2)
      if (close < 0) {
        out += c
        continue
      }
      name = template.slice(i + 2, close)
      i = close
    } else {
      const word = /^[A-Za-z0-9_]+/.exec(template.slice(i + 1))
      if (!word) {
        out += c
        continue
      }
      name = word[0]
      i += word[0].length
    }
    const group = /^\d+$/.test(name) ? m[Number(name)] : m.groups?.[name]
    out += group ?? ''
  }
  return out
}

const MAX_REPLACED_BYTES = 1024 * 1024

// ── json ───────────────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function pointer(op: Record<string, unknown>, field: string): string[] {
  const p = op[field]
  if (p === '') return []
  if (typeof p === 'string') {
    if (!p.startsWith('/')) fail(`${field} must start with /`)
    return p
      .slice(1)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  }
  if (Array.isArray(p)) {
    return p.map((s) =>
      typeof s === 'string' || typeof s === 'number' ? String(s) : fail(`${field} segments must be strings or numbers`),
    )
  }
  return fail(`patch is missing \`${field}\``)
}

function arrayIndex(segment: string, len: number, allowEnd: boolean): number {
  if (allowEnd && segment === '-') return len
  if (!/^\d+$/.test(segment)) fail(`invalid array index ${segment}`)
  const i = Number(segment)
  if (i > len || (!allowEnd && i === len)) fail(`array index ${i} out of range`)
  return i
}

function walk(doc: Json, path: string[]): Json {
  let cur = doc
  for (const seg of path) {
    if (Array.isArray(cur)) cur = cur[arrayIndex(seg, cur.length, false)] as Json
    else if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) fail(`path segment ${seg} not found`)
      cur = cur[seg] as Json
    } else fail(`cannot descend into a scalar at ${seg}`)
  }
  return cur
}

/**
 * Sets an object member as an own data property. A plain assignment to
 * `__proto__` would replace the object's prototype instead of storing the key,
 * which a JSON document (and OPA's json.patch) treats as an ordinary member.
 */
function setMember(obj: { [k: string]: Json }, key: string, value: Json): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true })
}

/** Returns the new document: `add` at the root replaces it. */
function add(doc: Json, path: string[], value: Json): Json {
  if (path.length === 0) return value
  const parent = walk(doc, path.slice(0, -1))
  const last = path[path.length - 1] as string
  if (Array.isArray(parent)) parent.splice(arrayIndex(last, parent.length, true), 0, value)
  else if (parent !== null && typeof parent === 'object') setMember(parent, last, value)
  else fail('cannot add to a scalar')
  return doc
}

function remove(doc: Json, path: string[]): Json {
  if (path.length === 0) fail('cannot remove the root')
  const parent = walk(doc, path.slice(0, -1))
  const last = path[path.length - 1] as string
  if (Array.isArray(parent)) return parent.splice(arrayIndex(last, parent.length, false), 1)[0] as Json
  if (parent !== null && typeof parent === 'object') {
    if (!Object.prototype.hasOwnProperty.call(parent, last)) fail(`path segment ${last} not found`)
    const v = parent[last] as Json
    Reflect.deleteProperty(parent, last)
    return v
  }
  return fail('cannot remove from a scalar')
}

function equalJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}

function applyPatch(doc: Json, op: Record<string, unknown>): Json {
  const path = pointer(op, 'path')
  const value = (): Json => (op['value'] === undefined ? fail('patch is missing `value`') : structuredClone(op['value'] as Json))
  switch (op['op']) {
    case 'add':
      return add(doc, path, value())
    case 'remove':
      remove(doc, path)
      return doc
    case 'replace': {
      const v = value()
      if (path.length === 0) return v
      walk(doc, path)
      return replaceAt(doc, path, v)
    }
    case 'move': {
      const moved = remove(doc, pointer(op, 'from'))
      return add(doc, path, moved)
    }
    case 'copy':
      return add(doc, path, structuredClone(walk(doc, pointer(op, 'from'))))
    case 'test':
      if (!equalJson(walk(doc, path), op['value'])) fail('test operation failed')
      return doc
    default:
      return fail(`unsupported patch op ${String(op['op'])}`)
  }
}

/** `replace` sets an existing member in place, where `add` would insert into an array. */
function replaceAt(doc: Json, path: string[], value: Json): Json {
  const parent = walk(doc, path.slice(0, -1))
  const last = path[path.length - 1] as string
  if (Array.isArray(parent)) parent[arrayIndex(last, parent.length, false)] = value
  else if (parent !== null && typeof parent === 'object') setMember(parent, last, value)
  return doc
}

const escapeGoHtml = (text: string): string =>
  text
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

/** Go's `json.MarshalIndent` layout (JSON.stringify caps indent at 10 characters). */
function indentJson(v: unknown, indent: string, depth: number): string {
  const pad = indent.repeat(depth + 1)
  const close = indent.repeat(depth)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[\n${v.map((x) => pad + indentJson(x, indent, depth + 1)).join(',\n')}\n${close}]`
  }
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${indentJson(x, indent, depth + 1)}`).join(',\n')}\n${close}}`
  }
  return JSON.stringify(v)
}

// ── sprintf ────────────────────────────────────────────────────────────

type Arg = { kind: 'int'; value: number } | { kind: 'float'; value: number } | { kind: 'str'; value: string }

const MAX_FIELD = 4096

/** Go's `strconv.Quote`. */
function goQuoteChar(ch: string, quote: string): string {
  const cp = ch.codePointAt(0) ?? 0
  switch (ch) {
    case '\x07': return '\\a'
    case '\b': return '\\b'
    case '\f': return '\\f'
    case '\n': return '\\n'
    case '\r': return '\\r'
    case '\t': return '\\t'
    case '\v': return '\\v'
    case '\\': return '\\\\'
  }
  if (ch === quote) return `\\${ch}`
  if (cp < 0x20 || cp === 0x7f) return `\\x${cp.toString(16).padStart(2, '0')}`
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch) || (/\s/u.test(ch) && ch !== ' ')) {
    return cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\U${cp.toString(16).padStart(8, '0')}`
  }
  return ch
}

function goQuote(s: string): string {
  let out = '"'
  for (const ch of s) out += goQuoteChar(ch, '"')
  return `${out}"`
}

/** A value's Rego text, as `ast.Term.String()` writes it. */
function regoText(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return goQuote(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(regoText).join(', ')}]`
  const obj = sorted(v) as Record<string, unknown>
  return `{${Object.entries(obj).map(([k, x]) => `${goQuote(k)}: ${regoText(x)}`).join(', ')}}`
}

function toArg(v: unknown): Arg {
  if (typeof v === 'number') return Number.isInteger(v) ? { kind: 'int', value: v } : { kind: 'float', value: v }
  if (typeof v === 'string') return { kind: 'str', value: v }
  return { kind: 'str', value: regoText(v) }
}

const typeName = (a: Arg): string => (a.kind === 'int' ? 'int64' : a.kind === 'float' ? 'float64' : 'string')
const plain = (a: Arg): string =>
  a.kind === 'str' ? a.value : a.kind === 'int' ? String(a.value) : goFloat(Math.abs(a.value), 'g', undefined, a.value < 0)

/**
 * The exact decimal expansion of a finite double: `digits` with the decimal
 * point `point` places from the left. Doubles are dyadic rationals, so
 * multiplying by 5^k turns m / 2^k into a whole number of 10^-k.
 */
function exactDecimal(x: number): { digits: string; point: number } {
  if (x === 0) return { digits: '0', point: 1 }
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const hi = view.getUint32(0)
  const lo = view.getUint32(4)
  const exponent = (hi >>> 20) & 0x7ff
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  let e = exponent - 1075
  if (exponent === 0) e = -1074
  else mantissa |= 1n << 52n
  if (e >= 0) {
    const digits = (mantissa << BigInt(e)).toString()
    return { digits, point: digits.length }
  }
  const k = -e
  const digits = (mantissa * 5n ** BigInt(k)).toString()
  return { digits, point: digits.length - k }
}

/** Round a digit string to `keep` digits, half to even. Returns the digits and a carry. */
function roundDigits(digits: string, keep: number): { digits: string; carry: boolean } {
  if (keep >= digits.length) return { digits: digits.padEnd(keep, '0'), carry: false }
  if (keep < 0) return { digits: '', carry: false }
  const head = digits.slice(0, keep)
  const rest = digits.slice(keep)
  const first = rest.charCodeAt(0) - 48
  const tail = /[1-9]/.test(rest.slice(1))
  const lastOdd = keep > 0 && (head.charCodeAt(keep - 1) - 48) % 2 === 1
  const up = first > 5 || (first === 5 && (tail || lastOdd))
  if (!up) return { digits: head, carry: false }
  const n = (BigInt(head || '0') + 1n).toString().padStart(keep, '0')
  return n.length > keep ? { digits: n.slice(0, keep), carry: true } : { digits: n, carry: false }
}

/** `%f` with `precision` fraction digits, magnitude only. */
function fixed(x: number, precision: number): string {
  const { digits, point } = exactDecimal(x)
  const normalized = point <= 0 ? '0'.repeat(1 - point) + digits : digits
  const intLen = Math.max(point, 1)
  const r = roundDigits(normalized, intLen + precision)
  const all = r.carry ? `1${r.digits}` : r.digits
  const intPart = all.slice(0, all.length - precision) || '0'
  return precision > 0 ? `${intPart}.${all.slice(all.length - precision)}` : intPart
}

/** Significant digits and decimal exponent: `precision` digits, or the shortest. */
function scientific(x: number, precision: number | undefined): { digits: string; exp: number } {
  if (x === 0) return { digits: '0'.repeat(precision ?? 1), exp: 0 }
  if (precision === undefined) {
    const [m, e] = x.toExponential().split('e') as [string, string]
    return { digits: m.replace('.', ''), exp: Number(e) }
  }
  const { digits, point } = exactDecimal(x)
  const lead = digits.search(/[1-9]/)
  const significant = digits.slice(lead)
  let exp = point - lead - 1
  const r = roundDigits(significant, precision)
  if (r.carry) {
    exp += 1
    return { digits: `1${r.digits.slice(0, precision - 1)}`, exp }
  }
  return { digits: r.digits, exp }
}

const goExp = (exp: number): string => `e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`

/** `strconv.FormatFloat` for `e E f F g G`, magnitude only (sign added by the caller). */
function goFloat(x: number, verb: string, precision: number | undefined, negative = false): string {
  const sign = negative ? '-' : ''
  if (Number.isNaN(x)) return 'NaN'
  if (!Number.isFinite(x)) return `${negative ? '-' : '+'}Inf`
  if (verb === 'f' || verb === 'F') return sign + fixed(x, precision ?? 6)
  if (verb === 'e' || verb === 'E') {
    const p = precision ?? 6
    const { digits, exp } = scientific(x, p + 1)
    const text = `${digits[0]}${p > 0 ? `.${digits.slice(1)}` : ''}${goExp(exp)}`
    return sign + (verb === 'E' ? text.toUpperCase() : text)
  }
  // `%g`: shortest (or `precision` significant digits), in exponent form when
  // the exponent is below -4 or at least the precision (6 when shortest).
  if (x === 0) return `${sign}0`
  const p = precision === undefined ? undefined : Math.max(precision, 1)
  const sci = scientific(x, p)
  let digits = p === undefined ? sci.digits : sci.digits.replace(/0+$/, '') || '0'
  let text: string
  if (sci.exp < -4 || sci.exp >= (p ?? 6)) {
    text = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}${goExp(sci.exp)}`
  } else if (sci.exp < 0) {
    text = `0.${'0'.repeat(-sci.exp - 1)}${digits}`
  } else {
    const point = sci.exp + 1
    digits = digits.padEnd(point, '0')
    text = digits.length > point ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits
  }
  return sign + (verb === 'G' ? text.toUpperCase() : text)
}

interface Spec {
  plus: boolean
  minus: boolean
  sharp: boolean
  zero: boolean
  space: boolean
  width?: number
  precision?: number
}

function signed(spec: Spec, body: string, negative: boolean): string {
  if (negative) return `-${body}`
  if (spec.plus) return `+${body}`
  if (spec.space) return ` ${body}`
  return body
}

function pad(spec: Spec, body: string, zero: boolean): string {
  const len = [...body].length
  if (spec.width === undefined || len >= spec.width) return body
  const fill = spec.width - len
  if (spec.minus) return body + ' '.repeat(fill)
  if (zero) {
    const signLen = /^[-+ ]/.test(body) ? 1 : 0
    return body.slice(0, signLen) + '0'.repeat(fill) + body.slice(signLen)
  }
  return ' '.repeat(fill) + body
}

function intText(spec: Spec, value: number, radix: number, upper: boolean): string {
  let digits = Math.abs(value).toString(radix)
  if (upper) digits = digits.toUpperCase()
  if (spec.precision !== undefined) {
    if (spec.precision === 0 && value === 0) digits = ''
    digits = digits.padStart(spec.precision, '0')
  }
  if (spec.sharp) {
    if (radix === 16) digits = (upper ? '0X' : '0x') + digits
    else if (radix === 8 && !digits.startsWith('0')) digits = `0${digits}`
    else if (radix === 2) digits = `0b${digits}`
  }
  return signed(spec, digits, value < 0)
}

function truncate(s: string, precision: number | undefined): string {
  return precision === undefined ? s : [...s].slice(0, precision).join('')
}

function hexOf(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('')
}

function formatOne(verb: string, spec: Spec, a: Arg): string {
  const bad = (): string => `%!${verb}(${typeName(a)}=${plain(a)})`
  let body: string
  if (verb === 'T') return pad(spec, typeName(a), spec.zero)
  if (a.kind === 'int') {
    switch (verb) {
      case 'v': case 'd': body = intText(spec, a.value, 10, false); break
      case 'x': body = intText(spec, a.value, 16, false); break
      case 'X': body = intText(spec, a.value, 16, true); break
      case 'o': body = intText(spec, a.value, 8, false); break
      case 'b': body = intText(spec, a.value, 2, false); break
      case 'c': body = String.fromCodePoint(a.value); break
      case 'q': body = `'${goQuoteChar(String.fromCodePoint(a.value), "'")}'`; break
      default: return bad()
    }
  } else if (a.kind === 'float') {
    if (!'vgGeEfF'.includes(verb)) return bad()
    body = signed(spec, goFloat(Math.abs(a.value), verb === 'v' ? 'g' : verb, spec.precision), a.value < 0)
  } else {
    switch (verb) {
      case 'v': case 's': body = truncate(a.value, spec.precision); break
      case 'q': body = goQuote(truncate(a.value, spec.precision)); break
      case 'x': body = hexOf(truncate(a.value, spec.precision)); break
      case 'X': body = hexOf(truncate(a.value, spec.precision)).toUpperCase(); break
      default: return bad()
    }
  }
  const zero = spec.zero && !(a.kind === 'int' && spec.precision !== undefined)
  return pad(spec, body, zero)
}

function goSprintf(format: string, values: Arg[]): string {
  const chars = [...format]
  let out = ''
  let next = 0
  let i = 0
  const digits = (): number | undefined => {
    let n: number | undefined
    while (i < chars.length && /[0-9]/.test(chars[i] as string)) {
      n = (n ?? 0) * 10 + Number(chars[i])
      if (n > MAX_FIELD) fail(`field width or precision over ${MAX_FIELD}`)
      i += 1
    }
    return n
  }
  while (i < chars.length) {
    const c = chars[i++] as string
    if (c !== '%') {
      out += c
      continue
    }
    const spec: Spec = { plus: false, minus: false, sharp: false, zero: false, space: false }
    for (; i < chars.length; i++) {
      const f = chars[i]
      if (f === '+') spec.plus = true
      else if (f === '-') spec.minus = true
      else if (f === '#') spec.sharp = true
      else if (f === '0') spec.zero = true
      else if (f === ' ') spec.space = true
      else break
    }
    spec.width = digits()
    if (chars[i] === '.') {
      i += 1
      spec.precision = digits() ?? 0
    }
    if (i >= chars.length) {
      out += '%!(NOVERB)'
      break
    }
    const verb = chars[i++] as string
    if (verb === '%') {
      out += '%'
      continue
    }
    const value = values[next]
    if (!value) {
      out += `%!${verb}(MISSING)`
      continue
    }
    next += 1
    out += formatOne(verb, spec, value)
  }
  if (next < values.length) {
    out += `%!(EXTRA ${values.slice(next).map((v) => `${typeName(v)}=${plain(v)}`).join(', ')})`
  }
  return out
}

// ── the table ──────────────────────────────────────────────────────────

/** Every builtin the host provides, by OPA name. */
export const REGO_HOST_BUILTINS: Readonly<Record<string, RegoBuiltin>> = {
  sprintf: (_, args) => {
    const values = args[1]
    if (!Array.isArray(values)) fail('operand 2 must be an array')
    return goSprintf(str(args, 0), (values as unknown[]).map(toArg))
  },
  'time.now_ns': (ctx) => ctx.nowNs,
  'crypto.sha1': (ctx, args) => (ctx.digest ?? fail('no digest provided'))('sha1', str(args, 0)),
  'crypto.sha256': (ctx, args) => (ctx.digest ?? fail('no digest provided'))('sha256', str(args, 0)),
  'regex.find_n': (_, args) => findAll(compile(str(args, 0)), str(args, 1), int(args, 2)).map((m) => m[0]),
  'regex.replace': (_, args) => {
    const s = str(args, 0)
    const re = compile(str(args, 1))
    const template = str(args, 2)
    const matches = findAll(re, s, -1)
    if (s.length + matches.length * template.length > MAX_REPLACED_BYTES) fail('the replaced string would be over 1 MB')
    let out = ''
    let last = 0
    for (const m of matches) {
      out += s.slice(last, m.index) + expand(template, m)
      last = m.index + m[0].length
    }
    return out + s.slice(last)
  },
  'regex.split': (_, args) => {
    const pattern = str(args, 0)
    const s = str(args, 1)
    const re = compile(pattern)
    if (pattern !== '' && s === '') return ['']
    const parts: string[] = []
    let beg = 0
    let end = 0
    for (const m of findAll(re, s, -1)) {
      end = m.index
      if (m.index + m[0].length !== 0) parts.push(s.slice(beg, end))
      beg = m.index + m[0].length
    }
    if (end !== s.length) parts.push(s.slice(beg))
    return parts
  },
  'strings.any_prefix_match': (_, args) => {
    const base = strs(args, 1)
    return strs(args, 0).some((s) => base.some((b) => s.startsWith(b)))
  },
  'strings.any_suffix_match': (_, args) => {
    const base = strs(args, 1)
    return strs(args, 0).some((s) => base.some((b) => s.endsWith(b)))
  },
  'strings.count': (_, args) => {
    const s = str(args, 0)
    const sub = str(args, 1)
    return sub === '' ? [...s].length + 1 : s.split(sub).length - 1
  },
  indexof_n: (_, args) => {
    const hay = [...str(args, 0)]
    const pat = [...str(args, 1)]
    if (pat.length === 0) fail('empty search character')
    const found: number[] = []
    for (let i = 0; i + pat.length <= hay.length; i++) {
      if (pat.every((c, j) => hay[i + j] === c)) found.push(i)
    }
    return found
  },
  'json.patch': (_, args) => {
    const ops = args[1]
    if (!Array.isArray(ops)) fail('patches must be an array')
    let doc = structuredClone(args[0] as Json)
    for (const op of ops as unknown[]) {
      if (op === null || typeof op !== 'object') fail('a patch must be an object')
      doc = applyPatch(doc, op as Record<string, unknown>)
    }
    return doc
  },
  'json.marshal_with_options': (_, args) => {
    const opts = args[1]
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) fail('options must be an object')
    let pretty = false
    let indent = '\t'
    let prefix = ''
    for (const [key, v] of Object.entries(opts as Record<string, unknown>)) {
      if (key === 'pretty' && typeof v === 'boolean') pretty = v
      else if (key === 'indent' && typeof v === 'string') [pretty, indent] = [true, v]
      else if (key === 'prefix' && typeof v === 'string') [pretty, prefix] = [true, v]
      else fail(`invalid option ${key}`)
    }
    const value = sorted(args[0])
    const text = escapeGoHtml(pretty ? indentJson(value, indent, 0) : JSON.stringify(value))
    return pretty ? prefix + text.replace(/\n/g, `\n${prefix}`) : text
  },
}

export const REGO_HOST_BUILTIN_NAMES: readonly string[] = Object.keys(REGO_HOST_BUILTINS).sort()
