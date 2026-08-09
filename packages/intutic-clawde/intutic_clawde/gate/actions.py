"""Port of the proxy's command classifier.

Source of truth: packages/proxy/src/plugins/anomaly/actions.rs (in this repo).

The proxy synthesises abstract `action:` tokens from tool calls and evaluates
ordering rules over them. A pre-execution gate has to reach the *same* verdict
the proxy would, one turn earlier — if the two disagree, the gate either blocks
something the proxy would allow (a false stop mid-run) or waves through
something the proxy then refuses (two contradictory verdicts for one call).

So this is a deliberate transliteration, not a reimplementation. Pattern lists
are byte-identical to the Rust and `tests/test_gate_actions.py` re-reads
actions.rs to prove it. Note the trailing spaces in `"update "`, `"truncate "`
and `"curl -d "` — they are load-bearing and must survive editing.

The same discipline already keeps actions.rs in parity with the Claude Code
hook at services/sync-daemon/src/harness/claudeCodeHooks.ts:452.
"""

from __future__ import annotations

ACTION_PREFIX = "action:"

# Commands that put code or artefacts somewhere real.
DEPLOY_PATTERNS = [
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
]

# Commands that publish a package or a release to the outside world.
PUBLISH_PATTERNS = [
    "npm publish",
    "pnpm publish",
    "yarn publish",
    "cargo publish",
    "twine upload",
    "poetry publish",
    "gem push",
    "docker manifest push",
]

# Commands that cut a release.
RELEASE_PATTERNS = [
    "gh release create",
    "git tag",
    "npm version",
    "cargo release",
    "goreleaser release",
    "semantic-release",
]

# Commands that run a test suite.
TEST_PATTERNS = [
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
]

# Commands that send data somewhere over the network.
HTTP_POST_PATTERNS = [
    "curl -x post",
    "curl --request post",
    "curl -d ",
    "curl --data",
    "wget --post",
    "http post",
]

# Commands that write to a database.
DB_WRITE_PATTERNS = [
    "insert into",
    "update ",
    "delete from",
    "drop table",
    "truncate ",
    "alter table",
]

# Path fragments that indicate credential material.
#
# Note that `kubeconfig` and `service-account` are in here, so any command
# mentioning either synthesises action:secret_read and can trip the
# secret_read -> http_post forbidden succession in the proxy.
SECRET_PATH_FRAGMENTS = [
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
]

# Path fragments that indicate personal data leaving the system.
PII_PATH_FRAGMENTS = ["customer", "users.csv", "pii", "personal", "gdpr", "payroll"]

# Tool names harnesses use for "run a shell command".
#
# An agent's shell tool should carry one of these names (lowercase) so that
# tool_is() matches and the proxy classifies its arguments at all.
SHELL_TOOLS = ["bash", "shell", "run_command", "runcommand", "terminal", "execute", "exec"]

# Tool names harnesses use for "read a file".
READ_TOOLS = ["read", "readfile", "view", "cat", "open_file"]

# Tool names harnesses use for "fetch a URL".
FETCH_TOOLS = ["webfetch", "fetch", "http_request", "browser", "web_search"]

# Path fragments that indicate infrastructure-as-code.
# Source: packages/proxy/src/manifest.rs:280 (INFRA_PATH_FRAGMENTS).
# Used to decide when a *write* deserves an image-integrity check.
INFRA_PATH_FRAGMENTS = [
    "terraform",
    ".tf",
    "k8s/",
    "kubernetes/",
    "helm/",
    "dockerfile",
    "docker-compose",
    ".tfstate",
]


def flatten_input(value) -> str:
    """Concatenate the string-ish values of a tool's arguments, lowercased.

    Which key holds the command varies by harness (`command`, `cmd`, `script`,
    `file_path`, `path`, `url`), and a new harness will invent another. Reading
    every string value means an unknown key still classifies correctly.

    Mirrors the Rust exactly, including the leading space before each nested
    value — spacing changes which patterns can straddle a value boundary.
    """
    if isinstance(value, str):
        return value.lower()
    if isinstance(value, (list, tuple)):
        return "".join(" " + flatten_input(v) for v in value)
    if isinstance(value, dict):
        return "".join(" " + flatten_input(v) for v in value.values())
    # Numbers, bools and null contribute nothing, as in the Rust `_ => {}` arm.
    return ""


def matches_any(haystack: str, patterns: list[str]) -> bool:
    return any(p in haystack for p in patterns)


def tool_is(name: str, group: list[str]) -> bool:
    """Match a tool name against a group.

    `ends_with` is what lets namespaced names like `mcp__sh__bash` classify.
    """
    lower = name.lower()
    return any(lower == t or lower.endswith(t) for t in group)


def classify(tool_name: str, tool_input) -> list[str]:
    """Classify one tool call into the abstract actions it performs.

    Returns prefixed tokens (`action:deploy`, ...) in the order the Rust emits
    them. Order matters: the ordering detectors read position in the sequence.
    """
    args = flatten_input(tool_input)
    actions: list[str] = []

    if tool_is(tool_name, SHELL_TOOLS):
        # Tests first: `make test && git push` is both, and the ordering rule
        # needs the test to be seen as having happened before the deploy.
        if matches_any(args, TEST_PATTERNS):
            actions.append("run_tests")
        if matches_any(args, DEPLOY_PATTERNS):
            actions.append("deploy")
        if matches_any(args, PUBLISH_PATTERNS):
            actions.append("publish")
        if matches_any(args, RELEASE_PATTERNS):
            actions.append("release")
        # Source before sink, so that (secret_read -> http_post) can still fire
        # on a single command that does both.
        if matches_any(args, SECRET_PATH_FRAGMENTS):
            actions.append("secret_read")
        if matches_any(args, PII_PATH_FRAGMENTS):
            actions.append("pii_export")
        if matches_any(args, HTTP_POST_PATTERNS):
            actions.append("http_post")
        if matches_any(args, DB_WRITE_PATTERNS):
            actions.append("db_write")

    return [ACTION_PREFIX + a for a in actions]


def is_deploy(tool_name: str, tool_input) -> bool:
    """True when this call would deploy — the trigger for the image check."""
    return ACTION_PREFIX + "deploy" in classify(tool_name, tool_input)


def is_test(tool_name: str, tool_input) -> bool:
    return ACTION_PREFIX + "run_tests" in classify(tool_name, tool_input)


def touches_infra(path: str) -> bool:
    """True when a written path is infrastructure-as-code."""
    return matches_any((path or "").lower(), INFRA_PATH_FRAGMENTS)
