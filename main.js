"use strict";

/*
 * Created with @iobroker/create-adapter v1.20.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const uuidv4 = require("uuid/v4");
const request = require("request");
const traverse = require("traverse");
// Load your modules here, e.g.:
// const fs = require("fs");

class Volvo extends utils.Adapter {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "volvo"
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));

        this.updateInterval = null;
        this.vinArray = [];
        this.baseHeader = {
            Accept: "application/vnd.wirelesscar.com.voc.AppUser.v4+json; charset=utf-8",
            "X-Client-Version": "4.6.10.275495",
            "X-App-Name": "Volvo On Call",
            "Accept-Language": "de-de",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "Volvo%20On%20Call/4.6.10.275495 CFNetwork/1121.2.2 Darwin/19.3.0",
            "X-Os-Type": "iPhone OS",
            "X-Device-Id": uuidv4(),
            "X-Os-Version": "13.3.1",
            "X-Originator-Type": "app",
            "X-Request-Id": "",
            Authorization: ""
        };
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        const buff = new Buffer(this.config.user + ":" + this.config.password);
        const base64data = buff.toString("base64");
        this.baseHeader["Authorization"] = base64data;
        this.login().then(() => {
            this.log.debug("Login successful");
            this.setState("info.connection", true, true);

            this.vinArray.forEach(vin => {
                this.getVehicleAttribute(vin).then(() => {
                    this.getVehicleStatus(vin).then(() => {});
                });
                this.updateInterval = setInterval(() => {
                    this.vinArray.forEach(vin => {
                        this.getVehicleStatus(vin).then(() => {});
                    });
                }, this.config.interval * 60 * 1000);
            });
        });

        // in this template all states changes inside the adapters namespace are subscribed
        this.subscribeStates("*");
    }

    login() {
        return new Promise((resolve, reject) => {
            this.baseHeader["X-Request-Id"] = uuidv4();
            request.get(
                {
                    url: "https://vocapi.wirelesscar.net/customerapi/rest/customeraccounts",
                    headers: this.baseHeader,
                    followAllRedirects: true
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
                            this.log.error("No vehicles found");
                            this.log.error(body);
                            reject();
                            return;
                        }
                        customer.accountVehicleRelations.forEach(vehicle => {
                            this.vinArray.push(vehicle.vehicle.vehicleId);
                        });
                        const adapter = this;
                        traverse(customer).forEach(function(value) {
                            if (this.path.length > 0 && this.isLeaf) {
                                const modPath = this.path;
                                this.path.forEach((pathElement, pathIndex) => {
                                    if (!isNaN(parseInt(pathElement))) {
                                        let stringPathIndex = parseInt(pathElement) + 1 + "";
                                        while (stringPathIndex.length < 2) stringPathIndex = "0" + stringPathIndex;
                                        const key = this.path[pathIndex - 1] + stringPathIndex;
                                        const parentIndex = modPath.indexOf(pathElement) - 1;
                                        //if (this.key === pathElement) {
                                        modPath[parentIndex] = key;
                                        //}
                                        modPath.splice(parentIndex + 1, 1);
                                    }
                                });
                                adapter.setObjectNotExists("customer." + modPath.join("."), {
                                    type: "state",
                                    common: {
                                        name: this.key,
                                        role: "indicator",
                                        type: "mixed",
                                        write: false,
                                        read: true
                                    },
                                    native: {}
                                });
                                adapter.setState("customer." + modPath.join("."), value, true);
                            }
                        });
                        resolve();
                    } catch (error) {
                        this.log.error(error);
                        this.log.error(error.stack);
                        reject();
                    }
                }
            );
        });
    }
    getVehicleAttribute(vin) {
        return new Promise((resolve, reject) => {
            this.baseHeader["X-Request-Id"] = uuidv4();
            request.get(
                {
                    url: "https://vocapi.wirelesscar.net/customerapi/rest/vehicles/" + vin + "/attributes",
                    headers: this.baseHeader,
                    followAllRedirects: true
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

                        const adapter = this;
                        traverse(customer).forEach(function(value) {
                            if (this.path.length > 0 && this.isLeaf) {
                                const modPath = this.path;
                                this.path.forEach((pathElement, pathIndex) => {
                                    if (!isNaN(parseInt(pathElement))) {
                                        let stringPathIndex = parseInt(pathElement) + 1 + "";
                                        while (stringPathIndex.length < 2) stringPathIndex = "0" + stringPathIndex;
                                        const key = this.path[pathIndex - 1] + stringPathIndex;
                                        const parentIndex = modPath.indexOf(pathElement) - 1;
                                        //if (this.key === pathElement) {
                                        modPath[parentIndex] = key;
                                        //}
                                        modPath.splice(parentIndex + 1, 1);
                                    }
                                });
                                adapter.setObjectNotExists(vin + ".attributes." + modPath.join("."), {
                                    type: "state",
                                    common: {
                                        name: this.key,
                                        role: "indicator",
                                        type: "mixed",
                                        write: false,
                                        read: true
                                    },
                                    native: {}
                                });
                                adapter.setState(vin + ".attributes." + modPath.join("."), value, true);
                            }
                        });
                        resolve();
                    } catch (error) {
                        this.log.error(error);
                        this.log.error(error.stack);
                        reject();
                    }
                }
            );
        });
    }
    getVehicleStatus(vin, url, path) {
        return new Promise((resolve, reject) => {
            this.baseHeader["X-Request-Id"] = uuidv4();
            request.get(
                {
                    url: "https://vocapi.wirelesscar.net/customerapi/rest/vehicles/" + vin + "/status",
                    headers: this.baseHeader,
                    followAllRedirects: true
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

                        const adapter = this;
                        traverse(customer).forEach(function(value) {
                            if (this.path.length > 0 && this.isLeaf) {
                                const modPath = this.path;
                                this.path.forEach((pathElement, pathIndex) => {
                                    if (!isNaN(parseInt(pathElement))) {
                                        let stringPathIndex = parseInt(pathElement) + 1 + "";
                                        while (stringPathIndex.length < 2) stringPathIndex = "0" + stringPathIndex;
                                        const key = this.path[pathIndex - 1] + stringPathIndex;
                                        const parentIndex = modPath.indexOf(pathElement) - 1;
                                        //if (this.key === pathElement) {
                                        modPath[parentIndex] = key;
                                        //}
                                        modPath.splice(parentIndex + 1, 1);
                                    }
                                });
                                adapter.setObjectNotExists(vin + ".status." + modPath.join("."), {
                                    type: "state",
                                    common: {
                                        name: this.key,
                                        role: "indicator",
                                        type: "mixed",
                                        write: false,
                                        read: true
                                    },
                                    native: {}
                                });
                                adapter.setState(vin + ".status." + modPath.join("."), value, true);
                            }
                        });
                        resolve();
                    } catch (error) {
                        this.log.error(error);
                        this.log.error(error.stack);
                        reject();
                    }
                }
            );
        });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info("cleaned everything up...");
            clearInterval(this.updateInterval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = options => new Volvo(options);
} else {
    // otherwise start the instance directly
    new Volvo();
}
