import type { Logger } from 'pino';

import type { Config } from '../config.js';
import { openBrowser } from './browser.js';
import { OAuthClient } from './client.js';
import { listen } from './loopback.js';
import { challenge, newState, newVerifier } from './pkce.js';
import type { TokenResponse } from './types.js';

const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

export class OAuthFlow {
  constructor(
    private readonly cfg: Config,
    private readonly client: OAuthClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Run the full browser-based OAuth flow and return the token response
   * (which includes per-connection DB credentials).
   *
   * Intentionally detached from any caller AbortSignal: the MCP tool
   * call that triggered this may be cancelled by Claude Desktop's
   * per-call timeout (~30s), but the user still needs minutes to
   * complete login. The listener's internal timeout (10 min) bounds the
   * overall lifetime.
   */
  async authorize(): Promise<TokenResponse> {
    const verifier = newVerifier();
    const state = newState();

    const listener = await listen(
      state,
      this.cfg.loopbackPortMin,
      this.cfg.loopbackPortMax,
      AUTH_TIMEOUT_MS,
      this.logger,
    );
    try {
      const redirectURI = `http://127.0.0.1:${listener.port}/callback`;
      const authURL = buildAuthorizeURL(this.cfg, challenge(verifier), state, redirectURI);

      this.logger.info(
        {
          port: listener.port,
          authorize_url: this.cfg.authorizeURL,
          api_base_url: this.cfg.apiBaseURL,
        },
        'opening browser for authorization',
      );

      try {
        await openBrowser(authURL);
      } catch (e) {
        this.logger.warn(
          { err: (e as Error).message, url: authURL },
          'could not open browser automatically',
        );
      }

      const code = await listener.code;
      return await this.client.exchangeCode(code, verifier, redirectURI);
    } finally {
      listener.cleanup();
    }
  }

  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.client.refresh(refreshToken);
  }
}

export function buildAuthorizeURL(
  cfg: Config,
  challengeValue: string,
  state: string,
  redirectURI: string,
): string {
  const params = new URLSearchParams({
    client_id: cfg.oauthClientID,
    redirect_uri: redirectURI,
    response_type: 'code',
    code_challenge: challengeValue,
    code_challenge_method: 'S256',
    scope: cfg.oauthScope,
    state,
  });
  const sep = cfg.authorizeURL.includes('?') ? '&' : '?';
  return `${cfg.authorizeURL}${sep}${params.toString()}`;
}
