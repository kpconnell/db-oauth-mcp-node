import { describe, expect, it } from 'vitest';
import { pino } from 'pino';

import type { Config } from '../../src/config.js';
import { CredsCache } from '../../src/creds/cache.js';
import type { OAuthFlow } from '../../src/oauth/flow.js';
import type { TokenResponse } from '../../src/oauth/types.js';

function cfg(bufferSec = 60): Config {
  return {
    authorizeURL: 'https://auth/',
    apiBaseURL: 'https://api',
    tokenPath: '/t',
    refreshPath: '/r',
    revokePath: '/v',
    oauthClientID: 'c',
    oauthScope: 's',
    loopbackPortMin: 53000,
    loopbackPortMax: 53999,
    logLevel: 'silent',
    queryRowLimit: 1000,
    queryTimeoutSec: 30,
    refreshBufferSec: bufferSec,
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

function tokenWithExpiry(expiresAt: Date, opts: Partial<TokenResponse> = {}): TokenResponse {
  return {
    accessToken: 'access',
    tokenType: 'Bearer',
    expiresIn: 3600,
    refreshToken: '',
    connections: [
      {
        name: 'prod',
        engine: 'mariadb',
        host: 'h',
        port: 3306,
        username: 'u',
        password: 'p',
        databases: ['app'],
        expiresAt,
      },
    ],
    ...opts,
  };
}

class StubFlow {
  authorizeCalls = 0;
  refreshCalls = 0;
  constructor(
    public authorizeImpl: () => Promise<TokenResponse>,
    public refreshImpl: (rt: string) => Promise<TokenResponse> = async () => {
      throw new Error('refresh not stubbed');
    },
  ) {}
  authorize(): Promise<TokenResponse> {
    this.authorizeCalls++;
    return this.authorizeImpl();
  }
  refresh(rt: string): Promise<TokenResponse> {
    this.refreshCalls++;
    return this.refreshImpl(rt);
  }
}

describe('CredsCache', () => {
  it('peek returns null before any get', () => {
    const cache = new CredsCache(
      cfg(),
      new StubFlow(async () => tokenWithExpiry(new Date(Date.now() + 3600e3))) as unknown as OAuthFlow,
      silentLogger(),
    );
    expect(cache.peek()).toBeNull();
    expect(cache.status().connected).toBe(false);
  });

  it('clear() drops cached token', () => {
    const cache = new CredsCache(cfg(), {} as OAuthFlow, silentLogger());
    (cache as unknown as { token: TokenResponse | null; mintedAt: Date | null }).token =
      tokenWithExpiry(new Date(Date.now() + 3600e3));
    (cache as unknown as { mintedAt: Date | null }).mintedAt = new Date();
    expect(cache.status().connected).toBe(true);
    cache.clear();
    expect(cache.status().connected).toBe(false);
    expect(cache.peek()).toBeNull();
  });

  it('get returns cached token on the fast path when fresh', async () => {
    const fresh = tokenWithExpiry(new Date(Date.now() + 3600e3));
    const flow = new StubFlow(async () => {
      throw new Error('should not authorize');
    });
    const cache = new CredsCache(cfg(), flow as unknown as OAuthFlow, silentLogger());
    (cache as unknown as { token: TokenResponse; mintedAt: Date }).token = fresh;
    (cache as unknown as { mintedAt: Date }).mintedAt = new Date();

    const got = await cache.get();
    expect(got).toBe(fresh);
    expect(flow.authorizeCalls).toBe(0);
    expect(flow.refreshCalls).toBe(0);
  });

  it('get triggers refresh when stale and refresh token exists', async () => {
    const stale = tokenWithExpiry(new Date(Date.now() - 1000), { refreshToken: 'rt' });
    const refreshed = tokenWithExpiry(new Date(Date.now() + 3600e3));
    const flow = new StubFlow(
      async () => {
        throw new Error('should not authorize');
      },
      async () => refreshed,
    );
    const cache = new CredsCache(cfg(), flow as unknown as OAuthFlow, silentLogger());
    (cache as unknown as { token: TokenResponse; mintedAt: Date }).token = stale;
    (cache as unknown as { mintedAt: Date }).mintedAt = new Date();

    const got = await cache.get();
    expect(got).toBe(refreshed);
    expect(flow.refreshCalls).toBe(1);
    expect(flow.authorizeCalls).toBe(0);
  });

  it('get falls back to authorize if refresh throws', async () => {
    const stale = tokenWithExpiry(new Date(Date.now() - 1000), { refreshToken: 'rt' });
    const reauthed = tokenWithExpiry(new Date(Date.now() + 3600e3));
    const flow = new StubFlow(
      async () => reauthed,
      async () => {
        throw new Error('refresh 400');
      },
    );
    const cache = new CredsCache(cfg(), flow as unknown as OAuthFlow, silentLogger());
    (cache as unknown as { token: TokenResponse; mintedAt: Date }).token = stale;
    (cache as unknown as { mintedAt: Date }).mintedAt = new Date();

    const got = await cache.get();
    expect(got).toBe(reauthed);
    expect(flow.refreshCalls).toBe(1);
    expect(flow.authorizeCalls).toBe(1);
  });

  it('concurrent get calls share one in-flight authorize', async () => {
    let resolve!: (t: TokenResponse) => void;
    const promise = new Promise<TokenResponse>((r) => {
      resolve = r;
    });
    const flow = new StubFlow(async () => promise);
    const cache = new CredsCache(cfg(), flow as unknown as OAuthFlow, silentLogger());

    const p1 = cache.get();
    const p2 = cache.get();
    const p3 = cache.get();
    resolve(tokenWithExpiry(new Date(Date.now() + 3600e3)));
    await Promise.all([p1, p2, p3]);
    expect(flow.authorizeCalls).toBe(1);
  });

  it('mintedWithinMs reports true just after a store', async () => {
    const flow = new StubFlow(async () => tokenWithExpiry(new Date(Date.now() + 3600e3)));
    const cache = new CredsCache(cfg(), flow as unknown as OAuthFlow, silentLogger());
    await cache.get();
    expect(cache.mintedWithinMs(60_000)).toBe(true);
    expect(cache.mintedWithinMs(0)).toBe(false);
  });

  it('connection(name) returns the matching Connection', async () => {
    const tr: TokenResponse = {
      accessToken: 'a',
      tokenType: 'Bearer',
      expiresIn: 3600,
      refreshToken: '',
      connections: [
        {
          name: 'a',
          engine: 'mariadb',
          host: 'h',
          port: 1,
          username: 'u',
          password: 'p',
          databases: [],
          expiresAt: new Date(Date.now() + 3600e3),
        },
        {
          name: 'b',
          engine: 'mssql',
          host: 'h',
          port: 2,
          username: 'u',
          password: 'p',
          databases: [],
          expiresAt: new Date(Date.now() + 3600e3),
        },
      ],
    };
    const cache = new CredsCache(cfg(), {} as OAuthFlow, silentLogger());
    (cache as unknown as { token: TokenResponse }).token = tr;
    expect(cache.connection('b')?.engine).toBe('mssql');
    expect(cache.connection('nope')).toBeNull();
  });
});
