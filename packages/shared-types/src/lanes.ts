/**
 * Reversibility lanes: every action token's class, the tokens a
 * set of SOPs and the workspace close, and the hold rules a closed token
 * compiles to.
 *
 * | Class | Tokens |
 * |---|---|
 * | `reversible_contained` | `run_tests`, `secret_read`, `pii_export` |
 * | `reversible_wide` | `deploy`, `release`, `db_write`, `http_post`, `migrate`, `prod_write` |
 * | `irreversible` | `publish`, `destroy`, `force_push`, `payment` |
 *
 * Only `irreversible` and `reversible_wide` can be closed. A closed token is
 * held for a person (the existing hold, decision and bypass path), never
 * refused outright, except with no control plane, where a hold compiles to a
 * block because nobody could approve it.
 *
 * {@link laneHoldTokens} is the rule (`collect_lane_holds` in the proxy's
 * sops.rs mirrors it):
 *
 * 1. each applicable SOP that declares `closed_lanes:` closes the tokens of
 *    the classes it lists, plus every `reversible_wide` token when its
 *    `risk_tier` is HIGH or CRITICAL, minus its own top-level `open_actions:`;
 * 2. the workspace setting `closedLanes` closes its classes for everyone,
 *    and `open_actions:` does not reopen them;
 * 3. the union.
 *
 * `risk_tier` alone closes nothing.
 *
 * Self-contained, so `@intutic/gate` keeps a byte-identical copy. The Python
 * port is in `intutic_clawde/gate/actions.py`; `fixtures/lane-vectors.json`
 * holds the ports and the proxy's `token_class()` equal.
 *
 * @module
 */

/** A token's reversibility class. */
export type LaneClass = 'irreversible' | 'reversible_wide' | 'reversible_contained'
/** The classes `closed_lanes:` and `closedLanes` may name. */
export type ClosableLane = 'irreversible' | 'reversible_wide'
export const CLOSABLE_LANES: readonly ClosableLane[] = ['irreversible', 'reversible_wide']

/** Every action token's class, in the order of `ACTION_TOKENS` (guardrailIr.ts). */
export const TOKEN_CLASS: Readonly<Record<string, LaneClass>> = {
  'action:deploy': 'reversible_wide',
  'action:publish': 'irreversible',
  'action:release': 'reversible_wide',
  'action:db_write': 'reversible_wide',
  'action:secret_read': 'reversible_contained',
  'action:http_post': 'reversible_wide',
  'action:pii_export': 'reversible_contained',
  'action:run_tests': 'reversible_contained',
  'action:migrate': 'reversible_wide',
  'action:prod_write': 'reversible_wide',
  'action:destroy': 'irreversible',
  'action:force_push': 'irreversible',
  'action:payment': 'irreversible',
}

/**
 * The phrases a phrase-subject hold rule matches a token by: the classifier's
 * needles (gate-js `actions.ts`, held equal by a test). A token with none
 * (`secret_read` and `pii_export` read path fragments) is held by its action
 * subject only. `force_push` is a compound (the `git push` phrase and a
 * whole-word `--force` or `-f`); its phrases here are the partial form an
 * older gate can match.
 */
export const LANE_PHRASES: Readonly<Record<string, readonly string[]>> = {
  'action:deploy': ['git push', 'kubectl apply', 'kubectl rollout', 'helm upgrade', 'helm install', 'terraform apply', 'docker push', 'serverless deploy', 'fly deploy', 'vercel deploy', 'gcloud run deploy', 'aws deploy', 'aws s3 sync', 'eb deploy'],
  'action:publish': ['npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'twine upload', 'poetry publish', 'gem push', 'docker manifest push'],
  'action:release': ['gh release create', 'git tag', 'npm version', 'cargo release', 'goreleaser release', 'semantic-release'],
  'action:db_write': ['insert into', 'update ', 'delete from', 'drop table', 'drop database', 'drop schema', 'truncate ', 'alter table'],
  'action:http_post': ['curl -x post', 'curl --request post', 'curl -d ', 'curl --data', 'wget --post', 'http post'],
  'action:run_tests': ['npm test', 'npm run test', 'pnpm test', 'pnpm run test', 'yarn test', 'cargo test', 'go test', 'pytest', 'python -m pytest', 'vitest', 'jest', 'mocha', 'rspec', 'phpunit', 'make test', 'gradle test', 'mvn test', 'dotnet test', 'bazel test', 'tox'],
  'action:migrate': ['prisma migrate deploy', 'prisma db push', 'alembic upgrade', 'alembic downgrade', 'rails db:migrate', 'rake db:migrate', 'manage.py migrate', 'flyway migrate', 'liquibase update', 'knex migrate:latest', 'sequelize db:migrate'],
  'action:prod_write': ['--prod', 'rails_env=production', 'node_env=production', '--context prod', '--namespace production', '-n production', '--environment production', '--stage prod'],
  'action:destroy': ['terraform destroy', 'kubectl delete', 'helm uninstall', 'helm delete', 'drop table', 'drop database', 'drop schema', 'truncate ', 'aws s3 rb', 'aws s3 rm'],
  'action:force_push': ['git push --force', 'git push -f'],
  'action:payment': ['api.stripe.com/v1/charges', 'api.stripe.com/v1/payment_intents', 'api.stripe.com/v1/transfers', 'api.stripe.com/v1/payouts', 'api.stripe.com/v1/refunds', 'stripe charges create', 'stripe payment_intents create', 'stripe transfers create', 'stripe payouts create', 'api-m.paypal.com/v2/payments', 'api.paypal.com/v1/payments'],
}

/** A token's class, or null for a tool name or an unknown token. */
export function tokenLane(token: string): LaneClass | null {
  return Object.prototype.hasOwnProperty.call(TOKEN_CLASS, token) ? TOKEN_CLASS[token]! : null
}

/** The tokens of one class, in {@link TOKEN_CLASS} order. */
export function tokensOfClass(cls: LaneClass): string[] {
  return Object.keys(TOKEN_CLASS).filter((t) => TOKEN_CLASS[t] === cls)
}

/** The strongest class among `tokens` (irreversible, then reversible_wide, then reversible_contained), or null when none has one. The decide log's `lane`. */
export function laneOf(tokens: readonly string[]): LaneClass | null {
  let best: LaneClass | null = null
  for (const t of tokens) {
    const c = tokenLane(t)
    if (c === 'irreversible') return c
    if (c === 'reversible_wide') best = c
    else if (c === 'reversible_contained' && best === null) best = c
  }
  return best
}

/** One applicable SOP as {@link laneHoldTokens} reads it: its parsed `closed_lanes:`, top-level `open_actions:` and `risk_tier:`. */
export interface LaneSop {
  closedLanes: readonly string[]
  openActions: readonly string[]
  /** `LOW`, `MEDIUM`, `HIGH` or `CRITICAL` in any case; null or absent when unstated. */
  riskTier?: string | null
}

/**
 * The tokens held for review: each SOP's closed classes (and, at HIGH or
 * CRITICAL, `reversible_wide`) minus its own `open_actions:`, united with
 * the workspace's `closedLanes`. In {@link TOKEN_CLASS} order, each once. An
 * unknown class closes nothing (the parser already reported it).
 */
export function laneHoldTokens(input: { sops: readonly LaneSop[]; workspaceLanes?: readonly string[] | null }): string[] {
  const held: Record<string, true> = {}
  for (const sop of input.sops) {
    if (sop.closedLanes.length === 0) continue
    const tier = (sop.riskTier ?? '').toUpperCase()
    const classes = sop.closedLanes.slice()
    if (tier === 'HIGH' || tier === 'CRITICAL') classes.push('reversible_wide')
    for (const token of Object.keys(TOKEN_CLASS)) {
      const c = TOKEN_CLASS[token]!
      if (c !== 'reversible_contained' && classes.indexOf(c) !== -1 && sop.openActions.indexOf(token) === -1) held[token] = true
    }
  }
  for (const token of Object.keys(TOKEN_CLASS)) {
    const c = TOKEN_CLASS[token]!
    if (c !== 'reversible_contained' && (input.workspaceLanes ?? []).indexOf(c) !== -1) held[token] = true
  }
  return Object.keys(TOKEN_CLASS).filter((t) => held[t] === true)
}

/** A lane hold rule's id: `sop.lane.<class>.<token>`. */
export function laneHoldRuleId(token: string): string {
  return 'sop.lane.' + (tokenLane(token) ?? 'unknown') + '.' + token
}

/** A revert hold rule's id: `revert.<subject>`. */
export function revertHoldRuleId(subject: string): string {
  return 'revert.' + subject
}

/** One snapshot rule a token's hold compiles to; the writer adds the id, severity, reason and rationale. */
export interface HoldPatternSpec {
  subject: 'phrase' | 'action'
  source: string
  ignoreCase: boolean
}

/**
 * The snapshot rules that hold `token`, all under one id so one approval
 * covers each: the `phrase` rule over its phrases, which every gate since
 * v12 reads (so a gate whose classifier predates the token still holds it);
 * and, for a token whose phrases cannot express it (`force_push`'s
 * compound, `destroy`'s `rm -rf` outside the tree, the path-fragment
 * tokens), an `action` rule a v23 classifier matches. `force_push` lists the
 * action rule first, and its phrase rule is the partial form.
 */
export function laneHoldPatterns(token: string): HoldPatternSpec[] {
  const action: HoldPatternSpec = { subject: 'action', source: ' (' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ') ', ignoreCase: true }
  const phrases = Object.prototype.hasOwnProperty.call(LANE_PHRASES, token) ? LANE_PHRASES[token]! : []
  const phrase: HoldPatternSpec | null = phrases.length > 0 ? { subject: 'phrase', source: phrases.join('|'), ignoreCase: true } : null
  if (token === 'action:force_push') return [action, phrase!]
  if (token === 'action:destroy') return [phrase!, action]
  return phrase ? [phrase] : [action]
}
