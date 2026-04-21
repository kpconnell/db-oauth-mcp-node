/**
 * MCP tool registry.
 *
 * Five tools, each defined as a name + description + JSON Schema
 * (written as a plain object, not Zod, so the schema we ship matches
 * the Go version closely enough that Claude Desktop's approval cache
 * doesn't re-prompt the user).
 *
 * The descriptions are copied verbatim from the Go implementation.
 */

import type { Deps, ToolResult } from './helpers.js';
import { resolveConnection, toolError, toolText, withConnection } from './helpers.js';
import { truncSQL } from '../logging.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export function buildTools(deps: Deps): ToolDef[] {
  return [
    connectionStatus(deps),
    disconnect(deps),
    listConnections(deps),
    listSchema(deps),
    queryDatabase(deps),
  ];
}

// ─── query_database ──────────────────────────────────────────────────

function queryDatabase(deps: Deps): ToolDef {
  return {
    name: 'query_database',
    description:
      'Execute a read-only SQL query against one of the configured database connections. ' +
      'Pass `connection` with the name of the target (omit if only one connection exists — use ' +
      '`list_connections` to see the names and which engine each uses). ' +
      'Only read statements are allowed (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH on MariaDB; ' +
      'SELECT/WITH and a small allowlist of sp_help / sp_columns / sp_tables procs on MSSQL). ' +
      'Results are capped at a configurable row limit (default 1000). ' +
      "Use `list_schema` first if you don't know the table structure.",
    inputSchema: {
      type: 'object',
      required: ['sql'],
      properties: {
        connection: { type: 'string' },
        sql: { type: 'string' },
      },
      additionalProperties: { not: {} },
    },
    async handler(args) {
      const connection = typeof args.connection === 'string' ? args.connection : undefined;
      const sql = typeof args.sql === 'string' ? args.sql.trim() : '';
      if (!sql) return toolError('SQL cannot be empty');

      const timeoutMs = deps.cfg.queryTimeoutSec * 1000;
      try {
        const result = await withConnection(deps, connection, async (engine, pool) => {
          engine.validateSQL(sql);
          return engine.execute(pool, sql, deps.cfg.queryRowLimit, timeoutMs);
        });
        deps.logger.info(
          {
            connection,
            elapsed_ms: result.elapsed_ms,
            rows: result.row_count,
            truncated: result.truncated,
            sql: truncSQL(sql, 200),
          },
          'query executed',
        );
        return toolText(JSON.stringify(result, null, 2));
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  };
}

// ─── list_schema ─────────────────────────────────────────────────────

function listSchema(deps: Deps): ToolDef {
  return {
    name: 'list_schema',
    description:
      'List tables or describe a specific table\'s columns for a given connection. ' +
      'Pass `connection` with the name of the target (omit if only one connection exists). ' +
      'Call with no `table` argument to see all tables, or with `table` set to ' +
      "'schema.table' (MariaDB uses database.table; MSSQL uses schema.table within the " +
      "connection's initial catalog) to describe its columns.",
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string' },
      },
      additionalProperties: { not: {} },
    },
    async handler(args) {
      const connection = typeof args.connection === 'string' ? args.connection : undefined;
      const table =
        typeof args.table === 'string' && args.table.trim() !== ''
          ? args.table.trim()
          : undefined;

      try {
        const out = await withConnection(deps, connection, async (engine, pool) => {
          // Use the connection's declared databases as the schema filter.
          let schemas: string[] = [];
          const token = deps.creds.peek();
          if (token) {
            const resolved = resolveConnection(token, connection);
            schemas = resolved.databases;
          }

          if (!table) {
            return engine.listTables(pool, schemas);
          }
          return engine.describeTable(pool, table);
        });
        return toolText(JSON.stringify(out, null, 2));
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  };
}

// ─── list_connections ────────────────────────────────────────────────

function listConnections(deps: Deps): ToolDef {
  return {
    name: 'list_connections',
    description:
      'List the database connections available in the current session. Returns the ' +
      'name (pass to `query_database` / `list_schema` via the `connection` argument), engine ' +
      'type (`mariadb` or `mssql`), and the databases each connection grants access to. ' +
      'Calling this will trigger authentication if not yet connected.',
    inputSchema: {
      type: 'object',
      additionalProperties: { not: {} },
    },
    async handler() {
      try {
        const token = await deps.creds.get();
        const out = token.connections.map((c) => ({
          name: c.name,
          engine: c.engine,
          databases: c.databases,
          expires_at:
            c.expiresAt.getTime() === 0
              ? undefined
              : c.expiresAt.toISOString().replace(/\.\d+Z$/u, 'Z'),
        }));
        return toolText(JSON.stringify(out, null, 2));
      } catch (err) {
        return toolError(`authorize failed: ${(err as Error).message}`);
      }
    },
  };
}

// ─── connection_status ───────────────────────────────────────────────

function connectionStatus(deps: Deps): ToolDef {
  return {
    name: 'connection_status',
    description:
      "Show whether you're connected and, for each available database connection, " +
      'which user and engine it uses and when it expires.',
    inputSchema: {
      type: 'object',
      additionalProperties: { not: {} },
    },
    async handler() {
      const status = deps.creds.status();
      if (!status.connected) {
        return toolText('Not connected. Run any database tool to authenticate.');
      }
      if (status.connections.length === 0) {
        return toolText('Connected, but the OAuth backend returned no database connections.');
      }
      const parts: string[] = [];
      for (const c of status.connections) {
        let line = `${c.name} (${c.engine}) — user ${c.username}`;
        if (c.expires_at) {
          const remaining = new Date(c.expires_at).getTime() - Date.now();
          if (remaining <= 0) {
            line += '; expired, next query will reauthenticate';
          } else {
            const h = Math.floor(remaining / 3600_000);
            const m = Math.floor((remaining % 3600_000) / 60_000);
            line += `; expires in ${h}h ${m}m`;
          }
        }
        parts.push(line);
      }
      return toolText(parts.join('\n'));
    },
  };
}

// ─── disconnect ──────────────────────────────────────────────────────

function disconnect(deps: Deps): ToolDef {
  return {
    name: 'disconnect',
    description:
      'Disconnect from all database connections. Revokes the current access token and ' +
      'clears cached credentials. The next tool call will require re-authentication.',
    inputSchema: {
      type: 'object',
      additionalProperties: { not: {} },
    },
    async handler() {
      const token = deps.creds.peek();
      if (!token) {
        return toolText('Not connected; nothing to disconnect.');
      }
      try {
        await deps.oauthClient.revoke(token.accessToken);
      } catch (err) {
        deps.logger.warn(
          { err: (err as Error).message },
          'revoke request failed; clearing local cache anyway',
        );
      }
      deps.creds.clear();
      await deps.pool.closeAll();
      return toolText('Disconnected. Your database credentials have been revoked.');
    },
  };
}
