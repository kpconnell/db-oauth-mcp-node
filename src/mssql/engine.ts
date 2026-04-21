/**
 * Microsoft SQL Server engine implementation (via the `mssql` package,
 * which wraps `tedious`).
 *
 * The important translation here is from the engine-agnostic
 * `options` map on each OAuth `Connection` into the driver's config:
 *
 *   options.encrypt === false              -> config.options.encrypt = false
 *   options.encrypt === true               -> config.options.encrypt = true
 *   options.trust_server_certificate=true  -> config.options.trustServerCertificate = true
 *
 * These two are the whole reason the options map exists: AWS RDS for
 * SQL Server presents a self-signed fallback cert when you haven't
 * brought your own, and tedious rejects it without these hints.
 */

import type { Logger } from 'pino';
import sql from 'mssql';
import type { ConnectionPool, config as SqlConfig } from 'mssql';

import type {
  Column,
  ConnectionSpec,
  Engine,
  EnginePool,
  QueryResult,
  Table,
} from '../engine/engine.js';
import { boolOption } from '../engine/engine.js';
import { execute as executeQuery } from './query.js';
import { validateSQL as validateSQLImpl } from './safety.js';

export const ENGINE_NAME = 'mssql';

/** MSSQL error numbers treated as "credentials are bad, reauth + retry". */
const AUTH_ERROR_CODES = new Set([
  18456, // login failed (generic)
  4060, // cannot open database
  18452, // untrusted domain / logon failure
  18488, // password must be reset
]);

export class MSSQLEngine implements Engine {
  constructor(private readonly logger: Logger) {}

  name(): string {
    return ENGINE_NAME;
  }

  async open(spec: ConnectionSpec): Promise<EnginePool> {
    const { config, encrypt, trust } = buildConfig(spec);

    if (spec.databases.length > 1) {
      this.logger.warn(
        {
          chosen: spec.databases[0],
          others: spec.databases.slice(1),
        },
        'mssql connection lists multiple databases; using first as initial catalog',
      );
    }
    this.logger.debug(
      {
        host: spec.host,
        port: spec.port,
        user: spec.username,
        pw_len: spec.password.length,
        pw_sample: passwordSample(spec.password),
        database: config.database,
        encrypt,
        trust_server_certificate: trust,
      },
      'opening mssql pool',
    );

    const pool = new sql.ConnectionPool(config);
    await pool.connect();
    return pool;
  }

  validateSQL(sqlStr: string): void {
    validateSQLImpl(sqlStr);
  }

  execute(
    pool: EnginePool,
    sqlStr: string,
    rowLimit: number,
    timeoutMs: number,
  ): Promise<QueryResult> {
    return executeQuery(pool as ConnectionPool, sqlStr, rowLimit, timeoutMs);
  }

  async listTables(pool: EnginePool, _schemas: string[]): Promise<Table[]> {
    // Note on `_schemas`: the OAuth contract passes `connection.databases`
    // here, but for MSSQL those are *catalog* names (e.g. "VRP"), not
    // schema names (e.g. "dbo"). Tables live in schemas within a catalog,
    // so filtering INFORMATION_SCHEMA.TABLES by TABLE_SCHEMA against
    // catalog names returns nothing. We ignore the hint and return every
    // user table in the current catalog, excluding the well-known system
    // schemas.
    const p = pool as ConnectionPool;
    const req = p.request();
    const q = `
      SELECT TABLE_SCHEMA, TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA',
                                 'db_owner', 'db_accessadmin',
                                 'db_securityadmin', 'db_ddladmin',
                                 'db_backupoperator', 'db_datareader',
                                 'db_datawriter', 'db_denydatareader',
                                 'db_denydatawriter', 'guest')
      ORDER BY 1, 2`;
    const r = await req.query<{ TABLE_SCHEMA: string; TABLE_NAME: string }>(q);
    return r.recordset.map((row) => ({
      schema: row.TABLE_SCHEMA,
      table: row.TABLE_NAME,
    }));
  }

  async describeTable(pool: EnginePool, qualified: string): Promise<Column[]> {
    const idx = qualified.indexOf('.');
    if (idx < 0) throw new Error("table must be in 'schema.table' form");
    const schema = qualified.slice(0, idx);
    const name = qualified.slice(idx + 1);

    const req = (pool as ConnectionPool).request();
    req.input('schema', sql.NVarChar, schema);
    req.input('name', sql.NVarChar, name);
    type Row = {
      COLUMN_NAME: string;
      DATA_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_DEFAULT: string | null;
    };
    const r = await req.query<Row>(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @name
        ORDER BY ORDINAL_POSITION`,
    );
    if (r.recordset.length === 0) {
      throw new Error(`no such table: ${schema}.${name}`);
    }
    return r.recordset.map((row) => ({
      name: row.COLUMN_NAME,
      type: row.DATA_TYPE,
      nullable: row.IS_NULLABLE,
      default: row.COLUMN_DEFAULT ?? null,
    }));
  }

  isAuthError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const number = (err as { number?: unknown }).number;
    return typeof number === 'number' && AUTH_ERROR_CODES.has(number);
  }

  async close(pool: EnginePool): Promise<void> {
    await (pool as ConnectionPool).close();
  }
}

export interface BuiltConfig {
  config: SqlConfig;
  encrypt: string; // for debug logging
  trust: string; // for debug logging
}

/**
 * Build the mssql pool config from a ConnectionSpec, translating the
 * engine-agnostic `options` map into tedious flags.
 *
 * Extracted for testing — `open()` just runs it and passes through.
 */
export function buildConfig(spec: ConnectionSpec): BuiltConfig {
  const config: SqlConfig = {
    server: spec.host,
    port: spec.port,
    user: spec.username,
    password: spec.password,
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 10 * 60 * 1000 },
    options: {
      appName: 'db-oauth-mcp',
    },
  };
  if (spec.databases.length > 0) {
    config.database = spec.databases[0];
  }

  let encryptLog = '';
  let trustLog = '';

  const enc = boolOption(spec.options, 'encrypt');
  if (enc.found) {
    config.options!.encrypt = enc.value;
    encryptLog = enc.value ? 'true' : 'false';
  }

  const trust = boolOption(spec.options, 'trust_server_certificate');
  if (trust.found && trust.value) {
    config.options!.trustServerCertificate = true;
    trustLog = 'true';
  }

  return { config, encrypt: encryptLog, trust: trustLog };
}

function passwordSample(pw: string): string {
  if (pw.length === 0) return '<empty>';
  if (pw.length <= 4) return `<len=${pw.length}>`;
  return `${pw.slice(0, 2)}…${pw.slice(-2)}`;
}
