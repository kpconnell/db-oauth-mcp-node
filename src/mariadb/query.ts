/**
 * Query execution and result serialization for MariaDB / MySQL.
 *
 * mysql2/promise returns:
 *   - numbers for INT-family, FLOAT, DOUBLE
 *   - strings for DECIMAL / NUMERIC (because `decimalNumbers: false`)
 *   - Date for DATE / DATETIME / TIMESTAMP (because `dateStrings: false`)
 *   - Buffer for BLOB / BINARY / VARBINARY
 *   - string for CHAR / VARCHAR / TEXT
 *
 * We map the two Buffer / Date cases into the same shape the Go server
 * produces so A/B responses match byte-for-byte.
 */

import type { Pool, RowDataPacket, FieldPacket } from 'mysql2/promise';
import type { QueryResult } from '../engine/engine.js';

export const BINARY_INLINE_THRESHOLD = 4096;

export async function execute(
  pool: Pool,
  sql: string,
  rowLimit: number,
  timeoutMs: number,
): Promise<QueryResult> {
  const start = Date.now();
  const [rowsRaw, fieldsRaw] = await pool.query<RowDataPacket[]>({
    sql,
    timeout: timeoutMs,
    rowsAsArray: false,
  });
  const fields = fieldsRaw as FieldPacket[];

  let truncated = false;
  let hint: string | undefined;
  const rows: Record<string, unknown>[] = [];
  for (const raw of rowsRaw) {
    if (rows.length >= rowLimit) {
      truncated = true;
      hint = `Row limit of ${rowLimit} reached. Add a LIMIT clause or narrow your query to see more.`;
      break;
    }
    const row: Record<string, unknown> = {};
    for (const f of fields) {
      row[f.name] = serializeValue(raw[f.name], f);
    }
    rows.push(row);
  }

  return {
    columns: fields.map((f) => f.name),
    rows,
    row_count: rows.length,
    truncated,
    elapsed_ms: Date.now() - start,
    ...(hint ? { hint } : {}),
  };
}

/**
 * Serialize a single cell value.
 *
 * We key on the driver's column type rather than the runtime JS type so
 * DATE and DATETIME Date objects render differently (the latter gets a
 * time component; the former doesn't).
 */
export function serializeValue(v: unknown, field: FieldPacket): unknown {
  if (v === null || v === undefined) return null;

  const typeName = columnTypeName(field);

  if (Buffer.isBuffer(v)) {
    switch (typeName) {
      case 'DECIMAL':
      case 'NUMERIC':
        return v.toString('utf8');
      case 'DATE':
      case 'DATETIME':
      case 'TIMESTAMP':
        // Rare under default driver settings (those types usually come
        // back as Date or string), but preserve the Go behavior if they
        // do appear as bytes.
        return parseDateOrUTCString(v.toString('utf8'));
      case 'BLOB':
      case 'TINYBLOB':
      case 'MEDIUMBLOB':
      case 'LONGBLOB':
      case 'BINARY':
      case 'VARBINARY':
        return v.length > BINARY_INLINE_THRESHOLD
          ? `<${v.length} bytes>`
          : v.toString('base64');
      default:
        return v.toString('utf8');
    }
  }

  if (v instanceof Date) {
    if (typeName === 'DATE') {
      return formatDateOnly(v);
    }
    return formatRFC3339(v);
  }

  return v;
}

function formatDateOnly(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** RFC3339 without fractional seconds, UTC — matches Go's time.RFC3339. */
function formatRFC3339(d: Date): string {
  const iso = d.toISOString();
  return iso.replace(/\.\d+Z$/u, 'Z');
}

/**
 * Handle the `[]byte` MariaDB text path for DATE/DATETIME/TIMESTAMP.
 * Matches Go: try ISO-space form first, then date-only, else pass-through.
 */
function parseDateOrUTCString(s: string): string {
  const spaceMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u.exec(s);
  if (spaceMatch) {
    const d = new Date(`${spaceMatch[1]}T${spaceMatch[2]}Z`);
    if (!Number.isNaN(d.getTime())) return formatRFC3339(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(s)) return s;
  return s;
}

/**
 * Translate mysql2's numeric type code into the same name string the Go
 * driver's `DatabaseTypeName()` returns. Only the types serializeValue
 * actually branches on need a specific mapping; everything else falls
 * through to the default (treated as text).
 */
function columnTypeName(field: FieldPacket): string {
  // mysql2 exposes type codes as numbers. See:
  //   https://github.com/sidorares/node-mysql2/blob/master/lib/constants/types.js
  switch (field.columnType) {
    case 0x00:
      return 'DECIMAL';
    case 0xf6:
      return 'NUMERIC'; // NEWDECIMAL on the wire; Go surfaces as DECIMAL
    case 0x0a:
      return 'DATE';
    case 0x0c:
      return 'DATETIME';
    case 0x07:
      return 'TIMESTAMP';
    case 0xfc:
      return 'BLOB';
    case 0xf9:
      return 'TINYBLOB';
    case 0xfa:
      return 'MEDIUMBLOB';
    case 0xfb:
      return 'LONGBLOB';
    case 0xfe:
      return (Number(field.flags ?? 0) & 0x80) !== 0 ? 'BINARY' : 'CHAR';
    case 0xfd:
      return (Number(field.flags ?? 0) & 0x80) !== 0 ? 'VARBINARY' : 'VARCHAR';
    default:
      return 'UNKNOWN';
  }
}
