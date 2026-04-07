# ioBroker Volvo Adapter - AI Agent Knowledge Base

**Internal documentation for AI agents working on this project. Not user-facing.**

## Project Overview

- **Purpose**: ioBroker adapter for Volvo Cars API (connected-vehicle v2 + energy v2)
- **Admin UI**: Admin5 / jsonConfig (`admin/jsonConfig.json`) — no Materialize, no jQuery, no `index_m.html`
- **Localization**: Via `admin/i18n/{lang}/translations.json` (11 languages: de, en, es, fr, it, nl, pl, pt, ru, uk, zh-cn)
- **Primary Language**: JavaScript (Node.js)
- **Current Version**: 2.0.0

## Discovering Runtime Information

**Never hardcode IPs, credentials, or VINs.** Discover them at runtime:

- **ioBroker address**: Ask the user or check their environment
- **SSH credentials**: Ask the user
- **Admin credentials**: Ask the user
- **VIN**: Read from adapter states: `iobroker state getPlainValue volvo.0.info.connection` or list objects `iobroker object list volvo.0.*`
- **API key**: Stored in adapter config (encrypted via `encryptedNative`), read via adapter settings UI
- **Local dev IP**: Use `hostname -I` or similar

## Authentication Flow

PingFederate multi-step OTP authentication for Volvo ID:

1. **POST /as/authorization.oauth2** with `client_id`, `response_type=code`, `response_mode=pi.flow` → Returns `flowId`
2. **POST /pf-ws/authn/flows/{flowId}?action=checkUsernamePassword** → `OTP_REQUIRED`
3. **POST /pf-ws/authn/flows/{flowId}?action=checkOtp** → `OTP_VERIFIED`
4. **POST /pf-ws/authn/flows/{flowId}?action=continueAuthentication** → authorization `code`
5. **POST /as/token.oauth2** with `grant_type=authorization_code` → tokens

### Critical Auth Details

- **PingFederate cookies MANDATORY** between all auth steps — store and replay Set-Cookie headers
- **http→https URL conversion**: Auth responses may contain `http://` URLs; must convert to `https://`
- **X-XSRF-Header: PingFederate** required on ALL auth requests
- **Client credentials**: Defined as constants in `main.js` (`AUTH_BASIC`, `AUTH_SCOPES`)
- **Token Refresh**: Volvo doesn't always return a new `refresh_token` — **MUST preserve the old token** if new one is missing in the response
- **Token Storage**: Persisted in `volvo.0.auth.refreshToken` ioBroker state
- **Encrypted config**: `password` and `vccapikey` are in `encryptedNative` / `protectedNative` — ioBroker decrypts them automatically before passing to `this.config`

### Restart-Resilient Auth Flow

The auth flow persists state across adapter restarts so OTP submission survives:

- **Persisted states**: `auth.flowId`, `auth.flowCookies`, `auth.flowTimestamp`
- Flow expires after ~8 min (Volvo server-side is ~10 min)
- **Login paths** (in `newLogin()`):
  1. Stored `refresh_token` → immediate login
  2. OTP in config → try resume persisted flow OR do fresh full login
  3. No token, no OTP → trigger OTP email automatically, wait for user
- **OTP clearing**: After successful login, `_clearOtpFromConfig()` removes OTP from `native.otp` via `extendForeignObjectAsync` — this triggers a js-controller restart (expected). 3s delay added to let pending DB writes finish.
- **`isStopping` flag**: Set in `onUnload()`, checked in `lib/extractKeys.js` error handlers to suppress "DB closed" errors during shutdown

### Why the Adapter Sometimes Auto-Terminates

- js-controller sets `system.adapter.volvo.X.sigKill = -1` when it wants to stop the instance
- This triggers `TERMINATE_YOURSELF` in the adapter's state change handler
- Any **instance object change** (e.g. config save) triggers `stopInstance()` → `startInstance()`
- This is **expected behavior** — config changes always restart the adapter

## API Endpoints

### Vehicle List & Status
- **List Vehicles**: `GET https://api.volvocars.com/connected-vehicle/v2/vehicles`
- **Status Endpoints** (response wrapped in `{data: {...}}`):
  - `doors`, `windows`, `engine-status`, `fuel`, `odometer`, `statistics`, `tyres`, `warnings`, `brakes`, `diagnostics`, `engine`, `command-accessibility`, `commands`
  - URL pattern: `/connected-vehicle/v2/vehicles/{vin}/{endpoint}`

### Location
- `GET https://api.volvocars.com/location/v1/vehicles/{vin}/location` (Note: v1 still works!)
- Returns 404 if GPS is disabled — handled gracefully (warn, not error)

### Energy
- `GET https://api.volvocars.com/energy/v2/vehicles/{vin}/state`
- **CRITICAL**: Response is at ROOT level (NOT wrapped in `{data: {...}}`)
- Returns 404 for non-EV vehicles — handled gracefully

### Remote Commands
- `POST /connected-vehicle/v2/vehicles/{vin}/commands/{command}`
- **Content-Type**: Must be `application/json` (NOT vendor-specific headers)
- "Refresh" is NOT an API command — must call `updateDevice()` directly in code

### Dead/Deprecated Endpoints
- `extended-vehicle/v1` → 410 GONE
- `energy/v1` → 410 GONE
- `vocapi.wirelesscar.net` → Completely dead

## Deployment Process

### Build
1. Bump version in BOTH `package.json` AND `io-package.json`
2. Add news entry in `io-package.json` `common.news` (all 11 languages)
3. Update `## Changelog` in `README.md`
4. `npm install` to update `package-lock.json`
5. `npm pack` → Creates `iobroker.volvo-X.Y.Z.tgz`

### Deploy to ioBroker
1. `scp` the tgz to the ioBroker server: `scp iobroker.volvo-X.Y.Z.tgz root@SERVER:/tmp/`
2. On ioBroker: `iobroker url /tmp/iobroker.volvo-X.Y.Z.tgz --allow-root`
3. Upload admin files: `iobroker upload volvo --allow-root`
4. Restart: `iobroker restart volvo.X --allow-root`

### npm Cache Gotcha
- npm caches tgz by URL/filename. If the version doesn't change, the old cached version is installed.
- **Always bump version** before re-deploying.
- Using local file path (`/tmp/...`) with `scp` avoids HTTP server issues.

### Useful ioBroker Commands
```bash
iobroker state set volvo.0.xxx.xxx value --allow-root    # Set state
iobroker state get volvo.0.xxx.xxx --allow-root          # Get state
iobroker object del volvo.0.xxx.xxx --allow-root         # Delete object
iobroker list states volvo.0.* --allow-root              # List states
iobroker upload volvo --allow-root                       # Upload admin files
iobroker restart volvo.0 --allow-root                    # Restart adapter
iobroker object set system.adapter.volvo.0 native.key="value" --allow-root  # Set config property
```

Note: `--allow-root` is required on systems running ioBroker as root.

## Architecture

### Main Components

| File | Purpose |
|---|---|
| `main.js` | Core adapter: auth, API calls, state management, remote commands |
| `admin/jsonConfig.json` | Admin5 settings UI (jsonConfig schema) |
| `admin/i18n/{lang}/translations.json` | Localization for all 11 languages |
| `io-package.json` | Adapter metadata, `messagebox: true`, `encryptedNative`, `protectedNative` |
| `lib/extractKeys.js` | Helper for parsing API responses into ioBroker states |

### Key Methods in main.js

| Method | Purpose |
|---|---|
| `onReady()` | Startup: login, data fetch, intervals, OTP clear |
| `newLogin()` | Three-path login dispatcher |
| `_initAuthAndSendCredentials()` | Step 1+2 of PingFederate flow |
| `_persistAuthFlowState()` | Save flowId/cookies to ioBroker states |
| `_tryResumeAuthFlow()` | Resume persisted flow with OTP |
| `_fullOtpLogin(otp)` | Fresh full flow with OTP |
| `_exchangeCodeForTokens(code)` | Exchange auth code for access/refresh tokens |
| `_clearAuthFlowState()` | Remove persisted flow states |
| `_clearOtpFromConfig()` | Remove OTP from native config (triggers restart) |
| `_persistTokens()` | Save tokens to ioBroker states |
| `onMessage(obj)` | Handle sendTo: startLogin, submitOtp, testConnection |
| `getDeviceList()` | Fetch vehicle list + all status endpoints |
| `updateDevice()` | Refresh all vehicle data |
| `refreshToken()` | Exchange refresh token for new access token |

### Key Libraries
- **json2iob**: Parses API responses into ioBroker state trees
- **axios**: HTTP client for all API requests
- **qs**: URL-encoded form data for auth requests

### Data Flow
1. Adapter starts → reads stored refresh token → exchanges for access token
2. If no token: checks for OTP in config → triggers OTP email if none
3. Fetches vehicle list → iterates VINs
4. For each VIN: fetches all status endpoints + location + energy
5. json2iob parses responses into state objects under `volvo.0.{VIN}.*`
6. Interval timer repeats data fetch; separate timer refreshes auth token

## Common Gotchas

### API Response Format Differences
- **Energy v2**: Root-level response — use `res.data` directly
- **Connected-vehicle v2**: Wrapped — data is at `res.data.data`

### 404 Handling
- Location endpoint returns 404 if GPS is disabled — log as `debug`, not `error`
- Energy endpoint returns 404 for non-EV vehicles — log as `debug`, not `error`
- Always check `err.response?.status === 404` before logging as error

### VCC API Key Check
- Always check `this.config.vccapikey` before calling `getDeviceList()` or `updateDevice()`
- On fresh instances, the API key may not be configured yet
- Log a `warn` and skip data fetch if key is missing

### ioBroker Object Management
- `setObjectNotExistsAsync` won't update existing objects (role, type changes ignored)
- Use `extendObjectAsync` to modify existing state properties
- Or `iobroker object del` before recreating

### Admin UI (jsonConfig)
- Fields use `sm`, `md`, `lg`, `xl` size attributes — all must be specified or linter warns
- `doNotSave: true` prevents a field value from being saved to native config
- `sendTo` type fields trigger `onMessage` in the adapter with the specified `command`
- Localization keys must exist in ALL 11 language files under `admin/i18n/`

### Admin UI Caching
- ioBroker admin caches aggressively
- Version bump + `iobroker upload volvo --allow-root` required after admin file changes
- Browser hard-refresh may also be needed

### Commit Convention
- Always include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer
- Use conventional commits: `fix:`, `feat:`, `chore:`, `docs:`
- Git author: `Vinnedinho`
- Do NOT auto-commit/push — prepare changes, let user review
