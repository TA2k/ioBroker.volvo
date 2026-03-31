'use strict';

/*
 * Created with @iobroker/create-adapter v1.20.0
 */

const utils = require('@iobroker/adapter-core');
const { v4: uuidv4 } = require('uuid');
const request = require('request');
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
  'conve:environment',
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
    this.baseHeader = {
      Accept: 'application/vnd.wirelesscar.com.voc.AppUser.v4+json; charset=utf-8',
      'X-Client-Version': '4.8.14.350668',
      'X-App-Name': 'Volvo On Call',
      'Accept-Language': 'de-de',
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'Volvo%20On%20Call/4.8.14.350668 CFNetwork/1206 Darwin/20.1.0',
      'X-Os-Type': 'iPhone OS',
      'X-Device-Id': uuidv4(),
      'X-Os-Version': '14.2',
      'X-Originator-Type': 'app',
      'X-Request-Id': '',
      Authorization: '',
    };
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    const obj = await this.getForeignObjectAsync('system.config');
    if (obj && obj.native && obj.native.secret) {
      this.config.password = this.decrypt(obj.native.secret, this.config.password);
    } else {
      this.config.password = this.decrypt('Zgfr56gFe87jJOM', this.config.password);
    }
    this.setState('info.connection', false, true);
    const buff = Buffer.from(this.config.user + ':' + this.config.password);
    const base64data = buff.toString('base64');

    this.baseHeader['Authorization'] = 'Basic ' + base64data;
    this.subscribeStates('*');

    // Always use new Connected Vehicle API (old VOC API is dead)
    await this.newLogin();
    if (this.session.access_token) {
      await this.getDeviceList();
      await this.updateDevice();
      this.updateInterval = setInterval(async () => {
        await this.updateDevice();
      }, this.config.interval * 60 * 1000);
      // Refresh token 5 minutes before expiry
      const refreshMs = Math.max(60, (this.session.expires_in || 1799) - 300) * 1000;
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, refreshMs);
    }
    // in this template all states changes inside the adapters namespace are subscribed
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
        this.session = res.data;
        await this._persistTokens();
        this.setState('info.connection', true, true);
        return;
      } catch (error) {
        this.log.warn('Stored refresh token expired or invalid, need fresh OTP login');
      }
    }

    // Full OTP login flow
    if (!this.config.otp) {
      this.log.warn('No OTP code provided. Please use the adapter admin UI to start login and enter the OTP code sent to your email.');
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
   * Handle messages from admin UI (OTP login flow).
   */
  async onMessage(obj) {
    if (!obj || !obj.command) return;

    if (obj.command === 'startLogin') {
      // Phase 1: Start auth flow and submit credentials, trigger OTP email
      try {
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
            username: obj.message.user,
            password: obj.message.password,
          }, true);

          if (credData.status === 'OTP_REQUIRED') {
            const target = credData.devices && credData.devices[0] ? credData.devices[0].target : 'your email';
            this.sendTo(obj.from, obj.command, { success: true, message: 'OTP sent to ' + target }, obj.callback);
          } else {
            this.sendTo(obj.from, obj.command, { success: false, message: 'Unexpected status: ' + credData.status }, obj.callback);
          }
        } else {
          this.sendTo(obj.from, obj.command, { success: false, message: 'Unexpected status: ' + initData.status }, obj.callback);
        }
      } catch (error) {
        this.sendTo(obj.from, obj.command, { success: false, message: error.message }, obj.callback);
      }
    } else if (obj.command === 'submitOtp') {
      // Phase 2: Submit OTP, get tokens
      try {
        if (!this.authFlowId) {
          this.sendTo(obj.from, obj.command, { success: false, message: 'No active login flow. Start login first.' }, obj.callback);
          return;
        }

        const flowBase = 'https://volvoid.eu.volvocars.com/pf-ws/authn/flows/' + this.authFlowId;

        // Submit OTP
        const otpData = await this._authRequest('post', flowBase + '?action=checkOtp', {
          otp: obj.message.otp,
        }, true);

        if (otpData.status !== 'OTP_VERIFIED') {
          this.sendTo(obj.from, obj.command, { success: false, message: 'OTP invalid: ' + otpData.status }, obj.callback);
          return;
        }

        // Continue authentication
        const contData = await this._authRequest('post', flowBase + '?action=continueAuthentication', null, false);

        if (contData.status !== 'COMPLETED') {
          this.sendTo(obj.from, obj.command, { success: false, message: 'Auth not completed: ' + contData.status }, obj.callback);
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

        this.sendTo(obj.from, obj.command, { success: true, message: 'Login successful! Adapter is now connected.' }, obj.callback);
      } catch (error) {
        this.sendTo(obj.from, obj.command, { success: false, message: error.message }, obj.callback);
      }
    }
  }

  async getDeviceList() {
    await this.requestClient({
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

          const remoteArray = [{ command: 'refresh', name: 'Refresh all data' }];
          await this.requestClient({
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
          // await this.requestClient({
          //   method: 'get',
          //   url: 'https://api.volvocars.com/extended-vehicle/v1/vehicles/' + id + '/resources',
          //   headers: {
          //     accept: 'application/json',
          //     'vcc-api-key': this.config.vccapikey,
          //     Authorization: 'Bearer ' + this.session.access_token,
          //   },
          // })
          //   .then(async (res) => {
          //     this.log.debug(JSON.stringify(res.data));
          //   })
          //   .catch((error) => {
          //     this.log.error('get resources failed');
          //     this.log.error(error);
          //     error.response && this.log.error(JSON.stringify(error.response.data));
          //   });
        }
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error('get device list failed');
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async updateDevice() {
    for (const vin of this.vinArray) {
      const endpoints = [
        // 'environment',
        'engine',
        'windows',
        'diagnostics',
        'brakes',
        'doors',
        'engine-status',
        'fuel',
        // "battery-charge-level",
        'odometer',
        'statistics',
        'tyres',
        'warnings',
      ];
      for (const endpoint of endpoints) {
        await this.requestClient({
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
      await this.requestClient({
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
      await this.requestClient({
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
          this.log.error("failed to get energy state");
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }
  async refreshToken() {
    if (!this.session.refresh_token) {
      this.log.error('No refresh token available');
      this.setState('info.connection', false, true);
      return;
    }
    await this.requestClient({
      method: 'post',
      url: TOKEN_URL,
      headers: {
        Authorization: AUTH_BASIC,
        'X-XSRF-Header': 'PingFederate',
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: qs.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.session.refresh_token,
      }),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info('Token refresh successful');
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

  login() {
    return new Promise((resolve, reject) => {
      this.baseHeader['X-Request-Id'] = uuidv4();
      request.get(
        {
          url: 'https://vocapi.wirelesscar.net/customerapi/rest/customeraccounts',
          headers: this.baseHeader,
          followAllRedirects: true,
        },
        (err, resp, body) => {
          if (err || resp.statusCode >= 400 || !body) {
            this.log.error(err);
            reject();
            return;
          }
          this.log.debug(body);

          try {
            const customer = JSON.parse(body);
            if (!customer.accountVehicleRelations) {
              this.log.error('No vehicles found');
              this.log.error(body);
              reject();
              return;
            }
            customer.accountVehicleRelations.forEach((vehicle) => {
              this.vinArray.push(vehicle.vehicle.vehicleId);
              this.setObjectNotExists(vehicle.vehicle.vehicleId, {
                type: 'device',
                common: {
                  name: vehicle.vehicle.registrationNumber,
                  role: 'indicator',
                  type: 'mixed',
                  write: false,
                  read: true,
                },
                native: {},
              });
              this.extendObjectAsync(vehicle.vehicle.vehicleId + '.remote', {
                type: 'channel',
                common: {
                  name: 'Remote controls',
                },
                native: {},
              });

              const remotes = [
                'lock',
                'unlock',
                'heater/start',
                'heater/stop',
                'preclimatization/start',
                'preclimatization/stop',
                'parkingclimate/start',
                'parkingclimate/stop',
                'precleaning/start',
                'precleaning/stop',
                'engine/start',
                'engine/stop',
                'honk_and_flash',
                'honk_blink/both',
                'honk_blink/horn',
                'honk_blink/lights',
              ];
              remotes.forEach((service) => {
                this.setObjectNotExists(vehicle.vehicle.vehicleId + '.remote.' + service, {
                  type: 'state',
                  common: {
                    name: '',
                    type: 'boolean',
                    role: 'button',
                    write: true,
                    read: false,
                  },
                  native: {},
                });
              });
            });
            this.extractKeys(this, 'customer', customer, null, true);
            resolve();
          } catch (error) {
            this.log.error(error);
            this.log.error(error.stack);
            reject();
          }
        },
      );
    });
  }

  getMethod(vin, url, accept, path) {
    return new Promise((resolve, reject) => {
      this.log.debug('Get ' + path);
      this.baseHeader['X-Request-Id'] = uuidv4();
      this.baseHeader['Accept'] = 'application/vnd.wirelesscar.com.voc.$format.v4+json; charset=utf-8'.replace('$format', accept);
      url = url.replace('/$vin/', '/' + vin + '/');

      request.get(
        {
          url: url,
          headers: this.baseHeader,
          followAllRedirects: true,
        },
        (err, resp, body) => {
          if (err || resp.statusCode >= 400 || !body) {
            this.log.error(err);
            this.log.error(resp && resp.statusCode);
            this.log.error(body);
            reject();
            return;
          }
          this.log.debug(body);

          try {
            const customer = JSON.parse(body);
            if (path === 'trip') {
              this.extractKeys(this, vin + '.' + path, customer, null, true);
            } else {
              this.extractKeys(this, vin + '.' + path, customer);
            }
            resolve();
            return;
          } catch (error) {
            this.log.error(error);
            this.log.error(error.stack);
            reject();
          }
        },
      );
    });
  }
  async setMethod(vin, service, position) {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      this.baseHeader['X-Request-Id'] = uuidv4();
      this.baseHeader['Accept'] = 'application/vnd.wirelesscar.com.voc.Service.v4+json; charset=utf-8';
      this.baseHeader['Content-Type'] = 'application/json; charset=utf-8';
      let body = '{}';
      if (service === 'preclimatization/start') {
        this.baseHeader['Content-Type'] = 'application/vnd.wirelesscar.com.voc.RemotePreClimatization.v4+json; charset=utf-8';
      }
      if (position) {
        this.baseHeader['Content-Type'] = 'application/vnd.wirelesscar.com.voc.ClientPosition.v4+json; charset=utf-8';
        const latState = await this.getStateAsync(vin + '.position.position.latitude');
        const longState = await this.getStateAsync(vin + '.position.position.longitude');
        if (latState && longState) {
          body = '{"clientAccuracy":0,"clientLatitude":' + latState.val + ',"clientLongitude":' + longState.val + '}';
        }
      }
      const url = 'https://vocapi.wirelesscar.net/customerapi/rest/vehicles/' + vin + '/' + service;

      request.post(
        {
          url: url,
          headers: this.baseHeader,
          followAllRedirects: true,
          body: body,
          gzip: true,
        },
        (err, resp, body) => {
          if (err || (resp && resp.statusCode >= 400)) {
            this.log.error('Failed to setMethod ');
            err && this.log.error(err);
            resp && this.log.error(resp.statusCode);
            body && this.log.error(JSON.stringify(body));
            reject();
            return;
          }
          this.log.debug(body);

          try {
            this.log.info(body);
            resolve();
          } catch (error) {
            this.log.error(error);
            this.log.error(error.stack);
            reject();
          }
        },
      );
    });
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
      this.responseTimeout && clearTimeout(this.responseTimeout);
      callback();
    } catch (e) {
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
        const response = await this.requestClient({
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
          this.responseTimeout = setTimeout(async () => {
            await this.requestClient({
              method: 'get',
              url: asyncData.href,
              headers: {
                'content-type': 'application/json',
                'vcc-api-key': this.config.vccapikey,
                Authorization: 'Bearer ' + this.session.access_token,
              },
            })
              .then(async (res) => {
                this.log.info('Command ' + command + ' async result: ' + JSON.stringify(res.data));
              })
              .catch((error) => {
                this.log.error('Command ' + command + ' async check failed: ' + error);
                error.response && this.log.error(JSON.stringify(error.response.data));
              });
          }, 10000);
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
