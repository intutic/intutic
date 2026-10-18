/**
 * The patterns the decide log's arguments excerpt is redacted with: the
 * hook gates' credential-value patterns and the PII detectors' regexes,
 * applied without the detectors' validators, so a stored excerpt loses more
 * than live traffic would, never less. `@intutic/shared-types` derives the
 * list from its own tables (`decideLogRedactionSources`); this package does
 * not depend on it, so it carries the list, and
 * `fixtures/decide-log-vectors.json` holds it to the shared one, as it holds
 * the Python port's.
 *
 * Repetition is spelled out (`[A-Z2-7]` sixteen times) as the shared table
 * spells it, so the sources compare equal.
 *
 * @module
 */

const rep = (cls: string, n: number): string => cls.repeat(n)

export const DECIDE_LOG_REDACTION_SOURCES: readonly string[] = [
  '(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)' + rep('[A-Z2-7]', 16),
  'sk-ant-' + rep('[A-Za-z0-9_-]', 20) + '[A-Za-z0-9_-]*',
  'gh[pousr]_' + rep('[A-Za-z0-9]', 36),
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  'sk-or-v1-' + rep('[A-Za-z0-9]', 20) + '[A-Za-z0-9]*',
  'vk_' + rep('[a-f0-9]', 32),
  'gwk_' + rep('[a-f0-9]', 64),
  'sk_live_' + rep('[A-Za-z0-9]', 24),
  '[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4}|[0-9]{4}[ -][0-9]{6}[ -][0-9]{4,5}|[0-9]{13,19}',
  '[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}',
  '[0-9]{3}-[0-9]{2}-[0-9]{4}',
  '[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){1,8}',
  '\\+[1-9][0-9]{0,2}(?:[ .-]?\\([0-9]{1,4}\\)|[ .-]?[0-9]{1,4}){2,7}' +
    '|(?:1[ .-])?(?:\\([2-9][0-9]{2}\\) ?|[2-9][0-9]{2}[ .-])[2-9][0-9]{2}[ .-][0-9]{4}',
]
