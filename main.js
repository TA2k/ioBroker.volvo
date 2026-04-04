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
        // No valid session yet — stay alive and wait for OTP login via admin UI
        this.log.info('No active session. Adapter is running and waiting for login via admin UI (Settings → Start Login → Submit OTP).');
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
   * If OTP is stored in config (from admin UI sendTo), use it.
   * Otherwise try stored refresh_token first.
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

    // Full OTP login flow
    if (!this.config.otp) {
      this.log.warn('No stored refresh token and no OTP code. Please use the adapter admin UI to start login and enter the OTP code sent to your email.');
      this.log.info('The adapter will stay running and wait for login via the admin settings page.');
      return;
    }

    try {
      // Step 1: Init auth flow
      this.log.info('Starting OTP auth flow...');
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

      // Step 2: Submit credentials
      if (initData.status === 'USERNAME_PASSWORD_REQUIRED') {
        const flowUrl = initData._links.checkUsernamePassword.href;
        const credData = await this._authRequest('post', flowUrl + '?action=checkUsernamePassword', {
          username: this.config.user,
          password: this.config.password,
        }, true);
        this.log.debug('Credentials submitted, status: ' + credData.status);

        if (credData.status !== 'OTP_REQUIRED') {
          this.log.error('Unexpected status after credentials: ' + credData.status);
          return;
        }

        // Step 3: Submit OTP
        const otpUrl = credData._links.checkOtp.href;
        const otpData = await this._authRequest('post', otpUrl + '?action=checkOtp', {
          otp: this.config.otp,
        }, true);
        this.log.debug('OTP submitted, status: ' + otpData.status);

        if (otpData.status !== 'OTP_VERIFIED') {
          this.log.error('OTP verification failed: ' + otpData.status);
          return;
        }

        // Step 4: Continue authentication
        const contUrl = otpData._links.continueAuthentication.href;
        const contData = await this._authRequest('post', contUrl + '?action=continueAuthentication', null, false);
        this.log.debug('Auth continued, status: ' + contData.status);

        if (contData.status !== 'COMPLETED') {
          this.log.error('Auth not completed: ' + contData.status);
          return;
        }

        // Step 5: Exchange code for tokens
        const authCode = contData.authorizeResponse.code;
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

        // Clear OTP from config after successful login
        this.config.otp = '';
      }
    } catch (error) {
      this.log.error('Login failed: ' + error.message);
      if (error.response) {
        this.log.error(JSON.stringify(error.response.data));
      }
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
          this.sendTo(obj.from, obj.command, { error: 'No active login flow. Start login first.' }, obj.callback);
          return;
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
        const authCode = contData.authorizeResponse.code;
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

        this.session = tokenRes.data;
        await this._persistTokens();
        this.setState('info.connection', true, true);
        this.authFlowId = null;

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
            this.log.error('Error: ' + endpoint + ' failed');
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
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
          this.log.error('failed to get location');
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
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
          this.log.error('failed to get energy state');
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
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
