/**
 * SQL safety enforcement for MariaDB / MySQL.
 *
 * Ported verbatim from the Go implementation in
 * `internal/mariadb/safety.go`. The database's GRANTs remain the primary
 * control; this is defense in depth at the MCP layer so an obvious
 * write statement never hits the wire.
 */

const ALLOWED_LEAD_KEYWORDS = new Set([
  'SELECT',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
  'WITH',
]);

/**
 * Denied patterns matched against upper-cased SQL with string contents
 * stripped. Covers the classic SELECT-based escape hatches.
 */
const DENY_PATTERNS = ['INTO OUTFILE', 'INTO DUMPFILE', 'LOAD_FILE('] as const;

/** Throw with a helpful message if sql isn't a permitted read-only statement. */
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

  const lead = firstWord(upper);
  if (!ALLOWED_LEAD_KEYWORDS.has(lead)) {
    throw new Error(
      `only SELECT, SHOW, DESCRIBE, EXPLAIN, and WITH are permitted (got "${lead}")`,
    );
  }

  if (lead === 'WITH' && !withLeadsToSelect(upper)) {
    throw new Error('WITH clauses must resolve to a SELECT');
  }
}

function firstWord(s: string): string {
  const trimmed = s.trim();
  const match = /^[^\s(]+/u.exec(trimmed);
  return match ? match[0] : trimmed;
}

/**
 * Scan a WITH-prefixed statement; return true iff a SELECT token appears
 * at paren depth 0 (i.e. after the CTE list).
 */
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

/** Strip `--` line comments and `/* ... *\/` block comments. */
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
 * Replace contents of quoted strings with spaces so naive keyword scans
 * aren't misled by user data. Handles ' " and ` quotes; respects
 * backslash escapes the way MySQL does.
 */
function stripStrings(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\' && i + 1 < s.length) {
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
