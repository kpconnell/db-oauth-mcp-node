import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { createLogger } from './logging.js';

const VERSION = '0.3.0-dev';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  logger.info(
    {
      version: VERSION,
      authorize_url: cfg.authorizeURL,
      api_base_url: cfg.apiBaseURL,
      engines: [],
    },
    'starting db-oauth-mcp',
  );

  const server = new Server(
    { name: 'db-oauth-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Phase 1 stub — no tools registered yet. Subsequent phases wire each tool.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    throw new Error(`unknown tool: ${req.params.name}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
