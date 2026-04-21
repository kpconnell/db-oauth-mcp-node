import { describe, expect, it } from 'vitest';
import { validateSQL } from '../../src/mariadb/safety.js';

/**
 * Mirrors `internal/mariadb/safety_test.go` in the Go repo.
 * Each case here exists there too; any divergence is a porting bug.
 */

describe('validateSQL — allowed', () => {
  const ok = [
    'SELECT 1',
    'select * from users where id = 1',
    '  SELECT name FROM t ',
    'SHOW TABLES',
    'DESCRIBE users',
    'DESC users',
    'EXPLAIN SELECT * FROM t',
    'WITH x AS (SELECT 1 AS a) SELECT * FROM x',
    '-- leading comment\nSELECT 1',
    '/* block */ SELECT 1',
  ];
  for (const s of ok) {
    it(JSON.stringify(s), () => {
      expect(() => validateSQL(s)).not.toThrow();
    });
  }
});

describe('validateSQL — rejected', () => {
  const bad = [
    '',
    '   ',
    'UPDATE users SET x=1',
    'DELETE FROM users',
    'INSERT INTO users VALUES (1)',
    'DROP TABLE users',
    'ALTER TABLE users ADD col INT',
    'TRUNCATE users',
    'SELECT 1; SELECT 2',
    "SELECT * INTO OUTFILE '/tmp/x' FROM t",
    "SELECT * INTO DUMPFILE '/tmp/x' FROM t",
    "SELECT LOAD_FILE('/etc/passwd')",
    'WITH x AS (SELECT 1) DELETE FROM x',
  ];
  for (const s of bad) {
    it(JSON.stringify(s), () => {
      expect(() => validateSQL(s)).toThrow();
    });
  }
});

describe('validateSQL — string literals don\'t bypass', () => {
  it('semicolon inside string literal is fine', () => {
    expect(() => validateSQL("SELECT 'hello; world' AS s")).not.toThrow();
  });
  it('keyword inside string literal is fine', () => {
    expect(() => validateSQL("SELECT 'DROP TABLE users' AS s")).not.toThrow();
  });
  it('trailing semicolon is fine', () => {
    expect(() => validateSQL('SELECT 1;')).not.toThrow();
  });
});
