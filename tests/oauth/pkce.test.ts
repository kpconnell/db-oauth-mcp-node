import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { challenge, newState, newVerifier } from '../../src/oauth/pkce.js';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('pkce', () => {
  it('verifier is base64url, ≥43 chars', () => {
    const v = newVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v.length).toBeGreaterThanOrEqual(43);
  });

  it('challenge equals base64url(sha256(verifier))', () => {
    const v = newVerifier();
    const expected = base64url(createHash('sha256').update(v).digest());
    expect(challenge(v)).toBe(expected);
  });

  it('newState returns distinct values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(newState());
    expect(seen.size).toBe(20);
  });
});
