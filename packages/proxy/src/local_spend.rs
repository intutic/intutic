use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Debug)]
struct ConfigJson {
    #[serde(rename = "maxDailyBudgetUsd", alias = "max_daily_budget_usd")]
    max_daily_budget_usd: Option<f64>,
}

#[derive(Serialize, Deserialize, Debug)]
struct LocalSpendDelta {
    spent_usd: f64,
}

fn intutic_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".intutic")
}

pub fn get_max_daily_budget() -> f64 {
    let config_path = intutic_dir().join("config.json");
    if !config_path.exists() {
        return 10.0;
    }
    match fs::read_to_string(&config_path) {
        Ok(content) => match serde_json::from_str::<ConfigJson>(&content) {
            Ok(cfg) => cfg.max_daily_budget_usd.unwrap_or(10.0),
            Err(_) => 10.0,
        },
        Err(_) => 10.0,
    }
}

pub fn get_local_spend() -> f64 {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let spend_filename = format!("local-spend-{}.jsonl", today);
    let spend_path = intutic_dir().join("logs").join(&spend_filename);
    if !spend_path.exists() {
        return 0.0;
    }

    let mut total = 0.0;
    if let Ok(content) = fs::read_to_string(&spend_path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(delta) = serde_json::from_str::<LocalSpendDelta>(trimmed) {
                total += delta.spent_usd;
            }
        }
    }
    total
}

pub fn add_local_spend(amount: f64) {
    if amount <= 0.0 {
        return;
    }
    let dir = intutic_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let spend_filename = format!("local-spend-{}.jsonl", today);
    let spend_path = dir.join(&spend_filename);

    let delta = LocalSpendDelta { spent_usd: amount };
    if let Ok(line) = serde_json::to_string(&delta) {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&spend_path)
        {
            let _ = writeln!(file, "{}", line);
        }
    }
}

pub fn log_offline_trace(trace: &serde_json::Value) {
    let dir = intutic_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let trace_filename = format!("traces-{}.jsonl", today);
    let trace_path = dir.join(&trace_filename);

    if let Ok(line) = serde_json::to_string(trace) {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&trace_path)
        {
            let _ = writeln!(file, "{}", line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_spend_functions() {
        // Use a Mutex-like serial execution approach: run sequentially in a single test
        std::env::set_var("HOME", "/tmp/intutic_test_home");
        let dir = intutic_dir();
        let _ = fs::remove_dir_all(&dir);

        // Max budget defaults
        assert_eq!(get_max_daily_budget(), 10.0);
        assert_eq!(get_local_spend(), 0.0);

        // 1. Set local config limit (camelCase)
        let _ = fs::create_dir_all(&dir);
        let config_path = dir.join("config.json");
        fs::write(&config_path, r#"{"maxDailyBudgetUsd": 25.50}"#).unwrap();

        assert_eq!(get_max_daily_budget(), 25.50);

        // 2. Set local config limit (snake_case alias)
        fs::write(&config_path, r#"{"max_daily_budget_usd": 15.75}"#).unwrap();

        assert_eq!(get_max_daily_budget(), 15.75);

        // 3. Add some spend
        add_local_spend(5.25);
        assert_eq!(get_local_spend(), 5.25);

        // 4. Add more spend
        add_local_spend(2.50);
        assert_eq!(get_local_spend(), 7.75);

        let _ = fs::remove_dir_all(&dir);
    }
}
