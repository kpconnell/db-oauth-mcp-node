import { describe, expect, it } from 'vitest';
import { buildConfig } from '../../src/mssql/engine.js';
import type { ConnectionSpec } from '../../src/engine/engine.js';

/**
 * Mirrors `internal/mssql/engine_test.go`. The point of these tests is
 * to lock the options-map -> driver-config translation that fixes the
 * RDS self-signed-cert problem.
 */

function baseSpec(): ConnectionSpec {
  return {
    host: 'db.example.com',
    port: 1433,
    username: 'alice',
    password: 's3cret',
    databases: ['AppDB'],
  };
}

describe('buildConfig — defaults', () => {
  it('no options: leaves encrypt / trust unset', () => {
    const { config, encrypt, trust } = buildConfig(baseSpec());
    expect(config.server).toBe('db.example.com');
    expect(config.port).toBe(1433);
    expect(config.user).toBe('alice');
    expect(config.password).toBe('s3cret');
    expect(config.database).toBe('AppDB');
    expect(config.options?.encrypt).toBeUndefined();
    expect(config.options?.trustServerCertificate).toBeUndefined();
    expect(encrypt).toBe('');
    expect(trust).toBe('');
  });
});

describe('buildConfig — encrypt: false (RDS self-signed case)', () => {
  it('sets encrypt=false and trustServerCertificate=true when both flags present', () => {
    const spec = baseSpec();
    spec.options = {
      encrypt: false,
      trust_server_certificate: true,
    };
    const { config, encrypt, trust } = buildConfig(spec);
    expect(config.options?.encrypt).toBe(false);
    expect(config.options?.trustServerCertificate).toBe(true);
    expect(encrypt).toBe('false');
    expect(trust).toBe('true');
  });
});

describe('buildConfig — encrypt: true (require TLS)', () => {
  it('sets encrypt=true', () => {
    const spec = baseSpec();
    spec.options = { encrypt: true };
    const { config } = buildConfig(spec);
    expect(config.options?.encrypt).toBe(true);
  });
});

describe('buildConfig — string-form booleans', () => {
  it('accepts "false" / "yes" the same as native bools', () => {
    const spec = baseSpec();
    spec.options = {
      encrypt: 'false',
      trust_server_certificate: 'yes',
    };
    const { config } = buildConfig(spec);
    expect(config.options?.encrypt).toBe(false);
    expect(config.options?.trustServerCertificate).toBe(true);
  });
});

describe('buildConfig — trust=false leaves param unset', () => {
  it('trustServerCertificate stays undefined when trust_server_certificate is false', () => {
    const spec = baseSpec();
    spec.options = { trust_server_certificate: false };
    const { config, trust } = buildConfig(spec);
    expect(config.options?.trustServerCertificate).toBeUndefined();
    expect(trust).toBe('');
  });
});

describe('buildConfig — no database', () => {
  it('omits database when spec.databases is empty', () => {
    const spec = baseSpec();
    spec.databases = [];
    const { config } = buildConfig(spec);
    expect(config.database).toBeUndefined();
  });
});

describe('buildConfig — unknown options ignored', () => {
  it('does not leak unknown keys into config', () => {
    const spec = baseSpec();
    spec.options = {
      future_knob: 'maybe',
      encrypt: false,
    };
    const { config } = buildConfig(spec);
    expect(config.options?.encrypt).toBe(false);
    expect(
      (config.options as unknown as Record<string, unknown>)['future_knob'],
    ).toBeUndefined();
  });
});
