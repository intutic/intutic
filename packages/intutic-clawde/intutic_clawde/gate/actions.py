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

import re

from .phrases import has_phrase, phrase_text

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
    "drop database",
    "drop schema",
    "truncate ",
    "alter table",
]

# Commands that change a database schema (action:migrate, reversible_wide).
MIGRATE_PATTERNS = [
    "prisma migrate deploy",
    "prisma db push",
    "alembic upgrade",
    "alembic downgrade",
    "rails db:migrate",
    "rake db:migrate",
    "manage.py migrate",
    "flyway migrate",
    "liquibase update",
    "knex migrate:latest",
    "sequelize db:migrate",
]

# Flags and settings that point a command at production (action:prod_write,
# reversible_wide). A one-word needle is a substring, so `--prod` also
# matches `--production`.
PROD_WRITE_PATTERNS = [
    "--prod",
    "rails_env=production",
    "node_env=production",
    "--context prod",
    "--namespace production",
    "-n production",
    "--environment production",
    "--stage prod",
]

# Commands that destroy infrastructure or data (action:destroy, irreversible).
# DROP and TRUNCATE are also db_write. A recursive, forced remove whose target
# is outside the working tree is destroy too (removes_outside_tree).
DESTROY_PATTERNS = [
    "terraform destroy",
    "kubectl delete",
    "helm uninstall",
    "helm delete",
    "drop table",
    "drop database",
    "drop schema",
    "truncate ",
    "aws s3 rb",
    "aws s3 rm",
]

# Calls that move money (action:payment, irreversible).
PAYMENT_PATTERNS = [
    "api.stripe.com/v1/charges",
    "api.stripe.com/v1/payment_intents",
    "api.stripe.com/v1/transfers",
    "api.stripe.com/v1/payouts",
    "api.stripe.com/v1/refunds",
    "stripe charges create",
    "stripe payment_intents create",
    "stripe transfers create",
    "stripe payouts create",
    "api-m.paypal.com/v2/payments",
    "api.paypal.com/v1/payments",
]

# The whole-word flags that make a `git push` a force push (action:force_push,
# irreversible), looked for in the space-padded, whitespace-collapsed command.
# `--force-with-lease` is not one.
FORCE_PUSH_FLAGS = [" --force ", " -f "]

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
SHELL_TOOLS = [
    "bash",
    "shell",
    "run_command",
    "runcommand",
    "execute_command",
    "run_shell_command",
    "terminal",
    "execute",
    "exec",
]

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


def matches_phrase(words, patterns: list[str]) -> bool:
    """matches_any for a phrase list, whatever separates each phrase's words.

    A one-word pattern is a plain substring; see phrases.py, which matches in
    linear time rather than with a backtracking regex.
    """
    return any(has_phrase(words, p) for p in patterns)


def tool_is(name: str, group: list[str]) -> bool:
    """Match a tool name against a group.

    `ends_with` is what lets namespaced names like `mcp__sh__bash` classify.
    """
    lower = name.lower()
    return any(lower == t or lower.endswith(t) for t in group)


_WS_RUN = re.compile(r"[ \t\n\r\f\v]+")
_SEGMENT = re.compile(r"[;&|()\n]")
_WORD_GAP = re.compile(r"[ \t\r\f\v]+")
_REMOVE_COMMAND = "r" + "m"


def is_force_push(words, args: str) -> bool:
    """A force push: the `git push` phrase, and `--force` or `-f` as a whole
    word anywhere in the command, whitespace collapsed and padded with a space
    at each end."""
    if not has_phrase(words, "git push"):
        return False
    padded = " " + _WS_RUN.sub(" ", args) + " "
    return any(f in padded for f in FORCE_PUSH_FLAGS)


def removes_outside_tree(args: str) -> bool:
    """A recursive, forced remove command (-rf, -fr, -r -f, --recursive
    --force, in any case) with a target outside the working tree: absolute,
    under ~, or containing `..`. A target inside the tree is not one. The
    command is cut into segments at ; & | ( ) and newlines; in each, the first
    word that is the remove command (or ends with `/` and it) starts it, and
    every later word is a flag (before `--`) or a target, quotes stripped.
    Linear in the command. See actions.ts removesOutsideTree."""
    for segment in _SEGMENT.split(args):
        words = [w for w in _WORD_GAP.split(segment) if w != ""]
        at = next((i for i, w in enumerate(words) if w == _REMOVE_COMMAND or w.endswith("/" + _REMOVE_COMMAND)), -1)
        if at == -1:
            continue
        recursive = force = False
        flags = True
        targets = []
        for w in words[at + 1:]:
            if flags and w == "--":
                flags = False
            elif flags and w.startswith("--"):
                if w == "--recursive":
                    recursive = True
                if w == "--force":
                    force = True
            elif flags and w.startswith("-") and len(w) > 1:
                lower = w.lower()
                if "r" in lower:
                    recursive = True
                if "f" in lower:
                    force = True
            else:
                targets.append(w.strip("\"'"))
        if recursive and force and any(t.startswith("/") or t.startswith("~") or ".." in t for t in targets):
            return True
    return False


def classify(tool_name: str, tool_input) -> list[str]:
    """Classify one tool call into the abstract actions it performs.

    Returns prefixed tokens (`action:deploy`, ...) in the order the Rust emits
    them. Order matters: the ordering detectors read position in the sequence.
    """
    args = flatten_input(tool_input)
    actions: list[str] = []
    # Cut into words once, for every phrase list below.
    words = phrase_text(args)

    if tool_is(tool_name, SHELL_TOOLS):
        # Tests first: `make test && git push` is both, and the ordering rule
        # needs the test to be seen as having happened before the deploy.
        if matches_phrase(words, TEST_PATTERNS):
            actions.append("run_tests")
        if matches_phrase(words, DEPLOY_PATTERNS):
            actions.append("deploy")
        if matches_phrase(words, PUBLISH_PATTERNS):
            actions.append("publish")
        if matches_phrase(words, RELEASE_PATTERNS):
            actions.append("release")
        # Source before sink, so that (secret_read -> http_post) can still fire
        # on a single command that does both.
        if matches_any(args, SECRET_PATH_FRAGMENTS):
            actions.append("secret_read")
        if matches_any(args, PII_PATH_FRAGMENTS):
            actions.append("pii_export")
        if matches_phrase(words, HTTP_POST_PATTERNS):
            actions.append("http_post")
        if matches_phrase(words, DB_WRITE_PATTERNS):
            actions.append("db_write")
        # The newer tokens, after the eight, in this order in every
        # classifier: each is a lane (see TOKEN_CLASS), not an ordering step.
        if matches_phrase(words, MIGRATE_PATTERNS):
            actions.append("migrate")
        if matches_phrase(words, PROD_WRITE_PATTERNS):
            actions.append("prod_write")
        if matches_phrase(words, DESTROY_PATTERNS) or removes_outside_tree(args):
            actions.append("destroy")
        if is_force_push(words, args):
            actions.append("force_push")
        if matches_phrase(words, PAYMENT_PATTERNS):
            actions.append("payment")

    return [ACTION_PREFIX + a for a in actions]


def is_deploy(tool_name: str, tool_input) -> bool:
    """True when this call would deploy — the trigger for the image check."""
    return ACTION_PREFIX + "deploy" in classify(tool_name, tool_input)


def is_test(tool_name: str, tool_input) -> bool:
    """True when this call runs a test suite."""
    return ACTION_PREFIX + "run_tests" in classify(tool_name, tool_input)


def touches_infra(path: str) -> bool:
    """True when a written path is infrastructure-as-code."""
    return matches_any((path or "").lower(), INFRA_PATH_FRAGMENTS)


# ---------------------------------------------------------------------------
# Reversibility lanes: a transliteration of
# packages/shared-types/src/lanes.ts, held to fixtures/lane-vectors.json.
# ---------------------------------------------------------------------------

CLOSABLE_LANES = ("irreversible", "reversible_wide")

# Every action token's class, in ACTION_TOKENS order (guardrailIr.ts).
TOKEN_CLASS = {
    "action:deploy": "reversible_wide",
    "action:publish": "irreversible",
    "action:release": "reversible_wide",
    "action:db_write": "reversible_wide",
    "action:secret_read": "reversible_contained",
    "action:http_post": "reversible_wide",
    "action:pii_export": "reversible_contained",
    "action:run_tests": "reversible_contained",
    "action:migrate": "reversible_wide",
    "action:prod_write": "reversible_wide",
    "action:destroy": "irreversible",
    "action:force_push": "irreversible",
    "action:payment": "irreversible",
}

# The phrases a phrase-subject hold rule matches a token by: this module's
# needle lists; force_push's are the partial form an older gate can match.
LANE_PHRASES = {
    "action:deploy": DEPLOY_PATTERNS,
    "action:publish": PUBLISH_PATTERNS,
    "action:release": RELEASE_PATTERNS,
    "action:db_write": DB_WRITE_PATTERNS,
    "action:http_post": HTTP_POST_PATTERNS,
    "action:run_tests": TEST_PATTERNS,
    "action:migrate": MIGRATE_PATTERNS,
    "action:prod_write": PROD_WRITE_PATTERNS,
    "action:destroy": DESTROY_PATTERNS,
    "action:force_push": ["git push --force", "git push -f"],
    "action:payment": PAYMENT_PATTERNS,
}


def token_lane(token: str):
    """A token's class, or None for a tool name or an unknown token."""
    return TOKEN_CLASS.get(token)


def lane_of(tokens):
    """The strongest class among tokens, or None. The decide log's lane."""
    best = None
    for t in tokens:
        c = TOKEN_CLASS.get(t)
        if c == "irreversible":
            return c
        if c == "reversible_wide":
            best = c
        elif c == "reversible_contained" and best is None:
            best = c
    return best


def lane_hold_tokens(sops, workspace_lanes=None) -> list:
    """The tokens held for review. sops: dicts with closedLanes, openActions and riskTier."""
    held = set()
    for sop in sops:
        closed = list(sop.get("closedLanes") or [])
        if not closed:
            continue
        if str(sop.get("riskTier") or "").upper() in ("HIGH", "CRITICAL"):
            closed.append("reversible_wide")
        opened = sop.get("openActions") or []
        for token, cls in TOKEN_CLASS.items():
            if cls != "reversible_contained" and cls in closed and token not in opened:
                held.add(token)
    for token, cls in TOKEN_CLASS.items():
        if cls != "reversible_contained" and cls in (workspace_lanes or []):
            held.add(token)
    return [t for t in TOKEN_CLASS if t in held]


def lane_hold_rule_id(token: str) -> str:
    """A lane hold rule's id: sop.lane.<class>.<token>."""
    return "sop.lane." + (TOKEN_CLASS.get(token) or "unknown") + "." + token


def revert_hold_rule_id(subject: str) -> str:
    """A revert hold rule's id: revert.<subject>."""
    return "revert." + subject


def lane_hold_patterns(token: str) -> list:
    """The snapshot rules that hold token, as dicts of subject, source and ignoreCase; see lanes.ts."""
    action = {"subject": "action", "source": " (" + re.escape(token).replace("\\:", ":").replace("\\_", "_") + ") ",
              "ignoreCase": True}
    phrases = LANE_PHRASES.get(token) or []
    phrase = {"subject": "phrase", "source": "|".join(phrases), "ignoreCase": True} if phrases else None
    if token == "action:force_push":
        return [action, phrase]
    if token == "action:destroy":
        return [phrase, action]
    return [phrase] if phrase else [action]
