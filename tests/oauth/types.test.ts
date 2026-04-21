import { describe, expect, it } from 'vitest';
import {
  earliestExpiry,
  findConnection,
  parseTokenResponse,
  type TokenResponse,
} from '../../src/oauth/types.js';

function mkConn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'prod',
    engine: 'mariadb',
    host: 'db.example.com',
    port: 3306,
    username: 'u',
    password: 'p',
    databases: ['app'],
    expires_at: '2026-12-31T23:59:00Z',
    ...overrides,
  };
}

describe('parseTokenResponse — options field (Laravel quirk tolerance)', () => {
  it('accepts options as an object', () => {
    const raw = {
      access_token: 'a',
      expires_in: 3600,
      refresh_token: 'r',
      connections: [mkConn({ options: { encrypt: false, trust_server_certificate: true } })],
    };
    const tr = parseTokenResponse(raw);
    expect(tr.connections[0].options).toEqual({
      encrypt: false,
      trust_server_certificate: true,
    });
  });

  it('accepts options as [] (PHP empty-array quirk) and normalizes to undefined', () => {
    const raw = {
      access_token: 'a',
      connections: [mkConn({ options: [] })],
    };
    const tr = parseTokenResponse(raw);
    expect(tr.connections[0].options).toBeUndefined();
    expect(tr.connections[0].name).toBe('prod');
  });

  it('accepts options as null and normalizes to undefined', () => {
    const raw = {
      access_token: 'a',
      connections: [mkConn({ options: null })],
    };
    const tr = parseTokenResponse(raw);
    expect(tr.connections[0].options).toBeUndefined();
  });

  it('accepts missing options and leaves it undefined', () => {
    const raw = { access_token: 'a', connections: [mkConn()] };
    const tr = parseTokenResponse(raw);
    expect(tr.connections[0].options).toBeUndefined();
  });

  it('rejects options as a non-empty array', () => {
    const raw = {
      access_token: 'a',
      connections: [mkConn({ options: ['oops'] })],
    };
    expect(() => parseTokenResponse(raw)).toThrow(/non-empty array/);
  });
});

describe('parseTokenResponse — structural validation', () => {
  it('requires connections to be an array', () => {
    expect(() => parseTokenResponse({ access_token: 'a', connections: {} })).toThrow(
      /connections/,
    );
  });

  it('parses expires_at to Date', () => {
    const raw = {
      access_token: 'a',
      connections: [mkConn({ expires_at: '2026-04-21T12:00:00Z' })],
    };
    const tr = parseTokenResponse(raw);
    expect(tr.connections[0].expiresAt).toBeInstanceOf(Date);
    expect(tr.connections[0].expiresAt.toISOString()).toBe('2026-04-21T12:00:00.000Z');
  });

  it('populates all primitive fields', () => {
    const raw = {
      access_token: 'tok',
      token_type: 'Bearer',
      expires_in: 86400,
      refresh_token: 'rtok',
      connections: [
        {
          name: 'reporting',
          engine: 'mssql',
          host: 'mssql.example.com',
          port: 1433,
          username: 'oa_abc',
          password: 'p@ss',
          databases: ['DW', 'Staging'],
          expires_at: '2026-04-21T12:00:00Z',
        },
      ],
    };
    const tr = parseTokenResponse(raw);
    expect(tr.accessToken).toBe('tok');
    expect(tr.refreshToken).toBe('rtok');
    expect(tr.expiresIn).toBe(86400);
    expect(tr.connections[0]).toMatchObject({
      name: 'reporting',
      engine: 'mssql',
      host: 'mssql.example.com',
      port: 1433,
      username: 'oa_abc',
      password: 'p@ss',
      databases: ['DW', 'Staging'],
    });
  });
});

describe('findConnection / earliestExpiry', () => {
  function tr(conns: Record<string, unknown>[]): TokenResponse {
    return parseTokenResponse({ access_token: 'a', connections: conns });
  }

  it('findConnection returns the right match', () => {
    const t = tr([mkConn({ name: 'a' }), mkConn({ name: 'b', engine: 'mssql' })]);
    const c = findConnection(t, 'b');
    expect(c?.engine).toBe('mssql');
    expect(findConnection(t, 'nope')).toBeUndefined();
  });

  it('earliestExpiry returns the soonest expires_at', () => {
    const t = tr([
      mkConn({ name: 'a', expires_at: '2026-06-01T00:00:00Z' }),
      mkConn({ name: 'b', expires_at: '2026-05-01T00:00:00Z' }),
      mkConn({ name: 'c', expires_at: '2026-07-01T00:00:00Z' }),
    ]);
    const e = earliestExpiry(t);
    expect(e?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('earliestExpiry returns null when no connection has a real expiry', () => {
    const t = tr([mkConn({ expires_at: '' })]);
    expect(earliestExpiry(t)).toBeNull();
  });
});
