//! Decide rules: the grammar, the validator and the semantics.
//!
//! A decide rule asks a self-hosted model a few narrow `yes_no` or `choice`
//! questions about a tool call or a model response, turns each answer's
//! probability into yes, no or unknown through a band, and combines the
//! answers with the rule's `when` expression in Kleene three-valued logic:
//! true refuses, false allows, unknown escalates. It is written as one SOP
//! front-matter line, `decide: {json}`, which `sops.rs` reads with the rest of
//! the front matter.
//!
//! This is the port of `packages/shared-types/src/decide.ts`; the Python gate
//! carries another (`intutic_clawde/gate/decide.py`). All three run
//! `packages/shared-types/fixtures/decide-vectors.json` and must reach the same
//! answers, reason text included, so this module reads a line exactly as the
//! TypeScript does: shape first, then the eight ordered checks, questions in
//! sorted name order, `when` atoms left to right, lengths in code points and
//! ASCII-only regexes.
//!
//! Everything here is pure. Asking the model is a pipeline stage, not a
//! plugin, because a plugin's `evaluate` may do no I/O.

/// The engine client: adapters, state, timeouts and error mapping.
pub mod engine;
/// One call's rules through the engine, inside the engine protections.
pub mod evaluate;
/// The self-hosted guard on the engine's URL.
pub mod guard;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const DECIDE_MAX_QUESTIONS: usize = 8;
pub const DECIDE_MAX_OPTIONS: usize = 8;
pub const DECIDE_MAX_RULES_PER_CALL: usize = 4;
pub const DECIDE_MAX_WHEN_CHARS: usize = 256;
pub const DECIDE_MIN_ASK_CHARS: usize = 8;
pub const DECIDE_MAX_ASK_CHARS: usize = 300;
/// Appended to every `choice` question's options when absent, and always asked last.
pub const NONE_OF_THESE: &str = "none_of_these";
pub const DEFAULT_BAND: Band = Band {
    yes_at: 0.85,
    no_below: 0.15,
};

pub const DECIDE_REFUSED: &str = "DECIDE_REFUSED";
pub const DECIDE_ESCALATED: &str = "DECIDE_ESCALATED";
pub const GOVERNANCE_UNAVAILABLE: &str = "GOVERNANCE_UNAVAILABLE";

const MAX_TOOLS: usize = 8;
const MAX_TITLE: usize = 80;
const KEYWORDS: [&str; 4] = ["AND", "OR", "NOT", "IN"];
const RULE_FIELDS: [&str; 10] = [
    "id",
    "title",
    "on",
    "tools",
    "questions",
    "when",
    "band",
    "escalate",
    "rollout",
    "context",
];
const QUESTION_FIELDS: [&str; 4] = ["type", "ask", "options", "band"];
const BAND_FIELDS: [&str; 2] = ["yes_at", "no_below"];

const EMPTY_LINE: &str = "decide: the line is empty; write one rule per line as `decide: {json}`";
const NOT_JSON: &str = "decide: the value is not JSON; write one rule per line as `decide: {json}`";

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a fixed decide pattern compiles"))
}

fn tool_token_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")
}

fn rule_id_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[a-z][a-z0-9_-]{0,47}$")
}

fn name_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[a-z][a-z0-9_]{0,31}$")
}

/// A question that asks about approval (check 8). Approval comes from the
/// harness's ask or the review queue, never from a model reading text.
/// ASCII word boundaries and case folding, as the other ports read it.
fn approval_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i-u)\b(approv\w*|authori[sz]\w*|pre-?approv\w*|consent\w*|permi(t|ssion)\w*|sign(ed)?[- ]off)\b",
    )
}

// ─── Types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Band {
    pub yes_at: f64,
    pub no_below: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuestionType {
    YesNo,
    Choice,
}

impl QuestionType {
    pub fn as_str(self) -> &'static str {
        match self {
            QuestionType::YesNo => "yes_no",
            QuestionType::Choice => "choice",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    pub kind: QuestionType,
    pub ask: String,
    /// `choice` only, as written; [`Question::asked_options`] places `none_of_these`.
    pub options: Vec<String>,
    pub band: Option<Band>,
}

impl Question {
    /// The options as asked: `none_of_these` appended when absent and moved last when present.
    pub fn asked_options(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .options
            .iter()
            .filter(|o| o.as_str() != NONE_OF_THESE)
            .cloned()
            .collect();
        out.push(NONE_OF_THESE.to_string());
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum On {
    ToolCall,
    Response,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Escalate {
    Ask,
    Review,
    Refuse,
}

impl Escalate {
    pub fn as_str(self) -> &'static str {
        match self {
            Escalate::Ask => "ask",
            Escalate::Review => "review",
            Escalate::Refuse => "refuse",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Rollout {
    #[default]
    Shadow,
    Enforce,
}

/// A parsed `when`, with `!=` and `IN` already rewritten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expr {
    Yes(String),
    Eq(String, String),
    Not(Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
}

/// A validated rule, defaults applied: `escalate` is `ask` and `rollout` is
/// `shadow` when unwritten; `tools` is empty for `on: response`.
#[derive(Debug, Clone, PartialEq)]
pub struct DecideRule {
    pub id: String,
    pub title: Option<String>,
    pub on: On,
    pub tools: Vec<String>,
    pub questions: BTreeMap<String, Question>,
    /// As written; [`DecideRule::expr`] is its parse.
    pub when: String,
    pub expr: Expr,
    pub band: Option<Band>,
    pub escalate: Escalate,
    pub rollout: Rollout,
    pub context: Vec<String>,
}

impl DecideRule {
    /// The band a question is judged on: its own, else the rule's, else the default.
    pub fn question_band(&self, name: &str) -> Band {
        self.questions
            .get(name)
            .and_then(|q| q.band)
            .or(self.band)
            .unwrap_or(DEFAULT_BAND)
    }
}

/// A `decide:` line, read or not. An unreadable line is kept, never dropped:
/// it refuses what it would have judged.
#[derive(Debug, Clone, PartialEq)]
pub enum DecideDecl {
    Rule(Box<DecideRule>),
    Unreadable { id: Option<String>, error: String },
}

// ─── Shape ────────────────────────────────────────────────────────────

fn unknown_field(obj: &Map<String, Value>, allowed: &[&str]) -> Option<String> {
    obj.keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .min()
        .cloned()
}

fn has_newline_or_tab(s: &str) -> bool {
    s.contains(['\t', '\r', '\n'])
}

fn band_shape(v: &Value, path: &str) -> Option<String> {
    let Some(obj) = v.as_object() else {
        return Some(format!("{path} must be an object"));
    };
    if let Some(extra) = unknown_field(obj, &BAND_FIELDS) {
        return Some(format!("{path}: unknown field {extra}"));
    }
    let Some(yes_at) = obj.get("yes_at") else {
        return Some(format!("{path}.yes_at is required"));
    };
    if !yes_at.as_f64().is_some_and(|y| y > 0.5 && y < 1.0) {
        return Some(format!("{path}.yes_at must be above 0.5 and below 1"));
    }
    let Some(no_below) = obj.get("no_below") else {
        return Some(format!("{path}.no_below is required"));
    };
    if !no_below.as_f64().is_some_and(|n| n > 0.0) {
        return Some(format!("{path}.no_below must be above 0"));
    }
    None
}

fn question_shape(name: &str, v: &Value) -> Option<String> {
    let path = format!("questions.{name}");
    let Some(obj) = v.as_object() else {
        return Some(format!("{path} must be an object"));
    };
    if let Some(extra) = unknown_field(obj, &QUESTION_FIELDS) {
        return Some(format!("{path}: unknown field {extra}"));
    }
    let Some(kind) = obj.get("type") else {
        return Some(format!("{path}.type is required"));
    };
    let kind = match kind.as_str() {
        Some("yes_no") => QuestionType::YesNo,
        Some("choice") => QuestionType::Choice,
        _ => return Some(format!("{path}.type must be yes_no or choice")),
    };
    let Some(ask) = obj.get("ask") else {
        return Some(format!("{path}.ask is required"));
    };
    let ask_ok = ask.as_str().is_some_and(|a| {
        let n = a.chars().count();
        (DECIDE_MIN_ASK_CHARS..=DECIDE_MAX_ASK_CHARS).contains(&n) && !has_newline_or_tab(a)
    });
    if !ask_ok {
        return Some(format!(
            "{path}.ask must be {DECIDE_MIN_ASK_CHARS} to {DECIDE_MAX_ASK_CHARS} characters with no tab or newline"
        ));
    }
    match (kind, obj.get("options")) {
        (QuestionType::YesNo, Some(_)) => {
            return Some(format!("{path}.options applies to choice questions only"));
        }
        (QuestionType::YesNo, None) => {}
        (QuestionType::Choice, None) => {
            return Some(format!("{path}.options is required for a choice question"));
        }
        (QuestionType::Choice, Some(options)) => {
            let Some(options) = options.as_array() else {
                return Some(format!("{path}.options must be a list"));
            };
            if !(2..=DECIDE_MAX_OPTIONS).contains(&options.len()) {
                return Some(format!(
                    "{path}.options lists 2 to {DECIDE_MAX_OPTIONS} options"
                ));
            }
            for (i, o) in options.iter().enumerate() {
                let Some(o) = o.as_str().filter(|o| name_re().is_match(o)) else {
                    return Some(format!("{path}.options[{i}] is not an option name"));
                };
                if options.iter().position(|x| x.as_str() == Some(o)) != Some(i) {
                    return Some(format!("{path}.options[{i}] repeats {o}"));
                }
            }
        }
    }
    obj.get("band")
        .and_then(|b| band_shape(b, &format!("{path}.band")))
}

fn rule_shape(v: &Value) -> Option<String> {
    let Some(obj) = v.as_object() else {
        return Some("a rule is a JSON object".to_string());
    };
    if let Some(extra) = unknown_field(obj, &RULE_FIELDS) {
        return Some(format!("unknown field {extra}"));
    }

    let Some(id) = obj.get("id") else {
        return Some("id is required".to_string());
    };
    if !id.as_str().is_some_and(|s| rule_id_re().is_match(s)) {
        return Some(
            "id must be a lower-case letter, then up to 47 of a-z, 0-9, _ or -".to_string(),
        );
    }

    if let Some(title) = obj.get("title") {
        let ok = title.as_str().is_some_and(|t| {
            (1..=MAX_TITLE).contains(&t.chars().count()) && !has_newline_or_tab(t)
        });
        if !ok {
            return Some(format!(
                "title must be 1 to {MAX_TITLE} characters with no tab or newline"
            ));
        }
    }

    let Some(on) = obj.get("on") else {
        return Some("on is required".to_string());
    };
    if !matches!(on.as_str(), Some("tool_call" | "response")) {
        return Some("on must be tool_call or response".to_string());
    }

    if let Some(tools) = obj.get("tools") {
        let Some(tools) = tools.as_array() else {
            return Some("tools must be a list".to_string());
        };
        if !(1..=MAX_TOOLS).contains(&tools.len()) {
            return Some(format!("tools names 1 to {MAX_TOOLS} tools"));
        }
        for (i, t) in tools.iter().enumerate() {
            if !t.as_str().is_some_and(|t| tool_token_re().is_match(t)) {
                return Some(format!("tools[{i}] is not a tool name"));
            }
        }
    }

    let Some(questions) = obj.get("questions") else {
        return Some("questions is required".to_string());
    };
    let Some(questions) = questions.as_object() else {
        return Some("questions must be an object".to_string());
    };
    let mut names: Vec<&String> = questions.keys().collect();
    names.sort();
    for name in names {
        if !name_re().is_match(name) {
            return Some(format!("questions: {name} is not a question name"));
        }
        if KEYWORDS.contains(&name.to_ascii_uppercase().as_str()) {
            return Some(format!("questions: {name} is a when keyword"));
        }
        if let Some(why) = question_shape(name, &questions[name.as_str()]) {
            return Some(why);
        }
    }

    let Some(when) = obj.get("when") else {
        return Some("when is required".to_string());
    };
    let Some(when) = when.as_str() else {
        return Some("when must be a string".to_string());
    };
    if !(1..=DECIDE_MAX_WHEN_CHARS).contains(&when.chars().count()) {
        return Some(format!(
            "when must be 1 to {DECIDE_MAX_WHEN_CHARS} characters"
        ));
    }

    if let Some(why) = obj.get("band").and_then(|b| band_shape(b, "band")) {
        return Some(why);
    }
    if obj
        .get("escalate")
        .is_some_and(|e| !matches!(e.as_str(), Some("ask" | "review" | "refuse")))
    {
        return Some("escalate must be ask, review or refuse".to_string());
    }
    if obj
        .get("rollout")
        .is_some_and(|r| !matches!(r.as_str(), Some("shadow" | "enforce")))
    {
        return Some("rollout must be shadow or enforce".to_string());
    }
    if let Some(context) = obj.get("context") {
        let Some(c) = context.as_array() else {
            return Some("context must be a list".to_string());
        };
        if c.len() > 1 || (c.len() == 1 && c[0].as_str() != Some("last_user_turn")) {
            return Some("context may list last_user_turn, once".to_string());
        }
    }
    None
}

// ─── `when` ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    Name(String),
    Kw(&'static str),
    Open,
    Close,
    Comma,
    EqEq,
    NotEq,
    End,
}

/// A `when` that does not parse: the message and its 1-based column, in code points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhenError {
    pub message: String,
    pub column: usize,
}

fn when_err<T>(message: impl Into<String>, column: usize) -> Result<T, WhenError> {
    Err(WhenError {
        message: message.into(),
        column,
    })
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn tokenize(src: &str) -> Result<Vec<(Tok, usize)>, WhenError> {
    let cs: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        let col = i + 1;
        match c {
            ' ' | '\t' | '\n' | '\r' => i += 1,
            '(' => {
                out.push((Tok::Open, col));
                i += 1;
            }
            ')' => {
                out.push((Tok::Close, col));
                i += 1;
            }
            ',' => {
                out.push((Tok::Comma, col));
                i += 1;
            }
            '=' | '!' if cs.get(i + 1) == Some(&'=') => {
                out.push((if c == '=' { Tok::EqEq } else { Tok::NotEq }, col));
                i += 2;
            }
            c if is_word_char(c) => {
                let mut j = i;
                while j < cs.len() && is_word_char(cs[j]) {
                    j += 1;
                }
                let w: String = cs[i..j].iter().collect();
                if let Some(kw) = KEYWORDS.iter().find(|k| **k == w) {
                    out.push((Tok::Kw(kw), col));
                } else if w.starts_with(|c: char| c.is_ascii_lowercase())
                    && w.chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                {
                    out.push((Tok::Name(w), col));
                } else {
                    return when_err(format!("unknown word {w}"), col);
                }
                i = j;
            }
            c => return when_err(format!("unexpected character {c}"), col),
        }
    }
    out.push((Tok::End, cs.len() + 1));
    Ok(out)
}

struct Parser {
    toks: Vec<(Tok, usize)>,
    k: usize,
}

impl Parser {
    fn peek(&self) -> &(Tok, usize) {
        &self.toks[self.k]
    }

    fn next(&mut self) -> (Tok, usize) {
        let t = self.toks[self.k].clone();
        // `End` is last, and nothing reads past it.
        if self.k + 1 < self.toks.len() {
            self.k += 1;
        }
        t
    }

    fn is_kw(&self, w: &str) -> bool {
        matches!(self.peek().0, Tok::Kw(k) if k == w)
    }

    fn option(&mut self) -> Result<String, WhenError> {
        match self.next() {
            (Tok::Name(o), _) => Ok(o),
            (_, col) => when_err("expected an option", col),
        }
    }

    fn or(&mut self) -> Result<Expr, WhenError> {
        let mut a = self.and()?;
        while self.is_kw("OR") {
            self.next();
            a = Expr::Or(Box::new(a), Box::new(self.and()?));
        }
        Ok(a)
    }

    fn and(&mut self) -> Result<Expr, WhenError> {
        let mut a = self.unary()?;
        while self.is_kw("AND") {
            self.next();
            a = Expr::And(Box::new(a), Box::new(self.unary()?));
        }
        Ok(a)
    }

    fn unary(&mut self) -> Result<Expr, WhenError> {
        if self.is_kw("NOT") {
            self.next();
            return Ok(Expr::Not(Box::new(self.unary()?)));
        }
        self.atom()
    }

    fn atom(&mut self) -> Result<Expr, WhenError> {
        let q = match self.next() {
            (Tok::Open, _) => {
                let e = self.or()?;
                return match self.next() {
                    (Tok::Close, _) => Ok(e),
                    (_, col) => when_err("expected )", col),
                };
            }
            (Tok::Name(q), _) => q,
            (_, col) => return when_err("expected a question name, NOT or (", col),
        };
        match self.peek().0 {
            Tok::EqEq => {
                self.next();
                Ok(Expr::Eq(q, self.option()?))
            }
            Tok::NotEq => {
                self.next();
                Ok(Expr::Not(Box::new(Expr::Eq(q, self.option()?))))
            }
            Tok::Kw("IN") => {
                self.next();
                let (open, col) = self.next();
                if open != Tok::Open {
                    return when_err("expected (", col);
                }
                let mut e = Expr::Eq(q.clone(), self.option()?);
                loop {
                    match self.next() {
                        (Tok::Close, _) => return Ok(e),
                        (Tok::Comma, _) => {
                            e = Expr::Or(
                                Box::new(e),
                                Box::new(Expr::Eq(q.clone(), self.option()?)),
                            );
                        }
                        (_, col) => return when_err("expected , or )", col),
                    }
                }
            }
            _ => Ok(Expr::Yes(q)),
        }
    }
}

/// Parse a `when` expression. Names are not checked here; [`validate`] does that.
pub fn parse_when(src: &str) -> Result<Expr, WhenError> {
    let mut p = Parser {
        toks: tokenize(src)?,
        k: 0,
    };
    let e = p.or()?;
    match p.peek() {
        (Tok::End, _) => Ok(e),
        (_, col) => when_err("expected AND, OR or the end", *col),
    }
}

/// The canonical form: fully parenthesised, `!=` and `IN` rewritten.
pub fn canonical_when(e: &Expr) -> String {
    match e {
        Expr::Yes(q) => q.clone(),
        Expr::Eq(q, o) => format!("({q} == {o})"),
        Expr::Not(a) => format!("(NOT {})", canonical_when(a)),
        Expr::And(a, b) => format!("({} AND {})", canonical_when(a), canonical_when(b)),
        Expr::Or(a, b) => format!("({} OR {})", canonical_when(a), canonical_when(b)),
    }
}

/// Every atom, left to right as written.
fn atoms_of<'a>(e: &'a Expr, out: &mut Vec<&'a Expr>) {
    match e {
        Expr::Yes(_) | Expr::Eq(..) => out.push(e),
        Expr::Not(a) => atoms_of(a, out),
        Expr::And(a, b) | Expr::Or(a, b) => {
            atoms_of(a, out);
            atoms_of(b, out);
        }
    }
}

// ─── Validation ───────────────────────────────────────────────────────

fn band_of(v: Option<&Value>) -> Option<Band> {
    let b = v?.as_object()?;
    Some(Band {
        yes_at: b.get("yes_at")?.as_f64()?,
        no_below: b.get("no_below")?.as_f64()?,
    })
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|xs| {
            xs.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Validate a value as a decide rule (the line's JSON, without `kind`): the
/// shape, then the eight checks in their fixed order. The first failure is
/// the reason.
pub fn validate(value: &Value) -> Result<DecideRule, String> {
    if let Some(shape) = rule_shape(value) {
        return Err(format!("decide: {shape}"));
    }
    // The shape guarantees every field read below.
    let obj = value.as_object().expect("checked by the shape");
    let on = if obj["on"].as_str() == Some("tool_call") {
        On::ToolCall
    } else {
        On::Response
    };
    let raw_questions = obj["questions"].as_object().expect("checked by the shape");
    let mut questions = BTreeMap::new();
    for (name, q) in raw_questions {
        let kind = if q["type"].as_str() == Some("choice") {
            QuestionType::Choice
        } else {
            QuestionType::YesNo
        };
        questions.insert(
            name.clone(),
            Question {
                kind,
                ask: q["ask"].as_str().unwrap_or_default().to_string(),
                options: strings(q.get("options")),
                band: band_of(q.get("band")),
            },
        );
    }
    let band = band_of(obj.get("band"));

    if (on == On::ToolCall) != obj.contains_key("tools") {
        return Err(
            "decide: tools is required for on: tool_call and not allowed for on: response"
                .to_string(),
        );
    }
    if on != On::ToolCall && obj.contains_key("context") {
        return Err("decide: context applies to on: tool_call only".to_string());
    }
    if !(1..=DECIDE_MAX_QUESTIONS).contains(&questions.len()) {
        return Err(format!(
            "decide: a rule asks 1 to {DECIDE_MAX_QUESTIONS} questions"
        ));
    }
    if band.is_some_and(|b| b.no_below >= b.yes_at) {
        return Err("decide: band: no_below must be below yes_at".to_string());
    }
    for (name, q) in &questions {
        if q.band.is_some_and(|b| b.no_below >= b.yes_at) {
            return Err(format!("decide: {name}: no_below must be below yes_at"));
        }
    }

    let when = obj["when"].as_str().unwrap_or_default().to_string();
    let expr = parse_when(&when)
        .map_err(|e| format!("decide: when: {} at column {}", e.message, e.column))?;
    let mut atoms = Vec::new();
    atoms_of(&expr, &mut atoms);
    let mut used = BTreeSet::new();
    for atom in atoms {
        let (Expr::Yes(name) | Expr::Eq(name, _)) = atom else {
            continue;
        };
        let Some(q) = questions.get(name) else {
            return Err(format!("decide: when: unknown question {name}"));
        };
        match atom {
            Expr::Yes(_) if q.kind != QuestionType::YesNo => {
                return Err(format!("decide: when: {name} is not a yes_no question"));
            }
            Expr::Eq(_, o) => {
                if q.kind != QuestionType::Choice {
                    return Err(format!("decide: when: {name} is not a choice question"));
                }
                if !q.asked_options().contains(o) {
                    return Err(format!("decide: when: unknown option {o} for {name}"));
                }
            }
            _ => {}
        }
        used.insert(name.clone());
    }
    if let Some(unused) = questions.keys().find(|n| !used.contains(*n)) {
        return Err(format!("decide: question {unused} is never used in when"));
    }
    if let Some((name, _)) = questions
        .iter()
        .find(|(_, q)| approval_re().is_match(&q.ask))
    {
        return Err(format!(
            "decide: {name} asks about approval; approval comes from the harness ask or the review queue, never from a question"
        ));
    }

    Ok(DecideRule {
        id: obj["id"].as_str().unwrap_or_default().to_string(),
        title: obj.get("title").and_then(Value::as_str).map(str::to_string),
        on,
        tools: strings(obj.get("tools")),
        questions,
        when,
        expr,
        band,
        escalate: match obj.get("escalate").and_then(Value::as_str) {
            Some("review") => Escalate::Review,
            Some("refuse") => Escalate::Refuse,
            _ => Escalate::Ask,
        },
        rollout: match obj.get("rollout").and_then(Value::as_str) {
            Some("enforce") => Rollout::Enforce,
            _ => Rollout::Shadow,
        },
        context: strings(obj.get("context")),
    })
}

/// Parse the value of one `decide:` line (the text after the key).
pub fn parse_line(raw: &str) -> DecideDecl {
    let text = raw.trim();
    if text.is_empty() {
        return DecideDecl::Unreadable {
            id: None,
            error: EMPTY_LINE.to_string(),
        };
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return DecideDecl::Unreadable {
            id: None,
            error: NOT_JSON.to_string(),
        };
    };
    match validate(&value) {
        Ok(rule) => DecideDecl::Rule(Box::new(rule)),
        Err(error) => DecideDecl::Unreadable {
            id: value
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            error,
        },
    }
}

/// Every `decide:` line of one SOP, in order. A line reusing an earlier
/// line's id is unreadable: ids are unique within a SOP.
pub fn parse_lines<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<DecideDecl> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .map(|raw| {
            let decl = parse_line(raw);
            let id = match &decl {
                DecideDecl::Rule(r) => Some(r.id.clone()),
                DecideDecl::Unreadable { id, .. } => id.clone(),
            };
            match id {
                Some(id) if !seen.insert(id.clone()) => DecideDecl::Unreadable {
                    error: format!("decide: id {id} is used twice in this SOP"),
                    id: Some(id),
                },
                _ => decl,
            }
        })
        .collect()
}

// ─── Identity ─────────────────────────────────────────────────────────

/// A number as JavaScript's `JSON.stringify` writes it: the shortest digits
/// that round-trip, in full from 1e-6 up to 1e21 and with an exponent outside.
fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    if x < 0.0 {
        return format!("-{}", js_number(-x));
    }
    // `{:e}` writes the shortest round-trip digits: `8.5e-1`, `1e-7`.
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i64 = exp.parse().unwrap_or(0);
    let all: String = mantissa.chars().filter(|c| *c != '.').collect();
    let ds = all.trim_end_matches('0');
    let ds = if ds.is_empty() { "0" } else { ds };
    let k = ds.len() as i64;
    let n = exp + 1; // x = 0.d1d2... × 10^n
    if k <= n && n <= 21 {
        format!("{ds}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &ds[..n as usize], &ds[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{ds}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let mantissa = if k > 1 {
            format!("{}.{}", &ds[..1], &ds[1..])
        } else {
            ds.to_string()
        };
        format!("{mantissa}e{}{}", if e >= 0 { '+' } else { '-' }, e.abs())
    }
}

/// JSON with keys sorted at every level and no whitespace, numbers as
/// JavaScript writes them.
fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        Value::String(k.clone()),
                        canonical_json(&m[k.as_str()])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(xs) => format!(
            "[{}]",
            xs.iter().map(canonical_json).collect::<Vec<_>>().join(",")
        ),
        Value::Number(n) => match (n.as_u64(), n.as_i64()) {
            (Some(u), _) => u.to_string(),
            (_, Some(i)) => i.to_string(),
            _ => js_number(n.as_f64().unwrap_or(0.0)),
        },
        other => other.to_string(),
    }
}

fn band_json(b: Band) -> Value {
    serde_json::json!({ "yes_at": b.yes_at, "no_below": b.no_below })
}

/// What the rule hash covers: `on`, `tools` (sorted), the questions with
/// their bands made explicit and `none_of_these` placed, `when` in canonical
/// form and `context` (sorted), as canonical JSON. `id`, `title`, `escalate`
/// and `rollout` are left out, so flipping shadow to enforce keeps a rule's
/// evidence and a changed word, option or band starts it over.
pub fn hash_input(rule: &DecideRule) -> String {
    let mut questions = Map::new();
    for (name, q) in &rule.questions {
        let mut out = Map::new();
        out.insert("type".into(), Value::from(q.kind.as_str()));
        out.insert("ask".into(), Value::from(q.ask.as_str()));
        if q.kind == QuestionType::Choice {
            out.insert("options".into(), Value::from(q.asked_options()));
        }
        out.insert("band".into(), band_json(rule.question_band(name)));
        questions.insert(name.clone(), Value::Object(out));
    }
    let sorted = |xs: &[String]| -> Vec<String> {
        xs.iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    };
    canonical_json(&serde_json::json!({
        "on": match rule.on { On::ToolCall => "tool_call", On::Response => "response" },
        "tools": sorted(&rule.tools),
        "questions": Value::Object(questions),
        "when": canonical_when(&rule.expr),
        "context": sorted(&rule.context),
    }))
}

/// `ruleHash`: lower-case hex SHA-256 of [`hash_input`].
pub fn rule_hash(rule: &DecideRule) -> String {
    hex::encode(Sha256::digest(hash_input(rule).as_bytes()))
}

// ─── Semantics ────────────────────────────────────────────────────────

/// Kleene's three values: true, false, unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tri {
    T,
    F,
    U,
}

pub fn k_and(a: Tri, b: Tri) -> Tri {
    match (a, b) {
        (Tri::F, _) | (_, Tri::F) => Tri::F,
        (Tri::T, Tri::T) => Tri::T,
        _ => Tri::U,
    }
}

pub fn k_or(a: Tri, b: Tri) -> Tri {
    match (a, b) {
        (Tri::T, _) | (_, Tri::T) => Tri::T,
        (Tri::F, Tri::F) => Tri::F,
        _ => Tri::U,
    }
}

pub fn k_not(a: Tri) -> Tri {
    match a {
        Tri::T => Tri::F,
        Tri::F => Tri::T,
        Tri::U => Tri::U,
    }
}

/// A probability through a band: T at or above `yes_at`, F below `no_below`, U between.
pub fn band_value(p: f64, band: Band) -> Tri {
    if p >= band.yes_at {
        Tri::T
    } else if p < band.no_below {
        Tri::F
    } else {
        Tri::U
    }
}

/// The orders a `choice` question is asked in, as index lists over its n
/// options: as written and reversed, plus, past three options, the list
/// rotated by half (the judge cascade's `attributeSops` order rule).
pub fn choice_orders(n: usize) -> Vec<Vec<usize>> {
    let ids: Vec<usize> = (0..n).collect();
    let mut orders = vec![ids.clone(), ids.iter().rev().copied().collect()];
    if n > 3 {
        let half = n / 2;
        orders.push(ids[half..].iter().chain(&ids[..half]).copied().collect());
    }
    orders
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChoiceAtom {
    /// The probability averaged over the orders.
    pub p: f64,
    /// The largest probability any order gave minus the smallest.
    pub spread: f64,
    pub value: Tri,
}

/// One option map per order: option name to probability.
pub type PerOrder = BTreeMap<String, f64>;

/// Each option's atom `q == o`: the mean over the orders through the band,
/// or U when the orders disagree by more than the band's width. An option an
/// order leaves out is 0; no orders at all is U.
pub fn choice_atoms(
    options: &[String],
    per_order: &[PerOrder],
    band: Band,
) -> BTreeMap<String, ChoiceAtom> {
    let mut out = BTreeMap::new();
    for o in options {
        let ps: Vec<f64> = per_order
            .iter()
            .map(|m| m.get(o).copied().unwrap_or(0.0))
            .collect();
        if ps.is_empty() {
            out.insert(
                o.clone(),
                ChoiceAtom {
                    p: 0.0,
                    spread: 0.0,
                    value: Tri::U,
                },
            );
            continue;
        }
        let mut sum = 0.0;
        for p in &ps {
            sum += p;
        }
        let p = sum / ps.len() as f64;
        let max = ps.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let min = ps.iter().copied().fold(f64::INFINITY, f64::min);
        let spread = max - min;
        let value = if spread > band.yes_at - band.no_below {
            Tri::U
        } else {
            band_value(p, band)
        };
        out.insert(o.clone(), ChoiceAtom { p, spread, value });
    }
    out
}

/// The atoms a `when` is evaluated over. A missing atom is U.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Atoms {
    pub yes: BTreeMap<String, Tri>,
    pub eq: BTreeMap<String, BTreeMap<String, Tri>>,
}

pub fn eval_when(e: &Expr, atoms: &Atoms) -> Tri {
    match e {
        Expr::Yes(q) => atoms.yes.get(q).copied().unwrap_or(Tri::U),
        Expr::Eq(q, o) => atoms
            .eq
            .get(q)
            .and_then(|m| m.get(o))
            .copied()
            .unwrap_or(Tri::U),
        Expr::Not(a) => k_not(eval_when(a, atoms)),
        Expr::And(a, b) => k_and(eval_when(a, atoms), eval_when(b, atoms)),
        Expr::Or(a, b) => k_or(eval_when(a, atoms), eval_when(b, atoms)),
    }
}

/// An engine's answer: `p` = p(yes) for `yes_no`; `per_order` for `choice`,
/// one option map per order of [`choice_orders`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Answer {
    pub p: Option<f64>,
    pub per_order: Option<Vec<PerOrder>>,
}

/// A fitted combiner: it replaces `when`, and is judged on its own band.
#[derive(Debug, Clone, PartialEq)]
pub struct Combiner {
    pub bias: f64,
    pub weights: BTreeMap<String, f64>,
    pub band: Band,
}

fn logit(p: f64) -> f64 {
    let q = p.clamp(1e-12, 1.0 - 1e-12);
    (q / (1.0 - q)).ln()
}

/// s = σ(bias + Σ w_q · logit(p_q)), summed in sorted question order. A
/// `choice` question enters through the averaged probability of its top
/// option. `None` when a weighted question has no answer.
pub fn combiner_score(
    rule: &DecideRule,
    answers: &BTreeMap<String, Answer>,
    combiner: &Combiner,
) -> Option<f64> {
    let mut x = combiner.bias;
    for (name, w) in &combiner.weights {
        let q = rule.questions.get(name)?;
        let a = answers.get(name)?;
        let p = match q.kind {
            QuestionType::YesNo => a.p?,
            QuestionType::Choice => {
                let per_order = a.per_order.as_deref().filter(|p| !p.is_empty())?;
                choice_atoms(&q.asked_options(), per_order, rule.question_band(name))
                    .values()
                    .map(|c| c.p)
                    .fold(f64::NEG_INFINITY, f64::max)
            }
        };
        x += w * logit(p);
    }
    Some(1.0 / (1.0 + (-x).exp()))
}

/// The atoms of a rule's answers, each question through its own band.
pub fn atoms(rule: &DecideRule, answers: &BTreeMap<String, Answer>) -> Atoms {
    let mut out = Atoms::default();
    for (name, q) in &rule.questions {
        let a = answers.get(name);
        let band = rule.question_band(name);
        match q.kind {
            QuestionType::YesNo => {
                let v = a.and_then(|a| a.p).map_or(Tri::U, |p| band_value(p, band));
                out.yes.insert(name.clone(), v);
            }
            QuestionType::Choice => {
                let per_order = a.and_then(|a| a.per_order.as_deref()).unwrap_or(&[]);
                let c = choice_atoms(&q.asked_options(), per_order, band);
                out.eq.insert(
                    name.clone(),
                    c.into_iter().map(|(o, a)| (o, a.value)).collect(),
                );
            }
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Allow,
    Refuse,
    Escalate,
    /// The engine could not answer: an error, a timeout, a failed canary.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuleOutcome {
    /// `when`, or the combiner's band value when one is pinned.
    pub value: Tri,
    pub outcome: Outcome,
    pub code: Option<&'static str>,
    /// How an escalation reaches a person, when `escalate` is `ask` or `review`.
    pub via: Option<Escalate>,
    pub score: Option<f64>,
    pub atoms: Atoms,
}

/// One rule's outcome: T refuses (`DECIDE_REFUSED`), F allows, U escalates
/// through `escalate`; `escalate: refuse` refuses with `DECIDE_ESCALATED`.
pub fn rule_outcome(
    rule: &DecideRule,
    answers: &BTreeMap<String, Answer>,
    combiner: Option<&Combiner>,
) -> RuleOutcome {
    let atoms = atoms(rule, answers);
    let (value, score) = match combiner {
        Some(c) => {
            let score = combiner_score(rule, answers, c);
            (score.map_or(Tri::U, |s| band_value(s, c.band)), score)
        }
        None => (eval_when(&rule.expr, &atoms), None),
    };
    let (outcome, code, via) = match (value, rule.escalate) {
        (Tri::T, _) => (Outcome::Refuse, Some(DECIDE_REFUSED), None),
        (Tri::F, _) => (Outcome::Allow, None, None),
        (Tri::U, Escalate::Refuse) => (Outcome::Refuse, Some(DECIDE_ESCALATED), None),
        (Tri::U, e) => (Outcome::Escalate, Some(DECIDE_ESCALATED), Some(e)),
    };
    RuleOutcome {
        value,
        outcome,
        code,
        via,
        score,
        atoms,
    }
}

// ─── One call, several rules ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub rule_ref: String,
    pub on: On,
    pub tools: Vec<String>,
    /// The effective rollout: `Enforce` only when every condition for it holds.
    pub effective: Rollout,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Selection<'a> {
    /// At most [`DECIDE_MAX_RULES_PER_CALL`], enforce first, then in snapshot order.
    pub evaluate: Vec<&'a Candidate>,
    /// Shadow rules past the limit: not evaluated, logged.
    pub skipped: Vec<&'a Candidate>,
    /// Set when an enforce rule is past the limit: the call refuses
    /// `GOVERNANCE_UNAVAILABLE` before any engine call.
    pub unavailable: Option<String>,
}

/// The rules a tool call asks. `candidates` are in snapshot order (SOP order,
/// then line order); a rule matches when it is `on: tool_call` and names the
/// tool exactly.
pub fn select_rules<'a>(candidates: &'a [Candidate], tool: &str) -> Selection<'a> {
    let matched: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| c.on == On::ToolCall && c.tools.iter().any(|t| t == tool))
        .collect();
    let (enforce, shadow): (Vec<&Candidate>, Vec<&Candidate>) = matched
        .into_iter()
        .partition(|c| c.effective == Rollout::Enforce);
    let ordered: Vec<&Candidate> = enforce.into_iter().chain(shadow).collect();
    let cut = ordered.len().min(DECIDE_MAX_RULES_PER_CALL);
    let beyond = &ordered[cut..];
    Selection {
        evaluate: ordered[..cut].to_vec(),
        skipped: beyond
            .iter()
            .copied()
            .filter(|c| c.effective != Rollout::Enforce)
            .collect(),
        unavailable: beyond
            .iter()
            .any(|c| c.effective == Rollout::Enforce)
            .then(|| format!("more than {DECIDE_MAX_RULES_PER_CALL} decide rules name {tool}")),
    }
}

/// One evaluated rule's result.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleResult {
    pub rule_ref: String,
    pub effective: Rollout,
    pub outcome: Outcome,
    pub code: Option<String>,
    pub via: Option<Escalate>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CallOutcome {
    /// `Allow`, `Refuse` or `Escalate`.
    pub outcome: Outcome,
    pub code: Option<String>,
    pub rule_ref: Option<String>,
    pub via: Option<Escalate>,
    pub reason: Option<String>,
}

/// The call's outcome from its rules' results, in evaluation order. Only
/// enforce rules count: the first that refuses (or whose engine was
/// unavailable) refuses the call; otherwise the first that escalates
/// escalates it; otherwise the call is allowed.
pub fn call_outcome(selection: &Selection<'_>, results: &[RuleResult]) -> CallOutcome {
    if let Some(reason) = &selection.unavailable {
        return CallOutcome {
            outcome: Outcome::Refuse,
            code: Some(GOVERNANCE_UNAVAILABLE.to_string()),
            rule_ref: None,
            via: None,
            reason: Some(reason.clone()),
        };
    }
    let enforcing = || results.iter().filter(|r| r.effective == Rollout::Enforce);
    if let Some(r) =
        enforcing().find(|r| matches!(r.outcome, Outcome::Refuse | Outcome::Unavailable))
    {
        let code = if r.outcome == Outcome::Unavailable {
            GOVERNANCE_UNAVAILABLE.to_string()
        } else {
            r.code.clone().unwrap_or_else(|| DECIDE_REFUSED.to_string())
        };
        return CallOutcome {
            outcome: Outcome::Refuse,
            code: Some(code),
            rule_ref: Some(r.rule_ref.clone()),
            via: None,
            reason: None,
        };
    }
    if let Some(r) = enforcing().find(|r| r.outcome == Outcome::Escalate) {
        return CallOutcome {
            outcome: Outcome::Escalate,
            code: Some(DECIDE_ESCALATED.to_string()),
            rule_ref: Some(r.rule_ref.clone()),
            via: Some(r.via.unwrap_or(Escalate::Ask)),
            reason: None,
        };
    }
    CallOutcome {
        outcome: Outcome::Allow,
        code: None,
        rule_ref: None,
        via: None,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_matches_json_stringify() {
        for (x, want) in [
            (0.85, "0.85"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (0.30000000000000004, "0.30000000000000004"),
            (0.9999999, "0.9999999"),
            (1.5, "1.5"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
        ] {
            assert_eq!(js_number(x), want, "{x}");
        }
    }

    #[test]
    fn the_approval_pattern_is_ascii() {
        assert!(approval_re().is_match("Did the user APPROVE it?"));
        assert!(!approval_re().is_match("Is the approach safe?"));
        // A non-ASCII letter is not a word character, so the boundary holds.
        assert!(approval_re().is_match("éapproval"));
    }
}
