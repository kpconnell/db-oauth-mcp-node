/**
 * MariaDB / MySQL engine implementation.
 *
 * Uses `mysql2/promise`. Mirrors the Go implementation at
 * `internal/mariadb/engine.go`: same pool sizing, same TLS default
 * (driver-default — "preferred"), same auth-error detection codes.
 */

import type { Logger } from 'pino';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';

import type {
  Column,
  ConnectionSpec,
  Engine,
  EnginePool,
  QueryResult,
  Table,
} from '../engine/engine.js';
import { execute as executeQuery } from './query.js';
import { validateSQL as validateSQLImpl } from './safety.js';

export const ENGINE_NAME = 'mariadb';

/** MariaDB error codes treated as "credentials are bad, reauth + retry". */
const AUTH_ERROR_CODES = new Set([
  1045, // ER_ACCESS_DENIED_ERROR
  1820, // ER_MUST_CHANGE_PASSWORD
  1130, // ER_HOST_NOT_PRIVILEGED
]);

export class MariaDBEngine implements Engine {
  constructor(private readonly logger: Logger) {}

  name(): string {
    return ENGINE_NAME;
  }

  async open(spec: ConnectionSpec): Promise<EnginePool> {
    this.logger.debug(
      {
        host: spec.host,
        port: spec.port,
        user: spec.username,
        pw_len: spec.password.length,
        pw_sample: passwordSample(spec.password),
      },
      'opening mariadb pool',
    );
    return mysql.createPool({
      host: spec.host,
      port: spec.port,
      user: spec.username,
      password: spec.password,
      connectionLimit: 5,
      idleTimeout: 10 * 60 * 1000,
      // Preserve Go-style byte handling: driver returns raw Buffers for
      // DECIMAL/DATE text paths, so our serializer can match Go's shape.
      decimalNumbers: false,
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      charset: 'utf8mb4',
    });
  }

  validateSQL(sql: string): void {
    validateSQLImpl(sql);
  }

  execute(
    pool: EnginePool,
    sql: string,
    rowLimit: number,
    timeoutMs: number,
  ): Promise<QueryResult> {
    return executeQuery(pool as Pool, sql, rowLimit, timeoutMs);
  }

  async listTables(pool: EnginePool, schemas: string[]): Promise<Table[]> {
    const p = pool as Pool;
    let sql = 'SELECT table_schema, table_name FROM information_schema.tables';
    const params: string[] = [];
    if (schemas.length > 0) {
      const placeholders = schemas.map(() => '?').join(',');
      sql += ` WHERE table_schema IN (${placeholders})`;
      params.push(...schemas);
    } else {
      sql +=
        " WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')";
    }
    sql += ' ORDER BY 1, 2';
    const [rows] = await p.query<RowDataPacket[]>(sql, params);
    return rows.map((r) => ({
      schema: String(r['table_schema']),
      table: String(r['table_name']),
    }));
  }

  async describeTable(pool: EnginePool, qualified: string): Promise<Column[]> {
    const idx = qualified.indexOf('.');
    if (idx < 0) {
      throw new Error("table must be in 'database.table' form");
    }
    const schema = qualified.slice(0, idx);
    const name = qualified.slice(idx + 1);

    const [rows] = await (pool as Pool).query<RowDataPacket[]>(
      `SELECT column_name, data_type, is_nullable, column_default, column_comment
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`,
      [schema, name],
    );
    if (rows.length === 0) {
      throw new Error(`no such table: ${schema}.${name}`);
    }
    return rows.map((r) => ({
      name: String(r['column_name']),
      type: String(r['data_type']),
      nullable: String(r['is_nullable']),
      default: r['column_default'] === null ? null : String(r['column_default']),
      comment: r['column_comment'] ? String(r['column_comment']) : undefined,
    }));
  }

  isAuthError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const errno = (err as { errno?: unknown }).errno;
    return typeof errno === 'number' && AUTH_ERROR_CODES.has(errno);
  }

  async close(pool: EnginePool): Promise<void> {
    await (pool as Pool).end();
  }
}

/**
 * Short redacted fingerprint of a password for debug logs: first/last
 * 2 chars plus length. Same rule as the Go helper.
 */
export function passwordSample(pw: string): string {
  if (pw.length === 0) return '<empty>';
  if (pw.length <= 4) return `<len=${pw.length}>`;
  return `${pw.slice(0, 2)}…${pw.slice(-2)}`;
}
