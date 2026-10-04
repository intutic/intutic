//! DSN-aware destructive-SQL rule for model-emitted shell commands (TD-480).
//!
//! # The gap this closes
//!
//! `DROP TABLE` was blocked on the MCP tool path and flagged at the harness
//! hook gate, and the LLM proxy had no SQL rule at all — so a `DROP` that
//! reached a database through a model-emitted shell command on a harness with
//! no hook gate went unseen. A DSN-blind pattern is not the fix: against a
//! scratch database a `DROP` is what a migration looks like, and refusing every
//! one would get the rule switched off. The rule has to know *which database*
//! the command targets.
//!
//! # What it does
//!
//! For a call to a shell tool (`actions::SHELL_TOOLS` — `Bash`, `shell`,
//! `run_command`, `execute_command`, …), every string argument is read as a
//! shell command and searched for a SQL client invocation: `psql`, `mysql` /
//! `mariadb`, `sqlite3`, and `dropdb`. For each one it reads
//!
//! * the SQL the client will run — `-c` / `--command` (psql), `-e` /
//!   `--execute` (mysql), the trailing positional (sqlite3), a heredoc, a
//!   here-string, or text piped in from earlier in the same pipeline — and
//!   looks for `DROP TABLE|DATABASE|SCHEMA`, `TRUNCATE`, and `DELETE` with no
//!   `WHERE`. Comments and string literals are stripped first, so
//!   `SELECT 'drop table'` is not a drop; `dropdb` is a `DROP DATABASE` by
//!   definition;
//! * the target — a `postgres://` / `postgresql://` / `mysql://` URI, the
//!   `-h` / `-p` / `-d` (psql) or `-h` / `-P` / `-D` (mysql) flags, a libpq
//!   `host=… dbname=…` string, inline `PGHOST=` / `PGPORT=` / `PGDATABASE=`
//!   assignments, or the sqlite file. It is rendered as a credential-free
//!   canonical form, `postgres://host:port/db`, and matched against the
//!   workspace's allowlist.
//!
//! A target that cannot be read off the command — a `$DATABASE_URL`, a
//! command substitution, no host named at all (the client would use `PGHOST`
//! or the local socket, neither of which the proxy can see), a script that
//! switches connection with `\connect` — is **unknown**, and unknown is never
//! on the allowlist.
//!
//! # Policy and where it comes from
//!
//! Off unless a SOP covering the node's role declares it, through the same
//! front matter every other proxy rule reads (`sops.rs`) — on disk for a
//! standalone proxy, from the workspace's `sops-policy` on a gateway:
//!
//! ```yaml
//! ---
//! sql_guard: refuse                 # or `warn`
//! sql_allow_dsns: postgres://localhost/*, postgres://localhost:*, sqlite:*
//! ---
//! ```
//!
//! # Why a native rule and not a WASM rule
//!
//! TD-480 suggested a WASM rule with a DSN allowlist. Two things in this
//! codebase make that the worse fit. A WASM rule has no configuration input —
//! its descriptor is `ruleId`, `name`, `sha256`, `priority`, `mode` — so a
//! per-workspace allowlist would have to be compiled into the binary, one
//! build per workspace. And a WASM rule sees only the request side, where a
//! model-emitted tool call arrives in the *next* request's history, after the
//! harness has already run it: a `DROP` reported one turn late is not
//! prevented. This rule runs in the response gate instead (`response_gate.rs`),
//! on the model's own output, before the client receives the call — and its
//! allowlist rides the SOP front matter that already reaches every proxy.
//!
//! # What it does not see
//!
//! SQL in a file (`psql -f drop.sql`, `mysql < drop.sql`), SQL issued from a
//! program (`python -c "cursor.execute(...)"`), ORM and migration tools
//! (`prisma migrate reset`, `rails db:drop`). Those are not SQL-client
//! invocations and are left alone — which is also why a migration command
//! passes untouched.

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

use crate::plugins::anomaly::actions::{tool_is, SHELL_TOOLS};

// ─── Policy ──────────────────────────────────────────────────────────────

/// What a non-allowlisted destructive statement gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SqlGuardSeverity {
    /// Forward the call and log it.
    Warn,
    /// Withhold the call and tell the agent why.
    Refuse,
}

impl SqlGuardSeverity {
    /// Parse a `sql_guard:` value. `Err` carries the reason; the caller still
    /// enforces at [`SqlGuardSeverity::Refuse`], because a typo must not be
    /// the thing that switches a guard off.
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "refuse" | "block" | "deny" | "kill" => Ok(Self::Refuse),
            "warn" | "steer" | "advise" => Ok(Self::Warn),
            other => Err(format!(
                "{other:?}: expected `refuse` or `warn`. Enforcing as `refuse` — \
                 to turn the SQL guard off, remove the key"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Warn => "warn",
            Self::Refuse => "refuse",
        }
    }
}

/// The SQL guard in force for one node, resolved from its SOPs.
#[derive(Debug, Clone, PartialEq)]
pub struct SqlGuardPolicy {
    pub severity: SqlGuardSeverity,
    /// Workspace-scope allowlist patterns. Empty: nothing allowed by this level.
    pub allow: Vec<String>,
    /// Org-scope allowlist patterns — a ceiling. When non-empty, a target must
    /// match one of these **and**, if the workspace declared any, one of
    /// `allow`. Two lists rather than a computed intersection because globs do
    /// not intersect into a glob, and an org ceiling must never widen.
    pub org_allow: Vec<String>,
    /// A `mode: shadow` SOP's guard: evaluated and logged, never enforced.
    pub shadow: bool,
}

impl SqlGuardPolicy {
    /// Does the allowlist admit `target`? Unknown targets never are.
    pub fn permits(&self, target: &Target) -> bool {
        let Target::Known(t) = target else {
            return false;
        };
        let hit = |list: &[String]| list.iter().any(|p| glob_match(&normalize_pattern(p), t));
        match (self.allow.is_empty(), self.org_allow.is_empty()) {
            (true, true) => false,
            (false, true) => hit(&self.allow),
            (true, false) => hit(&self.org_allow),
            (false, false) => hit(&self.allow) && hit(&self.org_allow),
        }
    }

    /// Whether a match under this policy withholds the call.
    pub fn refuses(&self) -> bool {
        !self.shadow && self.severity == SqlGuardSeverity::Refuse
    }
}

// ─── Findings ────────────────────────────────────────────────────────────

/// Where a SQL client invocation points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// Canonical, credential-free: `postgres://host[:port]/db`,
    /// `mysql://host[:port]/db`, `sqlite:<path>`.
    Known(String),
    /// Why the target could not be read off the command. Never carries any of
    /// the command's own text, so it cannot carry a credential either.
    Unknown(&'static str),
}

impl Target {
    pub fn display(&self) -> String {
        match self {
            Self::Known(t) => t.clone(),
            Self::Unknown(why) => format!("an unidentified database ({why})"),
        }
    }
}

/// One destructive SQL client invocation found in a tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlHit {
    /// `psql`, `mysql`, `sqlite3`, `dropdb`.
    pub client: &'static str,
    /// `DROP TABLE`, `TRUNCATE`, `DELETE without WHERE`, … — sorted, deduped.
    pub statements: Vec<&'static str>,
    pub target: Target,
}

/// A hit the policy does not allow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlViolation {
    pub tool: String,
    pub hit: SqlHit,
    pub severity: SqlGuardSeverity,
    pub shadow: bool,
}

impl SqlViolation {
    /// Whether this violation withholds the call (an enforcing `refuse`).
    pub fn refuses(&self) -> bool {
        !self.shadow && self.severity == SqlGuardSeverity::Refuse
    }

    fn statements(&self) -> String {
        self.hit.statements.join(", ")
    }

    /// Operator-facing line. Credential-free by construction: the target is
    /// the canonical form, which has no userinfo, query string or password flag.
    pub fn log_message(&self) -> String {
        let mode = if self.shadow {
            "shadow (not enforced)".to_string()
        } else {
            self.severity.as_str().to_string()
        };
        format!(
            "SQL guard [{mode}]: {} would run {} through {} against {}, which is not on the \
             SQL allowlist (sql_allow_dsns) in force for this node",
            self.tool,
            self.statements(),
            self.hit.client,
            self.hit.target.display()
        )
    }

    /// What the agent reads in place of the withheld call.
    pub fn agent_message(&self) -> String {
        let fix = match self.hit.target {
            Target::Known(_) => {
                "Do not retry it against that database. Run it against an allowlisted scratch \
                 or development database, or ask an operator to add this one to the policy."
            }
            Target::Unknown(_) => {
                "Destructive SQL may only run against an allowlisted database, so name the host \
                 and database explicitly on the command line (not through a variable), or ask \
                 an operator."
            }
        };
        format!(
            "[Intutic] Blocked tool call: {} would run {} through {} against {}, which is not \
             on this workspace's SQL allowlist. The call was withheld by the proxy and never \
             reached the client, so it did not run. {fix}",
            self.tool,
            self.statements(),
            self.hit.client,
            self.hit.target.display()
        )
    }
}

/// Evaluate one tool call against every policy in force.
///
/// Returns every violation, enforcing and not; the caller refuses on the
/// first one whose policy [`SqlGuardPolicy::refuses`] and logs the rest.
pub fn evaluate(policies: &[SqlGuardPolicy], tool: &str, args: &Value) -> Vec<SqlViolation> {
    if policies.is_empty() {
        return Vec::new();
    }
    let hits = inspect_tool_call(tool, args);
    let mut out = Vec::new();
    for policy in policies {
        for hit in &hits {
            if !policy.permits(&hit.target) {
                out.push(SqlViolation {
                    tool: tool.to_string(),
                    hit: hit.clone(),
                    severity: policy.severity,
                    shadow: policy.shadow,
                });
            }
        }
    }
    out
}

/// Every destructive SQL client invocation in a shell-tool call.
///
/// Empty for any tool that is not a shell tool. Every string in the
/// arguments is read as a command, because which key carries it varies by
/// harness (`command`, `cmd`, `script`, …); an array of strings is also read
/// as an argv, which is how Codex's `shell` tool passes `["psql", "-c", …]`.
pub fn inspect_tool_call(tool: &str, args: &Value) -> Vec<SqlHit> {
    if !tool_is(tool, SHELL_TOOLS) {
        return Vec::new();
    }
    let mut found = Vec::new();
    collect_from_value(args, &mut found, 0);
    // An argv is read both as an argv and string by string, so the same
    // invocation can be found twice.
    let mut out: Vec<SqlHit> = Vec::new();
    for h in found {
        if !out.contains(&h) {
            out.push(h);
        }
    }
    out
}

/// Nesting is bounded so an adversarially deep argument document costs
/// nothing; no harness nests a command more than a couple of levels deep.
const MAX_VALUE_DEPTH: usize = 8;

fn collect_from_value(v: &Value, out: &mut Vec<SqlHit>, depth: usize) {
    if depth > MAX_VALUE_DEPTH {
        return;
    }
    match v {
        Value::String(s) => {
            // OpenAI-shaped arguments that failed to parse upstream arrive as
            // one JSON string; read it as JSON first, as a command otherwise.
            if let Ok(inner @ (Value::Object(_) | Value::Array(_))) =
                serde_json::from_str::<Value>(s)
            {
                collect_from_value(&inner, out, depth + 1);
            } else {
                out.extend(inspect_command(s));
            }
        }
        Value::Array(items) => {
            let argv: Option<Vec<Word>> = items
                .iter()
                .map(|i| i.as_str().map(Word::literal))
                .collect();
            if let Some(argv) = argv.filter(|a| !a.is_empty()) {
                out.extend(analyze_segments(
                    vec![Segment {
                        words: argv,
                        ..Segment::default()
                    }],
                    0,
                ));
            }
            for item in items {
                collect_from_value(item, out, depth + 1);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                collect_from_value(item, out, depth + 1);
            }
        }
        _ => {}
    }
}

/// Every destructive SQL client invocation in one shell command string.
pub fn inspect_command(cmd: &str) -> Vec<SqlHit> {
    // Cheap reject: nothing destructive can be here without one of these, and
    // this runs on every string argument of every shell call.
    let lower = cmd.to_ascii_lowercase();
    if !["drop", "truncate", "delete"]
        .iter()
        .any(|k| lower.contains(k))
    {
        return Vec::new();
    }
    analyze_segments(lex(cmd), 0)
}

// ─── Shell lexing ────────────────────────────────────────────────────────

/// One shell word, quotes removed.
#[derive(Debug, Clone, Default, PartialEq)]
struct Word {
    text: String,
    /// Carried a `$` or backtick outside single quotes — its value is decided
    /// at run time by something the proxy cannot see.
    var: bool,
    /// Any part was quoted — a quoted `2` before `>` is not a file descriptor.
    quoted: bool,
}

impl Word {
    fn literal(s: &str) -> Self {
        Self {
            text: s.to_string(),
            var: false,
            quoted: true,
        }
    }
}

/// One simple command.
#[derive(Debug, Clone, Default)]
struct Segment {
    words: Vec<Word>,
    /// Heredoc and here-string bodies: what the command reads on stdin.
    stdin: String,
    /// Joined to the previous segment by `|`.
    piped_from_prev: bool,
}

/// Split a command into simple commands. Not a shell — enough of one to find
/// words, quotes, separators, pipes and heredocs, which is what this rule reads.
fn lex(cmd: &str) -> Vec<Segment> {
    let chars: Vec<char> = cmd.chars().collect();
    let mut segs: Vec<Segment> = Vec::new();
    let mut seg = Segment::default();
    let mut word: Option<Word> = None;
    // (delimiter, strip leading tabs)
    let mut pending_heredocs: Vec<(String, bool)> = Vec::new();
    // What the next completed word is for: a heredoc delimiter, a here-string
    // body, or a redirection target to drop.
    #[derive(PartialEq)]
    enum Next {
        Arg,
        HeredocDelim(bool),
        HereString,
        RedirectTarget,
    }
    let mut next = Next::Arg;
    let mut i = 0;

    macro_rules! end_word {
        () => {
            if let Some(w) = word.take() {
                match std::mem::replace(&mut next, Next::Arg) {
                    Next::Arg => seg.words.push(w),
                    Next::HeredocDelim(strip) => pending_heredocs.push((w.text, strip)),
                    Next::HereString => {
                        seg.stdin.push_str(&w.text);
                        seg.stdin.push('\n');
                    }
                    Next::RedirectTarget => {}
                }
            }
        };
    }
    macro_rules! end_segment {
        ($piped_next:expr) => {
            end_word!();
            if !seg.words.is_empty() || !seg.stdin.is_empty() {
                segs.push(std::mem::take(&mut seg));
            }
            seg.piped_from_prev = $piped_next;
        };
    }

    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                if chars.get(i + 1) == Some(&'\n') {
                    i += 2;
                    continue;
                }
                let w = word.get_or_insert_with(Word::default);
                if let Some(n) = chars.get(i + 1) {
                    w.text.push(*n);
                }
                i += 2;
                continue;
            }
            '\'' => {
                let w = word.get_or_insert_with(Word::default);
                w.quoted = true;
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    w.text.push(chars[i]);
                    i += 1;
                }
            }
            '"' => {
                let w = word.get_or_insert_with(Word::default);
                w.quoted = true;
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        i += 1;
                    } else if chars[i] == '$' || chars[i] == '`' {
                        w.var = true;
                    }
                    w.text.push(chars[i]);
                    i += 1;
                }
            }
            '$' | '`' => {
                // `${X}`, `$(cmd)` and backticks are one word, decided at run
                // time: take them whole rather than letting their braces and
                // spaces split the command.
                let w = word.get_or_insert_with(Word::default);
                w.var = true;
                w.text.push(c);
                let (open, close) = match (c, chars.get(i + 1)) {
                    ('$', Some('{')) => ('{', '}'),
                    ('$', Some('(')) => ('(', ')'),
                    ('`', _) => ('`', '`'),
                    _ => {
                        i += 1;
                        continue;
                    }
                };
                if c == '$' {
                    i += 1;
                    w.text.push(open);
                }
                let mut depth = 1;
                i += 1;
                while i < chars.len() {
                    let ch = chars[i];
                    w.text.push(ch);
                    if ch == close && (open == close || depth == 1) {
                        break;
                    }
                    if open != close {
                        if ch == open {
                            depth += 1;
                        } else if ch == close {
                            depth -= 1;
                        }
                    }
                    i += 1;
                }
            }
            ' ' | '\t' | '\r' => end_word!(),
            '#' if word.is_none() => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            '\n' => {
                end_word!();
                // Heredoc bodies start on the line after the operator.
                for (delim, strip) in std::mem::take(&mut pending_heredocs) {
                    i += 1;
                    loop {
                        if i >= chars.len() {
                            break;
                        }
                        let start = i;
                        while i < chars.len() && chars[i] != '\n' {
                            i += 1;
                        }
                        let line: String = chars[start..i].iter().collect();
                        let cmp = if strip {
                            line.trim_start_matches('\t')
                        } else {
                            &line
                        };
                        if cmp.trim_end() == delim {
                            break;
                        }
                        seg.stdin.push_str(&line);
                        seg.stdin.push('\n');
                        i += 1;
                    }
                }
                end_segment!(false);
            }
            ';' | '(' | ')' | '{' | '}' => {
                end_segment!(false);
            }
            '&' => {
                if chars.get(i + 1) == Some(&'&') {
                    i += 1;
                }
                end_segment!(false);
            }
            '|' => {
                if chars.get(i + 1) == Some(&'|') {
                    i += 1;
                    end_segment!(false);
                } else {
                    end_segment!(true);
                }
            }
            '<' | '>' => {
                // `2>` / `0<`: a bare digit word glued to the operator is a
                // file descriptor, not an argument.
                if let Some(w) = &word {
                    if !w.quoted && !w.text.is_empty() && w.text.chars().all(|d| d.is_ascii_digit())
                    {
                        word = None;
                    }
                }
                end_word!();
                if c == '<' && chars.get(i + 1) == Some(&'<') {
                    if chars.get(i + 2) == Some(&'<') {
                        next = Next::HereString;
                        i += 3;
                    } else {
                        let strip = chars.get(i + 2) == Some(&'-');
                        next = Next::HeredocDelim(strip);
                        i += if strip { 3 } else { 2 };
                    }
                    continue;
                }
                // `>>`, `>|`, `>&2`, `<&0`: consume the whole operator. A
                // descriptor duplication names no file; anything else does,
                // and that file is not an argument to the command.
                i += 1;
                let mut dup = false;
                while i < chars.len() && matches!(chars[i], '>' | '&' | '|') {
                    dup |= chars[i] == '&';
                    i += 1;
                }
                if dup {
                    while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '-') {
                        i += 1;
                    }
                } else {
                    next = Next::RedirectTarget;
                }
                continue;
            }
            _ => {
                word.get_or_insert_with(Word::default).text.push(c);
            }
        }
        i += 1;
    }
    end_segment!(false);
    segs
}

// ─── SQL clients ─────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Role {
    Host,
    Port,
    Db,
    Sql,
    /// A value-taking option this rule does not read (user, file, …).
    Skip,
}

struct Opt {
    short: Option<char>,
    long: Option<&'static str>,
    /// sqlite3-style single-dash long option, matched exactly.
    exact: Option<&'static str>,
    role: Role,
    /// Takes its value only when attached (`-pX`, `--password=X`), never the
    /// next word — mysql's password option.
    attached_only: bool,
}

const fn opt(short: Option<char>, long: Option<&'static str>, role: Role) -> Opt {
    Opt {
        short,
        long,
        exact: None,
        role,
        attached_only: false,
    }
}

const fn exact(name: &'static str, role: Role) -> Opt {
    Opt {
        short: None,
        long: None,
        exact: Some(name),
        role,
        attached_only: false,
    }
}

const PSQL_OPTS: &[Opt] = &[
    opt(Some('h'), Some("host"), Role::Host),
    opt(Some('p'), Some("port"), Role::Port),
    opt(Some('d'), Some("dbname"), Role::Db),
    opt(Some('c'), Some("command"), Role::Sql),
    opt(Some('U'), Some("username"), Role::Skip),
    opt(Some('f'), Some("file"), Role::Skip),
    opt(Some('v'), Some("set"), Role::Skip),
    opt(None, Some("variable"), Role::Skip),
    opt(Some('o'), Some("output"), Role::Skip),
    opt(Some('P'), Some("pset"), Role::Skip),
    opt(Some('F'), Some("field-separator"), Role::Skip),
    opt(Some('R'), Some("record-separator"), Role::Skip),
    opt(Some('T'), Some("table-attr"), Role::Skip),
    opt(Some('L'), Some("log-file"), Role::Skip),
];

/// mysql's `-p` is the PASSWORD and takes only an attached value (`-pX`),
/// never the next word — a bare `-p` prompts. `-P` is the port.
const MYSQL_OPTS: &[Opt] = &[
    Opt {
        short: Some('p'),
        long: Some("password"),
        exact: None,
        role: Role::Skip,
        attached_only: true,
    },
    opt(Some('h'), Some("host"), Role::Host),
    opt(Some('P'), Some("port"), Role::Port),
    opt(Some('D'), Some("database"), Role::Db),
    opt(Some('e'), Some("execute"), Role::Sql),
    opt(Some('u'), Some("user"), Role::Skip),
    opt(Some('S'), Some("socket"), Role::Skip),
];

const SQLITE_OPTS: &[Opt] = &[
    exact("-cmd", Role::Sql),
    exact("-init", Role::Skip),
    exact("-separator", Role::Skip),
    exact("-nullvalue", Role::Skip),
    exact("-newline", Role::Skip),
];

const DROPDB_OPTS: &[Opt] = &[
    opt(Some('h'), Some("host"), Role::Host),
    opt(Some('p'), Some("port"), Role::Port),
    opt(Some('U'), Some("username"), Role::Skip),
    opt(None, Some("maintenance-db"), Role::Skip),
];

#[derive(Clone, Copy, PartialEq)]
enum Client {
    Psql,
    Mysql,
    Sqlite,
    Dropdb,
}

impl Client {
    fn from_word(w: &str) -> Option<Self> {
        let base = w.rsplit('/').next().unwrap_or(w).to_ascii_lowercase();
        match base.as_str() {
            "psql" => Some(Self::Psql),
            "mysql" | "mariadb" => Some(Self::Mysql),
            "sqlite3" | "sqlite" => Some(Self::Sqlite),
            "dropdb" => Some(Self::Dropdb),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Psql => "psql",
            Self::Mysql => "mysql",
            Self::Sqlite => "sqlite3",
            Self::Dropdb => "dropdb",
        }
    }

    fn opts(self) -> &'static [Opt] {
        match self {
            Self::Psql => PSQL_OPTS,
            Self::Mysql => MYSQL_OPTS,
            Self::Sqlite => SQLITE_OPTS,
            Self::Dropdb => DROPDB_OPTS,
        }
    }
}

/// A client's command line, read.
#[derive(Default)]
struct Invocation {
    host: Option<Word>,
    port: Option<Word>,
    db: Option<Word>,
    sql: Vec<String>,
    positionals: Vec<Word>,
}

fn parse_invocation(client: Client, args: &[Word]) -> Invocation {
    let opts = client.opts();
    let mut inv = Invocation::default();
    let mut i = 0;
    let mut end_of_opts = false;
    let assign = |inv: &mut Invocation, role: Role, w: Word| match role {
        Role::Host => inv.host = Some(w),
        Role::Port => inv.port = Some(w),
        Role::Db => inv.db = Some(w),
        Role::Sql => inv.sql.push(w.text),
        Role::Skip => {}
    };
    while i < args.len() {
        let a = &args[i];
        let t = a.text.as_str();
        if end_of_opts || !t.starts_with('-') || t == "-" {
            inv.positionals.push(a.clone());
            i += 1;
            continue;
        }
        if t == "--" {
            end_of_opts = true;
            i += 1;
            continue;
        }
        let with_text = |text: &str| Word {
            text: text.to_string(),
            var: a.var,
            quoted: a.quoted,
        };
        if let Some(o) = opts.iter().find(|o| o.exact == Some(t)) {
            if let Some(v) = args.get(i + 1) {
                assign(&mut inv, o.role, v.clone());
            }
            i += 2;
            continue;
        }
        if let Some(long) = t.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (long, None),
            };
            if let Some(o) = opts.iter().find(|o| o.long == Some(name)) {
                match inline {
                    Some(v) => assign(&mut inv, o.role, with_text(v)),
                    None if o.attached_only => {}
                    None => {
                        if let Some(v) = args.get(i + 1) {
                            assign(&mut inv, o.role, v.clone());
                        }
                        i += 1;
                    }
                }
            }
            i += 1;
            continue;
        }
        // Short options: `-h host`, `-hhost`, or a cluster like `-qc SQL`,
        // where the first value-taking letter takes the rest of the word or,
        // if nothing is left, the next word. sqlite3 has no short options.
        if opts.iter().any(|o| o.exact.is_some()) {
            i += 1;
            continue;
        }
        let letters: Vec<char> = t[1..].chars().collect();
        let mut consumed_next = false;
        for (k, ch) in letters.iter().enumerate() {
            let Some(o) = opts.iter().find(|o| o.short == Some(*ch)) else {
                continue;
            };
            let rest: String = letters[k + 1..].iter().collect();
            if !rest.is_empty() {
                assign(&mut inv, o.role, with_text(&rest));
            } else if !o.attached_only {
                if let Some(v) = args.get(i + 1) {
                    assign(&mut inv, o.role, v.clone());
                }
                consumed_next = true;
            }
            break;
        }
        i += if consumed_next { 2 } else { 1 };
    }
    inv
}

/// Env assignments a libpq client reads, written inline before it.
#[derive(Default)]
struct PgEnv {
    host: Option<Word>,
    port: Option<Word>,
    db: Option<Word>,
}

fn analyze_segments(segs: Vec<Segment>, depth: usize) -> Vec<SqlHit> {
    let mut out = Vec::new();
    // Text flowing into each segment's stdin from earlier in its pipeline.
    let mut pipeline_text = String::new();
    for seg in &segs {
        if !seg.piped_from_prev {
            pipeline_text.clear();
        }
        let client_at = seg
            .words
            .iter()
            .position(|w| !w.var && Client::from_word(&w.text).is_some());
        if let Some(at) = client_at {
            let client = Client::from_word(&seg.words[at].text).expect("checked above");
            let mut env = PgEnv::default();
            for w in &seg.words[..at] {
                if let Some((k, v)) = w.text.split_once('=') {
                    let val = Word {
                        text: v.to_string(),
                        var: w.var,
                        quoted: w.quoted,
                    };
                    match k {
                        "PGHOST" => env.host = Some(val),
                        "PGPORT" => env.port = Some(val),
                        "PGDATABASE" => env.db = Some(val),
                        _ => {}
                    }
                }
            }
            let mut stdin = pipeline_text.clone();
            stdin.push_str(&seg.stdin);
            if let Some(hit) = analyze_client(client, &seg.words[at + 1..], &env, &stdin) {
                out.push(hit);
            }
        }
        // `bash -c "psql …"`, `ssh host "psql …"`, `docker exec db sh -c "…"`:
        // a word that is itself a command is read as one.
        if depth < 3 {
            for w in &seg.words {
                if w.text.contains(char::is_whitespace) {
                    let lower = w.text.to_ascii_lowercase();
                    if ["psql", "mysql", "mariadb", "sqlite", "dropdb"]
                        .iter()
                        .any(|c| lower.contains(c))
                    {
                        out.extend(analyze_segments(lex(&w.text), depth + 1));
                    }
                }
            }
        }
        // Each word on its own statement line: `echo "DROP TABLE x" | psql`
        // must read as a statement that begins with DROP, not with `echo`.
        for w in &seg.words {
            pipeline_text.push_str(&w.text);
            pipeline_text.push_str(";\n");
        }
        pipeline_text.push_str(&seg.stdin);
        pipeline_text.push_str(";\n");
    }
    out
}

fn analyze_client(client: Client, args: &[Word], env: &PgEnv, stdin: &str) -> Option<SqlHit> {
    let inv = parse_invocation(client, args);

    let mut sql_text: Vec<&str> = inv.sql.iter().map(String::as_str).collect();
    if client == Client::Sqlite {
        // sqlite3 FILE [SQL…]
        sql_text.extend(inv.positionals.iter().skip(1).map(|w| w.text.as_str()));
    }
    sql_text.push(stdin);

    let mut statements: Vec<&'static str> = Vec::new();
    let mut switches_connection = false;
    let mut used_db: Option<String> = None;
    for text in &sql_text {
        let scan = scan_sql(text);
        statements.extend(scan.statements);
        switches_connection |= scan.switches_connection;
        if scan.used_db.is_some() {
            used_db = scan.used_db;
        }
    }
    if client == Client::Dropdb {
        statements.push("DROP DATABASE");
    }
    statements.sort_unstable();
    statements.dedup();
    if statements.is_empty() {
        return None;
    }

    let mut target = resolve_target(client, &inv, env);
    if switches_connection {
        target = Target::Unknown("the SQL switches connection with \\connect");
    } else if let (Some(db), Target::Known(t)) = (used_db, &target) {
        // mysql `USE other; DROP TABLE …` runs against `other`.
        if let Some((base, _)) = t.rsplit_once('/') {
            target = Target::Known(format!("{base}/{db}"));
        }
    }
    Some(SqlHit {
        client: client.name(),
        statements,
        target,
    })
}

const FROM_VARIABLE: &str =
    "the connection target comes from a shell variable or command substitution";
const NO_HOST: &str =
    "no host is named, so the client falls back to its environment or the local socket, which the proxy cannot see";

fn resolve_target(client: Client, inv: &Invocation, env: &PgEnv) -> Target {
    if client == Client::Sqlite {
        return match inv.positionals.first() {
            Some(w) if w.var => Target::Unknown(FROM_VARIABLE),
            Some(w) if w.text != ":memory:" && !w.text.is_empty() => {
                Target::Known(format!("sqlite:{}", w.text))
            }
            _ => Target::Known("sqlite::memory:".to_string()),
        };
    }
    let scheme = match client {
        Client::Mysql => "mysql",
        _ => "postgres",
    };

    let mut host: Option<Word> = env.host.clone();
    let mut port: Option<Word> = env.port.clone();
    let mut db: Option<Word> = env.db.clone();

    // The connection word: `-d` value, else the first positional.
    let conn = inv.db.clone().or_else(|| inv.positionals.first().cloned());
    if let Some(c) = conn {
        if c.var {
            return Target::Unknown(FROM_VARIABLE);
        }
        let lower = c.text.to_ascii_lowercase();
        if lower.contains("://") {
            match parse_uri(&c.text) {
                Some(u) => {
                    host = u.host.map(|h| Word::literal(&h));
                    port = u.port.map(|p| Word::literal(&p));
                    db = u.db.map(|d| Word::literal(&d));
                }
                None => return Target::Unknown("the connection URI could not be parsed"),
            }
        } else if c.text.contains('=') {
            // libpq keyword/value string: `host=x port=5432 dbname=app`.
            for kv in c.text.split_whitespace() {
                if let Some((k, v)) = kv.split_once('=') {
                    let v = Word::literal(v.trim_matches(['\'', '"']));
                    match k {
                        "host" | "hostaddr" => host = Some(v),
                        "port" => port = Some(v),
                        "dbname" => db = Some(v),
                        _ => {}
                    }
                }
            }
        } else {
            db = Some(c);
        }
    }
    // dropdb's positional is the database it drops.
    if client == Client::Dropdb {
        if let Some(p) = inv.positionals.first() {
            db = Some(p.clone());
        }
    }
    if let Some(h) = &inv.host {
        host = Some(h.clone());
    }
    if let Some(p) = &inv.port {
        port = Some(p.clone());
    }

    if [&host, &port, &db]
        .iter()
        .any(|w| w.as_ref().is_some_and(|w| w.var))
    {
        return Target::Unknown(FROM_VARIABLE);
    }
    let Some(host) = host.filter(|h| !h.text.is_empty()) else {
        return Target::Unknown(NO_HOST);
    };
    let port = port
        .filter(|p| !p.text.is_empty())
        .map(|p| format!(":{}", p.text))
        .unwrap_or_default();
    let db = db.map(|d| d.text).unwrap_or_default();
    Target::Known(format!(
        "{scheme}://{}{port}/{db}",
        host.text.to_ascii_lowercase()
    ))
}

struct Uri {
    host: Option<String>,
    port: Option<String>,
    db: Option<String>,
}

/// `scheme://[user[:password]@]host[:port][/db][?params]`. The userinfo is
/// discarded here and never stored, which is what makes every rendering of a
/// target credential-free.
fn parse_uri(raw: &str) -> Option<Uri> {
    let (_, rest) = raw.split_once("://")?;
    let (authority, path) = match rest.find(['/', '?']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let hostport = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (host, port) = if let Some(stripped) = hostport.strip_prefix('[') {
        let (h, tail) = stripped.split_once(']')?;
        (format!("[{h}]"), tail.strip_prefix(':').map(str::to_string))
    } else {
        match hostport.rsplit_once(':') {
            // A multi-host list keeps its commas; only the last port splits off.
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => {
                (h.to_string(), Some(p.to_string()))
            }
            _ => (hostport.to_string(), None),
        }
    };
    let db = path
        .strip_prefix('/')
        .map(|p| p.split('?').next().unwrap_or("").to_string())
        .filter(|d| !d.is_empty());
    let host = Some(host).filter(|h| !h.is_empty());
    Some(Uri {
        host,
        port: port.filter(|p| !p.is_empty()),
        db,
    })
}

/// Canonicalise an allowlist entry the way targets are canonicalised, so a
/// pattern written `postgresql://user@localhost/*` still matches.
fn normalize_pattern(p: &str) -> String {
    let p = p.trim().to_ascii_lowercase();
    let Some((scheme, rest)) = p.split_once("://") else {
        return p;
    };
    let scheme = match scheme {
        "postgresql" => "postgres",
        "mariadb" => "mysql",
        s => s,
    };
    let auth_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(auth_end);
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    format!("{scheme}://{authority}{tail}")
}

/// `*` matches any run of characters (including `/` and `:`), `?` one.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.to_ascii_lowercase().chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

// ─── SQL scanning ────────────────────────────────────────────────────────

#[derive(Default)]
struct SqlScan {
    statements: Vec<&'static str>,
    switches_connection: bool,
    used_db: Option<String>,
}

/// Comments and string literals removed, so a statement's *text* is what is
/// matched and never data that merely mentions a drop.
fn strip_sql(sql: &str) -> String {
    let c: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '-' if c.get(i + 1) == Some(&'-') => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
            }
            // MySQL line comment — only at the start of a line, because `#`
            // mid-line is an operator in Postgres, and stripping from there
            // could hide a statement that follows it.
            '#' if out.rsplit('\n').next().is_some_and(|l| l.trim().is_empty()) => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
            }
            '/' if c.get(i + 1) == Some(&'*') => {
                i += 2;
                while i < c.len() && !(c[i] == '*' && c.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
                out.push(' ');
            }
            '\'' => {
                i += 1;
                while i < c.len() {
                    if c[i] == '\'' {
                        if c.get(i + 1) == Some(&'\'') {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    if c[i] == '\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
                out.push_str("''");
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

fn scan_sql(sql: &str) -> SqlScan {
    static DROP: OnceLock<Regex> = OnceLock::new();
    static TRUNCATE: OnceLock<Regex> = OnceLock::new();
    static DELETE: OnceLock<Regex> = OnceLock::new();
    static WHERE: OnceLock<Regex> = OnceLock::new();
    static CONNECT: OnceLock<Regex> = OnceLock::new();
    static USE: OnceLock<Regex> = OnceLock::new();
    let drop = DROP.get_or_init(|| {
        Regex::new(r"(?i)^drop\s+(table|database|schema)\b").expect("static regex")
    });
    // Statement-initial: MySQL also has a numeric TRUNCATE(x, d) function.
    let truncate = TRUNCATE
        .get_or_init(|| Regex::new(r"(?i)^truncate(\s+table)?\s+[^\s(]").expect("static regex"));
    let delete = DELETE.get_or_init(|| Regex::new(r"(?i)^delete\s+from\s").expect("static regex"));
    let where_ = WHERE.get_or_init(|| Regex::new(r"(?i)\bwhere\b").expect("static regex"));
    let connect =
        CONNECT.get_or_init(|| Regex::new(r"(?im)^\s*\\(c|connect)(\s|$)").expect("static regex"));
    let use_ =
        USE.get_or_init(|| Regex::new(r"(?i)^use\s+`?([A-Za-z0-9_$-]+)`?$").expect("static regex"));

    let mut scan = SqlScan {
        switches_connection: connect.is_match(sql),
        ..SqlScan::default()
    };
    if sql.trim().is_empty() {
        return scan;
    }
    // A psql meta-command (`\set`, `\connect`) is ended by its newline, not by
    // a semicolon; left in, it would swallow the statement on the next line.
    let sql: String = sql
        .lines()
        .map(|l| {
            if l.trim_start().starts_with('\\') {
                ";"
            } else {
                l
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    for stmt in strip_sql(&sql).split(';') {
        let s = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
        let s = s.as_str();
        if let Some(m) = drop.captures(s) {
            scan.statements
                .push(match m[1].to_ascii_lowercase().as_str() {
                    "table" => "DROP TABLE",
                    "database" => "DROP DATABASE",
                    _ => "DROP SCHEMA",
                });
        } else if truncate.is_match(s) {
            scan.statements.push("TRUNCATE");
        } else if delete.is_match(s) && !where_.is_match(s) {
            scan.statements.push("DELETE without WHERE");
        } else if let Some(m) = use_.captures(s) {
            scan.used_db = Some(m[1].to_string());
        }
    }
    scan
}

// ─── Streaming ───────────────────────────────────────────────────────────

/// Holds a streamed shell-tool block back until its arguments are complete.
///
/// The response gate's name check can decide on the first line of a tool
/// block; an argument rule cannot, because the arguments arrive as fragments
/// over later lines. So while a SQL guard is in force, the lines of a
/// shell-tool block — and only those — are withheld until the block ends,
/// evaluated whole, then released in order or replaced by a refusal. Text and
/// every other tool's blocks flow through unheld. The cost is that a shell
/// call reaches the client at block end rather than incrementally, which the
/// harness does not notice: it acts on a tool call only once the block is
/// complete. `ArgHoldback` in `proxy.rs` already makes the same trade.
///
/// Three wire shapes, recognised from the event itself rather than from
/// configuration, so a cross-provider stream (read here before translation)
/// is handled the same as a same-provider one:
///
/// * Anthropic — `content_block_start` (tool_use) … `input_json_delta` …
///   `content_block_stop` at the same index;
/// * OpenAI chat — a `tool_calls` delta naming the function, argument deltas
///   at the same `tool_calls[].index`, ended by the next call, a
///   `finish_reason`, or `[DONE]`;
/// * OpenAI Responses — `response.output_item.added` (function_call) …
///   `response.function_call_arguments.delta` … `response.output_item.done`
///   at the same `output_index`.
pub struct StreamHold {
    policies: Vec<SqlGuardPolicy>,
    held: Option<Held>,
}

#[derive(Clone, Copy, PartialEq)]
enum Shape {
    Anthropic,
    OpenAIChat,
    Responses,
}

struct Held {
    shape: Shape,
    /// Block / tool-call / output index the block's lines carry.
    key: u64,
    /// Where a refusal is written — see `ToolUseEvent::block_index`.
    block_index: u64,
    tool: String,
    args: String,
    lines: Vec<String>,
}

/// What to do with the line just pushed.
#[derive(Debug, Default)]
pub struct HoldStep {
    /// Lines to forward now, in order (possibly including the one pushed).
    pub emit: Vec<String>,
    /// Withhold the block and close the stream with a refusal at this index.
    pub refuse: Option<(SqlViolation, u64)>,
    /// Non-enforcing violations (`warn`, shadow) to log.
    pub notes: Vec<SqlViolation>,
}

fn data_json(line: &str) -> Option<Value> {
    let d = line.strip_prefix("data:")?.trim();
    if d.is_empty() || d == "[DONE]" {
        return None;
    }
    serde_json::from_str(d).ok()
}

impl StreamHold {
    pub fn new(policies: Vec<SqlGuardPolicy>) -> Self {
        Self {
            policies,
            held: None,
        }
    }

    /// Feed one SSE line (trimmed, without its newline).
    pub fn push(&mut self, line: String) -> HoldStep {
        let Some(held) = self.held.as_mut() else {
            return self.maybe_start(line);
        };
        let v = data_json(&line);
        let ty = v
            .as_ref()
            .and_then(|v| v.get("type"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        match held.shape {
            Shape::Anthropic => {
                let idx = v
                    .as_ref()
                    .and_then(|v| v.get("index"))
                    .and_then(|i| i.as_u64());
                if ty == "content_block_delta" && idx == Some(held.key) {
                    if let Some(f) = v
                        .as_ref()
                        .and_then(|v| v.get("delta"))
                        .and_then(|d| d.get("partial_json"))
                        .and_then(|p| p.as_str())
                    {
                        held.args.push_str(f);
                    }
                }
                held.lines.push(line);
                if ty == "content_block_stop" && idx == Some(held.key) {
                    return self.finish_block(None);
                }
                HoldStep::default()
            }
            Shape::Responses => {
                let idx = v
                    .as_ref()
                    .and_then(|v| v.get("output_index"))
                    .and_then(|i| i.as_u64());
                if idx == Some(held.key) {
                    let vv = v.as_ref().expect("idx implies parsed");
                    match ty {
                        "response.function_call_arguments.delta" => {
                            if let Some(f) = vv.get("delta").and_then(|d| d.as_str()) {
                                held.args.push_str(f);
                            }
                        }
                        // The authoritative whole, when the server sends it.
                        "response.function_call_arguments.done" => {
                            if let Some(a) = vv.get("arguments").and_then(|d| d.as_str()) {
                                held.args = a.to_string();
                            }
                        }
                        _ => {}
                    }
                }
                held.lines.push(line);
                if ty == "response.output_item.done" && idx == Some(held.key) {
                    return self.finish_block(None);
                }
                HoldStep::default()
            }
            Shape::OpenAIChat => {
                if line.strip_prefix("data:").map(str::trim) == Some("[DONE]") {
                    return self.finish_block(Some(line));
                }
                let Some(v) = v else {
                    // Blank separators and comments ride with the block.
                    held.lines.push(line);
                    return HoldStep::default();
                };
                let choice = v.get("choices").and_then(|c| c.get(0));
                let tc = choice
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("tool_calls"))
                    .and_then(|t| t.get(0));
                let finished = choice
                    .and_then(|c| c.get("finish_reason"))
                    .is_some_and(|f| !f.is_null());
                match tc {
                    Some(tc)
                        if tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) == held.key =>
                    {
                        if let Some(f) = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .and_then(|a| a.as_str())
                        {
                            held.args.push_str(f);
                        }
                        held.lines.push(line);
                        if finished {
                            return self.finish_block(None);
                        }
                        HoldStep::default()
                    }
                    // Another call, or the end of the message: the held call is
                    // complete, and this line is handled on its own merits.
                    Some(_) => self.finish_block(Some(line)),
                    None if finished => self.finish_block(Some(line)),
                    None => {
                        held.lines.push(line);
                        HoldStep::default()
                    }
                }
            }
        }
    }

    /// Lines still held when the upstream ended without closing the block.
    /// The call is incomplete — the stream was cut — and is dropped rather
    /// than forwarded unverified.
    pub fn take_unfinished(&mut self) -> Option<String> {
        self.held.take().map(|h| h.tool)
    }

    fn maybe_start(&mut self, line: String) -> HoldStep {
        let start = crate::protocol::tool_use_parser::parse_sse_chunk(&line)
            .filter(|ev| tool_is(&ev.tool_name, SHELL_TOOLS));
        let (Some(ev), Some(v)) = (start, data_json(&line)) else {
            return HoldStep {
                emit: vec![line],
                ..HoldStep::default()
            };
        };
        let (shape, key, args) =
            if v.get("type").and_then(|t| t.as_str()) == Some("content_block_start") {
                let key = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                // An input already present on the start event (non-incremental
                // senders) counts; `{}` — the usual placeholder — does not.
                let initial = v
                    .get("content_block")
                    .and_then(|b| b.get("input"))
                    .filter(|i| i.as_object().is_some_and(|o| !o.is_empty()))
                    .map(|i| i.to_string())
                    .unwrap_or_default();
                (Shape::Anthropic, key, initial)
            } else if v.get("type").and_then(|t| t.as_str()) == Some("response.output_item.added") {
                let key = v.get("output_index").and_then(|i| i.as_u64()).unwrap_or(0);
                let initial = v
                    .get("item")
                    .and_then(|i| i.get("arguments"))
                    .and_then(|a| a.as_str())
                    .unwrap_or("")
                    .to_string();
                (Shape::Responses, key, initial)
            } else {
                let tc = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("tool_calls"))
                    .and_then(|t| t.get(0));
                let key = tc
                    .and_then(|t| t.get("index"))
                    .and_then(|i| i.as_u64())
                    .unwrap_or(0);
                let initial = tc
                    .and_then(|t| t.get("function"))
                    .and_then(|f| f.get("arguments"))
                    .and_then(|a| a.as_str())
                    .unwrap_or("")
                    .to_string();
                (Shape::OpenAIChat, key, initial)
            };
        self.held = Some(Held {
            shape,
            key,
            block_index: ev.block_index,
            tool: ev.tool_name,
            args,
            lines: vec![line],
        });
        HoldStep::default()
    }

    /// The held block is complete: evaluate it, then release or refuse.
    /// `after` is a line that ended the block without belonging to it.
    fn finish_block(&mut self, after: Option<String>) -> HoldStep {
        let held = self
            .held
            .take()
            .expect("finish_block runs only while holding");
        let args: Value =
            serde_json::from_str(&held.args).unwrap_or_else(|_| Value::String(held.args.clone()));
        let violations = evaluate(&self.policies, &held.tool, &args);
        let mut step = HoldStep::default();
        for v in violations {
            if step.refuse.is_none() && v.refuses() {
                step.refuse = Some((v, held.block_index));
            } else {
                step.notes.push(v);
            }
        }
        if step.refuse.is_some() {
            return step;
        }
        step.emit = held.lines;
        if let Some(line) = after {
            let next = self.push(line);
            step.emit.extend(next.emit);
            step.notes.extend(next.notes);
            step.refuse = next.refuse;
        }
        step
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(sev: SqlGuardSeverity, allow: &[&str]) -> SqlGuardPolicy {
        SqlGuardPolicy {
            severity: sev,
            allow: allow.iter().map(|s| s.to_string()).collect(),
            org_allow: Vec::new(),
            shadow: false,
        }
    }

    fn scratch() -> Vec<SqlGuardPolicy> {
        vec![policy(
            SqlGuardSeverity::Refuse,
            &[
                "postgres://localhost/*",
                "postgres://localhost:*",
                "postgres://scratch-*.internal*",
                "mysql://127.0.0.1*",
                "sqlite:*",
            ],
        )]
    }

    fn bash(cmd: &str) -> Value {
        json!({ "command": cmd })
    }

    fn one(cmd: &str) -> SqlHit {
        let hits = inspect_command(cmd);
        assert_eq!(hits.len(), 1, "{cmd:?} → {hits:?}");
        hits.into_iter().next().unwrap()
    }

    fn known(t: &str) -> Target {
        Target::Known(t.to_string())
    }

    // ── Detection across the client forms ───────────────────────────────

    #[test]
    fn psql_dash_c_with_flags() {
        let h = one(r#"psql -h db.prod.internal -p 5432 -d app -c "DROP TABLE users""#);
        assert_eq!(h.client, "psql");
        assert_eq!(h.statements, vec!["DROP TABLE"]);
        assert_eq!(h.target, known("postgres://db.prod.internal:5432/app"));
    }

    #[test]
    fn psql_long_options_and_attached_values() {
        let h = one("psql --host=db.prod --dbname app --command='truncate table events'");
        assert_eq!(h.statements, vec!["TRUNCATE"]);
        assert_eq!(h.target, known("postgres://db.prod/app"));
        let h = one("psql -X -hdb.prod -dapp -qc'drop schema reporting cascade'");
        assert_eq!(h.statements, vec!["DROP SCHEMA"]);
        assert_eq!(h.target, known("postgres://db.prod/app"));
    }

    #[test]
    fn psql_uri_positional() {
        let h = one("psql postgresql://app@db.prod.internal:6432/app -c 'DROP DATABASE app'");
        assert_eq!(h.statements, vec!["DROP DATABASE"]);
        assert_eq!(h.target, known("postgres://db.prod.internal:6432/app"));
    }

    #[test]
    fn psql_conninfo_string() {
        let h = one(r#"psql "host=db.prod port=5432 dbname=app" -c "drop table t""#);
        assert_eq!(h.target, known("postgres://db.prod:5432/app"));
    }

    #[test]
    fn psql_heredoc() {
        let cmd =
            "psql -h db.prod -d app <<'SQL'\nBEGIN;\nDROP TABLE users;\nCOMMIT;\nSQL\necho done";
        let h = one(cmd);
        assert_eq!(h.statements, vec!["DROP TABLE"]);
        assert_eq!(h.target, known("postgres://db.prod/app"));
    }

    #[test]
    fn psql_here_string_and_pipe() {
        assert_eq!(
            one(r#"psql -h db.prod -d app <<< "TRUNCATE events""#).statements,
            vec!["TRUNCATE"]
        );
        let h = one(r#"echo "DROP TABLE users;" | psql -h db.prod -d app"#);
        assert_eq!(h.statements, vec!["DROP TABLE"]);
        assert_eq!(h.target, known("postgres://db.prod/app"));
    }

    #[test]
    fn mysql_forms() {
        let h = one(r#"mysql -h db.prod -P 3306 -u root -psecret -D shop -e "DELETE FROM orders""#);
        assert_eq!(h.client, "mysql");
        assert_eq!(h.statements, vec!["DELETE without WHERE"]);
        assert_eq!(h.target, known("mysql://db.prod:3306/shop"));
        // Bare `-p` prompts: it must not swallow the next word as a value.
        let h = one("mysql -h db.prod -p shop --execute='drop table carts'");
        assert_eq!(h.target, known("mysql://db.prod/shop"));
        // `USE` re-targets the database.
        let h = one(r#"mysql -h 127.0.0.1 -e "USE prod_shop; DROP TABLE carts""#);
        assert_eq!(h.target, known("mysql://127.0.0.1/prod_shop"));
    }

    #[test]
    fn sqlite_and_dropdb() {
        let h = one(r#"sqlite3 /tmp/scratch.db "DROP TABLE t""#);
        assert_eq!(h.client, "sqlite3");
        assert_eq!(h.target, known("sqlite:/tmp/scratch.db"));
        let h = one("dropdb -h db.prod -p 5432 app");
        assert_eq!(h.statements, vec!["DROP DATABASE"]);
        assert_eq!(h.target, known("postgres://db.prod:5432/app"));
    }

    #[test]
    fn nested_shells_and_inline_env() {
        let h = one(r#"bash -lc "psql -h db.prod -d app -c 'DROP TABLE users'""#);
        assert_eq!(h.target, known("postgres://db.prod/app"));
        let h = one("PGHOST=db.prod PGDATABASE=app psql -c 'drop table users'");
        assert_eq!(h.target, known("postgres://db.prod/app"));
        let h = one("kubectl exec -it pg-0 -- psql -U postgres -c 'DROP TABLE users'");
        assert!(matches!(h.target, Target::Unknown(_)), "{h:?}");
    }

    #[test]
    fn argv_array_is_read_as_a_command() {
        let args =
            json!({ "command": ["psql", "-h", "db.prod", "-d", "app", "-c", "DROP TABLE users"] });
        let hits = inspect_tool_call("shell", &args);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].target, known("postgres://db.prod/app"));
        let args = json!({ "command": ["bash", "-lc", "psql -h db.prod -c 'drop table x'"] });
        assert_eq!(inspect_tool_call("shell", &args).len(), 1);
    }

    #[test]
    fn delete_with_where_and_non_statement_mentions_pass() {
        for cmd in [
            r#"psql -h db.prod -c "DELETE FROM sessions WHERE expires_at < now()""#,
            r#"psql -h db.prod -c "SELECT 'drop table users' AS note""#,
            r#"psql -h db.prod -c "-- drop table users
                SELECT 1""#,
            r#"psql -h db.prod -c "ALTER TABLE users DROP COLUMN legacy""#,
            r#"mysql -h db.prod -e "SELECT TRUNCATE(1.234, 1)""#,
            "echo 'DROP TABLE users'",
            "git stash drop",
            "grep -ri 'drop table' migrations/",
        ] {
            assert!(inspect_command(cmd).is_empty(), "false positive on {cmd:?}");
        }
    }

    #[test]
    fn migration_tools_pass() {
        let p = scratch();
        for cmd in [
            "pnpm prisma migrate deploy",
            "npx knex migrate:latest",
            "alembic upgrade head",
            "flyway -url=jdbc:postgresql://db.prod/app migrate",
            "psql -h db.prod -d app -f migrations/001_init.sql",
            "psql -h db.prod -d app -f migrations/002_drop_legacy_tables.sql",
            "pnpm db:reset --drop-only-on-dev",
            "rails db:migrate",
            r#"psql -h db.prod -d app -c "CREATE TABLE t (id int)""#,
        ] {
            assert!(
                evaluate(&p, "Bash", &bash(cmd)).is_empty(),
                "{cmd:?} was flagged"
            );
        }
    }

    #[test]
    fn non_shell_tools_are_ignored() {
        let args = bash("psql -h db.prod -c 'DROP TABLE users'");
        assert!(inspect_tool_call("Write", &args).is_empty());
        assert!(inspect_tool_call("WebFetch", &args).is_empty());
        for t in [
            "Bash",
            "shell",
            "run_command",
            "execute_command",
            "terminal",
        ] {
            assert_eq!(inspect_tool_call(t, &args).len(), 1, "{t}");
        }
    }

    // ── Policy ──────────────────────────────────────────────────────────

    #[test]
    fn allowlisted_target_passes() {
        let p = scratch();
        // Credential-shaped URIs are assembled at runtime so no contiguous
        // connection string with a password sits in the source.
        for cmd in [
            "psql -h localhost -d app_dev -c 'DROP TABLE users'".to_string(),
            format!(
                "psql postgres://{}:{}@localhost:5433/app_test -c 'TRUNCATE events'",
                "dev", "dev"
            ),
            "psql -h scratch-7.internal -d tmp -c 'drop schema x cascade'".to_string(),
            "mysql -h 127.0.0.1 -e 'DROP DATABASE shop_test'".to_string(),
            "sqlite3 test.db 'DELETE FROM t'".to_string(),
            "dropdb -h localhost app_test".to_string(),
        ] {
            assert!(
                evaluate(&p, "Bash", &bash(&cmd)).is_empty(),
                "{cmd:?} was refused"
            );
        }
    }

    #[test]
    fn production_target_refused() {
        let v = evaluate(
            &scratch(),
            "Bash",
            &bash("psql -h db.prod.internal -d app -c 'DROP TABLE users'"),
        );
        assert_eq!(v.len(), 1);
        assert!(!v[0].shadow);
        assert_eq!(v[0].severity, SqlGuardSeverity::Refuse);
        let msg = v[0].agent_message();
        assert!(msg.contains("postgres://db.prod.internal/app"), "{msg}");
        assert!(msg.contains("DROP TABLE"), "{msg}");
        // A look-alike host must not ride a `localhost` pattern.
        assert_eq!(
            evaluate(
                &scratch(),
                "Bash",
                &bash("psql -h localhost.evil.com -c 'drop table t'")
            )
            .len(),
            1
        );
    }

    #[test]
    fn unknown_targets_refused() {
        let p = scratch();
        for cmd in [
            r#"psql "$DATABASE_URL" -c 'DROP TABLE users'"#,
            "psql $DATABASE_URL -c 'DROP TABLE users'",
            "psql -h ${DB_HOST} -c 'drop table users'",
            "psql -h $(cat host.txt) -c 'drop table users'",
            "psql -d app -c 'DROP TABLE users'",
            "mysql -e 'truncate table carts'",
            "psql -h localhost -d dev <<EOF\n\\connect prod\nDROP TABLE users;\nEOF",
        ] {
            let v = evaluate(&p, "Bash", &bash(cmd));
            assert_eq!(v.len(), 1, "{cmd:?} → {v:?}");
            assert!(
                matches!(v[0].hit.target, Target::Unknown(_)),
                "{cmd:?} → {v:?}"
            );
        }
    }

    #[test]
    fn empty_allowlist_refuses_everything_destructive() {
        let p = vec![policy(SqlGuardSeverity::Refuse, &[])];
        assert_eq!(
            evaluate(&p, "Bash", &bash("psql -h localhost -c 'drop table t'")).len(),
            1
        );
        assert!(evaluate(&p, "Bash", &bash("psql -h localhost -c 'select 1'")).is_empty());
    }

    #[test]
    fn org_ceiling_never_widens() {
        let p = SqlGuardPolicy {
            severity: SqlGuardSeverity::Refuse,
            allow: vec!["postgres://*".into()],
            org_allow: vec!["postgres://localhost/*".into()],
            shadow: false,
        };
        assert!(p.permits(&known("postgres://localhost/app")));
        assert!(!p.permits(&known("postgres://db.prod/app")));
        assert!(!p.permits(&Target::Unknown(NO_HOST)));
    }

    #[test]
    fn pattern_normalisation() {
        let p = policy(
            SqlGuardSeverity::Refuse,
            &["postgresql://someone@LOCALHOST/*"],
        );
        assert!(p.permits(&known("postgres://localhost/app")));
    }

    #[test]
    fn severity_parsing_fails_safe() {
        assert_eq!(SqlGuardSeverity::parse("warn"), Ok(SqlGuardSeverity::Warn));
        assert_eq!(
            SqlGuardSeverity::parse(" Refuse "),
            Ok(SqlGuardSeverity::Refuse)
        );
        assert!(SqlGuardSeverity::parse("refsue").is_err());
        assert!(SqlGuardSeverity::parse("off").is_err());
    }

    // ── Credentials never surface ───────────────────────────────────────

    #[test]
    fn passwords_are_never_rendered() {
        let p = scratch();
        // Assembled at runtime: no contiguous credential-shaped literal in source.
        let pw = ["hun", "ter2"].concat();
        let cases = [
            format!("psql postgres://admin:{pw}@db.prod.internal:5432/app?sslpassword={pw} -c 'DROP TABLE users'"),
            format!("mysql -h db.prod -uadmin -p{pw} -e 'DROP DATABASE shop'"),
            format!("mysql -h db.prod --password={pw} -e 'DROP DATABASE shop'"),
            format!("PGPASSWORD={pw} psql -h db.prod -c 'DROP TABLE users'"),
            format!(r#"psql "host=db.prod password={pw} dbname=app" -c 'DROP TABLE users'"#),
            format!("psql postgres://admin:{pw}@$HOST/app -c 'DROP TABLE users'"),
        ];
        for cmd in &cases {
            let v = evaluate(&p, "Bash", &bash(cmd));
            assert_eq!(v.len(), 1, "{cmd:?}");
            for rendered in [
                v[0].log_message(),
                v[0].agent_message(),
                format!("{:?}", v[0]),
            ] {
                assert!(!rendered.contains(&pw), "password leaked: {rendered}");
                assert!(!rendered.contains("admin"), "user leaked: {rendered}");
            }
        }
    }

    // ── Streaming hold ──────────────────────────────────────────────────

    fn run(hold: &mut StreamHold, lines: &[String]) -> (Vec<String>, Option<(SqlViolation, u64)>) {
        let mut out = Vec::new();
        for l in lines {
            let step = hold.push(l.clone());
            out.extend(step.emit);
            if step.refuse.is_some() {
                return (out, step.refuse);
            }
        }
        (out, None)
    }

    fn anthropic_stream(cmd: &str) -> Vec<String> {
        let args = json!({ "command": cmd }).to_string();
        let (a, b) = args.split_at(args.len() / 2);
        let delta = |f: &str| {
            format!(
                "data: {}",
                json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":f}})
            )
        };
        vec![
            "event: content_block_start".into(),
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#.into(),
            "".into(),
            r#"data: {"type":"content_block_stop","index":0}"#.into(),
            "event: content_block_start".into(),
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}"#.into(),
            "".into(),
            "event: content_block_delta".into(),
            delta(a),
            "".into(),
            "event: content_block_delta".into(),
            delta(b),
            "".into(),
            "event: content_block_stop".into(),
            r#"data: {"type":"content_block_stop","index":1}"#.into(),
            "".into(),
            "event: message_stop".into(),
        ]
    }

    #[test]
    fn stream_releases_allowed_block_in_order() {
        let lines = anthropic_stream("psql -h localhost -d dev -c 'DROP TABLE t'");
        let mut hold = StreamHold::new(scratch());
        let (out, refuse) = run(&mut hold, &lines);
        assert!(refuse.is_none());
        assert_eq!(out, lines, "an allowed stream must come out byte-identical");
    }

    #[test]
    fn stream_refuses_production_drop_split_across_deltas() {
        let lines = anthropic_stream("psql -h db.prod -d app -c 'DROP TABLE users'");
        let mut hold = StreamHold::new(scratch());
        let (out, refuse) = run(&mut hold, &lines);
        let (v, idx) = refuse.expect("must refuse");
        assert_eq!(idx, 1);
        assert_eq!(v.hit.target, known("postgres://db.prod/app"));
        assert!(
            !out.iter()
                .any(|l| l.contains("input_json_delta") || l.contains("tool_use")),
            "no part of the refused tool block may be emitted: {out:?}"
        );
    }

    #[test]
    fn stream_openai_chat_block_ends_at_next_call_and_done() {
        let start = |i: u64, name: &str| {
            format!(
                "data: {}",
                json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":i,"id":"c","type":"function","function":{"name":name,"arguments":""}}]}}]})
            )
        };
        let args = |i: u64, a: &str| {
            format!(
                "data: {}",
                json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":i,"function":{"arguments":a}}]}}]})
            )
        };
        let full = json!({"command":"mysql -h db.prod -e 'DROP DATABASE shop'"}).to_string();
        let (a, b) = full.split_at(10);
        let lines = vec![
            start(0, "read_file"),
            args(0, r#"{"path":"x"}"#),
            start(1, "shell"),
            args(1, a),
            args(1, b),
            "data: [DONE]".to_string(),
        ];
        let mut hold = StreamHold::new(scratch());
        let (out, refuse) = run(&mut hold, &lines);
        assert_eq!(out, lines[..2].to_vec(), "the non-shell call flows unheld");
        let (v, idx) = refuse.expect("must refuse");
        assert_eq!(idx, 0, "OpenAI refusals are addressed to the choice");
        assert_eq!(v.hit.client, "mysql");

        // Allowed: everything released, [DONE] last.
        let ok = json!({"command":"echo hi"}).to_string();
        let lines = vec![start(0, "shell"), args(0, &ok), "data: [DONE]".to_string()];
        let mut hold = StreamHold::new(scratch());
        let (out, refuse) = run(&mut hold, &lines);
        assert!(refuse.is_none());
        assert_eq!(out, lines);
    }

    #[test]
    fn stream_responses_api() {
        let full = json!({"command":["bash","-lc","psql -h db.prod -c 'truncate t'"]}).to_string();
        let lines = vec![
            "event: response.output_item.added".to_string(),
            format!(
                "data: {}",
                json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","name":"shell","arguments":""}})
            ),
            format!(
                "data: {}",
                json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":full})
            ),
            format!(
                "data: {}",
                json!({"type":"response.output_item.done","output_index":1,"item":{}})
            ),
        ];
        let mut hold = StreamHold::new(scratch());
        let (out, refuse) = run(&mut hold, &lines);
        assert_eq!(out, lines[..1].to_vec());
        assert_eq!(refuse.expect("must refuse").1, 1);
    }

    #[test]
    fn stream_warn_and_shadow_never_withhold() {
        let lines = anthropic_stream("psql -h db.prod -d app -c 'DROP TABLE users'");
        let mut warn = scratch();
        warn[0].severity = SqlGuardSeverity::Warn;
        let mut shadow = scratch();
        shadow[0].shadow = true;
        for policies in [warn, shadow] {
            let mut hold = StreamHold::new(policies);
            let mut out = Vec::new();
            let mut notes = 0;
            for l in &lines {
                let s = hold.push(l.clone());
                assert!(s.refuse.is_none());
                notes += s.notes.len();
                out.extend(s.emit);
            }
            assert_eq!(out, lines);
            assert_eq!(notes, 1);
        }
    }
}
