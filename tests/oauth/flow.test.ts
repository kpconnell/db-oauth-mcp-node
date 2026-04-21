import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { buildAuthorizeURL } from '../../src/oauth/flow.js';

function baseCfg(partial: Partial<Config> = {}): Config {
  return {
    authorizeURL: 'https://auth.example.com/mcp/authorize',
    apiBaseURL: 'https://api.example.com',
    tokenPath: '/t',
    refreshPath: '/r',
    revokePath: '/v',
    oauthClientID: 'claude-desktop-mcp',
    oauthScope: 'db:read',
    loopbackPortMin: 53000,
    loopbackPortMax: 53999,
    logLevel: 'info',
    queryRowLimit: 1000,
    queryTimeoutSec: 30,
    refreshBufferSec: 300,
    ...partial,
  };
}

describe('buildAuthorizeURL', () => {
  it('appends PKCE params with ? when authorize URL has no query', () => {
    const url = buildAuthorizeURL(baseCfg(), 'chal', 'st', 'http://127.0.0.1:53100/callback');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://auth.example.com/mcp/authorize');
    expect(u.searchParams.get('client_id')).toBe('claude-desktop-mcp');
    expect(u.searchParams.get('code_challenge')).toBe('chal');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('db:read');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53100/callback');
  });

  it('appends with & when authorize URL already has a query string', () => {
    const cfg = baseCfg({ authorizeURL: 'https://auth.example.com/start?tenant=acme' });
    const url = buildAuthorizeURL(cfg, 'chal', 'st', 'http://127.0.0.1:53100/callback');
    const u = new URL(url);
    expect(u.searchParams.get('tenant')).toBe('acme');
    expect(u.searchParams.get('state')).toBe('st');
  });
});
