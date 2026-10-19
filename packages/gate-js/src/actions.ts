/**
 * Port of the proxy's command classifier.
 *
 * Source of truth: `packages/proxy/src/plugins/anomaly/actions.rs`, by way of
 * `packages/intutic-clawde/intutic_clawde/gate/actions.py` (the Python SDK's
 * own transliteration, which this file mirrors line for line rather than
 * re-deriving from the Rust — see that module's docstring for why: two
 * independent readings of the Rust drift, one faithful copy of the Python
 * reading does not).
 *
 * The proxy synthesises abstract `action:` tokens from tool calls and
 * evaluates ordering rules over them. A pre-execution gate has to reach the
 * SAME verdict the proxy would, one turn earlier — if the two disagree, the
 * gate either blocks something the proxy would allow, or waves through
 * something the proxy then refuses.
 *
 * Note the trailing spaces in `'update '`, `'truncate '` and `'curl -d '` —
 * they are load-bearing and must survive editing.
 */

import { hasPhrase, phraseText, type PhraseText } from './phrases.js'

export const ACTION_PREFIX = 'action:'

/** Commands that put code or artefacts somewhere real. */
export const DEPLOY_PATTERNS: readonly string[] = [
  'git push',
  'kubectl apply',
  'kubectl rollout',
  'helm upgrade',
  'helm install',
  'terraform apply',
  'docker push',
  'serverless deploy',
  'fly deploy',
  'vercel deploy',
  'gcloud run deploy',
  'aws deploy',
  'aws s3 sync',
  'eb deploy',
]

/** Commands that publish a package or a release to the outside world. */
export const PUBLISH_PATTERNS: readonly string[] = [
  'npm publish',
  'pnpm publish',
  'yarn publish',
  'cargo publish',
  'twine upload',
  'poetry publish',
  'gem push',
  'docker manifest push',
]

/** Commands that cut a release. */
export const RELEASE_PATTERNS: readonly string[] = [
  'gh release create',
  'git tag',
  'npm version',
  'cargo release',
  'goreleaser release',
  'semantic-release',
]

/** Commands that run a test suite. */
export const TEST_PATTERNS: readonly string[] = [
  'npm test',
  'npm run test',
  'pnpm test',
  'pnpm run test',
  'yarn test',
  'cargo test',
  'go test',
  'pytest',
  'python -m pytest',
  'vitest',
  'jest',
  'mocha',
  'rspec',
  'phpunit',
  'make test',
  'gradle test',
  'mvn test',
  'dotnet test',
  'bazel test',
  'tox',
]

/** Commands that send data somewhere over the network. */
export const HTTP_POST_PATTERNS: readonly string[] = [
  'curl -x post',
  'curl --request post',
  'curl -d ',
  'curl --data',
  'wget --post',
  'http post',
]

/** Commands that write to a database. */
export const DB_WRITE_PATTERNS: readonly string[] = [
  'insert into',
  'update ',
  'delete from',
  'drop table',
  'drop database',
  'drop schema',
  'truncate ',
  'alter table',
]

/** Commands that change a database schema (`action:migrate`, reversible_wide). */
export const MIGRATE_PATTERNS: readonly string[] = [
  'prisma migrate deploy',
  'prisma db push',
  'alembic upgrade',
  'alembic downgrade',
  'rails db:migrate',
  'rake db:migrate',
  'manage.py migrate',
  'flyway migrate',
  'liquibase update',
  'knex migrate:latest',
  'sequelize db:migrate',
]

/**
 * Flags and settings that point a command at production (`action:prod_write`,
 * reversible_wide). A one-word needle is a substring, so `--prod` also
 * matches `--production`.
 */
export const PROD_WRITE_PATTERNS: readonly string[] = [
  '--prod',
  'rails_env=production',
  'node_env=production',
  '--context prod',
  '--namespace production',
  '-n production',
  '--environment production',
  '--stage prod',
]

/**
 * Commands that destroy infrastructure or data (`action:destroy`,
 * irreversible). `DROP` and `TRUNCATE` are also `db_write`. A recursive,
 * forced `rm` whose target is outside the working tree is `destroy` too
 * ({@link removesOutsideTree}).
 */
export const DESTROY_PATTERNS: readonly string[] = [
  'terraform destroy',
  'kubectl delete',
  'helm uninstall',
  'helm delete',
  'drop table',
  'drop database',
  'drop schema',
  'truncate ',
  'aws s3 rb',
  'aws s3 rm',
]

/** Calls that move money (`action:payment`, irreversible). */
export const PAYMENT_PATTERNS: readonly string[] = [
  'api.stripe.com/v1/charges',
  'api.stripe.com/v1/payment_intents',
  'api.stripe.com/v1/transfers',
  'api.stripe.com/v1/payouts',
  'api.stripe.com/v1/refunds',
  'stripe charges create',
  'stripe payment_intents create',
  'stripe transfers create',
  'stripe payouts create',
  'api-m.paypal.com/v2/payments',
  'api.paypal.com/v1/payments',
]

/**
 * The whole-word flags that make a `git push` a force push
 * (`action:force_push`, irreversible), looked for in the space-padded,
 * whitespace-collapsed command. `--force-with-lease` is not one.
 */
export const FORCE_PUSH_FLAGS: readonly string[] = [' --force ', ' -f ']

/**
 * Path fragments that indicate credential material.
 *
 * `kubeconfig` and `service-account` are in here, so any command mentioning
 * either synthesises `action:secret_read`.
 */
export const SECRET_PATH_FRAGMENTS: readonly string[] = [
  '.env',
  'credentials',
  'id_rsa',
  'id_ed25519',
  '.pem',
  '.p12',
  '.pfx',
  'secrets.',
  '.netrc',
  '.aws/',
  '.ssh/',
  'kubeconfig',
  'service-account',
]

/** Path fragments that indicate personal data leaving the system. */
export const PII_PATH_FRAGMENTS: readonly string[] = [
  'customer',
  'users.csv',
  'pii',
  'personal',
  'gdpr',
  'payroll',
]

/** Tool names harnesses use for "run a shell command". */
export const SHELL_TOOLS: readonly string[] = [
  'bash',
  'shell',
  'run_command',
  'runcommand',
  // Cline / Roo Code's shell tool (kept in step with the Rust SHELL_TOOLS).
  'execute_command',
  // Gemini CLI's shell tool.
  'run_shell_command',
  'terminal',
  'execute',
  'exec',
]

/** Tool names harnesses use for "read a file". */
export const READ_TOOLS: readonly string[] = ['read', 'readfile', 'view', 'cat', 'open_file']

/** Tool names harnesses use for "fetch a URL". */
export const FETCH_TOOLS: readonly string[] = ['webfetch', 'fetch', 'http_request', 'browser', 'web_search']

/**
 * Path fragments that indicate infrastructure-as-code.
 * Source: `packages/proxy/src/manifest.rs:280` (`INFRA_PATH_FRAGMENTS`).
 * Used to decide when a WRITE deserves an image-integrity check.
 */
export const INFRA_PATH_FRAGMENTS: readonly string[] = [
  'terraform',
  '.tf',
  'k8s/',
  'kubernetes/',
  'helm/',
  'dockerfile',
  'docker-compose',
  '.tfstate',
]

/**
 * Concatenate the string-ish values of a tool's arguments, lowercased.
 *
 * Which key holds the command varies by harness (`command`, `cmd`, `script`,
 * `file_path`, `path`, `url`), and a new harness will invent another. Reading
 * every string value means an unknown key still classifies correctly.
 *
 * Mirrors the Python/Rust exactly, including the leading space before each
 * nested value — spacing changes which patterns can straddle a value
 * boundary.
 */
export function flattenInput(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase()
  if (Array.isArray(value)) return value.map((v) => ' ' + flattenInput(v)).join('')
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((v) => ' ' + flattenInput(v))
      .join('')
  }
  // Numbers, booleans and null/undefined contribute nothing.
  return ''
}

/**
 * Does `words` contain any of `patterns`, whatever separates each phrase's
 * words? A one-word pattern is a plain substring (see phrases.ts).
 */
function matchesPhrase(words: PhraseText, patterns: readonly string[]): boolean {
  return patterns.some((p) => hasPhrase(words, p))
}

export function matchesAny(haystack: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => haystack.includes(p))
}

/**
 * Match a tool name against a group.
 *
 * `endsWith` is what lets namespaced names like `mcp__sh__bash` classify.
 */
export function toolIs(name: string, group: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return group.some((t) => lower === t || lower.endsWith(t))
}

/**
 * A force push: the `git push` phrase, and `--force` or `-f` as a whole word
 * anywhere in the command, whitespace collapsed and padded with a space at
 * each end.
 */
export function isForcePush(words: PhraseText, args: string): boolean {
  if (!hasPhrase(words, 'git push')) return false
  const padded = ' ' + args.replace(/[ \t\n\r\f\v]+/g, ' ') + ' '
  return FORCE_PUSH_FLAGS.some((f) => padded.includes(f))
}

/**
 * A recursive, forced `rm` (`-rf`, `-fr`, `-r -f`, `--recursive --force`, in
 * any case) with a target outside the working tree: absolute, under `~`, or
 * containing `..`. `rm -rf build/` is not one. The command is cut into
 * segments at `;`, `&`, `|`, `(`, `)` and newlines; in each, the first word
 * that is `rm` (or ends `/rm`) starts it, and every later word is a flag
 * (before `--`) or a target, quotes stripped. Linear in the command.
 */
export function removesOutsideTree(args: string): boolean {
  for (const segment of args.split(/[;&|()\n]/)) {
    const words = segment.split(/[ \t\r\f\v]+/).filter((w) => w !== '')
    const at = words.findIndex((w) => w === 'rm' || w.endsWith('/rm'))
    if (at === -1) continue
    let recursive = false
    let force = false
    let flags = true
    const targets: string[] = []
    for (const w of words.slice(at + 1)) {
      if (flags && w === '--') flags = false
      else if (flags && w.startsWith('--')) {
        if (w === '--recursive') recursive = true
        if (w === '--force') force = true
      } else if (flags && w.startsWith('-') && w.length > 1) {
        const lower = w.toLowerCase()
        if (lower.includes('r')) recursive = true
        if (lower.includes('f')) force = true
      } else {
        let a = 0
        let b = w.length
        while (a < b && (w[a] === '"' || w[a] === "'")) a++
        while (b > a && (w[b - 1] === '"' || w[b - 1] === "'")) b--
        targets.push(w.slice(a, b))
      }
    }
    if (recursive && force && targets.some((t) => t.startsWith('/') || t.startsWith('~') || t.includes('..'))) return true
  }
  return false
}

/**
 * Classify one tool call into the abstract actions it performs.
 *
 * Returns prefixed tokens (`action:deploy`, ...) in the order the Rust/Python
 * emit them. Order matters: the ordering detectors read position in the
 * sequence.
 */
export function classify(toolName: string, toolInput: unknown): string[] {
  const args = flattenInput(toolInput)
  const actions: string[] = []
  // Cut into words once, for every phrase list below (see phrases.ts).
  const words = phraseText(args)

  if (toolIs(toolName, SHELL_TOOLS)) {
    // Tests first: `make test && git push` is both, and the ordering rule
    // needs the test to be seen as having happened before the deploy.
    if (matchesPhrase(words, TEST_PATTERNS)) actions.push('run_tests')
    if (matchesPhrase(words, DEPLOY_PATTERNS)) actions.push('deploy')
    if (matchesPhrase(words, PUBLISH_PATTERNS)) actions.push('publish')
    if (matchesPhrase(words, RELEASE_PATTERNS)) actions.push('release')
    // Source before sink, so that (secret_read -> http_post) can still fire
    // on a single command that does both.
    if (matchesAny(args, SECRET_PATH_FRAGMENTS)) actions.push('secret_read')
    if (matchesAny(args, PII_PATH_FRAGMENTS)) actions.push('pii_export')
    if (matchesPhrase(words, HTTP_POST_PATTERNS)) actions.push('http_post')
    if (matchesPhrase(words, DB_WRITE_PATTERNS)) actions.push('db_write')
    // The newer tokens, after the eight, in this order in every
    // classifier: each is a lane (lanes.ts), not an ordering step.
    if (matchesPhrase(words, MIGRATE_PATTERNS)) actions.push('migrate')
    if (matchesPhrase(words, PROD_WRITE_PATTERNS)) actions.push('prod_write')
    if (matchesPhrase(words, DESTROY_PATTERNS) || removesOutsideTree(args)) actions.push('destroy')
    if (isForcePush(words, args)) actions.push('force_push')
    if (matchesPhrase(words, PAYMENT_PATTERNS)) actions.push('payment')
  }

  return actions.map((a) => ACTION_PREFIX + a)
}

/** True when this call would deploy — the trigger for the image check. */
export function isDeploy(toolName: string, toolInput: unknown): boolean {
  return classify(toolName, toolInput).includes(ACTION_PREFIX + 'deploy')
}

/** True when this call runs a test suite. */
export function isTest(toolName: string, toolInput: unknown): boolean {
  return classify(toolName, toolInput).includes(ACTION_PREFIX + 'run_tests')
}

/** True when a written path is infrastructure-as-code. */
export function touchesInfra(path: string | null | undefined): boolean {
  return matchesAny((path ?? '').toLowerCase(), INFRA_PATH_FRAGMENTS)
}
