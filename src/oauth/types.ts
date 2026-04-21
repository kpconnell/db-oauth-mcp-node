/**
 * Types and decoding for OAuth token responses.
 *
 * The `connections` array is the contract's key extension over plain
 * OAuth 2.0: each entry carries its own DB engine, endpoint, and
 * short-lived credentials. The MCP server opens one pool per connection
 * and routes tool calls by `name`.
 */

export type Engine = 'mariadb' | 'mssql' | string;

export interface Connection {
  name: string;
  engine: Engine;
  host: string;
  port: number;
  username: string;
  password: string;
  databases: string[];
  expiresAt: Date;
  options?: Record<string, unknown>;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string;
  connections: Connection[];
}

/**
 * Parse a JSON token response from the OAuth backend.
 *
 * Tolerates the Laravel/PHP quirk where an empty associative array is
 * serialized as `[]` rather than `{}`: an options field of `[]`, `null`,
 * or missing all decode to `undefined`. A non-empty array throws — that's
 * clearly a type mismatch and the backend operator should hear about it.
 */
export function parseTokenResponse(raw: unknown): TokenResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('token response: not an object');
  }
  const r = raw as Record<string, unknown>;

  const accessToken = stringField(r, 'access_token', '');
  const tokenType = stringField(r, 'token_type', 'Bearer');
  const expiresIn = numberField(r, 'expires_in', 0);
  const refreshToken = stringField(r, 'refresh_token', '');

  const connsRaw = r.connections;
  if (!Array.isArray(connsRaw)) {
    throw new Error('token response: `connections` must be an array');
  }
  const connections = connsRaw.map((c, i) => parseConnection(c, i));

  return { accessToken, tokenType, expiresIn, refreshToken, connections };
}

function parseConnection(raw: unknown, idx: number): Connection {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`connection[${idx}]: not an object`);
  }
  const c = raw as Record<string, unknown>;
  const dbRaw = c.databases;
  const databases: string[] = Array.isArray(dbRaw)
    ? dbRaw.filter((x): x is string => typeof x === 'string')
    : [];
  const expiresAtRaw = c.expires_at;
  const expiresAt =
    typeof expiresAtRaw === 'string' && expiresAtRaw !== ''
      ? new Date(expiresAtRaw)
      : new Date(0);
  return {
    name: stringField(c, 'name', ''),
    engine: stringField(c, 'engine', ''),
    host: stringField(c, 'host', ''),
    port: numberField(c, 'port', 0),
    username: stringField(c, 'username', ''),
    password: stringField(c, 'password', ''),
    databases,
    expiresAt,
    options: parseOptions(c.options, idx),
  };
}

/**
 * Decode the per-connection `options` field.
 *
 * Accepted shapes:
 *   - missing / null       -> undefined
 *   - `[]` (PHP quirk)     -> undefined
 *   - `{ ... }` object     -> passed through
 *
 * A non-empty array throws, since that is almost certainly a backend
 * bug and silently swallowing it would hide real problems.
 */
function parseOptions(
  raw: unknown,
  idx: number,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return undefined;
    throw new Error(
      `connection[${idx}]: options is a non-empty array; expected an object`,
    );
  }
  if (typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  throw new Error(`connection[${idx}]: options must be an object or []/null`);
}

export function findConnection(
  tr: TokenResponse | null | undefined,
  name: string,
): Connection | undefined {
  if (!tr) return undefined;
  return tr.connections.find((c) => c.name === name);
}

/**
 * Earliest `expiresAt` across all connections, used to decide when to
 * refresh. Returns `null` if no connection carries a usable expiry (the
 * caller should then fall back to the token's own `expiresIn`).
 */
export function earliestExpiry(tr: TokenResponse | null | undefined): Date | null {
  if (!tr) return null;
  let earliest: Date | null = null;
  for (const c of tr.connections) {
    if (!c.expiresAt || Number.isNaN(c.expiresAt.getTime()) || c.expiresAt.getTime() === 0) {
      continue;
    }
    if (earliest === null || c.expiresAt.getTime() < earliest.getTime()) {
      earliest = c.expiresAt;
    }
  }
  return earliest;
}

function stringField(r: Record<string, unknown>, key: string, def: string): string {
  const v = r[key];
  return typeof v === 'string' ? v : def;
}
function numberField(r: Record<string, unknown>, key: string, def: number): number {
  const v = r[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}
