//! Evaluating one tool call's decide rules against the engine, inside the
//! engine protections.
//!
//! A transliteration of `packages/shared-types/src/decideEvaluate.ts`; read
//! its module comment for the design. In short: nothing is asked unless the
//! deterministic tiers allowed the call; a rule enforces only when its author
//! wrote `enforce`, its stamp is `enforce` and one of its pins (earned under
//! its own rule hash) is for the model digest the engine reports; and a
//! known-answer canary, cached per engine URL and digest in
//! `~/.intutic/decide/canary.json` for ten minutes, runs beside the rule's
//! questions when the cache is missing, failed or stale. A failed canary
//! discards every answer: the engine is unavailable, which refuses an
//! enforcing rule with `GOVERNANCE_UNAVAILABLE`.
//!
//! All three ports run the `rollout` and `evaluate` cases of
//! `packages/shared-types/fixtures/decide-engine-vectors.json`.

use super::engine::{
    build_tool_call_state, run_canary, Answer as EngineAnswer, DecideAsk, DecideEngineError,
    ErrorOutcome, ModelIdentity, QuestionCall, QuestionType as CallType, ToolCallStateInput,
};
use super::{
    call_outcome, rule_hash, rule_outcome, select_rules, Answer, Band, CallOutcome, Candidate,
    Combiner, DecideRule, Escalate, On, Outcome, QuestionType, Rollout, RuleResult, DEFAULT_BAND,
};
use futures_util::future::join_all;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tokio::time::Instant;

/// A canary result older than this is run again.
pub const DECIDE_CANARY_TTL_MS: f64 = 600_000.0;
/// The most engine and digest pairs the cache file keeps, newest last.
const CANARY_ENTRIES_MAX: usize = 16;

// ─── Effective rollout (protections 4 and 5) ──────────────────────────

/// A calibration a rule may enforce under, as a record's `pins[]` carries it.
#[derive(Debug, Clone, PartialEq)]
pub struct Pin {
    pub model_digest: String,
    pub eval_run_id: String,
    pub band: Option<Band>,
    /// A fitted combiner `(bias, weights)`; it replaces `when`.
    pub combiner: Option<(f64, BTreeMap<String, f64>)>,
}

impl Pin {
    /// A pin from its JSON, or `None` when it lacks a digest or an eval run.
    pub fn from_value(v: &Value) -> Option<Pin> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty());
        let band = v.get("band").and_then(|b| {
            Some(Band {
                yes_at: b.get("yes_at")?.as_f64()?,
                no_below: b.get("no_below")?.as_f64()?,
            })
        });
        let combiner = v.get("combiner").and_then(|c| {
            let weights = c
                .get("weights")?
                .as_object()?
                .iter()
                .map(|(k, w)| Some((k.clone(), w.as_f64()?)))
                .collect::<Option<BTreeMap<_, _>>>()?;
            Some((c.get("bias")?.as_f64()?, weights))
        });
        Some(Pin {
            model_digest: s("modelDigest")?.to_string(),
            eval_run_id: s("evalRunId")?.to_string(),
            band,
            combiner,
        })
    }
}

/// A rule as a snapshot record carries it.
#[derive(Debug, Clone)]
pub struct RuleEntry {
    pub rule_ref: String,
    /// The hash the pins were earned under.
    pub rule_hash: String,
    /// The stamped rollout.
    pub rollout: Rollout,
    /// `rule`, `local-disable`, `server-shadow`, `silent-log` or `no-pins`.
    pub stamped_by: String,
    pub rule: DecideRule,
    pub sop_title: String,
    pub rule_text: String,
    pub pins: Vec<Pin>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveRollout {
    pub effective: Rollout,
    /// Why the rule runs as shadow: `rollout`, a writer's stamp, `no-pins` or `not_evaluated`.
    pub why: Option<String>,
    /// The pin the rule enforces under.
    pub pin: Option<Pin>,
}

/// Whether a rule enforces on this call. Only when its author wrote
/// `enforce`, it is stamped `enforce`, and one of its pins is for
/// `model_digest`; a `None` digest (the engine could not say) leaves a
/// stamped rule enforcing, so the engine's unavailability refuses.
pub fn effective_rollout(
    author: Rollout,
    stamped: Rollout,
    stamped_by: &str,
    pins: &[Pin],
    model_digest: Option<&str>,
) -> EffectiveRollout {
    let shadow = |why: &str| EffectiveRollout {
        effective: Rollout::Shadow,
        why: Some(why.to_string()),
        pin: None,
    };
    if author != Rollout::Enforce {
        return shadow("rollout");
    }
    if stamped != Rollout::Enforce {
        return shadow(if stamped_by == "rule" {
            "rollout"
        } else {
            stamped_by
        });
    }
    if pins.is_empty() {
        return shadow("no-pins");
    }
    let Some(digest) = model_digest else {
        return EffectiveRollout {
            effective: Rollout::Enforce,
            why: None,
            pin: None,
        };
    };
    match pins.iter().find(|p| p.model_digest == digest) {
        Some(pin) => EffectiveRollout {
            effective: Rollout::Enforce,
            why: None,
            pin: Some(pin.clone()),
        },
        None => shadow("not_evaluated"),
    }
}

// ─── The canary cache (protection 6) ──────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct CanaryEntry {
    pub url: String,
    pub model_digest: String,
    pub ok: bool,
    /// When it ran, in epoch milliseconds.
    pub at_ms: f64,
    pub p_violation: f64,
    pub p_clean: f64,
    pub choice_top: String,
}

impl CanaryEntry {
    fn from_value(v: &Value) -> Option<CanaryEntry> {
        let num = |k: &str| v.get(k).and_then(Value::as_f64).filter(|x| x.is_finite());
        Some(CanaryEntry {
            url: v.get("url")?.as_str()?.to_string(),
            model_digest: v.get("modelDigest")?.as_str()?.to_string(),
            ok: v.get("ok")?.as_bool()?,
            at_ms: num("atMs")?,
            p_violation: num("pViolation")?,
            p_clean: num("pClean")?,
            choice_top: v.get("choiceTop")?.as_str()?.to_string(),
        })
    }

    fn to_value(&self) -> Value {
        json!({
            "url": self.url, "modelDigest": self.model_digest, "ok": self.ok, "atMs": self.at_ms,
            "pViolation": self.p_violation, "pClean": self.p_clean, "choiceTop": self.choice_top,
        })
    }
}

/// A passed result younger than [`DECIDE_CANARY_TTL_MS`]. A failed one is never fresh.
pub fn canary_fresh(entry: Option<&CanaryEntry>, now_ms: f64) -> bool {
    entry.is_some_and(|e| e.ok && e.at_ms <= now_ms && now_ms - e.at_ms < DECIDE_CANARY_TTL_MS)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// The canary cache as one JSON file, `{"v":1,"entries":[…]}`, mode 0600 in
/// a 0700 directory, replaced whole by a rename so a reader never sees half
/// of it. A file that does not read is an empty cache, and the canary runs.
#[derive(Debug, Clone)]
pub struct CanaryFileStore {
    pub path: PathBuf,
}

impl CanaryFileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// `~/.intutic/decide/canary.json`.
    pub fn default_path() -> PathBuf {
        crate::paths::intutic_dir()
            .join("decide")
            .join("canary.json")
    }

    fn all(&self) -> Vec<CanaryEntry> {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        let Ok(doc) = serde_json::from_str::<Value>(&text) else {
            return Vec::new();
        };
        if doc.get("v").and_then(Value::as_u64) != Some(1) {
            return Vec::new();
        }
        doc.get("entries")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(CanaryEntry::from_value).collect())
            .unwrap_or_default()
    }

    pub fn read(&self, url: &str, model_digest: &str) -> Option<CanaryEntry> {
        self.all()
            .into_iter()
            .find(|e| e.url == url && e.model_digest == model_digest)
    }

    pub fn write(&self, entry: &CanaryEntry) -> std::io::Result<()> {
        let mut entries: Vec<CanaryEntry> = self
            .all()
            .into_iter()
            .filter(|e| e.url != entry.url || e.model_digest != entry.model_digest)
            .collect();
        entries.push(entry.clone());
        let keep = entries.len().saturating_sub(CANARY_ENTRIES_MAX);
        let entries: Vec<Value> = entries[keep..].iter().map(CanaryEntry::to_value).collect();
        let dir = self.path.parent().unwrap_or(Path::new("."));
        create_private_dir(dir)?;
        let tmp = dir.join(format!(
            ".canary.{}.{}.tmp",
            std::process::id(),
            now_ms() as u64
        ));
        let text = format!("{}\n", json!({ "v": 1, "entries": entries }));
        write_private(&tmp, text.as_bytes())?;
        std::fs::rename(&tmp, &self.path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

// ─── One call ─────────────────────────────────────────────────────────

/// The deterministic tiers' verdict on the call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deterministic {
    Allow,
    Refuse,
}

pub struct EvaluateInput<'a> {
    /// Anything but `Allow` returns at once, asking nothing.
    pub deterministic: Deterministic,
    pub tool: &'a str,
    pub tool_input: &'a Value,
    pub cwd: &'a str,
    /// Only rules with `context: [last_user_turn]` see it.
    pub last_user_turn: Option<&'a str>,
    /// In snapshot order.
    pub rules: &'a [RuleEntry],
    pub deadline: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanaryState {
    /// A fresh passed result from the cache.
    Cached,
    /// Run on this call, and passed.
    Ok,
    /// Run on this call, and failed or could not be answered.
    Failed,
}

impl CanaryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cached => "cached",
            Self::Ok => "ok",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuleReport {
    pub rule_ref: String,
    pub rule_hash: String,
    pub effective: Rollout,
    pub why: Option<String>,
    /// `Allow`, `Refuse`, `Escalate` or `Unavailable`.
    pub outcome: Outcome,
    pub code: Option<&'static str>,
    pub via: Option<Escalate>,
    /// The engine error that made the rule unavailable or unknown.
    pub error: Option<&'static str>,
    pub model_digest: Option<String>,
    /// `None` when nothing came back, or when a failed canary discarded it.
    pub answers: Option<BTreeMap<String, EngineAnswer>>,
}

#[derive(Debug, Clone)]
pub struct Evaluation {
    pub call: CallOutcome,
    /// The evaluated rules, in evaluation order.
    pub rules: Vec<RuleReport>,
    /// Shadow rules past the per-call limit, not asked.
    pub skipped: Vec<String>,
    /// The engine's identity before the questions.
    pub engine: Option<ModelIdentity>,
    /// `None` when no canary was needed.
    pub canary: Option<CanaryState>,
}

struct Asked {
    answers: Option<BTreeMap<String, EngineAnswer>>,
    error: Option<DecideEngineError>,
    model_digest: Option<String>,
}

fn allow() -> CallOutcome {
    CallOutcome {
        outcome: Outcome::Allow,
        code: None,
        rule_ref: None,
        via: None,
        reason: None,
    }
}

/// Asks the engine one rule's questions about the call.
async fn ask_rule<E: DecideAsk + ?Sized>(
    client: Option<&E>,
    error: Option<DecideEngineError>,
    e: &RuleEntry,
    input: &EvaluateInput<'_>,
) -> Asked {
    let Some(c) = client.filter(|_| error.is_none()) else {
        return Asked {
            answers: None,
            error: Some(error.unwrap_or(DecideEngineError::NotConfigured)),
            model_digest: None,
        };
    };
    let questions: Vec<QuestionCall> = e
        .rule
        .questions
        .iter()
        .map(|(name, q)| QuestionCall {
            name: name.clone(),
            qtype: match q.kind {
                QuestionType::YesNo => CallType::YesNo,
                QuestionType::Choice => CallType::Choice,
            },
            ask: q.ask.clone(),
            options: match q.kind {
                QuestionType::YesNo => Vec::new(),
                QuestionType::Choice => q.asked_options(),
            },
        })
        .collect();
    let with_turn = e.rule.context.iter().any(|c| c == "last_user_turn");
    let state = build_tool_call_state(&ToolCallStateInput {
        rule_id: &e.rule.id,
        sop_title: &e.sop_title,
        rule_text: &e.rule_text,
        tool: input.tool,
        cwd: input.cwd,
        tool_input: input.tool_input,
        last_user_turn: if with_turn {
            input.last_user_turn
        } else {
            None
        },
    });
    let result = match state {
        Ok(state) => c.ask(&state, &questions, input.deadline).await,
        Err(err) => Err(err),
    };
    match result {
        Ok(r) => Asked {
            answers: Some(r.answers),
            error: None,
            model_digest: Some(r.identity.model_digest),
        },
        Err(err) => Asked {
            answers: None,
            error: Some(err),
            model_digest: None,
        },
    }
}

/// Evaluates the decide rules a tool call matches. `engine` is the engine,
/// or the error creating it returned. Never fails: an engine error is an
/// unavailable rule (or, for `too_large`, an unknown one).
pub async fn evaluate_call<E: DecideAsk + ?Sized>(
    input: &EvaluateInput<'_>,
    engine: Result<&E, DecideEngineError>,
    engine_url: &str,
    canary: &CanaryFileStore,
) -> Evaluation {
    if input.deterministic != Deterministic::Allow {
        return Evaluation {
            call: CallOutcome {
                outcome: Outcome::Refuse,
                code: None,
                rule_ref: None,
                via: None,
                reason: Some("a deterministic rule refused the call".into()),
            },
            rules: Vec::new(),
            skipped: Vec::new(),
            engine: None,
            canary: None,
        };
    }
    let matched: Vec<&RuleEntry> = input
        .rules
        .iter()
        .filter(|r| r.rule.on == On::ToolCall && r.rule.tools.iter().any(|t| t == input.tool))
        .collect();
    if matched.is_empty() {
        return Evaluation {
            call: allow(),
            rules: Vec::new(),
            skipped: Vec::new(),
            engine: None,
            canary: None,
        };
    }

    let (client, mut engine_error) = match engine {
        Ok(e) => (Some(e), None),
        Err(err) => (None, Some(err)),
    };
    let mut identity: Option<ModelIdentity> = None;
    if let Some(c) = client {
        match c.describe(input.deadline).await {
            Ok(id) => identity = Some(id),
            Err(err) => engine_error = Some(err),
        }
    }
    let described = identity.as_ref().map(|i| i.model_digest.clone());

    // Pins are earned by one rule hash: a rule whose hash is not the one its
    // pins were stored under has none.
    let entries: Vec<RuleEntry> = matched
        .into_iter()
        .map(|r| {
            let mut e = r.clone();
            if rule_hash(&e.rule) != e.rule_hash {
                e.pins.clear();
            }
            e
        })
        .collect();
    let candidates: Vec<Candidate> = entries
        .iter()
        .map(|e| Candidate {
            rule_ref: e.rule_ref.clone(),
            on: e.rule.on,
            tools: e.rule.tools.clone(),
            effective: effective_rollout(
                e.rule.rollout,
                e.rollout,
                &e.stamped_by,
                &e.pins,
                described.as_deref(),
            )
            .effective,
        })
        .collect();
    let selection = select_rules(&candidates, input.tool);
    let skipped: Vec<String> = selection
        .skipped
        .iter()
        .map(|c| c.rule_ref.clone())
        .collect();
    if selection.unavailable.is_some() {
        return Evaluation {
            call: call_outcome(&selection, &[]),
            rules: Vec::new(),
            skipped,
            engine: identity,
            canary: None,
        };
    }
    let evaluated: Vec<&RuleEntry> = selection
        .evaluate
        .iter()
        .map(|c| {
            let i = candidates
                .iter()
                .position(|x| std::ptr::eq(x, *c))
                .expect("a selected candidate is one of the candidates");
            &entries[i]
        })
        .collect();

    let mut canary_state = None;
    let run = match (client, &engine_error, described.as_deref()) {
        (Some(c), None, Some(digest)) => {
            if canary_fresh(canary.read(engine_url, digest).as_ref(), now_ms()) {
                canary_state = Some(CanaryState::Cached);
                None
            } else {
                Some((c, digest.to_string()))
            }
        }
        _ => None,
    };
    let canary_run = async {
        let Some((c, digest)) = &run else {
            return true;
        };
        match run_canary(*c, input.deadline).await {
            Ok(r) => {
                // An unwritable cache only means the canary runs again next call.
                let _ = canary.write(&CanaryEntry {
                    url: engine_url.to_string(),
                    model_digest: digest.clone(),
                    ok: r.ok,
                    at_ms: now_ms(),
                    p_violation: r.p_violation,
                    p_clean: r.p_clean,
                    choice_top: r.choice_top,
                });
                r.ok
            }
            Err(_) => false,
        }
    };
    let (canary_ok, asked) = tokio::join!(
        canary_run,
        join_all(
            evaluated
                .iter()
                .map(|e| ask_rule(client, engine_error.clone(), e, input))
        )
    );
    if run.is_some() {
        canary_state = Some(if canary_ok {
            CanaryState::Ok
        } else {
            CanaryState::Failed
        });
    }

    let reports: Vec<RuleReport> = evaluated
        .iter()
        .zip(asked)
        .map(|(e, a)| {
            let digest = a.model_digest.clone().or_else(|| described.clone());
            let eff = effective_rollout(
                e.rule.rollout,
                e.rollout,
                &e.stamped_by,
                &e.pins,
                digest.as_deref(),
            );
            let report = |outcome, code, via, error, answers| RuleReport {
                rule_ref: e.rule_ref.clone(),
                rule_hash: e.rule_hash.clone(),
                effective: eff.effective,
                why: eff.why.clone(),
                outcome,
                code,
                via,
                error,
                model_digest: digest.clone(),
                answers,
            };
            if !canary_ok {
                return report(
                    Outcome::Unavailable,
                    None,
                    None,
                    Some("canary_failed"),
                    None,
                );
            }
            let error = a.error.as_ref().map(DecideEngineError::code);
            if a.error
                .as_ref()
                .is_some_and(|err| err.outcome() == ErrorOutcome::Unavailable)
            {
                return report(Outcome::Unavailable, None, None, error, None);
            }
            let inputs: BTreeMap<String, Answer> = a
                .answers
                .iter()
                .flatten()
                .map(|(name, x)| {
                    (
                        name.clone(),
                        Answer {
                            p: x.p,
                            per_order: (x.qtype == CallType::Choice).then(|| x.per_order.clone()),
                        },
                    )
                })
                .collect();
            // A pin's fitted combiner replaces `when`. Its per-question
            // temperatures are not applied here.
            let combiner = eff.pin.as_ref().and_then(|p| {
                p.combiner.as_ref().map(|(bias, weights)| Combiner {
                    bias: *bias,
                    weights: weights.clone(),
                    band: p.band.or(e.rule.band).unwrap_or(DEFAULT_BAND),
                })
            });
            let o = rule_outcome(&e.rule, &inputs, combiner.as_ref());
            report(o.outcome, o.code, o.via, error, a.answers)
        })
        .collect();
    let results: Vec<RuleResult> = reports
        .iter()
        .map(|r| RuleResult {
            rule_ref: r.rule_ref.clone(),
            effective: r.effective,
            outcome: r.outcome,
            code: r.code.map(str::to_string),
            via: r.via,
        })
        .collect();
    Evaluation {
        call: call_outcome(&selection, &results),
        rules: reports,
        skipped,
        engine: identity,
        canary: canary_state,
    }
}
