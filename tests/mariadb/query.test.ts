import { describe, expect, it } from 'vitest';
import { BINARY_INLINE_THRESHOLD, serializeValue } from '../../src/mariadb/query.js';
import type { FieldPacket } from 'mysql2/promise';

/**
 * Mirrors `internal/mariadb/query_test.go`. Each case there has a case
 * here — any divergence is a porting bug.
 */

function field(columnType: number, name = 'c', flags = 0): FieldPacket {
  return { name, columnType, flags } as unknown as FieldPacket;
}

// Type codes used: DECIMAL=0x00, DATE=0x0a, DATETIME=0x0c, BLOB=0xfc,
// VARCHAR=0xfd (no BINARY flag), VARBINARY=0xfd + flag 0x80.
const DECIMAL = () => field(0x00, 'd');
const DATE = () => field(0x0a, 'd');
const DATETIME = () => field(0x0c, 'dt');
const BLOB = () => field(0xfc, 'blob');
const VARCHAR = () => field(0xfd, 'v');

describe('serializeValue', () => {
  it('nil stays nil', () => {
    expect(serializeValue(null, VARCHAR())).toBeNull();
  });

  it('DECIMAL Buffer preserves precision as string', () => {
    expect(serializeValue(Buffer.from('123.456'), DECIMAL())).toBe('123.456');
  });

  it('VARCHAR Buffer -> string', () => {
    expect(serializeValue(Buffer.from('hello'), VARCHAR())).toBe('hello');
  });

  it('DATETIME Buffer -> ISO', () => {
    const got = serializeValue(Buffer.from('2024-01-15 10:30:00'), DATETIME());
    expect(typeof got).toBe('string');
    expect(got).toMatch(/^2024-01-15T10:30:00/);
  });

  it('DATE Buffer stays date-only', () => {
    expect(serializeValue(Buffer.from('2024-01-15'), DATE())).toBe('2024-01-15');
  });

  it('small BLOB -> base64', () => {
    const got = serializeValue(Buffer.from([0x01, 0x02, 0x03]), BLOB());
    expect(got).toBe(Buffer.from([0x01, 0x02, 0x03]).toString('base64'));
  });

  it('large BLOB -> <N bytes> placeholder', () => {
    const big = Buffer.alloc(BINARY_INLINE_THRESHOLD + 1);
    const got = serializeValue(big, BLOB());
    expect(got).toBe(`<${big.length} bytes>`);
  });

  it('Date as DATE -> yyyy-mm-dd', () => {
    const d = new Date(Date.UTC(2024, 0, 15, 10, 30, 0));
    expect(serializeValue(d, DATE())).toBe('2024-01-15');
  });

  it('Date as DATETIME -> RFC3339 (no fractional seconds)', () => {
    const d = new Date(Date.UTC(2024, 0, 15, 10, 30, 0));
    expect(serializeValue(d, DATETIME())).toBe('2024-01-15T10:30:00Z');
  });
});
