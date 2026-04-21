# db-oauth-mcp

Node.js MCP server (TypeScript, distributed as a `.mcpb` Desktop Extension)
that lets Claude Desktop run read-only SQL against one or more databases,
gated by OAuth 2.0 PKCE. Credentials are per-user, short-lived, and never
touch disk.

Supported engines: **MariaDB / MySQL** and **Microsoft SQL Server**. A
single OAuth session can expose any number of connections across either
engine — the backend decides what to hand out.

This is the Node port of
[db-oauth-mcp](https://github.com/kpconnell/db-oauth-mcp) (previously Go).
Same OAuth contract, same tool surface, same behavior — but distributed as
one platform-neutral zip with no code signing, no cross-compilation, and
no native binary.

## Status

Under construction. The Go implementation at v0.2.x remains the current
recommendation until this repo tags v0.3.0.

## Development

Requires Node 18+ and pnpm 10+.

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
OAUTH_AUTHORIZE_URL=https://auth.example.com/mcp/authorize \
OAUTH_API_BASE_URL=https://api.example.com \
LOG_LEVEL=debug \
node dist/server.js
```

See the [Go repo README](https://github.com/kpconnell/db-oauth-mcp#readme)
for the OAuth contract, tool documentation, and engine-specific safety
rules, all of which are inherited verbatim here.

## License

MIT. See [LICENSE](LICENSE).
