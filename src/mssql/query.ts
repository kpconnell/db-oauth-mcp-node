/**
 * Query execution + result serialization for Microsoft SQL Server.
 *
 * The `mssql` driver (tedious under the hood) returns:
 *   - numbers for INT / BIGINT / REAL / FLOAT
 *   - Decimal-like strings for DECIMAL / NUMERIC / MONEY (driver default)
 *   - Date for DATE / DATETIME / DATETIME2 / DATETIMEOFFSET / TIME / SMALLDATETIME
 *   - Buffer for VARBINARY / BINARY / IMAGE
 *   - string for UNIQUEIDENTIFIER
 *   - string for NVARCHAR / VARCHAR / NCHAR / CHAR / TEXT / NTEXT
 *
 * We re-render Buffers and Dates into the same shape the Go server
 * produces so A/B responses match byte-for-byte.
 */

import type { ConnectionPool, IColumnMetadata, IRecordSet } from 'mssql';
import type { QueryResult } from '../engine/engine.js';

export const BINARY_INLINE_THRESHOLD = 4096;

export async function execute(
  pool: ConnectionPool,
  sqlStr: string,
  rowLimit: number,
  _timeoutMs: number,
): Promise<QueryResult> {
  // Per-statement timeout is inherited from the pool config
  // (requestTimeout set in engine.ts at pool creation).
  const req = pool.request();

  const start = Date.now();
  const result = await req.query(sqlStr);

  const recordset = Array.isArray(result.recordset)
    ? (result.recordset as IRecordSet<Record<string, unknown>>)
    : undefined;

  if (!recordset || recordset.length === 0) {
    const cols = recordset?.columns ? columnsFromMetadata(recordset.columns) : [];
    return {
      columns: cols,
      rows: [],
      row_count: 0,
      truncated: false,
      elapsed_ms: Date.now() - start,
    };
  }

  const meta = recordset.columns;
  const columns = columnsFromMetadata(meta);

  let truncated = false;
  let hint: string | undefined;
  const rows: Record<string, unknown>[] = [];
  for (const raw of recordset) {
    if (rows.length >= rowLimit) {
      truncated = true;
      hint = `Row limit of ${rowLimit} reached. Add a TOP clause or narrow your query to see more.`;
      break;
    }
    const row: Record<string, unknown> = {};
    for (const name of columns) {
      const colMeta = meta?.[name];
      row[name] = serializeValue(raw[name], typeNameFromMeta(colMeta));
    }
    rows.push(row);
  }

  return {
    columns,
    rows,
    row_count: rows.length,
    truncated,
    elapsed_ms: Date.now() - start,
    ...(hint ? { hint } : {}),
  };
}

function columnsFromMetadata(meta: IColumnMetadata | undefined): string[] {
  if (!meta) return [];
  return Object.keys(meta).sort((a, b) => {
    const ia = meta[a]?.index ?? 0;
    const ib = meta[b]?.index ?? 0;
    return ia - ib;
  });
}

/**
 * Derive a canonical uppercase type name from the mssql driver's column
 * metadata. The driver reports via `type.name`, e.g. "NVarChar",
 * "VarBinary", "UniqueIdentifier".
 */
function typeNameFromMeta(
  col: IColumnMetadata[string] | undefined,
): string {
  // mssql surfaces `type` either as a class constructor (Function with
  // .name like "NVarChar") or as an ISqlType instance. Both have a
  // .name derivable via the constructor. Cast through unknown because
  // the mssql .d.ts union doesn't expose .name cleanly.
  const t = col?.type as unknown;
  if (typeof t === 'function' && typeof (t as { name?: string }).name === 'string') {
    return (t as { name: string }).name.toUpperCase();
  }
  if (t && typeof t === 'object') {
    const ctorName = (t as { constructor?: { name?: string } }).constructor?.name;
    if (typeof ctorName === 'string') return ctorName.toUpperCase();
  }
  return 'UNKNOWN';
}

export function serializeValue(v: unknown, typeName: string): unknown {
  if (v === null || v === undefined) return null;

  if (Buffer.isBuffer(v)) {
    switch (typeName) {
      case 'VARBINARY':
      case 'BINARY':
      case 'IMAGE':
      case 'ROWVERSION':
      case 'TIMESTAMP':
        return v.length > BINARY_INLINE_THRESHOLD
          ? `<${v.length} bytes>`
          : v.toString('base64');
      default:
        return v.toString('utf8');
    }
  }

  if (v instanceof Date) {
    switch (typeName) {
      case 'DATE':
        return formatDateOnly(v);
      case 'TIME':
        return formatTimeOnly(v);
      default:
        return formatISO(v);
    }
  }

  return v;
}

function formatDateOnly(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTimeOnly(d: Date): string {
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  const ms = d.getUTCMilliseconds();
  return ms === 0 ? `${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}.${ms.toString().padStart(3, '0')}`;
}

function formatISO(d: Date): string {
  // mssql driver often returns milliseconds; use full ISO (RFC3339Nano).
  return d.toISOString();
}
