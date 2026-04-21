/**
 * SQL safety enforcement for Microsoft SQL Server (T-SQL).
 *
 * Ported verbatim from `internal/mssql/safety.go` in the Go repo.
 *
 * Allowed lead keywords:
 *   SELECT, WITH, EXEC, EXECUTE
 *
 * EXEC is further restricted to a small allowlist of read-only system
 * procedures (sp_help / sp_columns / sp_tables / sp_describe_first_result_set etc.).
 *
 * Hard-denied regardless of lead keyword:
 *   xp_cmdshell, OPENROWSET, OPENDATASOURCE, BULK INSERT, sp_executesql,
 *   EXEC(...) / EXECUTE(...) (dynamic SQL), SELECT ... INTO <table>
 *   (variable and temp-table INTO are allowed).
 */

const ALLOWED_LEAD_KEYWORDS = new Set(['SELECT', 'WITH', 'EXEC', 'EXECUTE']);

const ALLOWED_SYS_PROCS = new Set([
  'SP_HELP',
  'SP_HELPTEXT',
  'SP_COLUMNS',
  'SP_TABLES',
  'SP_STORED_PROCEDURES',
  'SP_DESCRIBE_FIRST_RESULT_SET',
  'SP_WHO',
  'SP_WHO2',
]);

/**
 * Hard-denied substrings matched against uppercased SQL with string
 * contents stripped. Non-exhaustive by design — the lead-keyword check
 * catches classic DML/DDL; this list catches T-SQL-specific escape hatches.
 */
const DENY_PATTERNS = [
  'XP_CMDSHELL',
  'OPENROWSET(',
  'OPENDATASOURCE(',
  'BULK INSERT',
  'SP_EXECUTESQL',
  'EXEC(',
  'EXEC (',
  'EXECUTE(',
  'EXECUTE (',
] as const;

export function validateSQL(sql: string): void {
  const trimmed = stripComments(sql.trim());
  if (trimmed === '') throw new Error('empty SQL');

  const stripped = stripStrings(trimmed);

  // Reject any statement separator outside strings.
  const trailingStripped = stripped.replace(/[\s;]+$/u, '');
  if (trailingStripped.includes(';')) {
    throw new Error('multiple statements are not allowed');
  }

  const upper = stripped.toUpperCase();
  for (const bad of DENY_PATTERNS) {
    if (upper.includes(bad)) {
      throw new Error(`disallowed SQL feature: ${bad.replace(/\($/, '')}`);
    }
  }

  checkSelectInto(upper);

  const lead = firstWord(upper);
  if (!ALLOWED_LEAD_KEYWORDS.has(lead)) {
    throw new Error(
      `only SELECT, WITH, and EXEC (for sp_help/sp_columns/sp_tables) are permitted (got "${lead}")`,
    );
  }

  if (lead === 'WITH') {
    if (!withLeadsToSelect(upper)) {
      throw new Error('WITH clauses must resolve to a SELECT');
    }
  } else if (lead === 'EXEC' || lead === 'EXECUTE') {
    let proc = secondWord(upper);
    // Allow optional schema prefix: e.g. dbo.sp_help.
    const lastDot = proc.lastIndexOf('.');
    if (lastDot >= 0) proc = proc.slice(lastDot + 1);
    if (!ALLOWED_SYS_PROCS.has(proc)) {
      throw new Error(`EXEC target "${proc}" is not in the read-only allowlist`);
    }
  }
}

/**
 * Scan for ` INTO <target>` at any position. Target must begin with `@`
 * (variable) or `#` (temp table) to be allowed. Anything else means
 * `SELECT ... INTO NewTable` which creates a new table.
 */
function checkSelectInto(upper: string): void {
  const padded = ' ' + upper + ' ';
  let i = 0;
  for (;;) {
    const idx = padded.indexOf(' INTO ', i);
    if (idx < 0) return;
    let pos = idx + ' INTO '.length;
    while (pos < padded.length && padded[pos] === ' ') pos++;
    if (pos >= padded.length) return;
    const ch = padded[pos];
    if (ch !== '@' && ch !== '#') {
      throw new Error('SELECT INTO is not allowed (creates a table)');
    }
    i = pos;
  }
}

function firstWord(s: string): string {
  const trimmed = s.trim();
  const match = /^[^\s(]+/u.exec(trimmed);
  return match ? match[0] : trimmed;
}

function secondWord(s: string): string {
  const trimmed = s.trim();
  // Skip first token.
  let i = 0;
  while (i < trimmed.length && !/\s/u.test(trimmed[i])) i++;
  while (i < trimmed.length && /\s/u.test(trimmed[i])) i++;
  const start = i;
  while (
    i < trimmed.length &&
    !/\s/u.test(trimmed[i]) &&
    trimmed[i] !== '(' &&
    trimmed[i] !== ';'
  ) {
    i++;
  }
  return trimmed.slice(start, i);
}

function withLeadsToSelect(upper: string): boolean {
  let depth = 0;
  const tokens = upper.split(/\s+/u).filter((t) => t.length > 0);
  for (const tok of tokens) {
    for (const ch of tok) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth === 0 && tok === 'SELECT') return true;
  }
  return false;
}

function stripComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (i + 1 < s.length && s[i] === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (i + 1 < s.length && s[i] === '/' && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * Replace contents of quoted strings with spaces. T-SQL uses `[brackets]`
 * for identifiers (not string data), so we leave those untouched. T-SQL
 * also escapes quotes by doubling (`''`) — skip those as a pair.
 */
function stripStrings(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const quote = c;
      out += c;
      i++;
      while (i < s.length) {
        if (s[i] === quote && i + 1 < s.length && s[i + 1] === quote) {
          out += '  ';
          i += 2;
          continue;
        }
        if (s[i] === quote) {
          out += quote;
          i++;
          break;
        }
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
