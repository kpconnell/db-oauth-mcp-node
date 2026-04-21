/**
 * Credential cache.
 *
 * Wraps the OAuth flow and holds the current TokenResponse. Silently
 * refreshes when any connection's expires_at is within the refresh
 * buffer; falls back to a full authorize (browser flow) if refresh
 * fails or no token is cached yet.
 *
 * Ported from `internal/creds/cache.go` in the Go repo.
 */

import type { Logger } from 'pino';

import type { Config } from '../config.js';
import type { OAuthFlow } from '../oauth/flow.js';
import {
  earliestExpiry,
  findConnection,
  type Connection,
  type TokenResponse,
} from '../oauth/types.js';

export interface ConnectionStatus {
  name: string;
  engine: string;
  username: string;
  databases: string[];
  expires_at?: string;
}

export interface Status {
  connected: boolean;
  connections: ConnectionStatus[];
}

export class CredsCache {
  private token: TokenResponse | null = null;
  private mintedAt: Date | null = null;
  private inflight: Promise<TokenResponse> | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly flow: OAuthFlow,
    private readonly logger: Logger,
  ) {}

  /**
   * Return a live token + connections bundle. Silently refreshes if any
   * connection is nearing expiry; falls back to a full authorize if
   * that fails. Concurrent callers share a single in-flight flow.
   */
  get(): Promise<TokenResponse> {
    if (this.token !== null && this.tokenFresh(this.token)) {
      return Promise.resolve(this.token);
    }
    if (this.inflight !== null) return this.inflight;

    this.inflight = this.acquire().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async acquire(): Promise<TokenResponse> {
    const current = this.token;

    if (current !== null && current.refreshToken !== '') {
      this.logger.debug(
        { connections: current.connections.length },
        'refreshing credentials',
      );
      try {
        const refreshed = await this.flow.refresh(current.refreshToken);
        this.storeToken(refreshed);
        return refreshed;
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message },
          'refresh failed, falling back to full authorize',
        );
      }
    }

    const tr = await this.flow.authorize();
    this.storeToken(tr);
    return tr;
  }

  /**
   * True if no per-connection expiry is within the refresh buffer of now.
   * Falls back to the token's own expires_in if no connection carries
   * an expires_at.
   */
  private tokenFresh(tr: TokenResponse): boolean {
    const bufferMs = this.cfg.refreshBufferSec * 1000;
    const now = Date.now();
    const earliest = earliestExpiry(tr);
    if (earliest !== null) {
      return now < earliest.getTime() - bufferMs;
    }
    if (tr.expiresIn > 0 && this.mintedAt) {
      return now < this.mintedAt.getTime() + tr.expiresIn * 1000 - bufferMs;
    }
    return true;
  }

  peek(): TokenResponse | null {
    return this.token;
  }

  connection(name: string): Connection | null {
    const c = findConnection(this.token, name);
    return c ?? null;
  }

  clear(): void {
    this.token = null;
    this.mintedAt = null;
  }

  /**
   * True if the current token was obtained within the last d milliseconds.
   * Used to avoid re-authorizing in a loop when freshly-minted creds
   * are already being rejected by the database.
   */
  mintedWithinMs(d: number): boolean {
    if (!this.mintedAt) return false;
    return Date.now() - this.mintedAt.getTime() < d;
  }

  async invalidateAndRetry(): Promise<TokenResponse> {
    this.clear();
    return this.get();
  }

  status(): Status {
    if (this.token === null) return { connected: false, connections: [] };
    const conns: ConnectionStatus[] = this.token.connections.map((c) => ({
      name: c.name,
      engine: c.engine,
      username: c.username,
      databases: c.databases,
      expires_at:
        c.expiresAt.getTime() === 0 ? undefined : c.expiresAt.toISOString(),
    }));
    return { connected: true, connections: conns };
  }

  private storeToken(tr: TokenResponse): void {
    this.token = tr;
    this.mintedAt = new Date();
  }
}
