//! Spend budgets and rate limits on a virtual key, checked before a request
//! leaves the proxy.
//!
//! # Spend budgets
//!
//! The control plane puts every **hard** spend budget covering a key's calls
//! on the key's cached auth entry (`hardBudgets`, and the same field on
//! `/api/v1/auth/key-context`): the workspace's daily and monthly caps, the
//! key's own day and month budgets, and its owner's member budgets. Soft
//! budgets are not sent — they only alert, and alerting is the control
//! plane's job.
//!
//! The spend each budget is checked against is a Valkey counter the control
//! plane increments as it records each completed call
//! (`finopsService.incrementSpend`, `spendBudgetService.accrueKeySpend`).
//! This module only names those counters and does the arithmetic; the proxy
//! never writes them. So a request's own cost lands after it finishes, and a
//! request is refused when its estimated cost, with the same 20% margin the
//! workspace cap has always used, does not fit in what is left. Several
//! requests in flight at once can each fit and together overrun a budget by
//! up to their own cost — the next request after they land is refused.
//!
//! Windows are UTC calendar days and months. Key and member counters carry
//! the window in their name (`2026-10-09`, `2026-10`), so a new window starts
//! from zero; the workspace counters expire at the end of theirs.
//!
//! # Rate limits
//!
//! Requests per minute and tokens per minute, per key, counted by the proxy
//! itself in Valkey (`LocalStore::admit_rate`), so every proxy replica on one
//! Valkey shares one count. Windows are UTC calendar minutes.
//!
//! - **RPM** is exact: the check and the count are one atomic script, so two
//!   replicas racing for the last request cannot both get it.
//! - **TPM** counts the tokens each completed call actually used (input plus
//!   output, from the provider's usage), recorded when the call finishes. A
//!   request's tokens are not known before it is sent, so the check refuses a
//!   request once the minute's recorded tokens have reached the limit: the
//!   request that crosses the limit is allowed, and the ones after it are not.

use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use serde::Deserialize;

/// The same headroom `metering::check_budget` gives the workspace cap: output
/// tokens and tool-call overhead are not known when the request is checked.
pub const SAFETY_MARGIN: f64 = 1.20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetScope {
    Workspace,
    Key,
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetPeriod {
    Day,
    Month,
}

/// One hard budget, as the control plane sends it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardBudget {
    pub scope: BudgetScope,
    pub period: BudgetPeriod,
    pub limit_usd: f64,
}

/// A key's per-minute limits. `None` is no limit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct RateLimit {
    pub rpm: Option<u64>,
    pub tpm: Option<u64>,
}

impl RateLimit {
    pub fn is_empty(&self) -> bool {
        self.rpm.is_none() && self.tpm.is_none()
    }
}

/// Reads `hardBudgets` from an auth entry or a key-context answer.
///
/// `None` when the field is absent or null — an entry written by a control
/// plane older than the field, for which the caller keeps the workspace daily
/// cap it enforced before. An entry that does not parse is dropped with a
/// warning; the control plane writes these, so one that does not parse is a
/// bug to see, not a request to refuse.
pub fn parse_hard_budgets(value: Option<&serde_json::Value>) -> Option<Vec<HardBudget>> {
    let list = value?.as_array()?;
    Some(
        list.iter()
            .filter_map(|v| match serde_json::from_value::<HardBudget>(v.clone()) {
                Ok(b) if b.limit_usd.is_finite() && b.limit_usd > 0.0 => Some(b),
                _ => {
                    tracing::warn!(entry = %v, "Ignoring a hard budget that does not parse");
                    None
                }
            })
            .collect(),
    )
}

/// Reads `rateLimit` from an auth entry or a key-context answer; `None` when neither limit is set.
pub fn parse_rate_limit(value: Option<&serde_json::Value>) -> Option<RateLimit> {
    let v = value?;
    let limit = |name: &str| v.get(name).and_then(|n| n.as_u64()).filter(|n| *n > 0);
    let rl = RateLimit {
        rpm: limit("rpm"),
        tpm: limit("tpm"),
    };
    (!rl.is_empty()).then_some(rl)
}

/// A UTC window: its id (part of the key and member counter names) and when it resets.
pub fn window(period: BudgetPeriod, now: DateTime<Utc>) -> (String, DateTime<Utc>) {
    match period {
        BudgetPeriod::Day => {
            let start = Utc
                .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
                .single()
                .unwrap_or(now);
            (
                start.format("%Y-%m-%d").to_string(),
                start + Duration::days(1),
            )
        }
        BudgetPeriod::Month => {
            let (y, m) = if now.month() == 12 {
                (now.year() + 1, 1)
            } else {
                (now.year(), now.month() + 1)
            };
            let reset = Utc
                .with_ymd_and_hms(y, m, 1, 0, 0, 0)
                .single()
                .unwrap_or(now);
            (now.format("%Y-%m").to_string(), reset)
        }
    }
}

/// The Valkey counter holding a budget's spend in the current window.
///
/// The workspace counters are the control plane's `workspaceBudgetDailyKey` /
/// `workspaceBudgetMonthlyKey`; the key and member ones are its `keySpendKey`
/// / `memberSpendKey`. Pinned against the TypeScript builders by
/// `services/control-plane/__tests__/unit/valkeyKeyParity.test.ts`.
pub fn spend_counter_key(
    budget: &HardBudget,
    workspace_id: &str,
    key_id: &str,
    member_id: &str,
    now: DateTime<Utc>,
) -> String {
    let period = match budget.period {
        BudgetPeriod::Day => "day",
        BudgetPeriod::Month => "month",
    };
    let (window_id, _) = window(budget.period, now);
    match (budget.scope, budget.period) {
        (BudgetScope::Workspace, BudgetPeriod::Day) => format!("v2:budget:{}:daily", workspace_id),
        (BudgetScope::Workspace, BudgetPeriod::Month) => {
            format!("v2:budget:{}:monthly", workspace_id)
        }
        (BudgetScope::Key, _) => format!(
            "v2:budget:{}:key:{}:{}:{}",
            workspace_id, key_id, period, window_id
        ),
        (BudgetScope::Member, _) => format!(
            "v2:budget:{}:member:{}:{}:{}",
            workspace_id, member_id, period, window_id
        ),
    }
}

/// A hard budget that does not cover a request.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetRefusal {
    pub budget: HardBudget,
    pub spent_usd: f64,
    pub estimated_usd: f64,
    pub resets_at: DateTime<Utc>,
}

impl BudgetRefusal {
    pub fn remaining_usd(&self) -> f64 {
        (self.budget.limit_usd - self.spent_usd).max(0.0)
    }

    /// Seconds until the budget's window resets, for `Retry-After`.
    pub fn retry_after_secs(&self, now: DateTime<Utc>) -> u64 {
        (self.resets_at - now).num_seconds().max(1) as u64
    }

    /// What the agent reads: whose budget, how much of it is spent, and when it resets.
    pub fn message(&self) -> String {
        let whose = match self.budget.scope {
            BudgetScope::Workspace => "The workspace's",
            BudgetScope::Key => "This API key's",
            BudgetScope::Member => "Your member",
        };
        let (cadence, window) = match self.budget.period {
            BudgetPeriod::Day => ("daily", "today"),
            BudgetPeriod::Month => ("monthly", "this month"),
        };
        format!(
            "{whose} {cadence} spend budget of ${:.2} does not cover this request: ${:.2} spent {window} (UTC), \
             ${:.2} left, and the request is estimated at ${:.2} with a 20% margin. It resets at {}. \
             An owner or admin can change budgets on Settings › Billing.",
            self.budget.limit_usd,
            self.spent_usd,
            self.remaining_usd(),
            self.estimated_usd * SAFETY_MARGIN,
            self.resets_at.to_rfc3339(),
        )
    }

    /// The structured `budget` field of the 429 body, for SDKs.
    pub fn detail(&self) -> serde_json::Value {
        serde_json::json!({
            "scope": match self.budget.scope {
                BudgetScope::Workspace => "workspace",
                BudgetScope::Key => "key",
                BudgetScope::Member => "member",
            },
            "period": match self.budget.period {
                BudgetPeriod::Day => "day",
                BudgetPeriod::Month => "month",
            },
            "limitUsd": self.budget.limit_usd,
            "spentUsd": self.spent_usd,
            "resetsAt": self.resets_at.to_rfc3339(),
        })
    }
}

/// The first budget whose remainder does not cover `estimated_usd` (with the
/// margin), given each budget's spend so far, in the same order.
pub fn first_uncovered(
    budgets: &[HardBudget],
    spent: &[f64],
    estimated_usd: f64,
    now: DateTime<Utc>,
) -> Option<BudgetRefusal> {
    budgets.iter().zip(spent).find_map(|(b, &spent_usd)| {
        (estimated_usd * SAFETY_MARGIN > b.limit_usd - spent_usd).then(|| BudgetRefusal {
            budget: b.clone(),
            spent_usd,
            estimated_usd,
            resets_at: window(b.period, now).1,
        })
    })
}

/// Which per-minute limit refused a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitKind {
    Requests,
    Tokens,
}

/// What `LocalStore::admit_rate` decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateDecision {
    /// Within both limits; the request was counted.
    Admitted,
    /// A limit is reached for this minute. Nothing was counted.
    Limited {
        kind: RateLimitKind,
        limit: u64,
        used: u64,
    },
    /// The counter could not be read. Rate limits fail open: a throttle that
    /// cannot count lets the request through, unlike a spend cap.
    Unavailable,
}

/// The UTC minute a moment falls in, as seconds since the epoch divided by 60.
pub fn minute_of(now: DateTime<Utc>) -> i64 {
    now.timestamp().div_euclid(60)
}

/// Seconds until the next UTC minute, for `Retry-After`.
pub fn secs_to_next_minute(now: DateTime<Utc>) -> u64 {
    (60 - now.timestamp().rem_euclid(60)) as u64
}

/// Rate-limit counter names. The key id is a hash tag, so both counters of one
/// key share a slot and the admit script stays valid on a cluster.
pub fn rate_counter_keys(key_id: &str, minute: i64) -> (String, String) {
    (
        format!("v2:keyrate:{{{}}}:rpm:{}", key_id, minute),
        format!("v2:keyrate:{{{}}}:tpm:{}", key_id, minute),
    )
}

/// How long a rate counter lives: its minute, plus a minute for clocks a little behind.
pub const RATE_COUNTER_TTL_SECS: u64 = 120;

/// The refusal an agent reads when a per-minute limit is reached.
pub fn rate_limited_message(
    kind: RateLimitKind,
    limit: u64,
    used: u64,
    retry_after: u64,
) -> String {
    match kind {
        RateLimitKind::Requests => format!(
            "This API key is limited to {limit} requests per minute and has sent {used} this minute. Retry in {retry_after}s."
        ),
        RateLimitKind::Tokens => format!(
            "This API key is limited to {limit} tokens per minute and has used {used} this minute. Retry in {retry_after}s."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn budget(scope: BudgetScope, period: BudgetPeriod, limit_usd: f64) -> HardBudget {
        HardBudget {
            scope,
            period,
            limit_usd,
        }
    }

    #[test]
    fn hard_budgets_parse_and_a_bad_entry_is_dropped_alone() {
        let v = serde_json::json!([
            {"scope": "key", "period": "day", "limitUsd": 5},
            {"scope": "member", "period": "month", "limitUsd": 200.5},
            {"scope": "team", "period": "day", "limitUsd": 1},
            {"scope": "key", "period": "day", "limitUsd": 0}
        ]);
        assert_eq!(
            parse_hard_budgets(Some(&v)),
            Some(vec![
                budget(BudgetScope::Key, BudgetPeriod::Day, 5.0),
                budget(BudgetScope::Member, BudgetPeriod::Month, 200.5),
            ])
        );
    }

    #[test]
    fn an_absent_or_null_field_is_none_and_an_empty_list_is_some() {
        assert_eq!(parse_hard_budgets(None), None);
        assert_eq!(parse_hard_budgets(Some(&serde_json::Value::Null)), None);
        assert_eq!(
            parse_hard_budgets(Some(&serde_json::json!([]))),
            Some(vec![])
        );
    }

    #[test]
    fn rate_limits_parse_and_an_empty_one_is_none() {
        assert_eq!(
            parse_rate_limit(Some(&serde_json::json!({"rpm": 60, "tpm": null}))),
            Some(RateLimit {
                rpm: Some(60),
                tpm: None
            })
        );
        assert_eq!(
            parse_rate_limit(Some(&serde_json::json!({"rpm": null, "tpm": null}))),
            None
        );
        assert_eq!(parse_rate_limit(None), None);
    }

    #[test]
    fn day_and_month_windows_roll_over_at_utc_boundaries() {
        let late = at("2026-12-31T23:59:59Z");
        assert_eq!(
            window(BudgetPeriod::Day, late),
            ("2026-12-31".into(), at("2027-01-01T00:00:00Z"))
        );
        assert_eq!(
            window(BudgetPeriod::Month, late),
            ("2026-12".into(), at("2027-01-01T00:00:00Z"))
        );
        let next = at("2027-01-01T00:00:00Z");
        assert_eq!(window(BudgetPeriod::Day, next).0, "2027-01-01");
        assert_eq!(window(BudgetPeriod::Month, next).0, "2027-01");
    }

    #[test]
    fn counter_keys_match_the_control_plane_builders() {
        let now = at("2026-10-09T12:00:00Z");
        let key = |s, p| spend_counter_key(&budget(s, p, 1.0), "ws_1", "key_1", "mem_1", now);
        assert_eq!(
            key(BudgetScope::Workspace, BudgetPeriod::Day),
            "v2:budget:ws_1:daily"
        );
        assert_eq!(
            key(BudgetScope::Workspace, BudgetPeriod::Month),
            "v2:budget:ws_1:monthly"
        );
        assert_eq!(
            key(BudgetScope::Key, BudgetPeriod::Day),
            "v2:budget:ws_1:key:key_1:day:2026-10-09"
        );
        assert_eq!(
            key(BudgetScope::Member, BudgetPeriod::Month),
            "v2:budget:ws_1:member:mem_1:month:2026-10"
        );
    }

    #[test]
    fn a_request_is_refused_by_the_first_budget_that_does_not_cover_it() {
        let now = at("2026-10-09T12:00:00Z");
        let budgets = [
            budget(BudgetScope::Workspace, BudgetPeriod::Day, 100.0),
            budget(BudgetScope::Key, BudgetPeriod::Day, 5.0),
            budget(BudgetScope::Member, BudgetPeriod::Month, 1.0),
        ];
        // $1 estimate × 1.2 = $1.20: fits the workspace's $90 left, not the key's $0.50.
        let r = first_uncovered(&budgets, &[10.0, 4.5, 0.0], 1.0, now).expect("refused");
        assert_eq!(r.budget.scope, BudgetScope::Key);
        assert_eq!(r.remaining_usd(), 0.5);
        assert_eq!(r.resets_at, at("2026-10-10T00:00:00Z"));
        assert_eq!(r.retry_after_secs(now), 12 * 3600);
        assert!(r
            .message()
            .contains("This API key's daily spend budget of $5.00"));
        assert_eq!(r.detail()["scope"], "key");
        assert_eq!(r.detail()["period"], "day");
        // Everything covered.
        assert_eq!(first_uncovered(&budgets, &[0.0, 0.0, 0.0], 0.5, now), None);
    }

    #[test]
    fn the_margin_refuses_a_request_that_only_just_fits() {
        let now = at("2026-10-09T12:00:00Z");
        let b = [budget(BudgetScope::Member, BudgetPeriod::Month, 10.0)];
        // $1 left; $0.90 × 1.2 = $1.08 does not fit, $0.80 × 1.2 = $0.96 does.
        assert!(first_uncovered(&b, &[9.0], 0.9, now).is_some());
        assert!(first_uncovered(&b, &[9.0], 0.8, now).is_none());
    }

    #[test]
    fn minutes_and_rate_keys() {
        let now = at("2026-10-09T12:00:45Z");
        assert_eq!(secs_to_next_minute(now), 15);
        let m = minute_of(now);
        assert_eq!(m, now.timestamp() / 60);
        assert_eq!(
            rate_counter_keys("key_1", m),
            (
                format!("v2:keyrate:{{key_1}}:rpm:{m}"),
                format!("v2:keyrate:{{key_1}}:tpm:{m}")
            )
        );
    }
}
