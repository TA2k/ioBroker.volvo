# ioBroker Volvo Adapter - AI Agent Knowledge Base

**Internal documentation for AI agents working on this project. Not user-facing.**

## Project Overview

- **Purpose**: ioBroker adapter for Volvo Cars API (connected-vehicle v2 + energy v2)
- **Admin UI**: Old-style Materialize CSS with jQuery (`admin/index_m.html`)
- **Localization**: Via `admin/words.js` with `systemDictionary`, ioBroker's `translate.js` auto-translates elements with `class="translate"`
- **Primary Language**: JavaScript (Node.js)

## Discovering Runtime Information

**Never hardcode IPs, credentials, or VINs.** Discover them at runtime:

- **ioBroker address**: Ask the user or check their environment
- **SSH credentials**: Ask the user
- **Admin credentials**: Ask the user
- **VIN**: Read from adapter states: `iobroker state getPlainValue volvo.0.info.connection` or list objects `iobroker object list volvo.0.*`
- **API key**: Stored in adapter config (encrypted), read via adapter settings UI
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

## API Endpoints

### Vehicle List & Status
- **List Vehicles**: `GET https://api.volvocars.com/connected-vehicle/v2/vehicles`
- **Status Endpoints** (response wrapped in `{data: {...}}`):
  - `doors`, `windows`, `engine-status`, `fuel`, `odometer`, `statistics`, `tyres`, `warnings`, `brakes`, `diagnostics`, `engine`, `command-accessibility`, `commands`
  - URL pattern: `/connected-vehicle/v2/vehicles/{vin}/{endpoint}`

### Location
- `GET https://api.volvocars.com/location/v1/vehicles/{vin}/location` (Note: v1 still works!)

### Energy
- `GET https://api.volvocars.com/energy/v2/vehicles/{vin}/state`
- **CRITICAL**: Response is at ROOT level (NOT wrapped in `{data: {...}}`)

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
2. `npm pack` → Creates `iobroker.volvo-X.Y.Z.tgz`

### Deploy to ioBroker
1. `scp` the tgz to the ioBroker server: `scp iobroker.volvo-X.Y.Z.tgz root@SERVER:/tmp/`
2. On ioBroker: `iobroker url /tmp/iobroker.volvo-X.Y.Z.tgz`
3. Upload admin files: `iobroker upload volvo`
4. Restart: `iobroker restart volvo.0`

### npm Cache Gotcha
- npm caches tgz by URL/filename. If the version doesn't change, the old cached version is installed.
- **Always bump version** before re-deploying.
- Using local file path (`/tmp/...`) with `scp` avoids HTTP server issues.

### Useful ioBroker Commands
```bash
iobroker state set volvo.0.xxx.xxx value    # Set state
iobroker state get volvo.0.xxx.xxx          # Get state
iobroker object del volvo.0.xxx.xxx         # Delete object
iobroker list states volvo.0.*              # List states
iobroker upload volvo                       # Upload admin files
iobroker restart volvo.0                    # Restart adapter
```

## Architecture

### Main Components

| File | Purpose |
|---|---|
| `main.js` | Core adapter: auth, API calls, state management, remote commands |
| `admin/index_m.html` | Settings UI with OTP login flow (Materialize + jQuery) |
| `admin/words.js` | Localization dictionary (`systemDictionary`) |
| `io-package.json` | Adapter metadata, `messagebox: true` for sendTo/onMessage |
| `lib/extractKeys.js` | Helper for parsing API responses into ioBroker states |

### Key Libraries
- **json2iob**: Parses API responses into ioBroker state trees
- **axios**: HTTP client for all API requests
- **qs**: URL-encoded form data for auth requests

### Data Flow
1. Adapter starts → reads stored refresh token → exchanges for access token
2. Fetches vehicle list → iterates VINs
3. For each VIN: fetches all status endpoints + location + energy
4. json2iob parses responses into state objects under `volvo.0.{VIN}.*`
5. Interval timer repeats data fetch; separate timer refreshes auth token

## Common Gotchas

### API Response Format Differences
- **Energy v2**: Root-level response — use `res.data` directly
- **Connected-vehicle v2**: Wrapped — data is at `res.data.data`

### ioBroker Object Management
- `setObjectNotExistsAsync` won't update existing objects (role, type changes ignored)
- Use `extendObjectAsync` to modify existing state properties
- Or `iobroker object del` before recreating

### Admin UI Caching
- ioBroker admin caches aggressively
- Version bump + `iobroker upload volvo` required after admin file changes
- Browser hard-refresh may also be needed

### Commit Convention
- Always include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer
- Use conventional commits: `fix:`, `feat:`, `chore:`, `docs:`
