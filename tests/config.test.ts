import { describe, expect, it } from 'vitest';
import { loadConfig, refreshURL, revokeURL, tokenURL } from '../src/config.js';

describe('loadConfig', () => {
  it('errors if OAUTH_AUTHORIZE_URL is missing', () => {
    expect(() =>
      loadConfig({ OAUTH_API_BASE_URL: 'https://api.example.com' }),
    ).toThrow(/OAUTH_AUTHORIZE_URL/);
  });

  it('errors if OAUTH_API_BASE_URL is missing', () => {
    expect(() =>
      loadConfig({ OAUTH_AUTHORIZE_URL: 'https://auth.example.com/mcp/authorize' }),
    ).toThrow(/OAUTH_API_BASE_URL/);
  });

  it('applies defaults and trims trailing slash from base URL', () => {
    const cfg = loadConfig({
      OAUTH_AUTHORIZE_URL: 'https://auth.example.com/mcp/authorize',
      OAUTH_API_BASE_URL: 'https://api.example.com/',
    });
    expect(cfg.apiBaseURL).toBe('https://api.example.com');
    expect(cfg.oauthClientID).toBe('claude-desktop-mcp');
    expect(cfg.oauthScope).toBe('db:read');
    expect(cfg.queryRowLimit).toBe(1000);
    expect(cfg.refreshBufferSec).toBe(300);
    expect(cfg.loopbackPortMin).toBe(53000);
    expect(cfg.loopbackPortMax).toBe(53999);
  });

  it('honors explicit env overrides', () => {
    const cfg = loadConfig({
      OAUTH_AUTHORIZE_URL: 'https://auth.example.com/mcp/authorize',
      OAUTH_API_BASE_URL: 'https://api.example.com',
      OAUTH_TOKEN_PATH: '/custom/token',
      QUERY_ROW_LIMIT: '250',
      LOG_LEVEL: 'DEBUG',
    });
    expect(cfg.tokenPath).toBe('/custom/token');
    expect(cfg.queryRowLimit).toBe(250);
    expect(cfg.logLevel).toBe('debug');
  });

  it('builds full URLs from base + paths', () => {
    const cfg = loadConfig({
      OAUTH_AUTHORIZE_URL: 'https://auth.example.com/mcp/authorize',
      OAUTH_API_BASE_URL: 'https://api.example.com',
    });
    expect(tokenURL(cfg)).toBe('https://api.example.com/api/mcp/oauth/token');
    expect(refreshURL(cfg)).toBe('https://api.example.com/api/mcp/oauth/refresh');
    expect(revokeURL(cfg)).toBe('https://api.example.com/api/mcp/oauth/revoke');
  });
});
