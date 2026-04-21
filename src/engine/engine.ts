/**
 * Engine interface + shared types.
 *
 * Adding a new database backend means providing a class that implements
 * `Engine` and registering it in `server.ts` alongside the existing
 * engines. The rest of the stack routes by `Engine.name()`, which must
 * match the `engine` field the OAuth backend returns in each
 * `connections[]` entry.
 */

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  hint?: string;
}

export interface Table {
  schema: string;
  table: string;
}

export interface Column {
  name: string;
  type: string;
  nullable: string;
  default: string | null;
  comment?: string;
}

/**
 * What an engine needs to open a pool. Decoupled from `oauth.Connection`
 * so this package has no dependency on the OAuth layer.
 */
export interface ConnectionSpec {
  host: string;
  port: number;
  username: string;
  password: string;
  databases: string[];
  /**
   * Engine-specific hints from the OAuth backend (e.g. mssql TLS flags).
   * Keys are snake_case; values are booleans / strings / numbers. Each
   * engine reads the keys it knows about and ignores the rest.
   */
  options?: Record<string, unknown>;
}

/** Opaque pool handle. Each engine owns the driver-specific concrete type. */
export type EnginePool = unknown;

export interface Engine {
  /** Engine identifier used in `oauth.Connection.engine`. */
  name(): string;

  /** Open a new pool for spec. Caller owns the lifecycle (close on rotation). */
  open(spec: ConnectionSpec): Promise<EnginePool>;

  /** Throw with a helpful message if sql isn't permitted under this engine's rules. */
  validateSQL(sql: string): void;

  /** Run sql, return up to rowLimit rows, respecting timeoutMs. */
  execute(
    pool: EnginePool,
    sql: string,
    rowLimit: number,
    timeoutMs: number,
  ): Promise<QueryResult>;

  /**
   * List tables visible through pool, optionally filtered to the given
   * schemas (empty falls back to engine-specific defaults — i.e. skip
   * system schemas).
   */
  listTables(pool: EnginePool, schemas: string[]): Promise<Table[]>;

  /**
   * Describe columns for a qualified name (`schema.table`). Engines
   * parse this themselves so MariaDB can accept `database.table` form
   * and mssql can accept `schema.table` within the initial catalog.
   */
  describeTable(pool: EnginePool, qualified: string): Promise<Column[]>;

  /**
   * Return true when `err` is a credential-rejection from the driver
   * and a reauth-then-retry is worth attempting.
   */
  isAuthError(err: unknown): boolean;

  /**
   * Close the pool cleanly. Called on rotation, disconnect, and shutdown.
   */
  close(pool: EnginePool): Promise<void>;
}

/**
 * Read key from `opts` as a boolean. Accepts:
 *   - native booleans
 *   - strings: "true"/"True"/"TRUE"/"1"/"yes"  → true
 *             "false"/"False"/"FALSE"/"0"/"no" → false
 *   - numbers: 1 → true, 0 → false
 * Returns `{ value, found }`. Missing / unparseable → `{ value: false, found: false }`.
 */
export function boolOption(
  opts: Record<string, unknown> | undefined,
  key: string,
): { value: boolean; found: boolean } {
  if (!opts || !(key in opts)) return { value: false, found: false };
  const v = opts[key];
  if (typeof v === 'boolean') return { value: v, found: true };
  if (typeof v === 'number') {
    if (v === 1) return { value: true, found: true };
    if (v === 0) return { value: false, found: true };
  }
  if (typeof v === 'string') {
    const lower = v.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes') {
      return { value: true, found: true };
    }
    if (lower === 'false' || lower === '0' || lower === 'no') {
      return { value: false, found: true };
    }
  }
  return { value: false, found: false };
}

/** Read key from `opts` as a string. Missing / non-string → `{ value: '', found: false }`. */
export function stringOption(
  opts: Record<string, unknown> | undefined,
  key: string,
): { value: string; found: boolean } {
  if (!opts || !(key in opts)) return { value: '', found: false };
  const v = opts[key];
  return typeof v === 'string' ? { value: v, found: true } : { value: '', found: false };
}
