/**
 * MCP helper utilities — shared by all tool handlers.
 */

import type { Logger } from 'pino';

import type { Config } from '../config.js';
import type { CredsCache } from '../creds/cache.js';
import type { Engine, EnginePool } from '../engine/engine.js';
import type { OAuthClient } from '../oauth/client.js';
import type { Connection, TokenResponse } from '../oauth/types.js';
import type { PoolManager } from '../pool/manager.js';

export interface Deps {
  cfg: Config;
  logger: Logger;
  creds: CredsCache;
  pool: PoolManager;
  oauthClient: OAuthClient;
}

/** MCP tool result shape returned by every handler. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function toolText(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Resolve a connection by name. If name is empty and exactly one
 * connection exists, return it. Otherwise throw a helpful error
 * listing the available names.
 */
export function resolveConnection(
  token: TokenResponse,
  name: string | undefined,
): Connection {
  if (token.connections.length === 0) {
    throw new Error(
      'no connections available in token response; the OAuth backend returned an empty connections list',
    );
  }
  if (!name) {
    if (token.connections.length === 1) return token.connections[0];
    const names = token.connections.map((c) => c.name);
    throw new Error(
      `multiple connections available; pass \`connection\` explicitly. Options: ${JSON.stringify(names)}`,
    );
  }
  const hit = token.connections.find((c) => c.name === name);
  if (hit) return hit;
  const names = token.connections.map((c) => c.name);
  throw new Error(`unknown connection "${name}". Available: ${JSON.stringify(names)}`);
}

/**
 * Run `fn` against a live pool for the named connection. On an auth
 * error from the engine, clear creds, reauthorize, reopen the pool,
 * and retry once — unless the rejected creds were minted within the
 * last 60s, in which case another authorize won't help and we surface
 * the error so the backend operator can fix it.
 */
export async function withConnection<T>(
  deps: Deps,
  connName: string | undefined,
  fn: (engine: Engine, pool: EnginePool) => Promise<T>,
): Promise<T> {
  const token = await deps.creds.get();
  const conn = resolveConnection(token, connName);
  const { pool, engine } = await deps.pool.getPool(conn);

  try {
    return await fn(engine, pool);
  } catch (err) {
    if (!engine.isAuthError(err)) throw err;

    if (deps.creds.mintedWithinMs(60_000)) {
      deps.logger.error(
        {
          engine: engine.name(),
          connection: conn.name,
          username: conn.username,
          err: (err as Error).message,
        },
        'engine rejected freshly-minted credentials',
      );
      throw new Error(
        `${engine.name()} rejected freshly-issued credentials for connection "${conn.name}" (user "${conn.username}"): ${(err as Error).message}. The OAuth backend is issuing bad creds; reauthorizing will not help`,
        { cause: err },
      );
    }

    deps.logger.warn(
      {
        engine: engine.name(),
        connection: conn.name,
        username: conn.username,
        err: (err as Error).message,
      },
      'engine rejected credentials; reauthorizing',
    );

    const token2 = await deps.creds.invalidateAndRetry();
    const conn2 = resolveConnection(token2, connName);
    const { pool: pool2, engine: engine2 } = await deps.pool.getPool(conn2);
    return fn(engine2, pool2);
  }
}
