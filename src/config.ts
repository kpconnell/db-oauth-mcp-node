export interface Config {
  authorizeURL: string;
  apiBaseURL: string;
  tokenPath: string;
  refreshPath: string;
  revokePath: string;
  oauthClientID: string;
  oauthScope: string;
  loopbackPortMin: number;
  loopbackPortMax: number;
  logLevel: string;
  queryRowLimit: number;
  queryTimeoutSec: number;
  refreshBufferSec: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authorizeURL = env.OAUTH_AUTHORIZE_URL ?? '';
  const apiBaseURL = (env.OAUTH_API_BASE_URL ?? '').replace(/\/+$/, '');
  if (!authorizeURL) {
    throw new Error(
      'OAUTH_AUTHORIZE_URL is required (full URL of the browser authorize page)',
    );
  }
  if (!apiBaseURL) {
    throw new Error(
      'OAUTH_API_BASE_URL is required (base URL for token/refresh/revoke endpoints)',
    );
  }
  return {
    authorizeURL,
    apiBaseURL,
    tokenPath: env.OAUTH_TOKEN_PATH || '/api/mcp/oauth/token',
    refreshPath: env.OAUTH_REFRESH_PATH || '/api/mcp/oauth/refresh',
    revokePath: env.OAUTH_REVOKE_PATH || '/api/mcp/oauth/revoke',
    oauthClientID: env.OAUTH_CLIENT_ID || 'claude-desktop-mcp',
    oauthScope: env.OAUTH_SCOPE || 'db:read',
    loopbackPortMin: envInt(env.LOOPBACK_PORT_MIN, 53000),
    loopbackPortMax: envInt(env.LOOPBACK_PORT_MAX, 53999),
    logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
    queryRowLimit: envInt(env.QUERY_ROW_LIMIT, 1000),
    queryTimeoutSec: envInt(env.QUERY_TIMEOUT_SEC, 30),
    refreshBufferSec: envInt(env.REFRESH_BUFFER_SEC, 300),
  };
}

export function tokenURL(c: Config): string {
  return c.apiBaseURL + c.tokenPath;
}
export function refreshURL(c: Config): string {
  return c.apiBaseURL + c.refreshPath;
}
export function revokeURL(c: Config): string {
  return c.apiBaseURL + c.revokePath;
}

function envInt(v: string | undefined, def: number): number {
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
