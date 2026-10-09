//! OPA builtins a compiled Rego policy asks the host to run.
//!
//! `opa build -t wasm` compiles most builtins into the module (`concat`,
//! `startswith`, `regex.match`, `net.cidr_contains`, `json.marshal`, …). The
//! rest it imports through `opa_builtinN`, and lists by name in the module's
//! `builtins` export. These are the ones implemented here, following OPA's
//! documented semantics (Go's `fmt`, `regexp`, `strings` and RFC 6902), and
//! checked against `opa eval` on the same inputs
//! (`tests/fixtures/rego/conformance.*`).
//!
//! Anything else a policy needs from the host is refused when the rule loads,
//! naming the builtin, so a policy never fails on every request instead.
//!
//! Arguments arrive and results leave as JSON, through the module's own
//! `opa_json_dump` / `opa_json_parse`, as in OPA's JavaScript SDK. A Rego set
//! therefore reaches a builtin as an array.
//!
//! An `Err` makes the builtin's result undefined, which is what `opa eval`
//! does with a builtin error outside strict mode: the expression fails and the
//! rule body does not match.

use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

/// Per-evaluation state a builtin may read.
#[derive(Debug, Clone, Copy)]
pub struct EvalCtx {
    /// `time.now_ns()`: fixed for the whole evaluation, as in OPA.
    pub now_ns: i64,
}

pub type Builtin = fn(&EvalCtx, &[Value]) -> Result<Value, String>;

/// Every builtin the host provides, by OPA name.
pub const SUPPORTED: &[(&str, Builtin)] = &[
    ("sprintf", sprintf),
    ("time.now_ns", time_now_ns),
    ("crypto.sha1", crypto_sha1),
    ("crypto.sha256", crypto_sha256),
    ("regex.find_n", regex_find_n),
    ("regex.replace", regex_replace),
    ("regex.split", regex_split),
    ("strings.any_prefix_match", strings_any_prefix_match),
    ("strings.any_suffix_match", strings_any_suffix_match),
    ("strings.count", strings_count),
    ("indexof_n", indexof_n),
    ("json.patch", json_patch),
    ("json.marshal_with_options", json_marshal_with_options),
];

pub fn lookup(name: &str) -> Option<Builtin> {
    SUPPORTED.iter().find(|(n, _)| *n == name).map(|(_, f)| *f)
}

fn arg(args: &[Value], i: usize) -> Result<&Value, String> {
    args.get(i)
        .ok_or_else(|| format!("missing operand {}", i + 1))
}

fn string_arg(args: &[Value], i: usize) -> Result<&str, String> {
    arg(args, i)?
        .as_str()
        .ok_or_else(|| format!("operand {} must be a string", i + 1))
}

fn int_arg(args: &[Value], i: usize) -> Result<i64, String> {
    match arg(args, i)? {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
            .ok_or_else(|| format!("operand {} must be an integer", i + 1)),
        _ => Err(format!("operand {} must be a number", i + 1)),
    }
}

/// A string, or an array of strings (how a set of strings arrives).
fn strings_arg(args: &[Value], i: usize) -> Result<Vec<&str>, String> {
    match arg(args, i)? {
        Value::String(s) => Ok(vec![s.as_str()]),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| format!("operand {} must contain only strings", i + 1))
            })
            .collect(),
        _ => Err(format!("operand {} must be a string, array or set", i + 1)),
    }
}

/// `v` with every object's keys in sorted order, as Go writes a map.
///
/// `serde_json` keeps insertion order in this build (another crate turns on
/// its `preserve_order` feature), so the order has to be imposed.
fn sorted(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(k, v)| (k.clone(), sorted(v)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

fn strings_value<S: AsRef<str>>(items: impl IntoIterator<Item = S>) -> Value {
    Value::Array(
        items
            .into_iter()
            .map(|s| Value::String(s.as_ref().to_string()))
            .collect(),
    )
}

// ── time / crypto ────────────────────────────────────────────────────────

fn time_now_ns(ctx: &EvalCtx, _: &[Value]) -> Result<Value, String> {
    Ok(Value::Number(ctx.now_ns.into()))
}

fn crypto_sha256(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    Ok(Value::String(hex::encode(Sha256::digest(
        string_arg(args, 0)?.as_bytes(),
    ))))
}

fn crypto_sha1(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    Ok(Value::String(hex::encode(sha1::Sha1::digest(
        string_arg(args, 0)?.as_bytes(),
    ))))
}

// ── regex ────────────────────────────────────────────────────────────────
//
// Rust's `regex` is linear-time like Go's RE2, and accepts the same syntax.
// One difference: the Perl classes `\d`, `\w`, `\s` and `\b` are
// Unicode-aware here and ASCII-only in Go, so they match more non-ASCII text.

/// Compiled size cap, so a pathological pattern cannot allocate without bound.
const REGEX_SIZE_LIMIT: usize = 1 << 20;

fn compile(pattern: &str) -> Result<regex::Regex, String> {
    regex::RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|e| e.to_string())
}

/// Go's `FindAllStringIndex`: Go skips an empty match that abuts the end of
/// the previous match.
fn find_all(re: &regex::Regex, s: &str, n: i64) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut prev_end: Option<usize> = None;
    for m in re.find_iter(s) {
        if n >= 0 && out.len() as i64 >= n {
            break;
        }
        if m.start() == m.end() && prev_end == Some(m.start()) {
            continue;
        }
        out.push((m.start(), m.end()));
        prev_end = Some(m.end());
    }
    out
}

fn regex_find_n(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let re = compile(string_arg(args, 0)?)?;
    let s = string_arg(args, 1)?;
    let n = int_arg(args, 2)?;
    Ok(strings_value(
        find_all(&re, s, n).into_iter().map(|(a, b)| &s[a..b]),
    ))
}

/// Longest string `regex.replace` will build; see [`MAX_FIELD`] for why a
/// builtin has a limit Go does not.
const MAX_REPLACED_BYTES: usize = 1024 * 1024;

fn regex_replace(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let s = string_arg(args, 0)?;
    let re = compile(string_arg(args, 1)?)?;
    let replacement = string_arg(args, 2)?;
    // Checked before building: a short pattern matching everywhere in a long
    // string would otherwise multiply the two lengths.
    let matches = re.find_iter(s).count();
    if s.len() + matches.saturating_mul(replacement.len()) > MAX_REPLACED_BYTES {
        return Err("the replaced string would be over 1 MB".to_string());
    }
    Ok(Value::String(re.replace_all(s, replacement).into_owned()))
}

/// Go's `Regexp.Split(s, -1)`, quirks included.
fn regex_split(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let pattern = string_arg(args, 0)?;
    let s = string_arg(args, 1)?;
    let re = compile(pattern)?;
    if !pattern.is_empty() && s.is_empty() {
        return Ok(strings_value([""]));
    }
    let mut parts = Vec::new();
    let (mut beg, mut end) = (0, 0);
    for (start, stop) in find_all(&re, s, -1) {
        end = start;
        if stop != 0 {
            parts.push(&s[beg..end]);
        }
        beg = stop;
    }
    if end != s.len() {
        parts.push(&s[beg..]);
    }
    Ok(strings_value(parts))
}

// ── strings ──────────────────────────────────────────────────────────────

fn strings_any_prefix_match(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let (search, base) = (strings_arg(args, 0)?, strings_arg(args, 1)?);
    Ok(Value::Bool(
        search.iter().any(|s| base.iter().any(|b| s.starts_with(b))),
    ))
}

fn strings_any_suffix_match(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let (search, base) = (strings_arg(args, 0)?, strings_arg(args, 1)?);
    Ok(Value::Bool(
        search.iter().any(|s| base.iter().any(|b| s.ends_with(b))),
    ))
}

/// Go's `strings.Count`: non-overlapping; an empty substring counts the
/// gaps between characters.
fn strings_count(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let (s, sub) = (string_arg(args, 0)?, string_arg(args, 1)?);
    let n = if sub.is_empty() {
        s.chars().count() + 1
    } else {
        s.matches(sub).count()
    };
    Ok(Value::Number(n.into()))
}

/// Every index (in characters) where `needle` starts in `haystack`,
/// overlapping matches included.
fn indexof_n(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let (haystack, needle) = (string_arg(args, 0)?, string_arg(args, 1)?);
    if needle.is_empty() {
        return Err("empty search character".to_string());
    }
    let hay: Vec<char> = haystack.chars().collect();
    let pat: Vec<char> = needle.chars().collect();
    let found = (0..hay.len())
        .take_while(|i| i + pat.len() <= hay.len())
        .filter(|&i| hay[i..i + pat.len()] == pat[..])
        .map(|i| Value::Number(i.into()));
    Ok(Value::Array(found.collect()))
}

// ── json ─────────────────────────────────────────────────────────────────

/// RFC 6902, as `json.patch` applies it: the whole patch or nothing.
fn json_patch(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let mut doc = arg(args, 0)?.clone();
    let Value::Array(ops) = arg(args, 1)? else {
        return Err("patches must be an array".to_string());
    };
    for op in ops {
        apply_patch(&mut doc, op)?;
    }
    Ok(doc)
}

fn pointer(value: &Value, field: &str) -> Result<Vec<String>, String> {
    match value.get(field) {
        Some(Value::String(p)) if p.is_empty() => Ok(Vec::new()),
        Some(Value::String(p)) => {
            let rest = p
                .strip_prefix('/')
                .ok_or_else(|| format!("{field} must start with /"))?;
            Ok(rest
                .split('/')
                .map(|seg| seg.replace("~1", "/").replace("~0", "~"))
                .collect())
        }
        Some(Value::Array(segs)) => segs
            .iter()
            .map(|s| match s {
                Value::String(s) => Ok(s.clone()),
                Value::Number(n) => Ok(n.to_string()),
                _ => Err(format!("{field} segments must be strings or numbers")),
            })
            .collect(),
        _ => Err(format!("patch is missing `{field}`")),
    }
}

fn array_index(segment: &str, len: usize, allow_end: bool) -> Result<usize, String> {
    if allow_end && segment == "-" {
        return Ok(len);
    }
    let i: usize = segment
        .parse()
        .map_err(|_| format!("invalid array index {segment}"))?;
    if i > len || (!allow_end && i == len) {
        return Err(format!("array index {i} out of range"));
    }
    Ok(i)
}

fn walk_mut<'a>(doc: &'a mut Value, path: &[String]) -> Result<&'a mut Value, String> {
    let mut cur = doc;
    for seg in path {
        cur = match cur {
            Value::Object(map) => map
                .get_mut(seg)
                .ok_or_else(|| format!("path segment {seg} not found"))?,
            Value::Array(items) => {
                let i = array_index(seg, items.len(), false)?;
                &mut items[i]
            }
            _ => return Err(format!("cannot descend into a scalar at {seg}")),
        };
    }
    Ok(cur)
}

fn get(doc: &Value, path: &[String]) -> Result<Value, String> {
    let mut probe = doc.clone();
    walk_mut(&mut probe, path).map(|v| v.clone())
}

fn add(doc: &mut Value, path: &[String], value: Value) -> Result<(), String> {
    let Some((last, parent)) = path.split_last() else {
        *doc = value;
        return Ok(());
    };
    match walk_mut(doc, parent)? {
        Value::Object(map) => {
            map.insert(last.clone(), value);
            Ok(())
        }
        Value::Array(items) => {
            let i = array_index(last, items.len(), true)?;
            items.insert(i, value);
            Ok(())
        }
        _ => Err("cannot add to a scalar".to_string()),
    }
}

fn remove(doc: &mut Value, path: &[String]) -> Result<Value, String> {
    let (last, parent) = path
        .split_last()
        .ok_or_else(|| "cannot remove the root".to_string())?;
    match walk_mut(doc, parent)? {
        Value::Object(map) => map
            .remove(last)
            .ok_or_else(|| format!("path segment {last} not found")),
        Value::Array(items) => {
            let i = array_index(last, items.len(), false)?;
            Ok(items.remove(i))
        }
        _ => Err("cannot remove from a scalar".to_string()),
    }
}

fn apply_patch(doc: &mut Value, op: &Value) -> Result<(), String> {
    let path = pointer(op, "path")?;
    let value = || {
        op.get("value")
            .cloned()
            .ok_or_else(|| "patch is missing `value`".to_string())
    };
    match op.get("op").and_then(Value::as_str) {
        Some("add") => add(doc, &path, value()?),
        Some("remove") => remove(doc, &path).map(|_| ()),
        Some("replace") => {
            let v = value()?;
            *walk_mut(doc, &path)? = v;
            Ok(())
        }
        Some("move") => {
            let from = pointer(op, "from")?;
            let moved = remove(doc, &from)?;
            add(doc, &path, moved)
        }
        Some("copy") => {
            let copied = get(doc, &pointer(op, "from")?)?;
            add(doc, &path, copied)
        }
        Some("test") => {
            if get(doc, &path)? == value()? {
                Ok(())
            } else {
                Err("test operation failed".to_string())
            }
        }
        other => Err(format!("unsupported patch op {other:?}")),
    }
}

/// `json.marshal_with_options`: Go's `json.Marshal` / `json.MarshalIndent`,
/// including its escaping of `<`, `>`, `&`, U+2028 and U+2029.
fn json_marshal_with_options(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let value = &sorted(arg(args, 0)?);
    let Value::Object(opts) = arg(args, 1)? else {
        return Err("options must be an object".to_string());
    };
    let mut pretty = false;
    let (mut indent, mut prefix) = ("\t".to_string(), String::new());
    for (key, v) in opts {
        match (key.as_str(), v) {
            ("pretty", Value::Bool(b)) => pretty = *b,
            ("indent", Value::String(s)) => {
                pretty = true;
                indent = s.clone();
            }
            ("prefix", Value::String(s)) => {
                pretty = true;
                prefix = s.clone();
            }
            _ => return Err(format!("invalid option {key}")),
        }
    }
    let text = if pretty {
        let mut out = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(indent.as_bytes());
        let mut ser = serde_json::Serializer::with_formatter(&mut out, formatter);
        serde::Serialize::serialize(value, &mut ser).map_err(|e| e.to_string())?;
        String::from_utf8(out).map_err(|e| e.to_string())?
    } else {
        serde_json::to_string(value).map_err(|e| e.to_string())?
    };
    // These characters can only occur inside JSON strings, so replacing them
    // everywhere escapes exactly the occurrences Go escapes.
    let text = text
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    // Go starts every line with the prefix, the first included.
    Ok(Value::String(if pretty {
        format!("{prefix}{}", text.replace('\n', &format!("\n{prefix}")))
    } else {
        text
    }))
}

// ── sprintf ──────────────────────────────────────────────────────────────
//
// OPA hands `sprintf` to Go's `fmt.Sprintf` after converting each value: an
// integer to `int64`, any other number to `float64`, a string to `string`, and
// everything else to its Rego text (`true`, `null`, `["a", 1]`, `{"k": 1}`),
// as a string. Implemented: flags `+ - # 0 space`, width, precision, and the
// verbs `v d s q x X o b c e E f F g G t T %`, with Go's error forms for a
// mismatched verb, a missing operand and extra operands.
//
// One difference: OPA keeps a number's source text, and passes one written in
// exponent notation (`1e-7`) as that text; the WASM ABI hands the host the
// value, so it is formatted as a float here.

#[derive(Debug, Clone)]
enum Arg {
    Int(i64),
    Float(f64),
    Str(String),
}

impl Arg {
    fn from_value(v: &Value) -> Self {
        match v {
            Value::Number(n) => match n.as_i64() {
                Some(i) => Arg::Int(i),
                None => Arg::Float(n.as_f64().unwrap_or(f64::NAN)),
            },
            Value::String(s) => Arg::Str(s.clone()),
            other => Arg::Str(rego_text(other)),
        }
    }

    fn type_name(&self) -> &'static str {
        match self {
            Arg::Int(_) => "int64",
            Arg::Float(_) => "float64",
            Arg::Str(_) => "string",
        }
    }

    /// `%!verb(type=value)`, Go's report of a verb that does not fit.
    fn bad_verb(&self, verb: char) -> String {
        format!("%!{verb}({}={})", self.type_name(), self.plain())
    }

    fn plain(&self) -> String {
        match self {
            Arg::Int(i) => i.to_string(),
            Arg::Float(f) => go_float(*f, 'g', None),
            Arg::Str(s) => s.clone(),
        }
    }
}

/// A value's Rego text, as `ast.Term.String()` writes it.
fn rego_text(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_text(n),
        Value::String(s) => go_quote(s),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(rego_text).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(_) => format!(
            "{{{}}}",
            sorted(v)
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| format!("{}: {}", go_quote(k), rego_text(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn number_text(n: &Number) -> String {
    match n.as_i64() {
        Some(i) => i.to_string(),
        None => n.to_string(),
    }
}

#[derive(Debug, Default, Clone, Copy)]
struct Spec {
    plus: bool,
    minus: bool,
    sharp: bool,
    zero: bool,
    space: bool,
    width: Option<usize>,
    precision: Option<usize>,
}

fn sprintf(_: &EvalCtx, args: &[Value]) -> Result<Value, String> {
    let format = string_arg(args, 0)?;
    let Value::Array(values) = arg(args, 1)? else {
        return Err("operand 2 must be an array".to_string());
    };
    let values: Vec<Arg> = values.iter().map(Arg::from_value).collect();
    Ok(Value::String(go_sprintf(format, &values)?))
}

/// Widest field or precision `sprintf` will produce. Go has no limit; a
/// builtin runs outside the guest's fuel and deadline, so this one does, and
/// a larger one makes the result undefined.
const MAX_FIELD: usize = 4096;

fn digits(chars: &mut std::iter::Peekable<std::str::Chars>) -> Result<Option<usize>, String> {
    let mut n: Option<usize> = None;
    while let Some(d) = chars.peek().and_then(|c| c.to_digit(10)) {
        let value = n.unwrap_or(0) * 10 + d as usize;
        if value > MAX_FIELD {
            return Err(format!("field width or precision over {MAX_FIELD}"));
        }
        n = Some(value);
        chars.next();
    }
    Ok(n)
}

fn go_sprintf(format: &str, values: &[Arg]) -> Result<String, String> {
    let mut out = String::new();
    let mut next = 0;
    let mut chars = format.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let mut spec = Spec::default();
        while let Some(&f) = chars.peek() {
            match f {
                '+' => spec.plus = true,
                '-' => spec.minus = true,
                '#' => spec.sharp = true,
                '0' => spec.zero = true,
                ' ' => spec.space = true,
                _ => break,
            }
            chars.next();
        }
        spec.width = digits(&mut chars)?;
        if chars.peek() == Some(&'.') {
            chars.next();
            spec.precision = Some(digits(&mut chars)?.unwrap_or(0));
        }
        let Some(verb) = chars.next() else {
            out.push_str("%!(NOVERB)");
            break;
        };
        if verb == '%' {
            out.push('%');
            continue;
        }
        let Some(value) = values.get(next) else {
            out.push_str(&format!("%!{verb}(MISSING)"));
            continue;
        };
        next += 1;
        out.push_str(&format_one(verb, spec, value));
    }
    if next < values.len() {
        let extra: Vec<String> = values[next..]
            .iter()
            .map(|v| format!("{}={}", v.type_name(), v.plain()))
            .collect();
        out.push_str(&format!("%!(EXTRA {})", extra.join(", ")));
    }
    Ok(out)
}

fn format_one(verb: char, spec: Spec, value: &Arg) -> String {
    let body = match (verb, value) {
        ('T', v) => return pad(spec, v.type_name().to_string(), spec.zero),
        ('v' | 'd', Arg::Int(i)) => int_text(spec, *i, 10, false),
        ('x', Arg::Int(i)) => int_text(spec, *i, 16, false),
        ('X', Arg::Int(i)) => int_text(spec, *i, 16, true),
        ('o', Arg::Int(i)) => int_text(spec, *i, 8, false),
        ('b', Arg::Int(i)) => int_text(spec, *i, 2, false),
        ('c', Arg::Int(i)) => char::from_u32(*i as u32).unwrap_or('\u{FFFD}').to_string(),
        ('q', Arg::Int(i)) => format!(
            "'{}'",
            go_quote_char(char::from_u32(*i as u32).unwrap_or('\u{FFFD}'), '\'')
        ),
        ('v' | 'g' | 'G' | 'e' | 'E' | 'f' | 'F', Arg::Float(f)) => {
            let v = if verb == 'v' { 'g' } else { verb };
            signed(
                spec,
                go_float(f.abs(), v, spec.precision),
                f.is_sign_negative(),
            )
        }
        ('v' | 's', Arg::Str(s)) => truncate(s, spec.precision),
        ('q', Arg::Str(s)) => go_quote(&truncate(s, spec.precision)),
        ('x' | 'X', Arg::Str(s)) => {
            let hex = hex::encode(truncate(s, spec.precision));
            if verb == 'X' {
                hex.to_uppercase()
            } else {
                hex
            }
        }
        (verb, v) => return v.bad_verb(verb),
    };
    // Go ignores the 0 flag for an integer given a precision.
    let zero = spec.zero && !(matches!(value, Arg::Int(_)) && spec.precision.is_some());
    pad(spec, body, zero)
}

fn truncate(s: &str, precision: Option<usize>) -> String {
    match precision {
        Some(p) => s.chars().take(p).collect(),
        None => s.to_string(),
    }
}

fn int_text(spec: Spec, i: i64, radix: u32, upper: bool) -> String {
    let magnitude = i.unsigned_abs();
    let mut digits = match radix {
        16 if upper => format!("{magnitude:X}"),
        16 => format!("{magnitude:x}"),
        8 => format!("{magnitude:o}"),
        2 => format!("{magnitude:b}"),
        _ => magnitude.to_string(),
    };
    if let Some(p) = spec.precision {
        if p == 0 && magnitude == 0 {
            digits.clear();
        }
        while digits.len() < p {
            digits.insert(0, '0');
        }
    }
    if spec.sharp {
        match radix {
            16 if upper => digits.insert_str(0, "0X"),
            16 => digits.insert_str(0, "0x"),
            8 if !digits.starts_with('0') => digits.insert(0, '0'),
            2 => digits.insert_str(0, "0b"),
            _ => {}
        }
    }
    signed(spec, digits, i < 0)
}

fn signed(spec: Spec, body: String, negative: bool) -> String {
    if negative {
        format!("-{body}")
    } else if spec.plus {
        format!("+{body}")
    } else if spec.space {
        format!(" {body}")
    } else {
        body
    }
}

/// Pad to the width: spaces, or zeros after any sign when `zero`.
fn pad(spec: Spec, body: String, zero: bool) -> String {
    let Some(width) = spec.width else {
        return body;
    };
    let len = body.chars().count();
    if len >= width {
        return body;
    }
    let fill = width - len;
    if spec.minus {
        return format!("{body}{}", " ".repeat(fill));
    }
    if zero {
        let sign_len = usize::from(body.starts_with(['-', '+', ' ']));
        let (sign, digits) = body.split_at(sign_len);
        return format!("{sign}{}{digits}", "0".repeat(fill));
    }
    format!("{}{body}", " ".repeat(fill))
}

/// `strconv.FormatFloat` for the `e E f F g G` verbs, magnitude only.
fn go_float(f: f64, verb: char, precision: Option<usize>) -> String {
    if f.is_nan() {
        return "NaN".to_string();
    }
    if f.is_infinite() {
        return "+Inf".to_string();
    }
    match verb {
        'f' | 'F' => format!("{:.*}", precision.unwrap_or(6), f),
        'e' | 'E' => {
            let text = go_exponent(&format!("{:.*e}", precision.unwrap_or(6), f));
            if verb == 'E' {
                text.to_uppercase()
            } else {
                text
            }
        }
        _ => {
            let text = go_general(f, precision);
            if verb == 'G' {
                text.to_uppercase()
            } else {
                text
            }
        }
    }
}

/// Rust writes `1.5e3`; Go writes `1.5e+03`.
fn go_exponent(rust: &str) -> String {
    match rust.split_once('e') {
        Some((mantissa, exp)) => {
            let (sign, digits) = match exp.strip_prefix('-') {
                Some(d) => ('-', d),
                None => ('+', exp),
            };
            format!("{mantissa}e{sign}{digits:0>2}")
        }
        None => rust.to_string(),
    }
}

/// `%g`: the shortest representation (or `precision` significant digits),
/// in exponent form when the exponent is below -4 or at least the precision
/// (6 when shortest).
fn go_general(f: f64, precision: Option<usize>) -> String {
    if f == 0.0 {
        return "0".to_string();
    }
    let sci = match precision {
        Some(p) => format!("{:.*e}", p.max(1) - 1, f),
        None => format!("{f:e}"),
    };
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let digits = if precision.is_some() {
        digits.trim_end_matches('0').to_string()
    } else {
        digits
    };
    let digits = if digits.is_empty() {
        "0".to_string()
    } else {
        digits
    };
    let eprec = match precision {
        None => 6,
        Some(p) => p.max(1) as i32,
    };
    if exp < -4 || exp >= eprec {
        let (head, tail) = digits.split_at(1);
        let mantissa = if tail.is_empty() {
            head.to_string()
        } else {
            format!("{head}.{tail}")
        };
        let sign = if exp < 0 { '-' } else { '+' };
        return format!("{mantissa}e{sign}{:02}", exp.abs());
    }
    if exp < 0 {
        return format!("0.{}{digits}", "0".repeat((-exp - 1) as usize));
    }
    let point = exp as usize + 1;
    if digits.len() <= point {
        format!("{digits}{}", "0".repeat(point - digits.len()))
    } else {
        format!("{}.{}", &digits[..point], &digits[point..])
    }
}

/// Go's `strconv.Quote`.
fn go_quote(s: &str) -> String {
    let mut out = String::from('"');
    for c in s.chars() {
        out.push_str(&go_quote_char(c, '"'));
    }
    out.push('"');
    out
}

fn go_quote_char(c: char, quote: char) -> String {
    match c {
        '\x07' => "\\a".to_string(),
        '\x08' => "\\b".to_string(),
        '\x0c' => "\\f".to_string(),
        '\n' => "\\n".to_string(),
        '\r' => "\\r".to_string(),
        '\t' => "\\t".to_string(),
        '\x0b' => "\\v".to_string(),
        '\\' => "\\\\".to_string(),
        c if c == quote => format!("\\{c}"),
        c if (c as u32) < 0x20 || c as u32 == 0x7f => format!("\\x{:02x}", c as u32),
        c if c.is_control() || (c.is_whitespace() && c != ' ') => {
            if (c as u32) <= 0xFFFF {
                format!("\\u{:04x}", c as u32)
            } else {
                format!("\\U{:08x}", c as u32)
            }
        }
        c => c.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CTX: EvalCtx = EvalCtx { now_ns: 42 };

    fn f(format: &str, values: Value) -> String {
        match sprintf(&CTX, &[json!(format), values]).unwrap() {
            Value::String(s) => s,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn sprintf_covers_the_verbs_policies_use() {
        assert_eq!(f("%s ran %d times", json!(["Bash", 3])), "Bash ran 3 times");
        assert_eq!(f("%v|%v|%v", json!([1.5, true, null])), "1.5|true|null");
        assert_eq!(f("%q", json!(["a\"b"])), "\"a\\\"b\"");
        assert_eq!(f("%05d|%-4d|%+d", json!([42, 7, 3])), "00042|7   |+3");
        assert_eq!(f("%.2f|%x|%X", json!([2.71, 255, 255])), "2.71|ff|FF");
        assert_eq!(f("%v", json!([["a", 1]])), "[\"a\", 1]");
        assert_eq!(f("100%%", json!([])), "100%");
    }

    #[test]
    fn sprintf_reports_mismatches_the_way_go_does() {
        assert_eq!(f("%d", json!(["x"])), "%!d(string=x)");
        assert_eq!(f("%s %s", json!(["a"])), "a %!s(MISSING)");
        assert_eq!(f("%s", json!(["a", 1])), "a%!(EXTRA int64=1)");
    }

    #[test]
    fn go_general_matches_go_for_v() {
        for (f, want) in [
            (1.5, "1.5"),
            (100000.0, "100000"),
            (1e6, "1e+06"),
            (123456.5, "123456.5"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (123456789.5, "1.234567895e+08"),
        ] {
            assert_eq!(go_general(f, None), want, "{f}");
        }
    }

    #[test]
    fn time_now_ns_is_the_evaluation_clock() {
        assert_eq!(time_now_ns(&CTX, &[]).unwrap(), json!(42));
    }

    #[test]
    fn unsupported_builtins_are_not_found() {
        assert!(lookup("sprintf").is_some());
        assert!(lookup("http.send").is_none());
    }
}
