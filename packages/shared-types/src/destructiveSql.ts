/**
 * Destructive SQL as a text rule: the statements every blocking text scanner
 * refuses in tool arguments.
 *
 * The control plane's DLP (`POST /api/v1/hook-gate`, which both gate SDKs'
 * server tier, the AgentCore interceptor and the QM security screen run) and
 * the MCP governance proxy's DLP read both from here. The harness hook gates
 * carry the same phrases as the `destructive.sql_drop` rule
 * (`protectedPaths.ts`). Each statement is matched as words by the phrase
 * matcher (phrases.ts), bounded at both ends: any separator the shell or the
 * database reads as a word break may split the keywords (a comment, an escaped
 * newline, a line continuation, `--` options), but `DROP TABLES` and
 * `truncate --size 0 table.log` are not the statement. No regex runs on the
 * text, so crafted input cannot make the scan backtrack.
 * `fixtures/destructive-sql-vectors.json` holds every implementation to the
 * same answers.
 *
 * A text rule, not a SQL parser: a quoted mention (`SELECT 'drop table'`) is
 * refused too, because quoting is how a shell command carries the real
 * statement (`psql -c 'DROP TABLE x'`). The proxy's `sql_guard`, which parses
 * the SQL a client will run, is the one that tells them apart.
 */
import { hasPhrase, phraseText, type PhraseText } from './phrases.js'

/** The statements a text scanner refuses, and the phrase that finds each. */
export const DESTRUCTIVE_SQL_STATEMENTS = [
  { statement: 'DROP TABLE', phrase: 'drop table', description: 'SQL DROP TABLE statement' },
  { statement: 'DROP DATABASE', phrase: 'drop database', description: 'SQL DROP DATABASE statement' },
  { statement: 'DROP SCHEMA', phrase: 'drop schema', description: 'SQL DROP SCHEMA statement' },
  { statement: 'TRUNCATE TABLE', phrase: 'truncate table', description: 'SQL TRUNCATE TABLE statement' },
] as const

export type DestructiveSqlStatement = (typeof DESTRUCTIVE_SQL_STATEMENTS)[number]['statement']

/**
 * The destructive statements `text` contains, in {@link DESTRUCTIVE_SQL_STATEMENTS}
 * order. Pass a {@link PhraseText} already cut from the text to reuse it.
 */
export function findDestructiveSql(text: string | PhraseText): Array<(typeof DESTRUCTIVE_SQL_STATEMENTS)[number]> {
  const words = typeof text === 'string' ? phraseText(text) : text
  return DESTRUCTIVE_SQL_STATEMENTS.filter((s) => hasPhrase(words, s.phrase, true))
}
