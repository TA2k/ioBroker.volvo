# Older changes

### 2.0.1
- Update dependencies

### 2.0.0
- BREAKING CHANGE: API key now stored encrypted, reenter of API key **required**

### 1.0.5
- Fix: restart-resilient OTP login flow — auth state persists across adapter restarts

### 1.0.4
- Fix: 404 errors for location/energy/vehicle endpoints handled gracefully (GPS off, non-EV vehicles)

### 1.0.3
- Fix: adapter no longer terminates on first start without stored token
- Fix: removed manual password decrypt (now handled by `encryptedNative`)
- Fix: full try-catch in `onReady()` prevents crashes on startup errors

### 1.0.2
- Fix: adapter stays alive waiting for OTP login when no token stored
- Fix: better startup log messages explaining next steps
- Fix: CI deploy job upgraded to Node 24 (resolves `promise-retry` error)

### 1.0.1
- Fix: multi-language support (ru, pt, nl, fr, it, es, pl, uk, zh-cn)
- Fix: jsonConfig admin UI size attributes for all breakpoints
- Fix: `protectedNative` / `encryptedNative` for sensitive fields
- Fix: OTP/sendTo message handlers null-safe
- Chore: added dependabot, `@iobroker/adapter-dev`, `@iobroker/eslint-config`
- Chore: CI `adapter-tests` now runs after linting
- Chore: migrated `.npmignore` to `package.json` `files`

### 1.0.0 🎉

First stable release — complete rewrite of the Volvo ioBroker adapter.

**New Features:**
- **Vehicle Details**: Model, year, color and images fetched from API
- **Retry Logic**: Automatic retry with exponential backoff on API errors (429/5xx)
- **Command Status Tracking**: Polls async command results (up to 5x) and stores status in `lastCommandStatus`
- **Auto-Refresh after Commands**: Doors auto-refresh after lock/unlock, engine-status after climatization
- **Last Update Timestamp**: `lastUpdate` state per vehicle shows last successful data fetch
- **Admin UI: jsonConfig Migration**: Modern React-based settings UI (Admin5) with i18n support
- **Admin UI: Connection Test**: Test API connection directly from adapter settings
- **Admin UI: Vehicle Info**: Display vehicle details from settings page

**Versioning Policy (SemVer):**
- MAJOR: Breaking changes (config changes, removed states, new minimum Node.js)
- MINOR: New features (new data points, commands, UI features)
- PATCH: Bug fixes, dependency updates, cleanup

### 0.2.7

- Extracted inline JavaScript from `admin/index_m.html` into separate `admin/index_m.js`
- Added ESLint config for admin browser JS (jQuery/browser globals)

### 0.2.6

- Removed obsolete files: `.create-adapter.json` (wrong adapter name), `lib/tools.js` (unused), `.prettierrc.js`/`.prettierignore` (Prettier not installed)
- Updated `.npmignore` (removed references to deleted `.eslintrc.json`)
- Updated CI workflow: dropped Node 18 (EOL), testing on Node 20 + 22

### 0.2.5

- Updated all dependencies to latest major versions
- @alcalzone/release-script 3.7 → 5.1, eslint 9 → 10, @iobroker/testing 5.0 → 5.2

### 0.2.4

- Migrated from ESLint 8 to ESLint 9 (flat config) — fixes CVE-2025-50537
- Removed deprecated `.eslintrc.json` and `.eslintignore`

### 0.2.3

- Fixed all npm audit vulnerabilities (0 remaining)
- Added npm overrides for serialize-javascript, diff, esbuild

### 0.2.2

- Fixed ESLint lint error (single quotes)
- Removed credentials and IPs from AGENTS.md, added discovery instructions
- Updated devDependencies: @iobroker/testing 5.2, @types/node 25.5, eslint 8.57

### 0.2.1

- Fixed refresh token not being preserved across token refreshes (caused 401 errors after ~25 minutes)
- Removed dead legacy code: old VOC API (`vocapi.wirelesscar.net`), `request` module, `uuid`, `json-bigint`
- Updated dependencies: axios 1.14, qs 6.15, json2iob 2.6.22, @iobroker/adapter-core 3.3
- Added update migration notice for users upgrading from pre-0.2.0 versions
- Removed unused `newApi` config option from io-package.json

### 0.2.0

- **Complete rewrite of authentication**: Replaced dead `grant_type: password` OAuth flow with new multi-step OTP (one-time password) login via PingFederate
- **All API endpoints updated to v2**: Vehicle list (`connected-vehicle/v2`), Energy (`energy/v2`), Commands (`connected-vehicle/v2/commands`)
- **Fixed remote commands**: Changed `Content-Type` from deprecated vendor-specific format to `application/json` (was causing HTTP 415 errors)
- **Fixed refresh button**: Now triggers a data re-fetch instead of sending an invalid API command (was causing HTTP 404)
- **Buttons are now proper buttons**: Remote controls use `role: button` with auto-reset instead of toggle booleans
- **Fixed Energy API parsing**: `batteryChargeLevel`, `electricRange`, `chargingStatus` etc. now update correctly (v2 response format differs from v1)
- **Added OTP login UI** in adapter settings with step-by-step flow
- **Added token persistence**: Refresh token stored in ioBroker state, survives adapter restarts
- **Removed dead code**: Old VOC API (`vocapi.wirelesscar.net`), `extended-vehicle/v1`, `energy/v1`, `newApi` checkbox — all removed
- **Admin UI localized**: English + German via `words.js`
- **Updated README** with new setup guide

### 0.1.2 (2024-05-02)

- Added support for v2 API


[Older changelogs can be found there](CHANGELOG_OLD.md)

### 0.1.1

- Added location API information

### 0.1.0

- (TA2k) Add new API for electric cars

### 0.0.6

- (TA2k) Fix trip object naming

### 0.0.5

- (TA2k) Fix receiving data

### 0.0.4

- (TA2k) Fix jscontroller

### 0.0.3

- (TA2k) Fix preclimate

### 0.0.2

- (TA2k) Initial release