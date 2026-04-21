import type { Logger } from 'pino';

import type { Config } from '../config.js';
import { refreshURL, revokeURL, tokenURL } from '../config.js';
import { parseTokenResponse, type TokenResponse } from './types.js';

export class OAuthClient {
  constructor(
    private readonly cfg: Config,
    private readonly logger: Logger,
  ) {}

  exchangeCode(code: string, verifier: string, redirectURI: string): Promise<TokenResponse> {
    return this.postToken(tokenURL(this.cfg), {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectURI,
      client_id: this.cfg.oauthClientID,
    });
  }

  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.postToken(refreshURL(this.cfg), {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.cfg.oauthClientID,
    });
  }

  async revoke(accessToken: string): Promise<void> {
    const res = await fetch(revokeURL(this.cfg), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`revoke failed: ${res.status} ${body}`);
    }
  }

  private async postToken(url: string, body: Record<string, string>): Promise<TokenResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const respText = await res.text();
    if (!res.ok) {
      throw new Error(`token endpoint ${url} returned ${res.status}: ${respText}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(respText);
    } catch (e) {
      throw new Error(`decode token response: ${(e as Error).message}`, { cause: e });
    }
    const tr = parseTokenResponse(parsed);

    this.logger.debug(
      {
        url,
        expires_in: tr.expiresIn,
        has_refresh_token: tr.refreshToken !== '',
        connection_count: tr.connections.length,
      },
      'token response decoded',
    );
    for (const [i, conn] of tr.connections.entries()) {
      this.logger.debug(
        {
          index: i,
          name: conn.name,
          engine: conn.engine,
          host: conn.host,
          port: conn.port,
          user: conn.username,
          pw_len: conn.password.length,
          databases: conn.databases,
          expires_at: conn.expiresAt,
          has_options: conn.options !== undefined,
        },
        'connection issued',
      );
    }
    return tr;
  }
}
