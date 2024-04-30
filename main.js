'use strict';

/*
 * Created with @iobroker/create-adapter v1.20.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const { v4: uuidv4 } = require('uuid');
const request = require('request');
const axios = require('axios').default;
const qs = require('qs');
const Json2iob = require('json2iob');
const { extractKeys } = require('./lib/extractKeys');
// Load your modules here, e.g.:
// const fs = require("fs");

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

    this.json2iob = new Json2iob(this);
    this.session = {};
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
    // Initialize your adapter here
    const obj = await this.getForeignObjectAsync('system.config');
    if (obj && obj.native && obj.native.secret) {
      this.config.password = this.decrypt(obj.native.secret, this.config.password);
    } else {
      this.config.password = this.decrypt('Zgfr56gFe87jJOM', this.config.password);
    }
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    const buff = new Buffer(this.config.user + ':' + this.config.password);
    const base64data = buff.toString('base64');

    this.baseHeader['Authorization'] = 'Basic ' + base64data;
    this.subscribeStates('*');
    if (this.config.newApi) {
      await this.newLogin();
      if (this.session.access_token) {
        await this.getDeviceList();
        await this.updateDevice();
        this.updateInterval = setInterval(async () => {
          await this.updateDevice();
        }, this.config.interval * 60 * 1000);
      }
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, (this.session.expires_in || 1799) * 1000);
    } else {
      //old volvo api
      this.login()
        .then(() => {
          this.log.debug('Login successful');
          this.setState('info.connection', true, true);

          this.vinArray.forEach((vin) => {
            this.getMethod(
              vin,
              'https://vocapi.wirelesscar.net/customerapi/rest/vehicles/$vin/attributes',
              'VehicleAttributes',
              'attributes',
            )
              .then(() => {})
              .catch(() => {});
            this.getMethod(vin, 'https://vocapi.wirelesscar.net/customerapi/rest/vehicles/$vin/status', 'VehicleStatus', 'status')
              .then(() => {})
              .catch(() => {});
            this.getMethod(vin, 'https://vocapi.wirelesscar.net/customerapi/rest/vehicles/$vin/trips?quantity=10', 'Trip', 'trip')
              .then(() => {})
              .catch(() => {});
            this.getMethod(
              vin,
              'https://vocapi.wirelesscar.net/customerapi/rest/vehicles/$vin/position?client_longitude=0.000000&client_precision=0.000000&client_latitude=0.000000 ',
              'Position',
              'position',
            )
              .then(() => {})
              .catch(() => {});

            this.updateInterval = setInterval(() => {
              this.vinArray.forEach((vin) => {
                this.getMethod(vin, 'https://vocapi.wirelesscar.net/customerapi/rest/vehicles/$vin/status', 'VehicleStatus', 'status')
                  .then(() => {})
                  .catch(() => {});
                this.getMethod(vin, 'https://vocapi.wirelesscar.net/customerapi/rest/vehicles/$vin/trips?quantity=10', 'Trip', 'trip')
                  .then(() => {})
                  .catch(() => {});
                this.getMethod(
                  vin,
                  'https://vocapi.wirelesscar.net/customerapi/rest/vehicles/$vin/position?client_longitude=0.000000&client_precision=0.000000&client_latitude=0.000000 ',
                  'Position',
                  'position',
                )
                  .then(() => {})
                  .catch(() => {});
              });
            }, this.config.interval * 60 * 1000);
          });
        })
        .catch(() => {
          this.log.error('Login failed');
        });
    }
    // in this template all states changes inside the adapters namespace are subscribed
  }
  async newLogin() {
    await this.requestClient({
      method: 'post',
      url: 'https://volvoid.eu.volvocars.com/as/token.oauth2',
      headers: {
        authorization: 'Basic aDRZZjBiOlU4WWtTYlZsNnh3c2c1WVFxWmZyZ1ZtSWFEcGhPc3kxUENhVXNpY1F0bzNUUjVrd2FKc2U0QVpkZ2ZJZmNMeXc=',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'okhttp/4.10.0',
      },
      data: qs.stringify({
        username: this.config.user,
        password: this.config.password,
        access_token_manager_id: 'JWTh4Yf0b',
        grant_type: 'password',
        scope:
          'openid email profile care_by_volvo:financial_information:invoice:read care_by_volvo:financial_information:payment_method care_by_volvo:subscription:read customer:attributes customer:attributes:write order:attributes vehicle:attributes tsp_customer_api:all conve:brake_status conve:climatization_start_stop conve:command_accessibility conve:commands conve:diagnostics_engine_status conve:diagnostics_workshop conve:doors_status conve:engine_status conve:environment conve:fuel_status conve:honk_flash conve:lock conve:lock_status conve:navigation conve:odometer_status conve:trip_statistics conve:tyre_status conve:unlock conve:vehicle_relation conve:warnings conve:windows_status energy:battery_charge_level energy:charging_connection_status energy:charging_system_status energy:electric_range energy:estimated_charging_time energy:recharge_status vehicle:attributes',
      }),
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info('Login successful');
        this.session = res.data;
        this.setState('info.connection', true, true);
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error('Login failed');
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async getDeviceList() {
    await this.requestClient({
      method: 'get',
      url: 'https://api.volvocars.com/extended-vehicle/v1/vehicles',
      headers: {
        accept: 'application/json',
        'vcc-api-key': this.config.vccapikey,
        Authorization: 'Bearer ' + this.session.access_token,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info(`Found ${res.data.vehicles.length} vehicles`);
        for (const device of res.data.vehicles) {
          this.log.info(JSON.stringify(device));
          const id = device.id;
          this.vinArray.push(device.id);
          const name = device.deviceName;

          await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
              name: id + name,
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

          const remoteArray = [{ command: 'Refresh', name: 'True = Refresh' }];
          await this.requestClient({
            method: 'get',
            url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles/' + id + '/commands',
            headers: {
              accept: 'application/vnd.volvocars.api.connected-vehicle.commandlist.v1+json',
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
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            });
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'boolean',
                def: remote.def || false,
                write: true,
                read: true,
              },
              native: {},
            });
          });
          this.json2iob.parse(id, device, { forceIndex: true });
          await this.requestClient({
            method: 'get',
            url: 'https://api.volvocars.com/extended-vehicle/v1/vehicles/' + id + '/resources',
            headers: {
              accept: 'application/json',
              'vcc-api-key': this.config.vccapikey,
              Authorization: 'Bearer ' + this.session.access_token,
            },
          })
            .then(async (res) => {
              this.log.debug(JSON.stringify(res.data));
            })
            .catch((error) => {
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            });
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
        'environment',
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
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });

      //added for including location position
      await this.requestClient({
        method: 'get',
        url: 'https://api.volvocars.com/energy/v1/vehicles/' + vin + '/recharge-status',
        headers: {
          accept: 'application/vnd.volvocars.api.energy.vehicledata.v1+json',
          'vcc-api-key': this.config.vccapikey,
          Authorization: 'Bearer ' + this.session.access_token,
        },
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          this.json2iob.parse(vin + '.status', res.data.data, { forceIndex: true });
        })
        .catch((error) => {
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }
  async refreshToken() {
    await this.requestClient({
      method: 'post',
      url: 'https://volvoid.eu.volvocars.com/as/token.oauth2',
      headers: {
        authorization: 'Basic aDRZZjBiOlU4WWtTYlZsNnh3c2c1WVFxWmZyZ1ZtSWFEcGhPc3kxUENhVXNpY1F0bzNUUjVrd2FKc2U0QVpkZ2ZJZmNMeXc=',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'okhttp/4.10.0',
      },
      data: qs.stringify({
        access_token_manager_id: 'JWTh4Yf0b',
        grant_type: 'refresh_token',
        refresh_token: this.session.refresh_token,
      }),
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info('Login successful');
        this.session = res.data;
        this.setState('info.connection', true, true);
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error('Login failed');
        error.response && this.log.error(JSON.stringify(error.response.data));
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
        let body = '';
        if (this.config.newApi) {
          body = null;
          if (command === 'unlock') {
            body = {
              unlockDuration: 0,
            };
          }
          const response = await this.requestClient({
            method: 'post',
            url: 'https://api.volvocars.com/connected-vehicle/v2/vehicles/' + vin + '/commands/' + command,
            headers: {
              'content-type': 'application/vnd.volvocars.api.connected-vehicle.' + command.replace('-', '') + '.v1+json',
              'vcc-api-key': this.config.vccapikey,
              Authorization: 'Bearer ' + this.session.access_token,
            },
            data: body,
          })
            .then(async (res) => {
              this.log.info(JSON.stringify(res.data));
              return res.data;
            })
            .catch((error) => {
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            });
          this.responseTimeout = setTimeout(async () => {
            await this.requestClient({
              method: 'get',
              url: response.async.href,
              headers: {
                'content-type': 'application/vnd.volvocars.api.connected-vehicle.requestdetailresponse.v1+json',
                'vcc-api-key': this.config.vccapikey,
                Authorization: 'Bearer ' + this.session.access_token,
              },
            })
              .then(async (res) => {
                this.log.info(JSON.stringify(res.data));
              })
              .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
              });
          }, 10000);
        } else {
          if (id.indexOf('remote') !== -1) {
            const action = id.split('.')[4];
            this.setMethod(vin, action, action.indexOf('honk') !== -1).catch(() => {
              this.log.error('failed set method');
            });
          }
        }
      }
    } else {
      // The state was deleted
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
