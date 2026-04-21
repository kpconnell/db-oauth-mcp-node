/**
 * Pool manager — keyed by connection name, routes to the right engine.
 *
 * If a connection's credentials rotate (username changes under the same
 * name), the old pool is closed and a new one opened. Concurrent
 * `getPool` calls for the same name are serialized so we don't open
 * two pools in parallel for the same connection.
 */

import type { Logger } from 'pino';
import type { Connection } from '../oauth/types.js';
import type { ConnectionSpec, Engine, EnginePool } from '../engine/engine.js';

interface Entry {
  engine: Engine;
  pool: EnginePool;
  username: string;
}

export class PoolManager {
  private readonly engines: Map<string, Engine>;
  private readonly pools: Map<string, Entry> = new Map();
  private readonly inflight: Map<string, Promise<{ pool: EnginePool; engine: Engine }>> =
    new Map();

  constructor(
    private readonly logger: Logger,
    engines: Engine[],
  ) {
    this.engines = new Map(engines.map((e) => [e.name(), e]));
  }

  engineNames(): string[] {
    return [...this.engines.keys()];
  }

  private lookupEngine(conn: Connection): Engine {
    const eng = this.engines.get(conn.engine);
    if (!eng) {
      throw new Error(
        `unsupported engine "${conn.engine}" for connection "${conn.name}" (registered: ${this.engineNames().join(', ')})`,
      );
    }
    return eng;
  }

  /**
   * Return a live pool for conn, opening one on first use. If the
   * cached pool was opened for a different username (creds rotated),
   * the old pool is closed and a new one is opened.
   */
  async getPool(conn: Connection): Promise<{ pool: EnginePool; engine: Engine }> {
    const eng = this.lookupEngine(conn);

    const existing = this.pools.get(conn.name);
    if (existing && existing.username === conn.username && existing.engine.name() === eng.name()) {
      return { pool: existing.pool, engine: existing.engine };
    }

    // Serialize concurrent opens for the same connection name.
    const pending = this.inflight.get(conn.name);
    if (pending) return pending;

    const opening = this.openAndStore(conn, eng, existing);
    this.inflight.set(conn.name, opening);
    try {
      return await opening;
    } finally {
      this.inflight.delete(conn.name);
    }
  }

  private async openAndStore(
    conn: Connection,
    eng: Engine,
    existing: Entry | undefined,
  ): Promise<{ pool: EnginePool; engine: Engine }> {
    if (existing) {
      this.logger.info(
        {
          connection: conn.name,
          old_user: existing.username,
          new_user: conn.username,
        },
        'closing pool for rotated credentials',
      );
      await this.safeClose(existing);
      this.pools.delete(conn.name);
    }

    const spec: ConnectionSpec = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      password: conn.password,
      databases: conn.databases,
      options: conn.options,
    };
    const pool = await eng.open(spec);
    this.pools.set(conn.name, { engine: eng, pool, username: conn.username });
    return { pool, engine: eng };
  }

  async closeOne(name: string): Promise<void> {
    const entry = this.pools.get(name);
    if (!entry) return;
    await this.safeClose(entry);
    this.pools.delete(name);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.pools.entries()];
    this.pools.clear();
    await Promise.all(entries.map(([, e]) => this.safeClose(e)));
  }

  private async safeClose(entry: Entry): Promise<void> {
    try {
      await entry.engine.close(entry.pool);
    } catch (e) {
      this.logger.warn({ err: (e as Error).message }, 'pool close failed');
    }
  }
}
