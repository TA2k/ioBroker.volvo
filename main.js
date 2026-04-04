'use strict';

/*
 * Created with @iobroker/create-adapter v1.20.0
 */

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const qs = require('qs');
const Json2iob = require('json2iob');
const { extractKeys } = require('./lib/extractKeys');

const AUTH_URL = 'https://volvoid.eu.volvocars.com/as/authorization.oauth2';
const TOKEN_URL = 'https://volvoid.eu.volvocars.com/as/token.oauth2';
const AUTH_BASIC = 'Basic aDRZZjBiOlU4WWtTYlZsNnh3c2c1WVFxWmZyZ1ZtSWFEcGhPc3kxUENhVXNpY1F0bzNUUjVrd2FKc2U0QVpkZ2ZJZmNMeXc=';
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
    this.authFlowId = null;
    this.authCookies = '';
    this.responseTimeout;
    this.requestClient = axios.create();
    this.extractKeys = extractKeys;
    this.updateInterval = null;
    this.vinArray = [];
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
        await this.getDeviceList();
        await this.updateDevice();
        this.updateInterval = setInterval(async () => {
          await this.updateDevice();
        }, this.config.interval * 60 * 1000);
        // Refresh token before it expires (5 min before expiry, min 60s)
        const refreshMs = Math.max(60, (this.session.expires_in || 1799) - 300) * 1000;
        this.log.info(`Token refresh scheduled every ${Math.round(refreshMs / 1000)}s`);
        this.refreshTokenInterval = setInterval(() => {
          this.refreshToken();
        }, refreshMs);
      } else {
        // No valid session yet — adapter will either wait for sendTo or be restarted with OTP in config
        this.log.info('No active session. Enter OTP in adapter settings and save to complete login.');
        this.log.info('If the adapter terminates, it will auto-login on next start after you save the OTP.');
        // Keep-alive interval so ioBroker doesn't terminate idle daemon
        this.keepAliveInterval = setInterval(() => {
          this.log.debug('Waiting for login...');
        }, 60000);
      }
    } catch (error) {
      this.log.error(`Startup error: ${error.message}`);
      this.log.error(error.stack);
      // Stay alive even after errors — user can fix config and re-login via admin
      this.log.info('Adapter staying alive despite startup error. Please check adapter settings.');
      this.keepAliveInterval = setInterval(() => {
        this.log.debug('Waiting for login after error...');
      }, 60000);
    }
  }
  /**
   * Extract Set-Cookie headers from an axios response and merge with stored cookies.
   */
  _extractCookies(response) {
    const setCookies = response.headers['set-cookie'];
    if (!setCookies) return;
    const cookieMap = {};
    // Parse existing cookies
    if (this.authCookies) {
      this.authCookies.split('; ').forEach((c) => {
        const [k] = c.split('=');
        if (k) cookieMap[k] = c;
      });
    }
    // Merge new cookies
    for (const raw of setCookies) {
      const pair = raw.split(';')[0]; // "key=value"
      const [k] = pair.split('=');
      if (k) cookieMap[k] = pair;
    }
    this.authCookies = Object.values(cookieMap).join('; ');
  }

  /**
   * Make an auth-flow request with cookie persistence and http→https fix.
   */
  async _authRequest(method, url, data, isJson) {
    if (url.startsWith('http://')) {
      url = 'https://' + url.slice(7);
    }
    const headers = {
      'X-XSRF-Header': 'PingFederate',
    };
    if (this.authCookies) {
      headers['Cookie'] = this.authCookies;
    }
    if (isJson) {
      headers['content-type'] = 'application/json';
    } else if (data) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const config = { method, url, headers, maxRedirects: 0, validateStatus: () => true };
    if (data) {
      config.data = isJson ? data : qs.stringify(data);
    }
    const res = await this.requestClient(config);
    this._extractCookies(res);
    if (res.status >= 400) {
      throw new Error(`Auth request failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
    return res.data;
  }

  /**
   * New API login using multi-step OTP flow.
   * Designed to be resilient to adapter restarts:
   * - With refresh token: use it
   * - With OTP in config + persisted flow state: resume OTP submission
   * - With OTP in config but no flow state: full fresh flow (init + credentials + OTP)
   * - No token, no OTP: init flow + credentials to trigger OTP email, persist state, wait
   */
  async newLogin() {
    // Try refresh token from stored state first
    const storedTokenState = await this.getStateAsync('auth.refreshToken');
    if (storedTokenState && storedTokenState.val) {
      this.log.info('Trying stored refresh token...');
      try {
        const res = await this.requestClient({
          method: 'post',
          url: TOKEN_URL,
          headers: {
            Authorization: AUTH_BASIC,
            'X-XSRF-Header': 'PingFederate',
            'content-type': 'application/x-www-form-urlencoded',
          },
          data: qs.stringify({
            grant_type: 'refresh_token',
            refresh_token: storedTokenState.val,
          }),
        });
        this.log.info('Login via stored refresh token successful');
        // Preserve refresh_token if not returned in response
        if (!res.data.refresh_token) {
          res.data.refresh_token = storedTokenState.val;
        }
        this.session = res.data;
        await this._persistTokens();
        this.setState('info.connection', true, true);
        return;
      } catch (_err) {
        this.log.warn('Stored refresh token expired or invalid, need fresh OTP login');
      }
    }

    // If OTP is available in config, attempt login
    if (this.config.otp) {
      // Try to resume a persisted auth flow first
      const resumed = await this._tryResumeAuthFlow();
      if (resumed) return;

      // No persisted flow or it expired — do full fresh flow (init + credentials + OTP)
      this.log.info('No persisted auth flow found. Starting complete fresh login with OTP...');
      const success = await this._fullOtpLogin(this.config.otp);
      if (success) return;

      // If fresh flow also failed, clear OTP and wait
      this.log.warn('OTP login failed. Please request a new OTP via the admin UI.');
      return;
    }

    // No refresh token and no OTP — trigger OTP email and wait
    if (!this.config.user || !this.config.password) {
      this.log.warn('No credentials configured. Please enter your Volvo ID email and password in the adapter settings.');
      return;
    }

    this.log.info('No refresh token and no OTP. Triggering OTP email...');
    try {
      await this._initAuthAndSendCredentials();
      this.log.info('*** OTP has been sent to your email. Enter it in the adapter settings (OTP field) and save/restart. ***');
    } catch (error) {
      this.log.error('Failed to trigger OTP email: ' + error.message);
      if (error.response) {
        this.log.error(JSON.stringify(error.response.data));
      }
      this.log.warn('Please check your credentials and try again.');
    }
  }

  /**
   * Init auth flow, submit credentials, and persist the flow state.
   * This triggers the OTP email from Volvo.
   */
  async _initAuthAndSendCredentials() {
    this.authCookies = '';
    const initData = await this._authRequest('post', AUTH_URL, {
      client_id: 'h4Yf0b',
      response_type: 'code',
      response_mode: 'pi.flow',
      acr_values: 'urn:volvoid:aal:bronze:2sv',
      scope: AUTH_SCOPES,
    }, false);

    this.authFlowId = initData.id;
    this.log.debug('Auth flow started: ' + initData.id + ' status: ' + initData.status);

    if (initData.status !== 'USERNAME_PASSWORD_REQUIRED') {
      throw new Error('Unexpected auth status: ' + initData.status);
    }

    const flowUrl = initData._links.checkUsernamePassword.href;
    const credData = await this._authRequest('post', flowUrl + '?action=checkUsernamePassword', {
      username: this.config.user,
      password: this.config.password,
    }, true);
    this.log.debug('Credentials submitted, status: ' + credData.status);

    if (credData.status !== 'OTP_REQUIRED') {
      throw new Error('Unexpected status after credentials: ' + credData.status);
    }

    // Persist flow state so OTP submission can survive adapter restart
    await this._persistAuthFlowState();
    return credData;
  }

  /**
   * Persist the auth flow state (flow ID + cookies) to survive adapter restarts.
   */
  async _persistAuthFlowState() {
    await this.setObjectNotExistsAsync('auth.flowId', {
      type: 'state',
      common: { name: 'Auth Flow ID', type: 'string', role: 'text', read: true, write: false },
      native: {},
    });
    await this.setObjectNotExistsAsync('auth.flowCookies', {
      type: 'state',
      common: { name: 'Auth Flow Cookies', type: 'string', role: 'text', read: true, write: false },
      native: {},
    });
    await this.setObjectNotExistsAsync('auth.flowTimestamp', {
      type: 'state',
      common: { name: 'Auth Flow Timestamp', type: 'number', role: 'date', read: true, write: false },
      native: {},
    });
    await this.setStateAsync('auth.flowId', this.authFlowId || '', true);
    await this.setStateAsync('auth.flowCookies', this.authCookies || '', true);
    await this.setStateAsync('auth.flowTimestamp', Date.now(), true);
  }

  /**
   * Try to resume an auth flow from persisted state with the OTP from config.
   * Returns true if login was successful.
   */
  async _tryResumeAuthFlow() {
    try {
      const flowIdState = await this.getStateAsync('auth.flowId');
      const cookiesState = await this.getStateAsync('auth.flowCookies');
      const tsState = await this.getStateAsync('auth.flowTimestamp');

      if (!flowIdState?.val || !tsState?.val) {
        return false;
      }

      // Auth flows expire after ~10 minutes, allow 8 min max
      const ageMs = Date.now() - Number(tsState.val);
      if (ageMs > 8 * 60 * 1000) {
        this.log.info('Persisted auth flow expired (' + Math.round(ageMs / 1000) + 's old). Starting fresh flow.');
        await this._clearAuthFlowState();
        return false;
      }

      this.log.info('Resuming persisted auth flow (age: ' + Math.round(ageMs / 1000) + 's)...');
      this.authFlowId = String(flowIdState.val);
      this.authCookies = String(cookiesState?.val || '');

      const flowBase = 'https://volvoid.eu.volvocars.com/pf-ws/authn/flows/' + this.authFlowId;

      // Submit OTP
      const otpData = await this._authRequest('post', flowBase + '?action=checkOtp', {
        otp: this.config.otp,
      }, true);
      this.log.debug('OTP submitted (resumed flow), status: ' + otpData.status);

      if (otpData.status !== 'OTP_VERIFIED') {
        this.log.warn('Resumed flow OTP failed: ' + otpData.status + '. Will try fresh flow.');
        await this._clearAuthFlowState();
        return false;
      }

      // Continue authentication
      const contData = await this._authRequest('post', flowBase + '?action=continueAuthentication', null, false);
      if (contData.status !== 'COMPLETED') {
        this.log.warn('Resumed flow auth not completed: ' + contData.status);
        await this._clearAuthFlowState();
        return false;
      }

      // Exchange code for tokens
      await this._exchangeCodeForTokens(contData.authorizeResponse.code);
      await this._clearAuthFlowState();
      return true;
    } catch (error) {
      this.log.warn('Resume auth flow failed: ' + error.message + '. Will try fresh flow.');
      await this._clearAuthFlowState();
      return false;
    }
  }

  /**
   * Full OTP login: init flow + credentials + OTP in one go.
   * Used as fallback when no persisted flow state is available.
   * Returns true if login was successful.
   */
  async _fullOtpLogin(otp) {
    try {
      this.log.info('Starting complete OTP auth flow...');
      this.authCookies = '';
      const initData = await this._authRequest('post', AUTH_URL, {
        client_id: 'h4Yf0b',
        response_type: 'code',
        response_mode: 'pi.flow',
        acr_values: 'urn:volvoid:aal:bronze:2sv',
        scope: AUTH_SCOPES,
      }, false);

      this.authFlowId = initData.id;
      this.log.debug('Auth flow started: ' + initData.id + ' status: ' + initData.status);

      if (initData.status !== 'USERNAME_PASSWORD_REQUIRED') {
        this.log.error('Unexpected auth status: ' + initData.status);
        return false;
      }

      // Submit credentials (this triggers a new OTP email, but we'll try the provided OTP)
      const flowUrl = initData._links.checkUsernamePassword.href;
      const credData = await this._authRequest('post', flowUrl + '?action=checkUsernamePassword', {
        username: this.config.user,
        password: this.config.password,
      }, true);
      this.log.debug('Credentials submitted, status: ' + credData.status);

      if (credData.status !== 'OTP_REQUIRED') {
        this.log.error('Unexpected status after credentials: ' + credData.status);
        return false;
      }

      // Submit OTP
      const otpUrl = credData._links.checkOtp.href;
      const otpData = await this._authRequest('post', otpUrl + '?action=checkOtp', {
        otp: otp,
      }, true);
      this.log.debug('OTP submitted, status: ' + otpData.status);

      if (otpData.status !== 'OTP_VERIFIED') {
        this.log.error('OTP verification failed: ' + otpData.status);
        return false;
      }

      // Continue authentication
      const contUrl = otpData._links.continueAuthentication.href;
      const contData = await this._authRequest('post', contUrl + '?action=continueAuthentication', null, false);
      this.log.debug('Auth continued, status: ' + contData.status);

      if (contData.status !== 'COMPLETED') {
        this.log.error('Auth not completed: ' + contData.status);
        return false;
      }

      // Exchange code for tokens
      await this._exchangeCodeForTokens(contData.authorizeResponse.code);
      return true;
    } catch (error) {
      this.log.error('Login failed: ' + error.message);
      if (error.response) {
        this.log.error(JSON.stringify(error.response.data));
      }
      return false;
    }
  }

  /**
   * Exchange an authorization code for tokens and store the session.
   */
  async _exchangeCodeForTokens(authCode) {
    const tokenRes = await this.requestClient({
      method: 'post',
      url: TOKEN_URL,
      headers: {
        Authorization: AUTH_BASIC,
        'X-XSRF-Header': 'PingFederate',
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: qs.stringify({
        code: authCode,
        grant_type: 'authorization_code',
      }),
    });

    this.log.info('Login successful');
    this.session = tokenRes.data;
    await this._persistTokens();
    this.setState('info.connection', true, true);

    // Clear OTP from config after successful login so it's not reused on restart
    this.config.otp = '';
    try {
      await this.extendForeignObjectAsync('system.adapter.' + this.namespace, {
        native: { otp: '' },
      });
    } catch (_e) {
      this.log.debug('Could not clear OTP from config: ' + _e.message);
    }
  }

  /**
   * Clear persisted auth flow state after use or expiry.
   */
  async _clearAuthFlowState() {
    try {
      await this.setStateAsync('auth.flowId', '', true);
      await this.setStateAsync('auth.flowCookies', '', true);
      await this.setStateAsync('auth.flowTimestamp', 0, true);
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
    if (this.session.refresh_token) {
      await this.setStateAsync('auth.refreshToken', this.session.refresh_token, true);
    }
  }

  /**
   * Wrap requestClient with retry logic and exponential backoff.
   * Retries up to 3 times on HTTP 429, 500, 502, 503, 504.
   */
  async apiRequest(config) {
    const retryStatuses = [429, 500, 502, 503, 504];
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.requestClient(config);
      } catch (error) {
        const status = error.response && error.response.status;
        if (attempt < maxRetries && status && retryStatuses.includes(status)) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          this.log.warn(`API request to ${config.url} failed with ${status}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
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
        this.authCookies = '';
        const initData = await this._authRequest('post', AUTH_URL, {
          client_id: 'h4Yf0b',
          response_type: 'code',
          response_mode: 'pi.flow',
          acr_values: 'urn:volvoid:aal:bronze:2sv',
          scope: AUTH_SCOPES,
        }, false);

        this.authFlowId = initData.id;

        if (initData.status === 'USERNAME_PASSWORD_REQUIRED') {
          const flowUrl = initData._links.checkUsernamePassword.href;
          const credData = await this._authRequest('post', flowUrl + '?action=checkUsernamePassword', {
            username: user,
            password: password,
          }, true);

          if (credData.status === 'OTP_REQUIRED') {
            // Persist flow state so OTP can be submitted after restart
            await this._persistAuthFlowState();
            const target = credData.devices && credData.devices[0] ? credData.devices[0].target : 'your email';
            this.sendTo(obj.from, obj.command, { result: 'OTP sent to ' + target }, obj.callback);
          } else {
            this.sendTo(obj.from, obj.command, { error: 'Unexpected status: ' + credData.status }, obj.callback);
          }
        } else {
          this.sendTo(obj.from, obj.command, { error: 'Unexpected status: ' + initData.status }, obj.callback);
        }
      } catch (error) {
        this.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
      }
    } else if (obj.command === 'submitOtp') {
      // Phase 2: Submit OTP, get tokens
      try {
        if (!this.authFlowId) {
          // Try to restore from persisted state
          const flowIdState = await this.getStateAsync('auth.flowId');
          const cookiesState = await this.getStateAsync('auth.flowCookies');
          if (flowIdState?.val) {
            this.authFlowId = String(flowIdState.val);
            this.authCookies = String(cookiesState?.val || '');
          } else {
            this.sendTo(obj.from, obj.command, { error: 'No active login flow. Start login first.' }, obj.callback);
            return;
          }
        }

        const flowBase = 'https://volvoid.eu.volvocars.com/pf-ws/authn/flows/' + this.authFlowId;

        // Submit OTP
        const otpData = await this._authRequest('post', flowBase + '?action=checkOtp', {
          otp: (obj.message || {}).otp || '',
        }, true);

        if (otpData.status !== 'OTP_VERIFIED') {
          this.sendTo(obj.from, obj.command, { error: 'OTP invalid: ' + otpData.status }, obj.callback);
          return;
        }

        // Continue authentication
        const contData = await this._authRequest('post', flowBase + '?action=continueAuthentication', null, false);

        if (contData.status !== 'COMPLETED') {
          this.sendTo(obj.from, obj.command, { error: 'Auth not completed: ' + contData.status }, obj.callback);
          return;
        }

        // Exchange code for tokens
        await this._exchangeCodeForTokens(contData.authorizeResponse.code);
        this.authFlowId = null;
        await this._clearAuthFlowState();

        // Clear keep-alive if it was running
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }

        // Start data fetching
        await this.getDeviceList();
        await this.updateDevice();
        if (!this.updateInterval) {
          this.updateInterval = setInterval(async () => {
            await this.updateDevice();
          }, this.config.interval * 60 * 1000);
        }
        if (!this.refreshTokenInterval) {
          const refreshMs = Math.max(60, (this.session.expires_in || 1799) - 300) * 1000;
          this.refreshTokenInterval = setInterval(() => {
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
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async updateDevice(singleVin) {
    const vins = singleVin ? [singleVin] : this.vinArray;
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
            this.log.debug(JSON.stringify(res.data));
            this.json2iob.parse(vin + '.status.' + endpoint, res.data.data, { forceIndex: true });
          })
          .catch((error) => {
            if (error.response && error.response.status === 404) {
              this.log.debug(`Endpoint ${endpoint} not available for this vehicle`);
            } else {
              this.log.error(`Error: ${endpoint} failed`);
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            }
          });
      }
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
          this.log.debug(JSON.stringify(res.data));
          this.json2iob.parse(vin + '.location', res.data.data, { forceIndex: true });
        })
        .catch((error) => {
          if (error.response && error.response.status === 404) {
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
          this.log.debug(JSON.stringify(res.data));
          this.json2iob.parse(vin + '.energy', res.data, { forceIndex: true });
        })
        .catch((error) => {
          if (error.response && error.response.status === 404) {
            this.log.debug('Energy data not available (vehicle may not support energy API)');
          } else {
            this.log.error('failed to get energy state');
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          }
        });

      await this.setStateAsync(vin + '.lastUpdate', new Date().toISOString(), true);
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
    const currentRefreshToken = this.session.refresh_token;
    await this.apiRequest({
      method: 'post',
      url: TOKEN_URL,
      headers: {
        Authorization: AUTH_BASIC,
        'X-XSRF-Header': 'PingFederate',
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: qs.stringify({
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
      }),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info('Token refresh successful');
        // Preserve refresh_token if not returned in response
        if (!res.data.refresh_token) {
          res.data.refresh_token = currentRefreshToken;
        }
        this.session = res.data;
        await this._persistTokens();
        this.setState('info.connection', true, true);
      })
      .catch((error) => {
        this.log.error('Token refresh failed: ' + (error.message || error));
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
        this.setState('info.connection', false, true);
      });
  }

  /**
   * Poll command status with retries and auto-refresh relevant data on completion.
   */
  async pollCommandStatus(vin, command, asyncHref) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
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
      this.log.info('cleaned everything up...');
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      this.keepAliveInterval && clearInterval(this.keepAliveInterval);
      this.responseTimeout && clearTimeout(this.responseTimeout);
      callback();
    } catch (_e) {
      callback();
    }
  }
  decrypt(key, value) {
    let result = '';
    for (let i = 0; i < value.length; ++i) {
      result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
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
