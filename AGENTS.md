# ioBroker Volvo Adapter - AI Agent Knowledge Base

**Internal documentation for AI agents working on this project. Not user-facing.**

## Project Overview

- **Purpose**: ioBroker adapter for Volvo Cars API (connected-vehicle v2 + energy v2)
- **Admin UI**: Admin5 / jsonConfig (`admin/jsonConfig.json`) — no Materialize, no jQuery, no `index_m.html`
- **Localization**: Via `admin/i18n/{lang}/translations.json` (11 languages: de, en, es, fr, it, nl, pl, pt, ru, uk, zh-cn)
- **Primary Language**: JavaScript (Node.js)
- **Current Version**: 4.0.0

## Discovering Runtime Information

**Never hardcode IPs, credentials, or VINs.** Discover them at runtime:

- **ioBroker address**: Ask the user or check their environment
- **SSH credentials**: Ask the user
- **Admin credentials**: Ask the user
- **VIN**: Read from adapter states: `iobroker state getValue volvo.0.info.connection` or list objects `iobroker object list volvo.0.*`
- **API key**: Stored in adapter config (encrypted via `encryptedNative`), read via adapter settings UI
- **Local dev IP**: Use `hostname -I` or similar

## Authentication Flow

Since 4.0.0 the adapter logs in directly at Volvo ID's Keycloak (`AUTH_ISSUER = https://auth.volvocars.com/realms/volvocars`) with the Keycloak client of the Volvo Cars app 7.5 (`vid-cm4ztba91ce0fc2fa4bz`, found in the APK, class with `clientIdPing`/`clientIdKeycloak`): Authorization Code + PKCE (S256), redirect `vca://www.volvocars.com/l/vca/oauth/callback`, refresh token bound to a DPoP key (ES256), no client secret.

History: `h4Yf0b` (PingFederate `pi.flow`) was disabled on 2026-10-26 (issue #155); 3.1.0 used the app's PingFederate client `mo2qy9h_10` on `volvoid.eu.volvocars.com`. Volvo announced (developer portal news "Volvo ID service migration", 2026-10-26) that the old system stops working after **2027-01-31**. `mo2qy9h_10` is unknown to Keycloak ("Client not found"), and Keycloak has token exchange disabled for the new client ("Standard token exchange is not enabled") → PingFederate logins cannot be migrated, every user has to log in once again.

The login pages are Keycloakify pages with an embedded `kcContext`. The adapter submits the HTML forms itself (`_authFetch()` follows redirects and keeps cookies per host):

1. **GET `…/protocol/openid-connect/auth`** (`client_id`, `redirect_uri`, `scope`, `code_challenge`, `acr_values=urn:volvoid:aal:bronze:2sv`) → page `pageId: "login"`
2. **POST `kcContext.url.loginAction`** with `username`, `password`, `credentialId=`, **`rememberMe=on`** → page `pageId: "login-otp-email"`, Volvo sends the OTP email
3. **POST `loginAction` of the OTP page** with `otp` → `302 Location: vca://…/callback?code=…` (wrong OTP: OTP page again with a new `loginAction`)
4. **POST `…/protocol/openid-connect/token`** with `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier` and a `DPoP` proof header → tokens (`token_type: Bearer`, refresh token is a JWT with `cnf.jkt`)

Helpers for PKCE, DPoP proofs, JWT claims and parsing `kcContext` live in `lib/volvoAuth.js` (unit tests in `test/testVolvoAuth.js`).

### Critical Auth Details

- **API calls** to `api.volvocars.com` use `Authorization: Bearer <access_token>` + `vcc-api-key`, **without** a DPoP proof (scheme `DPoP` returns 401)
- **Refresh** (`grant_type=refresh_token`, `client_id`) **requires a DPoP proof** signed with the same key (`invalid_dpop_proof` otherwise) → the private key is persisted as JWK in `auth.dpopKey`
- **Old logins are discarded on start**: a stored refresh token that is not a JWT issued by `AUTH_ISSUER` (PingFederate tokens are opaque) or has no `auth.dpopKey` → one `warn` asking for a new OTP login, token + key cleared
- **DPoP proofs are single-use** (`jti`): `apiRequest()` accepts a config factory so each retry builds a fresh proof
- **Scopes**: `AUTH_SCOPES` in `main.js` (`conve:*`/`energy:*`/`location:read`); `offline_access` is rejected (`invalid_scope`)
- **Token Refresh**: Keycloak **rotates** the refresh token on every refresh → `_persistTokens()` stores the new one each time. The old token keeps working (no revoke-on-reuse), the fallback to the old token only applies if none is returned
- **Token Storage**: `auth.refreshToken` + `auth.dpopKey` ioBroker states
- **Token Lifetimes** (measured 2026-11-06):
  - Access token: 30 min (`expires_in: 1800`) — refreshed every 1500s
  - Refresh token: **sliding 90 days** (`refresh_expires_in: 7776000`, `exp` moves forward on every refresh) — **only with `rememberMe=on`** in the login form, otherwise 30 minutes. `_exchangeCodeForTokens()` warns if `refresh_expires_in` is below one day (`MIN_EXPECTED_SESSION_SECONDS`). A possible absolute session maximum is not known yet
- **Login Timestamp**: `auth.loginTimestamp` (ms) set on every OTP login, only used for the age in the session-expired error
- **Session Expired**: `invalid_grant` on refresh → `_handleSessionExpired()`: one error log, polling + refresh intervals stopped, refresh token and login timestamp cleared, keep-alive until the next OTP login (`submitOtp` restarts the intervals because they are `null`)
- **401 on data endpoints**: `updateDevice()` aborts the cycle on the first 401, logs one warning and triggers `refreshToken()` immediately
- **Vehicle removed from the Volvo ID** (car replaced, seen 2026-11-03): every endpoint of the old VIN returns `403` (`No relationship to UUID` / `RELATION_NOT_FOUND`). `updateDevice()` stops that VIN after the first such 403 and calls `_handleUnlinkedVehicles()`: one `warn`, `getDeviceList()` reload, old VIN dropped from `vinArray`, new VINs fetched right away. `getDeviceList()` rebuilds `vinArray` (no duplicates on reload)
- **Encrypted config**: `password` and `vccapikey` are in `encryptedNative` / `protectedNative` — ioBroker decrypts them automatically before passing to `this.config`

### OTP Login (admin UI only)

- The OTP login is **only** started by the admin button "Start Login (Send OTP)" (`sendTo startLogin`) and finished with "Submit OTP" (`sendTo submitOtp`). The adapter never sends an OTP email on its own (user request)
- The OTP field is `doNotSave` — saving the settings with an OTP and restarting is no longer a login path (it failed with Keycloak `login-error` in a test and was removed)
- **Persisted flow states** (survive a restart between the two buttons): `auth.flowId` (OTP form action URL), `auth.flowVerifier` (PKCE), `auth.flowCookies` (JSON, per host)
- **Login paths** (in `newLogin()`): stored Keycloak `refresh_token` + `dpopKey` → immediate login; otherwise log a hint and wait for the buttons
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

### Energy Device API (Volvo wallboxes)
- Base `https://api.volvocars.com/energy-device/v1` (docs: developer portal "Energy Device API v1", OpenAPI only as data URL on the specification page, readable via Playwright)
- Scopes `energy_device:wallbox:read` (info, sessions), `:control` (start/pause), `:write` (schedule, amp limits) — accepted by the Keycloak app client (authorize check 2026-11-06), part of `AUTH_SCOPES`; tokens from logins before that don't have them (403 → hint to log in again)
- **No list endpoint**: wallboxes are addressed by the EVSE ID from the owner's document → setting `wallboxIds` (comma separated). Empty → no wallbox requests at all
- The Volvo app lists wallboxes via an internal GraphQL gateway (`energy-management-gateway.weu-prod.ecpaz.volvocars.biz/…/graphql`, `sites { wallboxes { evseId } }`) — not public, deliberately not used
- Implemented: `GET /wallbox/{id}` → `wallbox.<objId>.info`, `GET /wallbox/{id}/chargingsessions?start&end` (last 7 days) → count/totalEnergy/json/last, `POST /wallbox/{id}/start|pause`, `POST /wallbox/{id}/setChargingAmpLimit|setDischargingAmpLimit?limit=`. Not implemented: ID tokens (RFID), `readIdToken`, `chargingSchedule`
- Errors: 409/422 carry `{message, code}` (`WALLBOX_OFFLINE`, `WALLBOX_INCORRECT_STATUS`, `WALLBOX_IN_COOLDOWN`, `NOT_SUPPORTED_BY_WALLBOX`); polling problems are logged once per EVSE ID + status (`_wallboxProblem()`), then debug
- **Untested** — built from the documentation, no device available. Pure helpers in `lib/wallbox.js` (unit tests `test/testWallbox.js`)

### Remote Commands
- `POST /connected-vehicle/v2/vehicles/{vin}/commands/{command}`
- **Content-Type**: Must be `application/json` (NOT vendor-specific headers) **with a JSON body**: `{}` for all commands (spec: "Empty request body"), `{"runtimeMinutes": 0-15}` for `engine-start` (adapter sends 15). Without a body Volvo answers `415 UNSUPPORTED_MEDIA_TYPE` (seen 2026-11-10)
- "Refresh" is NOT an API command — must call `updateDevice()` directly in code

### Dead/Deprecated Endpoints
- `extended-vehicle/v1` → 410 GONE
- `energy/v1` → 410 GONE
- `vocapi.wirelesscar.net` → Completely dead

## Deployment Process

### Build
1. Bump version in BOTH `package.json` AND `io-package.json`
2. Add news entry in `io-package.json` `common.news` (all 11 languages) and **keep at most 7 entries**: remove the oldest ones (the repository builder truncates at 7, repository checker warning W1032)
3. Update `## Changelog` in `README.md` and keep the **same 7 versions** there: move older entries to the top of `CHANGELOG_OLD.md` (linked at the end of the README changelog)
4. Breaking changes that need user action (e.g. a new login): add an upgrade dialog to `io-package.json` `common.messages` (condition `oldVersion<X.0.0` + `newVersion>=X.0.0`, `level: warn`, buttons `agree`/`cancel`, all 11 languages, button names exactly as in `admin/i18n`). The admin shows it before the update; outdated messages are removed (since 4.0.0 only the Keycloak re-login message)
5. `npm install` to update `package-lock.json`
6. `npm pack` → Creates `iobroker.volvo-X.Y.Z.tgz`

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
iobroker state get volvo.0.xxx.xxx --allow-root          # Get full state object (JSON)
iobroker state getValue volvo.0.xxx.xxx --allow-root     # Get only the value
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
| `newLogin()` | Login with stored refresh token, otherwise wait for the admin buttons |
| `_authFetch()` | Browser-like auth request: per-host cookies, follows redirects up to the `vca://` callback |
| `_startLoginFlow()` | Steps 1+2: open login page, submit credentials (sends OTP email) |
| `_submitOtp(otp)` | Step 3+4: submit OTP, exchange code |
| `_persistAuthFlowState()` / `_loadAuthFlowState()` | Save/restore OTP form action, PKCE verifier, cookies |
| `_exchangeCodeForTokens(code, verifier)` | Code → DPoP-bound tokens, creates the DPoP key, warns on a short session |
| `_refreshTokenConfig()` | Refresh request with DPoP proof |
| `_clearAuthFlowState()` | Remove persisted flow states |
| `_persistTokens()` | Save refresh token + DPoP key to ioBroker states |
| `onMessage(obj)` | Handle sendTo: startLogin, submitOtp, testConnection |
| `getDeviceList()` | Fetch vehicle list + all status endpoints |
| `updateDevice()` | Refresh all vehicle data |
| `refreshToken()` | Exchange refresh token for new access token |
| `_handleSessionExpired()` | Refresh token dead (`invalid_grant`): stop polling, wait for OTP login |
| `_handleUnauthorized()` | 401 during update: warn once, refresh token immediately |
| `_handleUnlinkedVehicles(vins)` | 403 "no relationship": warn once, reload vehicle list, fetch new VINs |
| `_setupWallboxes()` | Objects for the EVSE IDs from `wallboxIds` |
| `updateWallboxes(objId?)` | Wallbox info + charging sessions (called at the end of `updateDevice()`) |
| `_handleWallboxCommand(id, state)` | start/pause/refresh buttons and amp limits under `wallbox.<objId>.remote` |
| `_getLoginTimestamp()` | Last OTP login from `auth.loginTimestamp` (0 if unknown) |

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

### Node.js Built-ins
- Require built-in modules with the `node:` prefix (`require('node:crypto')`), repository checker suggestion S5043

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
- Use conventional commits: `fix:`, `feat:`, `chore:`, `docs:` — subject and body in English
- Use the local git identity, do not override the author
- Add the co-author/attribution trailer your own tool or session prescribes, if any
- Do NOT auto-commit/push — prepare changes, let user review
