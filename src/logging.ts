import pino, { type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino(
    {
      level: normalizeLevel(level),
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ dest: 2, sync: false }),
  );
}

function normalizeLevel(level: string): string {
  const l = (level || 'info').toLowerCase();
  return ['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(l) ? l : 'info';
}

export function truncSQL(sql: string, max: number): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max) + '…';
}
