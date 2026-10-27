'use strict';

/*
 * Created with @iobroker/create-adapter v1.20.0
 */

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const qs = require('qs');
const Json2iob = require('json2iob');
const { extractKeys } = require('./lib/extractKeys');
const { createPkce, createDpopKey, createDpopProof, parseLoginPage } = require('./lib/volvoAuth');

const AUTH_URL = 'https://volvoid.eu.volvocars.com/as/authorization.oauth2';
const TOKEN_URL = 'https://volvoid.eu.volvocars.com/as/token.oauth2';
// Public client of the Volvo Cars app: Authorization Code + PKCE, tokens bound to a DPoP key
const CLIENT_ID = 'mo2qy9h_10';
const REDIRECT_URI = 'vca://www.volvocars.com/l/vca/oauth/callback';
// Refresh token does not rotate and dies a fixed time after the OTP login.
// 180 days is observed (not documented by Volvo), see AGENTS.md.
const REFRESH_TOKEN_MAX_AGE_DAYS = 180;
const REFRESH_TOKEN_WARN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLIENT_REJECTED_MESSAGE =
  'Volvo rejected the OAuth client used by this adapter (invalid_client). Volvo has disabled this client ID, ' +
  'so a new login will not help until the adapter is updated. Data updates are paused. ' +
  'See https://github.com/TA2k/ioBroker.volvo/issues/155';
const AUTH_SCOPES = [
  'openid',
  'conve:brake_status',
  'conve:climatization_start_stop',
  'conve:command_accessibility',
  'conve:commands',
  'conve:diagnostics_engine_status',
  'conve:diagnostics_workshop',
  'conve:doors_status',
  'conve:engine_status',
  'conve:fuel_status',
  'conve:honk_flash',
  'conve:lock',
  'conve:lock_status',
  'conve:navigation',
  'conve:odometer_status',
  'conve:trip_statistics',
  'conve:tyre_status',
  'conve:unlock',
  'conve:vehicle_relation',
  'conve:warnings',
  'conve:windows_status',
  'energy:battery_charge_level',
  'energy:charging_connection_status',
  'energy:charging_system_status',
  'energy:electric_range',
  'energy:estimated_charging_time',
  'energy:recharge_status',
  'energy:state:read',
  'location:read',
].join(' ');

class Volvo extends utils.Adapter {
  /**
   * @param {Partial<ioBroker.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'volvo',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.on('message', this.onMessage.bind(this));

    this.json2iob = new Json2iob(this);
    this.session = {};
    this.authFlow = null;
    this.authCookies = {};
    this.dpopKey = null;
    this.requestClient = axios.create();
    this.extractKeys = extractKeys;
    this.updateInterval = null;
    this.timeout = null;
    this.vinArray = [];
    this.isStopping = false;
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    try {
      // Note: password is automatically decrypted by adapter-core (encryptedNative in io-package.json)
      // No manual decrypt needed.
      this.log.debug('Adapter starting up...');
      this.setState('info.connection', false, true);
      this.subscribeStates('*');

      // Always use new Connected Vehicle API (old VOC API is dead)
      await this.newLogin();
      if (this.session.access_token) {
        if (this.config.vccapikey) {
          await this.getDeviceList();
          await this.updateDevice();
        } else {
          this.log.warn('No VCC API key configured. Please enter your API key in the adapter settings.');
        }
        this.updateInterval = this.setInterval(async () => {
          await this.updateDevice();
        }, this.config.interval * 60 * 1000);
        // Refresh token before it expires (5 min before expiry, min 60s)
        const refreshMs = Math.max(60, (this.session.expires_in || 1799) - 300) * 1000;
        this.log.info(`Token refresh scheduled every ${Math.round(refreshMs / 1000)}s`);
        this.refreshTokenInterval = this.setInterval(() => {
          this.refreshToken();
        }, refreshMs);
      } else {
        // No valid session yet — wait for the OTP login via sendTo from the admin UI
        // Keep-alive interval so ioBroker doesn't terminate idle daemon
        this.keepAliveInterval = this.setInterval(() => {
          this.log.debug('Waiting for login...');
        }, 60000);
      }
    } catch (error) {
      this.log.error(`Startup error: ${error.message}`);
      this.log.error(error.stack);
      // Stay alive even after errors — user can fix config and re-login via admin
      this.log.info('Adapter staying alive despite startup error. Please check adapter settings.');
      this.keepAliveInterval = this.setInterval(() => {
        this.log.debug('Waiting for login after error...');
      }, 60000);
    }
  }
  /**
   * Store Set-Cookie headers of an auth response in the per-host cookie jar.
   */
  _storeCookies(host, response) {
    const setCookies = response.headers['set-cookie'];
    if (!setCookies) return;
    const jar = this.authCookies[host] || {};
    for (const raw of setCookies) {
      const pair = raw.split(';')[0];
      const separator = pair.indexOf('=');
      const name = (separator === -1 ? pair : pair.slice(0, separator)).trim();
      if (!name) continue;
      if (separator === -1 || pair.slice(separator + 1) === '') {
        delete jar[name];
      } else {
        jar[name] = pair;
      }
    }
    this.authCookies[host] = jar;
  }

  /**
   * Browser-like auth request: keeps cookies per host and follows redirects
   * until a page is returned or Volvo redirects to the app callback.
   * @returns {Promise<{html?: string, code?: string, error?: string}>}
   */
  async _authFetch(method, url, form) {
    for (let hop = 0; hop < 10; hop++) {
      if (url.startsWith('http://')) {
        url = 'https://' + url.slice(7);
      }
      const host = new URL(url).host;
      const headers = { Cookie: Object.values(this.authCookies[host] || {}).join('; ') };
      if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      const res = await this.requestClient({
        method,
        url,
        headers,
        data: form ? qs.stringify(form) : undefined,
        maxRedirects: 0,
        responseType: 'text',
        validateStatus: () => true,
      });
      this._storeCookies(host, res);
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        if (location.startsWith(REDIRECT_URI)) {
          const params = new URL(location).searchParams;
          return { code: params.get('code') || undefined, error: params.get('error_description') || params.get('error') || undefined };
        }
        url = new URL(location, url).toString();
        method = 'get';
        form = null;
        continue;
      }
      if (res.status >= 400) {
        throw new Error(`Auth request failed: ${res.status} ${url.split('?')[0]}`);
      }
      return { html: String(res.data) };
    }
    throw new Error('Too many redirects during Volvo login');
  }

  /**
   * Refresh token request, signed with the DPoP key the tokens are bound to.
   */
  _refreshTokenConfig(refreshToken) {
    return {
      method: 'post',
      url: TOKEN_URL,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        DPoP: createDpopProof(this.dpopKey, 'POST', TOKEN_URL),
      },
      data: qs.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    };
  }

  /**
   * Load the DPoP key of the stored login, or null if there is none.
   */
  async _loadDpopKey() {
    const keyState = await this.getStateAsync('auth.dpopKey');
    if (!keyState || !keyState.val) return null;
    try {
      return JSON.parse(String(keyState.val));
    } catch {
      return null;
    }
  }

  /**
   * Login with the stored refresh token. Without one, wait for the OTP login from the admin UI.
   */
  async newLogin() {
    // Try refresh token from stored state first
    const storedTokenState = await this.getStateAsync('auth.refreshToken');
    this.dpopKey = await this._loadDpopKey();
    if (storedTokenState && storedTokenState.val && !this.dpopKey) {
      // Tokens of the old login client (before 3.1.0) were not DPoP-bound and no longer work
      this.log.info('Discarding the stored login of the old Volvo login method, a new login is required.');
      await this.setStateAsync('auth.refreshToken', '', true);
    } else if (storedTokenState && storedTokenState.val) {
      this.log.info('Trying stored refresh token...');
      try {
        const res = await this.requestClient(this._refreshTokenConfig(String(storedTokenState.val)));
        this.log.info('Login via stored refresh token successful');
        // Preserve refresh_token if not returned in response
        if (!res.data.refresh_token) {
          res.data.refresh_token = storedTokenState.val;
        }
        this.session = res.data;
        await this._persistTokens();
        this.setState('info.connection', true, true);
        await this._checkRefreshTokenAge();
        return;
      } catch (err) {
        if (this._isClientRejected(err)) {
          this.log.error(CLIENT_REJECTED_MESSAGE);
          return;
        }
        this.log.warn('Stored refresh token expired or invalid, need fresh OTP login');
      }
    }

    // No valid refresh token — the OTP login is only started from the admin UI
    if (!this.config.user || !this.config.password) {
      this.log.warn('No credentials configured. Please enter your Volvo ID email and password in the adapter settings.');
      return;
    }
    this.log.warn('Not logged in. Please click "Start Login (Send OTP)" in the adapter settings and submit the OTP from the email.');
  }

  /**
   * Open the Volvo ID login page, submit the credentials and persist the flow state.
   * This triggers the OTP email from Volvo.
   */
  async _startLoginFlow(user, password) {
    this.authCookies = {};
    this.authFlow = null;
    const pkce = createPkce();
    const params = qs.stringify({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: AUTH_SCOPES,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      acr_values: 'urn:volvoid:aal:bronze:2sv',
    });
    const loginPage = parseLoginPage((await this._authFetch('get', AUTH_URL + '?' + params)).html);
    if (loginPage.pageId !== 'login' || !loginPage.action) {
      throw new Error('Unexpected Volvo login page: ' + (loginPage.pageId || 'unknown'));
    }
    this.log.debug('Login page loaded, submitting credentials');

    const otpPage = parseLoginPage((await this._authFetch('post', loginPage.action, { username: user, password, credentialId: '' })).html);
    if (otpPage.pageId !== 'login-otp-email' || !otpPage.action) {
      throw new Error('Volvo did not ask for an OTP: ' + (otpPage.message || otpPage.pageId || 'unknown response'));
    }

    // Persist flow state so OTP submission can survive adapter restart
    this.authFlow = { action: otpPage.action, verifier: pkce.verifier };
    await this._persistAuthFlowState();
  }

  /**
   * Submit the OTP to the current login flow and exchange the returned code for tokens.
   */
  async _submitOtp(otp) {
    const result = await this._authFetch('post', this.authFlow.action, { otp: String(otp).trim() });
    if (!result.code) {
      const page = parseLoginPage(result.html);
      if (page.pageId === 'login-otp-email' && page.action) {
        // Wrong OTP: Volvo shows the form again with a new action, keep it for the next attempt
        this.authFlow.action = page.action;
        await this._persistAuthFlowState();
        throw new Error('OTP rejected: ' + (page.message || 'invalid code'));
      }
      this.authFlow = null;
      await this._clearAuthFlowState();
      throw new Error(
        'Login session is no longer valid (' + (result.error || page.message || page.pageId || 'unknown response') + '). Please click "Start Login (Send OTP)" again.',
      );
    }
    await this._exchangeCodeForTokens(result.code, this.authFlow.verifier);
    this.authFlow = null;
    await this._clearAuthFlowState();
  }

  /**
   * Persist the auth flow state (OTP form action, PKCE verifier, cookies) to survive adapter restarts.
   */
  async _persistAuthFlowState() {
    await this.setObjectNotExistsAsync('auth.flowId', {
      type: 'state',
      common: { name: 'Auth Flow ID', type: 'string', role: 'text', read: true, write: false },
      native: {},
    });
    await this.setObjectNotExistsAsync('auth.flowVerifier', {
      type: 'state',
      common: { name: 'Auth Flow PKCE Verifier', type: 'string', role: 'text', read: true, write: false },
      native: {},
    });
    await this.setObjectNotExistsAsync('auth.flowCookies', {
      type: 'state',
      common: { name: 'Auth Flow Cookies', type: 'string', role: 'text', read: true, write: false },
      native: {},
    });
    await this.setStateAsync('auth.flowId', this.authFlow.action, true);
    await this.setStateAsync('auth.flowVerifier', this.authFlow.verifier, true);
    await this.setStateAsync('auth.flowCookies', JSON.stringify(this.authCookies), true);
  }

  /**
   * Restore the auth flow from persisted state (e.g. after a restart between "Start login" and "Submit OTP").
   */
  async _loadAuthFlowState() {
    const actionState = await this.getStateAsync('auth.flowId');
    const verifierState = await this.getStateAsync('auth.flowVerifier');
    const cookiesState = await this.getStateAsync('auth.flowCookies');
    if (!actionState?.val || !verifierState?.val) {
      return false;
    }
    this.authFlow = { action: String(actionState.val), verifier: String(verifierState.val) };
    try {
      this.authCookies = JSON.parse(String(cookiesState?.val || '{}'));
    } catch {
      this.authCookies = {};
    }
    return true;
  }

  /**
   * Exchange an authorization code for DPoP-bound tokens and store the session.
   */
  async _exchangeCodeForTokens(authCode, verifier) {
    const dpopKey = createDpopKey();
    const tokenRes = await this.requestClient({
      method: 'post',
      url: TOKEN_URL,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        DPoP: createDpopProof(dpopKey, 'POST', TOKEN_URL),
      },
      data: qs.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code: authCode,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    this.log.info('Login successful');
    this.session = tokenRes.data;
    this.dpopKey = dpopKey;
    await this._persistTokens();
    await this.setStateAsync('auth.loginTimestamp', Date.now(), true);
    this.setState('info.connection', true, true);
  }

  /**
   * Warn (once a day) when the refresh token is about to reach its maximum lifetime.
   */
  async _checkRefreshTokenAge() {
    const loginTs = await this._getLoginTimestamp();
    if (!loginTs) return;
    const expiresAt = loginTs + REFRESH_TOKEN_MAX_AGE_DAYS * DAY_MS;
    const daysLeft = (expiresAt - Date.now()) / DAY_MS;
    if (daysLeft > REFRESH_TOKEN_WARN_DAYS) return;
    if (this.lastExpiryWarning && Date.now() - this.lastExpiryWarning < DAY_MS) return;
    this.lastExpiryWarning = Date.now();
    this.log.warn(
      `Volvo login will expire in about ${Math.max(0, Math.ceil(daysLeft))} day(s) (around ${new Date(expiresAt).toLocaleString()}). ` +
        'Please log in again in the adapter settings ("Start login" and enter the OTP from the email) to avoid an interruption.',
    );
  }

  /**
   * Time of the last OTP login in ms, or 0 if unknown.
   */
  async _getLoginTimestamp() {
    const loginState = await this.getStateAsync('auth.loginTimestamp');
    if (loginState && loginState.val) return Number(loginState.val);
    // Older versions did not store it. The refresh token never rotates,
    // so the last value change (lc) of its state is the login time.
    const tokenState = await this.getStateAsync('auth.refreshToken');
    if (!tokenState || !tokenState.val || !tokenState.lc) return 0;
    await this.setStateAsync('auth.loginTimestamp', tokenState.lc, true);
    return tokenState.lc;
  }

  /**
   * Clear persisted auth flow state after a successful login.
   */
  async _clearAuthFlowState() {
    try {
      await this.setStateAsync('auth.flowId', '', true);
      await this.setStateAsync('auth.flowVerifier', '', true);
      await this.setStateAsync('auth.flowCookies', '', true);
    } catch (_e) {
      // ignore - states might not exist yet
    }
  }

  /**
   * Persist tokens so they survive adapter restarts.
   */
  async _persistTokens() {
    await this.setObjectNotExistsAsync('auth', {
      type: 'channel',
      common: { name: 'Authentication' },
      native: {},
    });
    await this.setObjectNotExistsAsync('auth.refreshToken', {
      type: 'state',
      common: { name: 'Refresh Token', type: 'string', role: 'text', read: true, write: false },
      native: {},
    });
    await this.setObjectNotExistsAsync('auth.loginTimestamp', {
      type: 'state',
      common: { name: 'Last OTP login', type: 'number', role: 'date', read: true, write: false },
      native: {},
    });
    await this.setObjectNotExistsAsync('auth.dpopKey', {
      type: 'state',
      common: { name: 'DPoP key of the login', type: 'string', role: 'json', read: true, write: false },
      native: {},
    });
    if (this.session.refresh_token) {
      await this.setStateAsync('auth.refreshToken', this.session.refresh_token, true);
    }
    if (this.dpopKey) {
      await this.setStateAsync('auth.dpopKey', JSON.stringify(this.dpopKey), true);
    }
  }

  /**
   * Wrap requestClient with retry logic and exponential backoff.
   * Retries up to 3 times on HTTP 429, 500, 502, 503, 504.
   * @param {object | (() => object)} configOrFactory request config, or a function building one per attempt
   */
  async apiRequest(configOrFactory) {
    const retryStatuses = [429, 500, 502, 503, 504];
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const config = typeof configOrFactory === 'function' ? configOrFactory() : configOrFactory;
      try {
        return await this.requestClient(config);
      } catch (error) {
        const status = error.response && error.response.status;
        if (attempt < maxRetries && status && retryStatuses.includes(status)) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          this.log.warn(`API request to ${config.url} failed with ${status}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => this.setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Handle messages from admin UI (OTP login flow).
   */
  async onMessage(obj) {
    if (!obj || !obj.command) return;

    if (obj.command === 'startLogin') {
      // Phase 1: Start auth flow and submit credentials, trigger OTP email
      try {
        const msg = obj.message || {};
        const user = msg.user || this.config.user;
        const password = msg.password || this.config.password;
        if (!user || !password) {
          this.sendTo(obj.from, obj.command, { error: 'Username and password are required. Please save settings first.' }, obj.callback);
          return;
        }
        await this._startLoginFlow(user, password);
        this.sendTo(obj.from, obj.command, { result: 'OTP sent to your email' }, obj.callback);
      } catch (error) {
        this.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
      }
    } else if (obj.command === 'submitOtp') {
      // Phase 2: Submit OTP, get tokens
      try {
        if (!this.authFlow && !(await this._loadAuthFlowState())) {
          this.sendTo(obj.from, obj.command, { error: 'No active login flow. Start login first.' }, obj.callback);
          return;
        }
        await this._submitOtp((obj.message || {}).otp || '');

        // Clear keep-alive if it was running
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }

        // Start data fetching (errors here are non-fatal, data will be fetched on next cycle)
        if (this.config.vccapikey) {
          try {
            await this.getDeviceList();
            await this.updateDevice();
          } catch (fetchErr) {
            this.log.warn('Initial data fetch after login failed: ' + fetchErr.message);
          }
        } else {
          this.log.warn('No VCC API key configured. Please enter your API key in the adapter settings.');
        }
        if (!this.updateInterval) {
          this.updateInterval = this.setInterval(async () => {
            await this.updateDevice();
          }, this.config.interval * 60 * 1000);
        }
        if (!this.refreshTokenInterval) {
          const refreshMs = Math.max(60, (this.session.expires_in || 1799) - 300) * 1000;
          this.refreshTokenInterval = this.setInterval(() => {
            this.refreshToken();
          }, refreshMs);
        }

        this.sendTo(obj.from, obj.command, { result: 'Login successful! Adapter is now connected.' }, obj.callback);
      } catch (error) {
        this.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
      }
    } else if (obj.command === 'testConnection') {
      try {
        const msg = obj.message || {};
        const apiKey = msg.vccapikey || this.config.vccapikey;
        const res = await this.requestClient({
          method: 'get',
          url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles',
          headers: {
            accept: 'application/json',
            'vcc-api-key': apiKey,
            Authorization: 'Bearer ' + this.session.access_token,
          },
        });
        const count = (res.data.data || []).length;
        this.sendTo(obj.from, obj.command, { result: `Connection OK! Found ${count} vehicle(s).` }, obj.callback);
      } catch (error) {
        this.sendTo(obj.from, obj.command, { error: 'Connection failed: ' + error.message }, obj.callback);
      }
    } else if (obj.command === 'getVehicleInfo') {
      try {
        const lines = [];
        for (const vin of this.vinArray) {
          const res = await this.apiRequest({
            method: 'get',
            url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles/' + vin,
            headers: { accept: 'application/json', 'vcc-api-key': this.config.vccapikey, Authorization: 'Bearer ' + this.session.access_token },
          });
          const d = res.data.data || {};
          lines.push(`VIN: ${vin}`);
          if (d.descriptions) {
            lines.push(`Model: ${d.descriptions.model || '?'} (${d.modelYear || '?'})`);
            lines.push(`Color: ${d.descriptions.colour || '?'}`);
          }
          if (d.fuelType) lines.push(`Fuel: ${d.fuelType}`);
          if (d.externalColour) lines.push(`Exterior: ${d.externalColour}`);
        }
        this.sendTo(obj.from, obj.command, { result: lines.join('\n') || 'No vehicles found' }, obj.callback);
      } catch (error) {
        this.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
      }
    }
  }

  async getDeviceList() {
    await this.apiRequest({
      method: 'get',
      url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles',
      headers: {
        accept: 'application/json',
        'vcc-api-key': this.config.vccapikey,
        Authorization: 'Bearer ' + this.session.access_token,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        const vehicles = res.data.data || [];
        this.log.info(`Found ${vehicles.length} vehicles`);
        for (const device of vehicles) {
          this.log.info(JSON.stringify(device));
          const id = device.vin;
          this.vinArray.push(id);

          await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
              name: id,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.status', {
            type: 'channel',
            common: {
              name: 'Status of the car via Connected Vehicle API',
            },
            native: {},
          });

          //added for including location position
          await this.setObjectNotExistsAsync(id + '.location', {
            type: 'channel',
            common: {
              name: 'Location of the car via Connected Vehicle API',
            },
            native: {},
          });
          // end

          await this.setObjectNotExistsAsync(id + '.lastUpdate', {
            type: 'state',
            common: { name: 'Last successful data update', type: 'string', role: 'date', write: false, read: true },
            native: {},
          });

          await this.setObjectNotExistsAsync(id + '.remote.lastCommandStatus', {
            type: 'state',
            common: { name: 'Last command status', type: 'string', role: 'json', write: false, read: true },
            native: {},
          });

          const remoteArray = [{ command: 'refresh', name: 'Refresh all data' }];
          await this.apiRequest({
            method: 'get',
            url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles/' + id + '/commands',
            headers: {
              accept: 'application/json',
              'vcc-api-key': this.config.vccapikey,
              Authorization: 'Bearer ' + this.session.access_token,
            },
          })
            .then(async (res) => {
              this.log.debug(JSON.stringify(res.data));
              for (const command of res.data.data) {
                remoteArray.push({
                  command: command.command.toLowerCase().replace(/_/g, '-'),
                  name: command.command.toLowerCase(),
                });
              }
            })
            .catch((error) => {
              this.log.error('get command list failed');
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            });
          for (const remote of remoteArray) {
            await this.setObjectNotExistsAsync(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: 'boolean',
                role: 'button',
                def: false,
                write: true,
                read: false,
              },
              native: {},
            });
          }
          this.json2iob.parse(id, device, { forceIndex: true });

          // Fetch vehicle details
          await this.apiRequest({
            method: 'get',
            url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles/' + id,
            headers: {
              accept: 'application/json',
              'vcc-api-key': this.config.vccapikey,
              Authorization: 'Bearer ' + this.session.access_token,
            },
          })
            .then(async (res) => {
              this.log.debug(JSON.stringify(res.data));
              this.json2iob.parse(id + '.details', res.data.data, { forceIndex: true });
            })
            .catch((error) => {
              this.log.warn('get vehicle details failed: ' + (error.response ? error.response.status : error.message));
            });
        }
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error('get device list failed');
        if(error.message.includes('Invalid character') && error.message.includes('vcc-api-key')) {
          this.log.error('This likely means your API key is invalid. Please reenter your API key.');
        }
        if(error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  async updateDevice(singleVin) {
    if (!this.session.access_token) {
      this.log.warn('Not logged in to Volvo ID, skipping data update. Please log in via the adapter settings.');
      return;
    }
    const vins = singleVin ? [singleVin] : this.vinArray;
    let unauthorized = false;
    const isUnauthorized = (error) => error.response && error.response.status === 401;
    for (const vin of vins) {
      const endpoints = [
        'engine',
        'windows',
        'diagnostics',
        'brakes',
        'doors',
        'engine-status',
        'fuel',
        'odometer',
        'statistics',
        'tyres',
        'warnings',
      ];
      for (const endpoint of endpoints) {
        await this.apiRequest({
          method: 'get',
          url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles/' + vin + '/' + endpoint,
          headers: {
            accept: 'application/json, */*',
            'vcc-api-key': this.config.vccapikey,
            Authorization: 'Bearer ' + this.session.access_token,
          },
        })
          .then(async (res) => {
            if( res){
              this.log.debug(JSON.stringify(res.data));
              this.json2iob.parse(vin + '.status.' + endpoint, res.data.data, { forceIndex: true });
            }
          })
          .catch((error) => {
            if (isUnauthorized(error)) {
              unauthorized = true;
            } else if (error.response && error.response.status === 404) {
              this.log.debug(`Endpoint ${endpoint} not available for this vehicle`);
            } else {
              this.log.error(`Error: ${endpoint} failed`);
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            }
          });
        if (unauthorized) break;
      }
      if (unauthorized) break;
      // added for including location position
      await this.apiRequest({
        method: 'get',
        url: 'https://api.volvocars.com/location/v1/vehicles/' + vin + '/location',
        headers: {
          accept: 'application/json',
          'vcc-api-key': this.config.vccapikey,
          Authorization: 'Bearer ' + this.session.access_token,
        },
      })
        .then(async (res) => {
          if(res){
            this.log.debug(JSON.stringify(res.data));
            this.json2iob.parse(vin + '.location', res.data.data, { forceIndex: true });
          }
        })
        .catch((error) => {
          if (isUnauthorized(error)) {
            unauthorized = true;
          } else if (error.response && error.response.status === 404) {
            this.log.debug('Location not available (GPS may be off or no location data yet)');
          } else {
            this.log.error('failed to get location');
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          }
        });

      // Energy API v2 - recharge/battery state
      await this.apiRequest({
        method: 'get',
        url: 'https://api.volvocars.com/energy/v2/vehicles/' + vin + '/state',
        headers: {
          accept: 'application/json',
          'vcc-api-key': this.config.vccapikey,
          Authorization: 'Bearer ' + this.session.access_token,
        },
      })
        .then(async (res) => {
          if(res){
            this.log.debug(JSON.stringify(res.data));
            this.json2iob.parse(vin + '.energy', res.data, { forceIndex: true });
          }
        })
        .catch((error) => {
          if (isUnauthorized(error)) {
            unauthorized = true;
          } else if (error.response && error.response.status === 404) {
            this.log.debug('Energy data not available (vehicle may not support energy API)');
          } else {
            this.log.error('failed to get energy state');
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          }
        });
      if (unauthorized) break;

      await this.setStateAsync(vin + '.lastUpdate', new Date().toISOString(), true);
    }
    if (unauthorized) {
      await this._handleUnauthorized();
    }
  }
  async refreshToken() {
    if (!this.session.refresh_token) {
      this.log.error('No refresh token available, trying stored token...');
      const storedTokenState = await this.getStateAsync('auth.refreshToken');
      if (storedTokenState && storedTokenState.val) {
        this.session.refresh_token = storedTokenState.val;
      } else {
        this.log.error('No stored refresh token found. Please re-login via adapter settings.');
        this.setState('info.connection', false, true);
        return;
      }
    }
    if (!this.dpopKey) {
      this.dpopKey = await this._loadDpopKey();
      if (!this.dpopKey) {
        await this._handleSessionExpired();
        return;
      }
    }
    const currentRefreshToken = this.session.refresh_token;
    // Factory: every retry needs a fresh DPoP proof
    await this.apiRequest(() => this._refreshTokenConfig(currentRefreshToken))
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.debug('Token refresh successful');
        // Preserve refresh_token if not returned in response
        if (!res.data.refresh_token) {
          res.data.refresh_token = currentRefreshToken;
        }
        this.session = res.data;
        await this._persistTokens();
        this.setState('info.connection', true, true);
        await this._checkRefreshTokenAge();
      })
      .catch(async (error) => {
        // invalid_grant = refresh token is dead for good (e.g. max lifetime reached) — retrying won't help
        if (error.response && error.response.data && error.response.data.error === 'invalid_grant') {
          await this._handleSessionExpired();
          return;
        }
        if (this._isClientRejected(error)) {
          this.log.error(CLIENT_REJECTED_MESSAGE);
          this._pauseUpdates();
          return;
        }
        this.log.error('Token refresh failed: ' + (error.message || error));
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
        this.setState('info.connection', false, true);
      });
  }

  /**
   * Refresh token was rejected permanently. Stop polling and wait for a new OTP login
   * instead of logging the same 401 errors on every update cycle.
   */
  async _handleSessionExpired() {
    const loginTs = await this._getLoginTimestamp();
    const age = loginTs ? ` Last OTP login was ${((Date.now() - loginTs) / DAY_MS).toFixed(1)} days ago.` : '';
    this.log.error(
      'Volvo session expired: the refresh token is no longer valid (maximum lifetime reached or revoked).' + age + ' ' +
        'Data updates are paused. Please log in again in the adapter settings ("Start login" and enter the OTP from the email).',
    );
    this._pauseUpdates();
    // Drop the dead token so a restart goes straight to the OTP flow
    await this.setStateAsync('auth.refreshToken', '', true);
    await this.setStateAsync('auth.loginTimestamp', 0, true);
  }

  /**
   * Stop polling and token refresh, keep the adapter alive until the next login.
   */
  _pauseUpdates() {
    this.updateInterval && this.clearInterval(this.updateInterval);
    this.refreshTokenInterval && this.clearInterval(this.refreshTokenInterval);
    this.updateInterval = null;
    this.refreshTokenInterval = null;
    this.session = {};
    this.setState('info.connection', false, true);
    if (!this.keepAliveInterval) {
      this.keepAliveInterval = this.setInterval(() => {
        this.log.debug('Waiting for login...');
      }, 60000);
    }
  }

  _isClientRejected(error) {
    return !!(error && error.response && error.response.data && error.response.data.error === 'invalid_client');
  }

  /**
   * Access token was rejected (401). Skip the current cycle and try to get a new one right away.
   */
  async _handleUnauthorized() {
    this.log.warn('Volvo API rejected the access token (401). Skipping this update and refreshing the token.');
    await this.refreshToken();
  }

  /**
   * Poll command status with retries and auto-refresh relevant data on completion.
   */
  async pollCommandStatus(vin, command, asyncHref) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(resolve => this.setTimeout(resolve, 3000));
      try {
        const res = await this.apiRequest({
          method: 'get',
          url: asyncHref,
          headers: {
            'content-type': 'application/json',
            'vcc-api-key': this.config.vccapikey,
            Authorization: 'Bearer ' + this.session.access_token,
          },
        });
        const status = res.data?.invokeStatus || res.data?.status || 'UNKNOWN';
        this.log.info(`Command ${command} status (attempt ${attempt + 1}): ${status}`);
        await this.setStateAsync(vin + '.remote.lastCommandStatus', JSON.stringify({ command, status, time: new Date().toISOString() }), true);
        if (status === 'COMPLETED' || status === 'RUNNING') {
          await this.autoRefreshAfterCommand(vin, command);
          return;
        }
      } catch (error) {
        this.log.warn(`Command ${command} status poll failed: ${error.message}`);
      }
    }
  }

  /**
   * After a command completes, refresh the relevant data endpoints.
   */
  async autoRefreshAfterCommand(vin, command) {
    const endpointMap = {
      'lock': ['doors'],
      'unlock': ['doors'],
      'climatization-start': ['engine-status'],
      'climatization-stop': ['engine-status'],
    };
    const endpoints = endpointMap[command] || [];
    for (const endpoint of endpoints) {
      await this.apiRequest({
        method: 'get',
        url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles/' + vin + '/' + endpoint,
        headers: {
          accept: 'application/json, */*',
          'vcc-api-key': this.config.vccapikey,
          Authorization: 'Bearer ' + this.session.access_token,
        },
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          this.json2iob.parse(vin + '.status.' + endpoint, res.data.data, { forceIndex: true });
        })
        .catch((error) => {
          this.log.error('Auto-refresh ' + endpoint + ' failed');
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
    await this.setStateAsync(vin + '.lastUpdate', new Date().toISOString(), true);
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.isStopping = true;
      this.log.info('cleaned everything up...');
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      this.keepAliveInterval && clearInterval(this.keepAliveInterval);
      this.timeout && clearTimeout(this.timeout);
      callback();
    } catch (_e) {
      callback();
    }
  }
  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack && state.val) {
        const vin = id.split('.')[2];
        const command = id.split('.')[4];

        // Handle refresh: re-fetch all data instead of sending API command
        if (command === 'refresh') {
          this.log.info('Manual refresh triggered for VIN ' + vin);
          await this.updateDevice(vin);
          await this.setStateAsync(id, false, true);
          return;
        }

        this.log.info('Executing remote command: ' + command + ' for VIN ' + vin);
        const response = await this.apiRequest({
          method: 'post',
          url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles/' + vin + '/commands/' + command,
          headers: {
            'content-type': 'application/json',
            'vcc-api-key': this.config.vccapikey,
            Authorization: 'Bearer ' + this.session.access_token,
          },
        })
          .then(async (res) => {
            this.log.info('Command ' + command + ' response: ' + JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error('Command ' + command + ' failed: ' + error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });

        // Reset button state
        await this.setStateAsync(id, false, true);

        const asyncData = response && (response.async || (response.data && response.data.async));
        if (asyncData && asyncData.href) {
          this.pollCommandStatus(vin, command, asyncData.href);
        }
      }
    }
  }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<ioBroker.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Volvo(options);
} else {
  // otherwise start the instance directly
  new Volvo();
}
