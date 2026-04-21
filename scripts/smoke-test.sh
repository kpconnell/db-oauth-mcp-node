#!/usr/bin/env bash
# End-to-end smoke test for db-oauth-mcp (Node port).
#
# What it does:
#   1. Boots `node dist/server.js` as a coprocess via named FIFOs.
#   2. Drives it through initialize + tools/list (validates schemas).
#   3. Calls list_connections — on first run this triggers the OAuth
#      browser flow; subsequent runs within the token lifetime skip
#      straight to the cached session.
#   4. For each returned connection, runs `SELECT 1 AS ok` via
#      query_database (proves MariaDB/MSSQL connectivity end-to-end;
#      for MSSQL, this exercises the encrypt / trust_server_certificate
#      options translation — the fix for RDS self-signed-fallback certs).
#   5. For each connection, calls list_schema and prints first 5 tables.
#   6. Prints a per-connection pass/fail summary.
#
# Requires: jq, a compiled build at dist/server.js, and a running
# OAuth backend at $OAUTH_API_BASE_URL.
#
# Flags:
#   --no-auth       Stop after tools/list (no OAuth, no browser).
#   --skip-query    Run list_connections + list_schema but skip SELECT 1s.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="${ENTRY:-$ROOT/dist/server.js}"
export OAUTH_AUTHORIZE_URL="${OAUTH_AUTHORIZE_URL:-http://localhost:5173/mcp/authorize}"
export OAUTH_API_BASE_URL="${OAUTH_API_BASE_URL:-http://localhost:8080}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

no_auth=0
skip_query=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-auth) no_auth=1; shift ;;
    --skip-query) skip_query=1; shift ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
      exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null || { echo "jq is required (brew install jq)" >&2; exit 2; }
[[ -f "$ENTRY" ]] || {
  echo "server entry not found: $ENTRY" >&2
  echo "build first: pnpm run build" >&2
  exit 1
}

TMP=$(mktemp -d -t db-oauth-mcp-smoke.XXXXXX)
MCP_PID=""
cleanup() {
  if [[ -n "$MCP_PID" ]]; then
    kill "$MCP_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

STDERR_LOG="$TMP/stderr.log"
mkfifo "$TMP/req" "$TMP/resp"

# Start server first; its open-for-read on req and open-for-write on
# resp will unblock once we open our matching ends.
node "$ENTRY" <"$TMP/req" >"$TMP/resp" 2> >(tee "$STDERR_LOG" >&2) &
MCP_PID=$!
exec 3>"$TMP/req" 4<"$TMP/resp"

send() { printf '%s\n' "$1" >&3; }
recv() {
  local line
  if ! IFS= read -r line <&4; then
    echo "server closed stdout unexpectedly; see $STDERR_LOG" >&2
    exit 1
  fi
  printf '%s' "$line"
}
call_tool() {
  local id="$1" name="$2" args="$3"
  local req
  req=$(jq -nc --argjson id "$id" --arg n "$name" --argjson args "$args" '
    {jsonrpc:"2.0", id:$id, method:"tools/call",
     params:{name:$n, arguments:$args}}')
  send "$req"
  recv
}

echo "-- env --"
echo "OAUTH_AUTHORIZE_URL=$OAUTH_AUTHORIZE_URL"
echo "OAUTH_API_BASE_URL=$OAUTH_API_BASE_URL"
echo "LOG_LEVEL=$LOG_LEVEL"
echo "ENTRY=$ENTRY"
echo "stderr log: $STDERR_LOG"

echo
echo "-- initialize --"
send '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
init=$(recv)
echo "  server: $(echo "$init" | jq -c '.result.serverInfo')"
send '{"jsonrpc":"2.0","method":"notifications/initialized"}'

echo
echo "-- tools/list --"
send '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
tools=$(recv)
echo "$tools" | jq -r '.result.tools[].name' | sort | sed 's/^/  /'

if [[ $no_auth -eq 1 ]]; then
  echo
  echo "-- stopping (--no-auth) --"
  exec 3>&-
  wait "$MCP_PID" 2>/dev/null || true
  MCP_PID=""
  echo "done."
  exit 0
fi

echo
echo "-- list_connections --"
echo "   (first run opens a browser for OAuth login)"
conn_resp=$(call_tool 2 list_connections '{}')
err=$(echo "$conn_resp" | jq -r '.result.isError // false')
if [[ "$err" == "true" ]]; then
  echo "list_connections failed:" >&2
  echo "$conn_resp" | jq -r '.result.content[0].text' >&2
  exit 1
fi

conns_json=$(echo "$conn_resp" | jq -r '.result.content[0].text')
echo "$conns_json" | jq .
count=$(echo "$conns_json" | jq 'length')
echo "   -> $count connection(s)"

echo "$conns_json" | jq -c '.[]' > "$TMP/conns.txt"

id=100
pass=0
fail=0

if [[ $skip_query -eq 0 ]]; then
  echo
  echo "-- query_database: SELECT 1 AS ok per connection --"
  while IFS= read -r conn; do
    name=$(echo "$conn" | jq -r '.name')
    eng=$(echo "$conn"  | jq -r '.engine')
    id=$((id+1))
    args=$(jq -nc --arg n "$name" --arg q "SELECT 1 AS ok" '{connection:$n, sql:$q}')
    resp=$(call_tool "$id" query_database "$args")
    err=$(echo "$resp" | jq -r '.result.isError // false')
    if [[ "$err" == "true" ]]; then
      fail=$((fail+1))
      msg=$(echo "$resp" | jq -r '.result.content[0].text' | head -c 300)
      printf '  [FAIL] %s (%s): %s\n' "$name" "$eng" "$msg"
    else
      pass=$((pass+1))
      body=$(echo "$resp" | jq -r '.result.content[0].text')
      rows=$(echo "$body" | jq -c '.rows')
      elapsed=$(echo "$body" | jq -r '.elapsed_ms')
      printf '  [ OK ] %s (%s): %sms rows=%s\n' "$name" "$eng" "$elapsed" "$rows"
    fi
  done < "$TMP/conns.txt"
fi

echo
echo "-- list_schema per connection (first 5 tables) --"
while IFS= read -r conn; do
  name=$(echo "$conn" | jq -r '.name')
  eng=$(echo "$conn"  | jq -r '.engine')
  id=$((id+1))
  args=$(jq -nc --arg n "$name" '{connection:$n}')
  resp=$(call_tool "$id" list_schema "$args")
  err=$(echo "$resp" | jq -r '.result.isError // false')
  if [[ "$err" == "true" ]]; then
    fail=$((fail+1))
    msg=$(echo "$resp" | jq -r '.result.content[0].text' | head -c 300)
    printf '  [FAIL] %s (%s): %s\n' "$name" "$eng" "$msg"
  else
    pass=$((pass+1))
    body=$(echo "$resp" | jq -r '.result.content[0].text')
    if [[ "$body" == "null" ]]; then
      total=0
      head5="[]"
    else
      total=$(echo "$body" | jq 'length')
      head5=$(echo "$body" | jq -c '.[0:5]')
    fi
    printf '  [ OK ] %s (%s): %s total, first 5: %s\n' "$name" "$eng" "$total" "$head5"
  fi
done < "$TMP/conns.txt"

echo
printf '== %d passed / %d failed ==\n' "$pass" "$fail"

exec 3>&-
wait "$MCP_PID" 2>/dev/null || true
MCP_PID=""

[[ $fail -eq 0 ]]
