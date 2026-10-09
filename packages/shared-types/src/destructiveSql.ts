/**
 * Destructive SQL as a text rule: the statements every blocking text scanner
 * refuses in tool arguments, and what may separate their keywords.
 *
 * The control plane's DLP (`POST /api/v1/hook-gate`, which both gate SDKs'
 * server tier, the AgentCore interceptor, OpenAI Agents trace ingest and the
 * QM security screen run) and the MCP governance proxy's DLP read both from
 * here. The harness hook gates carry the same statements as the
 * `destructive.sql_drop` rule, in POSIX ERE (`protectedPaths.ts`); the action
 * classifiers in the Rust proxy and both gate SDKs read keyword phrases with
 * the same gap. `fixtures/destructive-sql-vectors.json` holds every one of
 * them to the same answers.
 *
 * A text rule, not a SQL parser: a quoted mention (`SELECT 'drop table'`) is
 * refused too, because quoting is how a shell command carries the real
 * statement (`psql -c 'DROP TABLE x'`). The proxy's `sql_guard`, which parses
 * the SQL a client will run, is the one that tells them apart.
 */

/**
 * What may separate two SQL keywords: whitespace, a newline, tab or carriage
 * return written as a two-character escape (`\n`, as `printf` expands it and
 * as JSON encodes a newline), a block comment, or a `--` comment that runs to
 * a newline. Byte-identical to `SQL_GAP` in the proxy's
 * `plugins/anomaly/actions.rs` (a test compares them), where the comment
 * explains why the gap is matched rather than stripped from the text.
 */
export const SQL_GAP = String.raw`(?:\s|\\[ntr]|/\*(?:[^*]|\*+[^*/])*\*+/|--(?:[^\n\\]|\\[^n\n])*(?:\n|\\n))+`

/** The statements a text scanner refuses, as the keywords that open each. */
export const DESTRUCTIVE_SQL_STATEMENTS = [
  { statement: 'DROP TABLE', description: 'SQL DROP TABLE statement' },
  { statement: 'DROP DATABASE', description: 'SQL DROP DATABASE statement' },
  { statement: 'DROP SCHEMA', description: 'SQL DROP SCHEMA statement' },
  { statement: 'TRUNCATE TABLE', description: 'SQL TRUNCATE TABLE statement' },
] as const

export type DestructiveSqlStatement = (typeof DESTRUCTIVE_SQL_STATEMENTS)[number]['statement']

/**
 * One case-insensitive pattern per statement, its keywords joined by
 * {@link SQL_GAP}. No `g` flag, so a shared instance carries no `lastIndex`.
 */
export const DESTRUCTIVE_SQL_PATTERNS: ReadonlyArray<{
  statement: DestructiveSqlStatement
  description: string
  regex: RegExp
}> = DESTRUCTIVE_SQL_STATEMENTS.map(({ statement, description }) => ({
  statement,
  description,
  regex: new RegExp(statement.split(' ').join(SQL_GAP), 'i'),
}))
