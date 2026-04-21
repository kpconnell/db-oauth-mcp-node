# Remote MCP on Laravel — Architecture

This document describes the target architecture for moving `db-oauth-mcp` from
a locally-installed stdio MCP server (the v0.3.x Node port) to a remote MCP
server hosted on our existing Laravel backend. The goal is workspace-level
installation in Claude Cowork with no per-user install and no code signing.

The Node port remains the recommended implementation until the Laravel
endpoint is shipped; this doc captures the design of what replaces it.

---

## Why move

- **Cowork admins can install remote MCP servers once for the whole
  workspace.** Every member gets the tools in their chats without
  downloading or dragging a `.mcpb` into Claude Desktop.
- **No code signing.** The Windows signing story in particular (USB-token
  CAs, no file-based `.pfx` from major CAs) is a real operational cost.
  A remote endpoint has no executable to sign.
- **Updates ship like any other backend change.** `git push` → deploy.
  No tagging, no `.mcpb` assembly, no "teammates please re-drag the new
  file" coordination.
- **DB credentials stop leaving the server.** The stdio model hands the
  user's DB creds to a Node process on each laptop. In the remote model
  credentials stay inside Laravel, which already knows the user from
  their session and can run the query directly.
- **Single auth model.** The custom OAuth endpoints we built for the
  stdio flow (`/api/mcp/oauth/token`, `/refresh`, `/revoke` — which
  return DB creds in the token response) are replaced by standard
  OAuth 2.0 via Laravel Passport. Cowork is treated as any other
  OAuth client.

## Non-goals

- Replacing Azure AD as the identity source. Alice is still an Azure AD
  user.
- Changing the SPA or the Sanctum-based API flow the SPA uses today.
- Changing how DB credentials are modeled or provisioned. The existing
  per-user → per-connection lookup carries over.

---

## Architecture at a glance

Three parties, three independent concerns:

```
                 ┌─────────────┐
                 │   Azure AD  │   identity: "who is Alice?"
                 └──────▲──────┘
                        │ OIDC (existing SSO, via Socialite)
                        │
   ┌────────────────────┴──────────────────┐
   │                                       │
   │             Laravel                   │
   │   ┌─────────────────────────────┐     │
   │   │  Sanctum (existing)         │◄── SPA (your users)
   │   │    for user/SPA auth        │
   │   └─────────────────────────────┘     │
   │   ┌─────────────────────────────┐     │
   │   │  Passport (new)             │◄── Cowork (OAuth client)
   │   │    for OAuth provider role │
   │   └─────────────────────────────┘     │
   │   ┌─────────────────────────────┐     │
   │   │  /api/mcp route (new)       │◄── Cowork (bearer-authed calls)
   │   │    JSON-RPC dispatch        │
   │   └─────────────────────────────┘     │
   └───────────────────────────────────────┘
                        │
                        │ PDO (MySQL/SQLSrv)
                        ▼
                  MariaDB, MSSQL
```

Laravel plays two OAuth roles:

- **OAuth client → Azure AD** — how Alice logs into Laravel. Unchanged
  from today (Socialite + `socialiteproviders/microsoft-azure`).
- **OAuth provider → Cowork** — how Cowork obtains tokens to act on
  Alice's behalf. New, via Passport.

These are independent. Passport does not talk to Azure. Cowork does
not talk to Azure. Azure is only in the loop when Alice's Laravel
session needs to be established.

---

## Laravel stays a pure API

Constraint: no web routes, no Blade views. The SPA is the only HTML-
rendering layer.

This means the OAuth authorize endpoint — the one browser-facing step
in the OAuth 2.0 dance — does **not** live on Laravel. It lives on the
SPA. Laravel exposes a companion API endpoint the SPA calls to turn a
validated authorize request into an authorization code.

The token endpoint (server-to-server only) and the MCP endpoint
(server-to-server only) live on Laravel and are pure API.

### URL allocation

| URL | Host | Nature | Caller |
|---|---|---|---|
| `https://spa.example.com/oauth/authorize` | SPA | Browser-facing | Cowork redirects Alice's browser here |
| `https://api.example.com/api/oauth/authorize-approve` | Laravel | JSON API | SPA (Sanctum-authenticated) |
| `https://api.example.com/api/oauth/token` | Laravel | JSON API | Cowork server |
| `https://api.example.com/api/oauth/token/refresh` | Laravel | JSON API | Cowork server |
| `https://api.example.com/api/mcp` | Laravel | JSON-RPC | Cowork server |

Cowork's OAuth configuration supports separate hosts for authorize vs
token endpoints (this is standard OAuth 2.0 — the two endpoints have
different transport characteristics and don't need to share a domain).

---

## End-to-end flow

Alice is in a Cowork chat. She asks Claude to run a query.

### 1. Cowork redirects Alice's browser

```
Alice's browser → GET https://spa.example.com/oauth/authorize
  ?client_id=cowork
  &redirect_uri=https://claude.ai/api/integrations/mcp/oauth/callback
  &response_type=code
  &scope=mcp
  &state=<opaque>
  &code_challenge=<base64url(sha256(verifier))>
  &code_challenge_method=S256
```

### 2. SPA ensures Alice is authenticated

The SPA's route handler for `/oauth/authorize`:

- Checks whether Alice has an active Sanctum session.
- If not: triggers the existing Azure SSO flow with
  `return_to=/oauth/authorize?...`. Azure returns her; Laravel
  establishes a Sanctum session; the SPA lands back on this route.
- If yes: proceeds.

This reuses the SPA's existing `ensureAuthenticated` guard. Zero new
SSO machinery.

### 3. SPA asks Laravel to generate an authorization code

```
SPA → POST https://api.example.com/api/oauth/authorize-approve
Cookie: sanctum_session=...
Body:
{
  "client_id":             "cowork",
  "redirect_uri":          "https://claude.ai/api/integrations/mcp/oauth/callback",
  "state":                 "<opaque>",
  "code_challenge":        "<chal>",
  "code_challenge_method": "S256",
  "scope":                 "mcp"
}
```

Laravel's controller:

- Authenticates the caller via `auth:sanctum` middleware → Alice.
- Validates the OAuth authorize parameters against Passport's
  `AuthorizationServer` (verifies `client_id`, `redirect_uri`,
  `scope`, PKCE challenge presence).
- Auto-approves: the Cowork client is first-party (admin-registered),
  so no consent screen is shown.
- Generates the authorization code, signed and bound to Alice's
  user ID.
- Returns the redirect URL the SPA should send Alice's browser to:

```json
{
  "redirect_to": "https://claude.ai/api/integrations/mcp/oauth/callback?code=<code>&state=<opaque>"
}
```

### 4. SPA redirects Alice's browser to Cowork

```javascript
window.location.href = response.data.redirect_to;
```

Cowork's callback handler receives `code` and `state`. The browser's
part of the flow is done.

### 5. Cowork exchanges the code for tokens (server-to-server)

```
Cowork server → POST https://api.example.com/api/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code>
&redirect_uri=https://claude.ai/api/integrations/mcp/oauth/callback
&client_id=cowork
&client_secret=<secret>
&code_verifier=<pkce-verifier>
```

Laravel (Passport's standard controller) validates everything and
responds:

```json
{
  "token_type":    "Bearer",
  "access_token":  "eyJ...",
  "expires_in":    3600,
  "refresh_token": "def987...",
  "scope":         "mcp"
}
```

Cowork stores these tokens, keyed by Alice's Cowork identity.

### 6. Every subsequent tool call

```
Cowork server → POST https://api.example.com/api/mcp
Authorization: Bearer eyJ...
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"query_database",
           "arguments":{"connection":"vrp","sql":"SELECT TOP 10 * FROM dbo.orders"}}}
```

Laravel:

- `auth:api` middleware resolves the bearer token → Alice's `User`.
- `scope:mcp` middleware checks the token was issued with the `mcp` scope.
- `McpController::handle` dispatches by JSON-RPC method:
  - `initialize` → server capabilities
  - `tools/list` → tool metadata (name, description, schema)
  - `tools/call` → tool handler by name
- The tool handler (e.g. `QueryDatabase`) looks up Alice's DB
  credentials via the same internal mechanism that exists today,
  opens a PDO connection, runs the query, returns a
  `CallToolResult`-shaped response.

### 7. Token refresh (automatic, invisible)

Cowork refreshes silently:

```
Cowork server → POST https://api.example.com/api/oauth/token
Body: grant_type=refresh_token, refresh_token=..., client_id=cowork, client_secret=..., scope=mcp
```

Access tokens expire in 1 hour by default; refresh tokens in 30 days.
If refresh fails (Alice revoked, admin removed the integration, her
Laravel account is disabled), Cowork falls back to the authorize flow
on her next tool use, which silently bounces through Azure and lands
back in a working state.

---

## Org-level grant, user-level attribution

The admin registers the integration in Cowork admin once; all
workspace members get the tools in their chats. But **each API call
to `/api/mcp` is still authenticated as a specific user.**

- Alice's bearer token → Alice's `User` record → Alice's DB
  credentials → query runs as Alice in the DB.
- Bob using the same workspace has a separate bearer token, tied to
  his `User` record.
- Audit logs, rate limits, and per-user DB permissions work exactly
  as they do through the SPA today.

Two levels of grant, two different scopes:

| Level | Who grants | Scope |
|---|---|---|
| Org | Cowork admin registering the integration | "Cowork may request tokens on behalf of workspace members." |
| User | Each member (implicitly, first use) | "Cowork may act as me at this Laravel instance." |

For internal use, the user-level grant is implicit — the Cowork
client is marked first-party in Passport, so no consent screen is
shown. Alice's first tool use is a silent Azure SSO bounce (if her
Laravel session has lapsed) followed by an instant authorization code
issuance. No clicks beyond her Microsoft login.

---

## Laravel implementation

### Package additions

```bash
composer require laravel/passport
php artisan install:api --passport   # Laravel 11+
php artisan passport:keys
```

Passport coexists with Sanctum without conflict — they're different
auth guards driven by different middleware. The SPA continues using
Sanctum; Cowork uses Passport.

### Guards

```php
// config/auth.php
'guards' => [
    'web'     => ['driver' => 'session', 'provider' => 'users'],
    'sanctum' => ['driver' => 'sanctum', 'provider' => 'users'],   // existing
    'api'     => ['driver' => 'passport', 'provider' => 'users'],  // new
],
```

### User model

```php
// app/Models/User.php
use Laravel\Passport\HasApiTokens as PassportTokens;
use Laravel\Sanctum\HasApiTokens as SanctumTokens;

class User extends Authenticatable
{
    use PassportTokens;
    use SanctumTokens { SanctumTokens::tokens insteadof PassportTokens; }
    // ... existing code
}
```

### Passport scope + client config

```php
// app/Providers/AppServiceProvider.php
public function boot(): void
{
    Passport::tokensCan([
        'mcp' => 'Run read-only SQL via MCP',
    ]);
    Passport::tokensExpireIn(now()->addHour());
    Passport::refreshTokensExpireIn(now()->addDays(30));
}
```

Register the Cowork client:

```bash
php artisan passport:client \
  --name="Claude Cowork" \
  --redirect_uri="https://claude.ai/api/integrations/mcp/oauth/callback"
# prints client_id + client_secret → paste into Cowork admin UI
```

Mark it as first-party to skip the consent screen for admin-
registered internal integrations. In the `oauth_clients` migration
row for this client, set `first_party = true` (or whichever column
your Passport version uses; recent versions use `personal_access`
and `password_client` booleans — the custom authorize controller
below handles auto-approval explicitly so you don't depend on this).

### Routes

```php
// routes/api.php
use App\Http\Controllers\OAuthController;
use App\Http\Controllers\McpController;
use Laravel\Passport\Http\Controllers as Passport;

Route::prefix('oauth')->group(function () {
    // SPA-facing: Sanctum-authed, returns the redirect URL the SPA should use
    Route::post('authorize-approve', [OAuthController::class, 'approve'])
         ->middleware('auth:sanctum');

    // Cowork-facing: standard Passport endpoints, pure API
    Route::post('token', [Passport\AccessTokenController::class, 'issueToken']);
    Route::post('token/refresh', [Passport\TransientTokenController::class, 'refresh']);
    Route::delete('tokens/{id}', [Passport\AuthorizedAccessTokenController::class, 'destroy']);
});

Route::post('mcp', [McpController::class, 'handle'])
     ->middleware(['auth:api', 'scope:mcp']);
```

### Custom authorize-approve controller

```php
// app/Http/Controllers/OAuthController.php
use League\OAuth2\Server\AuthorizationServer;
use Laravel\Passport\Bridge\User as UserEntity;
use Nyholm\Psr7\Response as Psr7Response;

class OAuthController extends Controller
{
    public function approve(Request $req, AuthorizationServer $server)
    {
        $validated = $req->validate([
            'client_id'             => 'required|string',
            'redirect_uri'          => 'required|url',
            'state'                 => 'required|string',
            'code_challenge'        => 'required|string',
            'code_challenge_method' => 'required|in:S256',
            'scope'                 => 'required|string',
        ]);

        // Rebuild the OAuth authorize request as a PSR-7 GET.
        $psr7 = $this->buildPsr7AuthorizeRequest($validated);
        $authRequest = $server->validateAuthorizationRequest($psr7);

        $authRequest->setUser(new UserEntity($req->user()->id));
        $authRequest->setAuthorizationApproved(true);

        $psr7Response = $server->completeAuthorizationRequest(
            $authRequest,
            new Psr7Response()
        );

        return response()->json([
            'redirect_to' => $psr7Response->getHeaderLine('Location'),
        ]);
    }

    private function buildPsr7AuthorizeRequest(array $v): ServerRequestInterface
    {
        $query = http_build_query($v + ['response_type' => 'code']);
        $psr7Factory = new \Nyholm\Psr7\Factory\Psr17Factory();
        return $psr7Factory->createServerRequest(
            'GET',
            'https://internal/oauth/authorize?' . $query,
        );
    }
}
```

### MCP controller

```php
// app/Http/Controllers/McpController.php
class McpController extends Controller
{
    public function __construct(private readonly McpService $service) {}

    public function handle(Request $req): JsonResponse
    {
        $rpc = $req->json()->all();
        $id  = $rpc['id']     ?? null;
        $method = $rpc['method'] ?? '';
        $params = $rpc['params'] ?? [];
        $user = $req->user();

        try {
            $result = match ($method) {
                'initialize'   => $this->service->initialize($params),
                'tools/list'   => ['tools' => $this->service->listTools()],
                'tools/call'   => $this->service->callTool($params, $user),
                default        => throw new \RuntimeException("unknown method: $method"),
            };
            return response()->json([
                'jsonrpc' => '2.0',
                'id'      => $id,
                'result'  => $result,
            ]);
        } catch (\Throwable $e) {
            return response()->json([
                'jsonrpc' => '2.0',
                'id'      => $id,
                'error'   => [
                    'code'    => -32603,
                    'message' => $e->getMessage(),
                ],
            ]);
        }
    }
}
```

`McpService` owns the five tool handlers (`query_database`,
`list_schema`, `list_connections`, `connection_status`, `disconnect`)
and the engine layer (MariaDB and MSSQL), mirroring the structure of
`src/mcp/tools.ts` and `src/mariadb/*` / `src/mssql/*` in the Node
port.

---

## SPA implementation

### Route

```typescript
// SPA router
{
  path: '/oauth/authorize',
  name: 'oauth-authorize',
  component: OAuthAuthorize,
}
```

### Component

```typescript
// OAuthAuthorize.vue / .tsx
async function handleAuthorize(query: URLSearchParams) {
  // Reuses the existing Azure SSO guard. If Alice isn't logged in, this
  // kicks her through Microsoft and returns her to the same URL.
  await ensureAuthenticated({
    returnTo: `/oauth/authorize?${query.toString()}`,
  });

  const { data } = await api.post('/api/oauth/authorize-approve', {
    client_id:             query.get('client_id'),
    redirect_uri:          query.get('redirect_uri'),
    state:                 query.get('state'),
    code_challenge:        query.get('code_challenge'),
    code_challenge_method: query.get('code_challenge_method'),
    scope:                 query.get('scope'),
  });

  window.location.href = data.redirect_to;
}
```

This is the whole SPA change. ~30 lines. No new dependencies.

---

## Cowork admin configuration

In Cowork admin → Integrations → Add Custom MCP Server:

| Field | Value |
|---|---|
| Name | VRP Database (or whatever your team recognizes) |
| MCP Endpoint | `https://api.example.com/api/mcp` |
| Authorize URL | `https://spa.example.com/oauth/authorize` |
| Token URL | `https://api.example.com/api/oauth/token` |
| Client ID | (from `php artisan passport:client`) |
| Client Secret | (from `php artisan passport:client`) |
| Scope | `mcp` |
| PKCE | S256 (enabled) |

Save. The integration is now available to every member in the
workspace.

---

## What carries over from the Node port (v0.3.x)

When porting to PHP, these artifacts from the Node codebase transfer
directly and should not be rewritten from scratch:

- **SQL safety rules.** `src/mariadb/safety.ts` and `src/mssql/safety.ts`
  are pure string logic — allowed lead keywords, deny patterns,
  string-stripping, CTE-leads-to-SELECT validation, EXEC allowlist
  for MSSQL, SELECT INTO guard. Port to PHP, keep the logic identical.
- **Test cases for safety.** `tests/mariadb/safety.test.ts` (26 cases)
  and `tests/mssql/safety.test.ts` (41 cases) translate 1:1 to PHPUnit.
  Port the tests first; they drive the PHP implementation.
- **Tool metadata.** `src/mcp/tools.ts` defines name, description, and
  input schema for each tool. Copy byte-for-byte to the PHP handlers
  so Claude's tool-approval cache recognizes them as the same tools.
- **Options → driver config translation.** MSSQL `encrypt` /
  `trust_server_certificate` flags from the OAuth connection options
  map to PDO attributes (`PDO::SQLSRV_ATTR_ENCRYPT`,
  `TrustServerCertificate` DSN param) exactly as they map to tedious
  config in the Node port.
- **Connection rotation semantics, refresh-buffer logic, minted-
  within-N-seconds reauth guard.** Same business rules, PHP
  implementation.

Things that do **not** carry over and can be discarded:

- The Node/ESM runtime, pnpm dependency tree, esbuild bundling.
- The `.mcpb` packaging pipeline.
- The custom `/api/mcp/oauth/token` / `/refresh` / `/revoke` endpoints
  that return DB creds in the token response. Replaced entirely by
  standard Passport.
- PKCE loopback listener and browser launcher. The authorize flow
  runs on the SPA via the user's actual browser; no loopback needed.
- Per-user Node process in Claude Desktop.

---

## Rollout plan

| # | Step | Est. |
|---|---|---|
| 1 | **Verify Cowork admin supports custom remote MCP with separate authorize/token URLs.** (Usually yes, but confirm before committing to the rewrite.) | 15 min |
| 2 | Port safety rules (MariaDB + MSSQL) + tests to PHP under `app/Services/Mcp/Safety/`. | 1 day |
| 3 | Port engine layer (PDO-based) with connection + options translation. | 1 day |
| 4 | Implement `McpService` + `McpController` + tool handlers. | 1 day |
| 5 | Install Passport, define scope, register Cowork client, add `OAuthController::approve` + routes. | half day |
| 6 | Add SPA `/oauth/authorize` route + component. | half day |
| 7 | Deploy to staging. Register a staging Cowork workspace against it. End-to-end test with all five tools across both engines. | half day |
| 8 | Promote to prod. Add Cowork admin registration against prod. Tell the team. | 15 min |

**~3 working days** of net implementation.

---

## Open questions to resolve before starting

1. **Does Cowork admin's Custom MCP Server form accept separate
   authorize and token URL fields?** (Standard OAuth 2.0 allows this;
   worth verifying in the admin UI.) If it only takes one base URL,
   the authorize endpoint on Laravel's API becomes a single 302
   redirect to the SPA — no HTML, just an HTTP redirect response,
   which is acceptable even under a strict "API-only" policy.

2. **Does Cowork surface MCP tool approval prompts to individual
   members, or does admin-level registration imply consent?** The
   implementation assumes the Passport client is first-party and
   auto-approves. If Cowork additionally prompts each user on first
   use, the experience includes one "Authorize Claude Cowork?" click
   per member — still fine, just an extra step.

3. **Does our Azure AD tenant policy require per-application admin
   consent?** If yes, the Cowork integration itself may need tenant-
   admin approval at the Azure level (separate from the Cowork admin
   registration). This only affects the login step, not the Laravel-
   issued MCP tokens.

4. **Revocation flow from Cowork.** If we want admin revocation in
   Cowork to immediately invalidate Laravel tokens, add a webhook
   from Cowork to Laravel's `/api/oauth/tokens/{id}` or a custom
   revocation endpoint. Default OAuth behavior (tokens remain valid
   until expiration) is acceptable in most scenarios; this is a
   hardening option.

5. **DB audit log attribution.** Today Laravel runs queries on behalf
   of SPA users with similar attribution; the MCP flow matches. If
   audit logs need to distinguish SPA-originated vs MCP-originated
   queries, add a lightweight tag to the PDO session context when
   handling `/api/mcp` requests.

---

## Migration from v0.3.x Node port

Once the Laravel remote MCP endpoint is in production:

1. Register the remote integration in Cowork admin. Members see both
   the local `db-oauth-mcp` (stdio) and the new remote one in their
   tool list.
2. Ask a small group to use the remote version exclusively for a
   period. Confirm parity of responses and error messages.
3. Deprecate the stdio version: announce end-of-support, remove from
   Cowork admin, archive the `db-oauth-mcp-node` repo. Teammates who
   still have the `.mcpb` installed can uninstall via Claude Desktop →
   Settings → Extensions.
4. Retire the custom OAuth endpoints on Laravel
   (`/api/mcp/oauth/token`, `/refresh`, `/revoke`) after confirming
   nothing uses them.

The Node repo stays available as a reference implementation of the
engine + safety logic, which is the highest-value artifact across
the transition.
