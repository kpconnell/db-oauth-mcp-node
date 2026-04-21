import { describe, expect, it } from 'vitest';
import { validateSQL } from '../../src/mssql/safety.js';

/** Mirrors `internal/mssql/safety_test.go`. */

describe('validateSQL — allowed', () => {
  const ok = [
    'SELECT 1',
    'select * from dbo.users where id = 1',
    '  SELECT TOP 10 name FROM t ',
    'WITH x AS (SELECT 1 AS a) SELECT * FROM x',
    "EXEC sp_help 'dbo.users'",
    'EXECUTE sp_columns users',
    'EXEC dbo.sp_tables',
    "EXEC sp_describe_first_result_set N'SELECT 1'",
    '-- leading comment\nSELECT 1',
    '/* block */ SELECT 1',
    'SELECT @x = 1',
    'SELECT 1 INTO @var',
    'SELECT 1 INTO #temp',
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
    'TRUNCATE TABLE users',
    'MERGE INTO t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET x=1',
    'CREATE TABLE new_t (id INT)',
    'SELECT 1; SELECT 2',
    'SELECT * INTO NewTable FROM OldTable',
    "SELECT * FROM OPENROWSET('x','y','z')",
    "SELECT * FROM OPENDATASOURCE('x','y')",
    "BULK INSERT t FROM 'c:/x.txt'",
    "EXEC xp_cmdshell 'dir'",
    "EXEC sp_executesql N'DROP TABLE t'",
    "EXEC('SELECT 1')",
    "EXEC ('SELECT 1')",
    "EXECUTE('SELECT 1')",
    'EXEC dbo.custom_proc',
    'EXEC @proc',
    "EXEC sp_help; EXEC xp_cmdshell 'dir'",
    'WITH x AS (SELECT 1) DELETE FROM x',
  ];
  for (const s of bad) {
    it(JSON.stringify(s), () => {
      expect(() => validateSQL(s)).toThrow();
    });
  }
});

describe('validateSQL — strings do not bypass', () => {
  const cases = [
    "SELECT 'DROP TABLE users' AS s",
    "SELECT 'hello; world' AS s",
    "SELECT 'it''s here' AS s", // T-SQL double-quote escape
  ];
  for (const s of cases) {
    it(JSON.stringify(s), () => {
      expect(() => validateSQL(s)).not.toThrow();
    });
  }
});

describe('validateSQL — trailing semicolon ok', () => {
  it('SELECT 1;', () => {
    expect(() => validateSQL('SELECT 1;')).not.toThrow();
  });
});
