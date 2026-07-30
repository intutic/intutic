//! Translating what harnesses emit into what the ordering rules are about.
//!
//! The scope-violation rules are expressed over abstract actions — `deploy` must
//! follow `run_tests`, `pii_export` must not follow `db_write`. Those are the
//! right invariants: they are the ones a single node cannot check for itself,
//! because the node that deploys is usually not the node that tested.
//!
//! But no harness emits a tool called `deploy`. Claude Code emits `Bash`, `Read`,
//! `Write`, `Edit`, `WebFetch`; Cursor and Codex emit their own near-synonyms.
//! Every one of the interesting actions arrives as `Bash` with a command string.
//! So the rules named a vocabulary nothing produced, and
//! [`MissingPredecessorDetector`](super::detectors::MissingPredecessorDetector)
//! and [`ForbiddenSuccessionDetector`](super::detectors::ForbiddenSuccessionDetector)
//! could not fire — `SCOPE_VIOLATION` had no reachable producer at all.
//!
//! This is the missing layer: classify a concrete tool call into the abstract
//! actions it performs, using the arguments that are right there in the request
//! body and were previously discarded.
//!
//! # Deliberately conservative
//!
//! A classification here can kill a request, so every pattern names a specific,
//! recognisable command. `git push` is a deploy; `git status` is not. Anything
//! unrecognised classifies as nothing, which returns the detector to the
//! behaviour it had before this module existed. Missing an action is recoverable;
//! blocking `ls` because it looked like an export is not.

/// Marks a synthesised action so it can never be confused with a real tool name.
///
/// [`SequenceAnomalyDetector`](super::detectors::SequenceAnomalyDetector) learns
/// transition probabilities between tools actually called, so it filters these
/// out — a synthetic token in that chain would be a transition no harness ever
/// made.
pub const ACTION_PREFIX: &str = "action:";

/// True for entries this module synthesised rather than a harness reporting them.
pub fn is_action(token: &str) -> bool {
    token.starts_with(ACTION_PREFIX)
}

/// Commands that put code or artefacts somewhere real.
const DEPLOY_PATTERNS: &[&str] = &[
    "git push",
    "kubectl apply",
    "kubectl rollout",
    "helm upgrade",
    "helm install",
    "terraform apply",
    "docker push",
    "serverless deploy",
    "fly deploy",
    "vercel deploy",
    "gcloud run deploy",
    "aws deploy",
    "aws s3 sync",
    "eb deploy",
];

/// Commands that publish a package or a release to the outside world.
const PUBLISH_PATTERNS: &[&str] = &[
    "npm publish",
    "pnpm publish",
    "yarn publish",
    "cargo publish",
    "twine upload",
    "poetry publish",
    "gem push",
    "docker manifest push",
];

/// Commands that cut a release.
const RELEASE_PATTERNS: &[&str] = &[
    "gh release create",
    "git tag",
    "npm version",
    "cargo release",
    "goreleaser release",
    "semantic-release",
];

/// Commands that run a test suite.
const TEST_PATTERNS: &[&str] = &[
    "npm test",
    "npm run test",
    "pnpm test",
    "pnpm run test",
    "yarn test",
    "cargo test",
    "go test",
    "pytest",
    "python -m pytest",
    "vitest",
    "jest",
    "mocha",
    "rspec",
    "phpunit",
    "make test",
    "gradle test",
    "mvn test",
    "dotnet test",
    "bazel test",
    "tox",
];

/// Commands that send data somewhere over the network.
const HTTP_POST_PATTERNS: &[&str] = &[
    "curl -x post",
    "curl --request post",
    "curl -d ",
    "curl --data",
    "wget --post",
    "http post",
];

/// Commands that write to a database.
const DB_WRITE_PATTERNS: &[&str] = &[
    "insert into",
    "update ",
    "delete from",
    "drop table",
    "truncate ",
    "alter table",
];

/// Path fragments that indicate credential material.
const SECRET_PATH_FRAGMENTS: &[&str] = &[
    ".env",
    "credentials",
    "id_rsa",
    "id_ed25519",
    ".pem",
    ".p12",
    ".pfx",
    "secrets.",
    ".netrc",
    ".aws/",
    ".ssh/",
    "kubeconfig",
    "service-account",
];

/// Path fragments that indicate personal data leaving the system.
const PII_PATH_FRAGMENTS: &[&str] = &["customer", "users.csv", "pii", "personal", "gdpr", "payroll"];

/// Tool names harnesses use for "run a shell command".
const SHELL_TOOLS: &[&str] = &["bash", "shell", "run_command", "runcommand", "terminal", "execute", "exec"];

/// Tool names harnesses use for "read a file".
const READ_TOOLS: &[&str] = &["read", "readfile", "view", "cat", "open_file", "str_replace_editor"];

/// Tool names harnesses use for "fetch a URL".
const FETCH_TOOLS: &[&str] = &["webfetch", "fetch", "http_request", "browser", "web_search"];

/// Concatenate the string-ish values of a tool's arguments, lowercased.
///
/// Which key holds the command varies by harness (`command`, `cmd`, `script`,
/// `file_path`, `path`, `url`), and a new harness will invent another. Reading
/// every string value means an unknown key still classifies correctly.
fn flatten_input(input: &serde_json::Value) -> String {
    let mut out = String::new();
    match input {
        serde_json::Value::String(s) => {
            out.push_str(&s.to_lowercase());
        }
        serde_json::Value::Array(items) => {
            for item in items {
                out.push(' ');
                out.push_str(&flatten_input(item));
            }
        }
        serde_json::Value::Object(map) => {
            for value in map.values() {
                out.push(' ');
                out.push_str(&flatten_input(value));
            }
        }
        _ => {}
    }
    out
}

fn matches_any(haystack: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| haystack.contains(p))
}

fn tool_is(name: &str, group: &[&str]) -> bool {
    let lower = name.to_lowercase();
    group.iter().any(|t| lower == *t || lower.ends_with(t))
}

/// Classify one tool call into the abstract actions it performs.
///
/// Returns prefixed tokens ready to append to the session's tool sequence, in the
/// position the call occupied — order is what the ordering rules read.
pub fn classify(tool_name: &str, input: &serde_json::Value) -> Vec<String> {
    let args = flatten_input(input);
    let mut actions: Vec<&'static str> = Vec::new();

    if tool_is(tool_name, SHELL_TOOLS) {
        // Tests first: `npm test && git push` is both, and the ordering rule
        // needs the test to be seen as having happened before the deploy.
        if matches_any(&args, TEST_PATTERNS) {
            actions.push("run_tests");
        }
        if matches_any(&args, DEPLOY_PATTERNS) {
            actions.push("deploy");
        }
        if matches_any(&args, PUBLISH_PATTERNS) {
            actions.push("publish");
        }
        if matches_any(&args, RELEASE_PATTERNS) {
            actions.push("release");
        }
        if matches_any(&args, HTTP_POST_PATTERNS) {
            actions.push("http_post");
        }
        if matches_any(&args, DB_WRITE_PATTERNS) {
            actions.push("db_write");
        }
        if matches_any(&args, SECRET_PATH_FRAGMENTS) {
            actions.push("secret_read");
        }
        if matches_any(&args, PII_PATH_FRAGMENTS) {
            actions.push("pii_export");
        }
    } else if tool_is(tool_name, READ_TOOLS) {
        if matches_any(&args, SECRET_PATH_FRAGMENTS) {
            actions.push("secret_read");
        }
        if matches_any(&args, PII_PATH_FRAGMENTS) {
            actions.push("pii_export");
        }
    } else if tool_is(tool_name, FETCH_TOOLS) {
        // A fetch tool carrying a body is a send, not a read.
        if args.contains("post") || args.contains("\"body\"") || args.contains("payload") {
            actions.push("http_post");
        }
    }

    actions
        .into_iter()
        .map(|a| format!("{ACTION_PREFIX}{a}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_git_push_is_a_deploy() {
        let actions = classify("Bash", &json!({"command": "git push origin main"}));
        assert_eq!(actions, vec!["action:deploy"]);
    }

    #[test]
    fn tests_are_recognised_before_the_deploy_in_the_same_command() {
        // `npm test && git push` must record the test first, or the ordering
        // rule sees a deploy with no prior test in the very command that ran one.
        let actions = classify("Bash", &json!({"command": "npm test && git push"}));
        assert_eq!(actions, vec!["action:run_tests", "action:deploy"]);
    }

    #[test]
    fn ordinary_commands_classify_as_nothing() {
        // The conservative default: unrecognised means no action, which leaves
        // the detectors exactly as they behaved before this module existed.
        for cmd in ["ls -la", "git status", "cd src", "echo hello", "grep -r foo ."] {
            assert!(
                classify("Bash", &json!({ "command": cmd })).is_empty(),
                "{cmd} should not classify as an action"
            );
        }
    }

    #[test]
    fn reading_a_credential_file_is_a_secret_read() {
        let actions = classify("Read", &json!({"file_path": "/home/me/.aws/credentials"}));
        assert_eq!(actions, vec!["action:secret_read"]);
    }

    #[test]
    fn arguments_are_found_whatever_the_key_is_called() {
        // Harnesses disagree on the key name, and the next one will invent
        // another. Every string value is read, so an unknown key still works.
        for key in ["command", "cmd", "script", "input", "some_new_field"] {
            let actions = classify("Bash", &json!({ key: "cargo publish" }));
            assert_eq!(actions, vec!["action:publish"], "key {key} should classify");
        }
    }

    #[test]
    fn nested_and_argv_style_arguments_are_reached() {
        // Some harnesses pass a command already split into argv. Joining the
        // values recovers it, which is what makes those harnesses work too.
        let actions = classify("Bash", &json!({"args": {"parts": ["npm", "publish"]}}));
        assert_eq!(actions, vec!["action:publish"]);

        let actions = classify("Bash", &json!({"outer": {"inner": "npm publish"}}));
        assert_eq!(actions, vec!["action:publish"]);
    }

    #[test]
    fn harness_synonyms_for_the_shell_all_work() {
        for tool in ["Bash", "shell", "run_command", "terminal", "execute"] {
            assert_eq!(
                classify(tool, &json!({"command": "kubectl apply -f x.yaml"})),
                vec!["action:deploy"],
                "{tool} should be treated as a shell"
            );
        }
    }

    #[test]
    fn synthesised_tokens_are_distinguishable_from_real_tools() {
        assert!(is_action("action:deploy"));
        assert!(!is_action("Bash"));
        assert!(!is_action("deploy"));
    }

    #[test]
    fn a_fetch_without_a_body_is_not_a_send() {
        assert!(classify("WebFetch", &json!({"url": "https://example.com/docs"})).is_empty());
        assert_eq!(
            classify("WebFetch", &json!({"url": "https://x.com", "method": "POST"})),
            vec!["action:http_post"]
        );
    }
}
