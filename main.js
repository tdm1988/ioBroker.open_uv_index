"use strict";

/*
 * Created with @iobroker/create-adapter v2.1.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;

//** Constants */
const ERROR_MESSAGE_DAY_LIMIT_REACHED = "AxiosError: Request failed with status code 500";

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
// The adapter instance.
let adapter;
// The adapter stop timer.
let stopTimer;
// The system logitude to be used for Open UV index report.
let openUvLongitude;
// The system latitude to be used for Open UV index report.
let openUvLatitude;
// Flag to indicate error state.
let errorFlag = false;

/**
 * Starts the adapter instance
 * @param {Partial<utils.AdapterOptions>} [options]
 */
function startAdapter(options) {
	// Create the adapter and define its methods
	return adapter = utils.adapter(Object.assign({}, options, {
		name: "open_uv_index",

		// The ready callback is called when databases are connected and adapter received configuration.
		// start here!
		ready: main, // Main method defined below for readability

		// Is called when adapter shuts down - callback has to be called under any circumstances!
		unload: (callback) => {
			try {
				clearTimeout(stopTimer);
				callback();
			} catch (e) {
				callback();
			}
		},

		// Is called if a subscribed state changes
		stateChange: (id, state) => {
			if (state) {
				// The state was changed
				adapter.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
			} else {
				// The state was deleted
				adapter.log.info(`state ${id} deleted`);
			}
		},
	}
	));
}

/**
 * Reads Open UV api key from adapter configuration.
 */
async function readOpenUvApiKey()
{
	try
	{
		adapter.log.debug("Loading Open UV API key...");
		if (	(adapter.config.apiKey == null)
			||	(adapter.config.apiKey == undefined)
			||  (adapter.config.apiKey == "")) {
			throw new Error("Open UV API key is not configured! Please check the adapter configuration.");
		} else {
			adapter.log.debug("Open UV API key is <" + adapter.config.apiKey + ">.");
		}

	} catch (error) {
		adapter.log.error("FAILED! Reading Open UV API key failed with error <" + error + ">!");
		errorFlag = true;
	}
}

/**
 * Reads ioBroker configured system location.
 */
async function readSystemLocation() {
	try
	{
		const systemConfig = await adapter.getForeignObjectAsync("system.config", "state");
		if (systemConfig) {
			if (	(systemConfig.common.longitude == undefined)
				||	(systemConfig.common.longitude == null)
				||	(systemConfig.common.longitude == "")
				||	(systemConfig.common.latitude == undefined)
				||	(systemConfig.common.latitude == null)
				||	(systemConfig.common.latitude == "")
			) {
				throw new Error("System <longitude> and <latitude> are not defined! Please check your system configuration!");
			} else {
				adapter.log.debug("Loading system <longitude> and <latitude>...");
				openUvLongitude = parseFloat(systemConfig.common.longitude);
				openUvLatitude = parseFloat(systemConfig.common.latitude);
				adapter.log.debug("Loaded longitude is <" + openUvLongitude + ">.");
				adapter.log.debug("Loaded latitude is <" + openUvLatitude + ">.");
			}
		} else {
			throw new Error("Could not read ioBroker system configuration!");
		}
	} catch (error) {
		adapter.log.error("FAILED! Reading ioBroker system location failed with error <" + error + ">!");
		errorFlag = true;
	}
}

/**
 * Request actual UV index report from Open-UV site using corresponding API.
 * Extracts and stores needed report values in adapter variables.
 */
async function requestOpenUvIndex() {
	const openUVURL = "https://api.openuv.io/api/v1/uv";
	try
	{
		adapter.log.debug("Starting Open UV api request ...");

		const openUVRequest = await axios({
			method: "get",
			url: openUVURL,
			params: {
				lat: openUvLatitude,
				lng: openUvLongitude
			},
			headers: {
				"x-access-token": adapter.config.apiKey
			},
			responseType: "json"
		});

		if (openUVRequest.data && openUVRequest.data.result) {
			adapter.log.debug("OK. Open UV api request finished successfull.");
			adapter.log.debug("Open UV api response received <" + JSON.stringify(openUVRequest.data) + ">.");
			// Set adapter variables.
			await adapter.setStateAsync("actual_uv_index", Math.round(openUVRequest.data.result.uv * 100) / 100, true);
			await adapter.setStateAsync("max_uv_index", Math.round(openUVRequest.data.result.uv_max * 100) / 100, true);
			const uvMaxTime = openUVRequest.data.result.uv_max_time;
			adapter.log.debug("UV Max time in UTC is <" + uvMaxTime + ">.");
			const uvMaxLocalTime = new Date(uvMaxTime);
			await adapter.setStateAsync("max_uv_index_time", uvMaxLocalTime.toLocaleTimeString(), true);

			let stateObject = await adapter.getStateAsync("open_uv_index.0.actual_uv_index");
			if (stateObject) {
				adapter.log.debug("Adapter variable <actual_uv_index> is set to <" + stateObject.val + ">.");
			}

			stateObject = await adapter.getStateAsync("open_uv_index.0.max_uv_index");
			if (stateObject) {
				adapter.log.debug("Adapter variable <max_uv_index> is set to <" + stateObject.val + ">.");
			}

			stateObject = await adapter.getStateAsync("max_uv_index_time");
			if (stateObject) {
				adapter.log.debug("Adapter variable <max_uv_index_time> is set to <" + stateObject.val + ">.");
			}
		} else {
			throw new Error("Could not receive Open UV api response!");
		}
	} catch (error) {
		adapter.log.error("FAILED! Open UV api request failed with error <" + error + ">!");
		if (error.message.includes(ERROR_MESSAGE_DAY_LIMIT_REACHED)) {
			adapter.log.warn("This error can occur when the limit of <50> requests per day has been reached.");
			adapter.log.warn("Please check adapter <schedule> settings.");
		}
		errorFlag = true;
	}
}

/**
 * Sets UV strength level based on read actual UV index.
 */
async function setUvStrength() {
	try
	{
		const stateObject = await adapter.getStateAsync("open_uv_index.0.actual_uv_index");
		if (!stateObject) {
			throw new Error("Could not read <open_uv_index.0.actual_uv_index>!");
		}

		const uvIndex = stateObject.val;
		let uvStrength;

		if ((uvIndex != undefined) && (uvIndex != null)) {
			if (uvIndex < 3) {
				uvStrength = "Low";
			} else if ((3 <= uvIndex) && (uvIndex < 6)) {
				uvStrength = "Medium";
			} else if ((6 <= uvIndex) && (uvIndex < 8)) {
				uvStrength = "High";
			} else if ((8 <= uvIndex) && (uvIndex < 11)) {
				uvStrength = "Very High";
			} else if (11 <= uvIndex) {
				uvStrength = "Extreme";
			} else {
				throw new Error("Could not set <UV Strength> from UV index value <" + uvIndex + ">!");
			}
		} else {
			throw new Error("Invalid <uv_index> state <" + uvIndex + "> detected!");
		}
		await adapter.setStateAsync("uv_strength", uvStrength, true);
		adapter.log.debug("Adapter variable <uv_strength> is set to <" + uvStrength + ">.");
	} catch (error) {
		adapter.log.error("FAILED! Setting UV strength failed with error <" + error + ">!");
		errorFlag = true;
	}
}

/**
 * Sets UV warning flag if max UV value is higher or equal 6 mW/m.
 */
async function setUvWarning() {
	try
	{
		let uvWarning = false;
		const stateObject = await adapter.getStateAsync("open_uv_index.0.max_uv_index");
		if (!stateObject) {
			throw new Error("Could not read adapter property <open_uv_index.0.max_uv_index>!");
		}

		const uvIndexMax = stateObject.val;

		if ((uvIndexMax != undefined) && (uvIndexMax != null)) {
			if (uvIndexMax >= 6) {
				uvWarning = true;
			} else {
				uvWarning = false;
			}
		} else {
			throw new Error("Adapter property <open_uv_index.0.max_uv_index> is not assigned!");
		}

		await adapter.setStateAsync("uv_warning", uvWarning, true);
		adapter.log.debug("Adapter variable <uv_warning> is set to <" + uvWarning + ">.");
	} catch (error) {
		adapter.log.error("FAILED! Setting UV warning failed with error <" + error + ">!");
		errorFlag = true;
	}
}

/**
 * The adapter main entry function.
 */
async function main() {
	try
	{
		errorFlag = false;
		// @ts-ignore
		stopTimer = setTimeout(async () => adapter.stop(), 8000);

		const maxStepCount = 5;

		for (let stepCount = 0; stepCount < maxStepCount; stepCount++)
		{
			switch(stepCount)
			{
				case 0:
					adapter.log.info("Executing adapter main function...");
					// Check if API key is set.
					await readOpenUvApiKey();
					break;
				case 1:
					// Load system longitude and latitude.
					await readSystemLocation();
					break;
				case 2:
					// Call Open UV api.
					await requestOpenUvIndex();
					break;
				case 3:
					// Set UV strength.
					await setUvStrength();
					break;
				case 4:
					// Set UV warning flag.
					await setUvWarning();
					break;
			}
			if (errorFlag) {
				throw new Error("Error occured during adapter execution! Stopped adapter main function.");
			}
		}
	} catch (error) {
		adapter.log.error("Exception caught <" + error + ">!");
		return;
	}
	adapter.log.info("OK. adapter main function finished successfull.");
}

if (require.main !== module) {
	// Export startAdapter in compact mode
	module.exports = startAdapter;
} else {
	// otherwise start the instance directly
	startAdapter();
}
