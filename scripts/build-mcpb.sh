#!/usr/bin/env bash
# Build a .mcpb (Claude Desktop Extension) from the current source tree.
#
# Usage:
#   scripts/build-mcpb.sh [VERSION]
# If VERSION is omitted, uses "dev".
#
# Output: dist-mcpb/db-oauth-mcp-<VERSION>.mcpb — a zip containing
#   manifest.json, icon.png, server/ (tsc output + flattened prod
#   node_modules). One artifact, runs on all four Claude Desktop
#   platforms since everything is Node.
set -euo pipefail

VERSION="${1:-dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING="$ROOT/staging"
OUT_DIR="$ROOT/dist-mcpb"
OUT="$OUT_DIR/db-oauth-mcp-$VERSION.mcpb"

cd "$ROOT"

rm -rf "$STAGING"
mkdir -p "$STAGING/server" "$OUT_DIR"

echo ">> installing dev deps + building TypeScript"
pnpm install --frozen-lockfile
pnpm run build

echo ">> staging compiled sources"
cp -R dist/. "$STAGING/server/"

echo ">> creating server package.json (ESM + pointer to entry)"
cat > "$STAGING/server/package.json" <<'JSON'
{
  "name": "db-oauth-mcp-server",
  "version": "0.0.0-bundled",
  "private": true,
  "type": "module",
  "main": "server.js"
}
JSON
# MCP manifest expects the entry at server/index.js. tsc emits server.js,
# so symlink the expected name.
cp "$STAGING/server/server.js" "$STAGING/server/index.js"

echo ">> installing production dependencies into staging/server (flat layout)"
# Extract `dependencies` from the root package.json into the staged
# package.json. Use plain npm for the staging install so we get a flat
# node_modules — pnpm's symlink-farm layout triples the .mcpb size
# because the zip captures both the virtual store and the top-level
# symlink shims.
node -e '
  const fs = require("fs");
  const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const bundled = JSON.parse(fs.readFileSync("staging/server/package.json", "utf8"));
  bundled.dependencies = root.dependencies;
  fs.writeFileSync("staging/server/package.json", JSON.stringify(bundled, null, 2));
'
(cd "$STAGING/server" && npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --silent)
# Drop npm's own bookkeeping that doesn't need to ship.
rm -f "$STAGING/server/package-lock.json"

echo ">> copying manifest + icon (with VERSION substitution)"
sed "s/{{VERSION}}/$VERSION/g" "$ROOT/mcpb/manifest.json" > "$STAGING/manifest.json"
cp "$ROOT/mcpb/icon.png" "$STAGING/icon.png"

echo ">> zipping .mcpb"
rm -f "$OUT"
(cd "$STAGING" && zip -rq "$OUT" .)
echo ">> built: $OUT"
du -h "$OUT" | awk '{print "   size:", $1}'
