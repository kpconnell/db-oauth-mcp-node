import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { CredsCache } from './creds/cache.js';
import type { Engine } from './engine/engine.js';
import { createLogger } from './logging.js';
import { MariaDBEngine } from './mariadb/engine.js';
import { MSSQLEngine } from './mssql/engine.js';
import { OAuthClient } from './oauth/client.js';
import { OAuthFlow } from './oauth/flow.js';
import { PoolManager } from './pool/manager.js';
import type { Deps } from './mcp/helpers.js';
import { buildTools, type ToolDef } from './mcp/tools.js';

const VERSION = '0.3.0-dev';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  const engines: Engine[] = [new MariaDBEngine(logger), new MSSQLEngine(logger)];
  const oauthClient = new OAuthClient(cfg, logger);
  const flow = new OAuthFlow(cfg, oauthClient, logger);
  const creds = new CredsCache(cfg, flow, logger);
  const poolMgr = new PoolManager(logger, engines);

  const deps: Deps = { cfg, logger, creds, pool: poolMgr, oauthClient };
  const tools: ToolDef[] = buildTools(deps);
  const byName: Map<string, ToolDef> = new Map(tools.map((t) => [t.name, t]));

  logger.info(
    {
      version: VERSION,
      authorize_url: cfg.authorizeURL,
      api_base_url: cfg.apiBaseURL,
      engines: engines.map((e) => e.name()),
      tools: tools.map((t) => t.name),
    },
    'starting db-oauth-mcp',
  );

  const server = new Server(
    { name: 'db-oauth-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const t = byName.get(req.params.name);
    if (!t) {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await t.handler(args);
    return result as unknown as CallToolResult;
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await poolMgr.closeAll();
      await server.close();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const transport = new StdioServerTransport();

  // MCP clients signal "we're done" by closing the server's stdin.
  // The SDK's transport sees EOF and calls onclose, but Node's event
  // loop keeps the process alive (pino, listeners). Attach shutdown
  // explicitly so we exit cleanly rather than lingering as an orphan.
  transport.onclose = () => void shutdown('transport-close');
  process.stdin.once('end', () => void shutdown('stdin-end'));

  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
