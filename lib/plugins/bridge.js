'use strict';

var engine = require('share2nightscout-bridge');

// Track the most recently seen record
var mostRecentRecord;
const winston = require('winston');
const { LoggingWinston } = require('@google-cloud/logging-winston');

const loggingWinston = new LoggingWinston();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'user-service' },
  transports: [
    //
    // - Write all logs with importance level of `error` or less to `error.log`
    // - Write all logs with importance level of `info` or less to `combined.log`
    //
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    loggingWinston,
  ],
});

function init(env, bus, ctx) {
  if (env.extendedSettings.bridge && env.extendedSettings.bridge.userName && env.extendedSettings.bridge.password) {
    return create(env, bus, ctx);
  } else {
    console.info('Dexcom bridge not enabled');
  }
}

function bridged(entries, ctx) {
  function payload(err, glucose) {
    if (err) {
      console.error('Bridge error: ', err);
    } else {
      if (glucose) {
        for (var i = 0; i < glucose.length; i++) {
          if (glucose[i].date > mostRecentRecord) {
            mostRecentRecord = glucose[i].date;
          }
        }
        //console.log("DEXCOM: Most recent entry received; "+new Date(mostRecentRecord).toString());
      }
      entries.create(glucose, function stored(err) {
        if (err) {
          console.error('Bridge storage error: ', err);
        }
      });

      logger.info(`Loop process: ${Object.keys(ctx.data)}`)
      logger.info(`Loop keys: ${Object.keys(ctx.loop)}`);
      logger.info(`Loop data: ${JSON.stringify(ctx.loop)}`);
      logger.info(`Device keys: ${Object.keys(ctx.devicestatus)}`);
      logger.info(`Device data: ${JSON.stringify(ctx.devicestatus)}`);
      if ('sbx' in ctx) {
        logger.info(`Sbx keys: ${Object.keys(ctx.sbx)}`);
        logger.info(`Sbx data: ${JSON.stringify(ctx.sbx)}`);
        logger.info(`Properties keys: ${Object.keys(ctx.sbx.properties.loop)}`);
        logger.info(`Properties data: ${JSON.stringify(ctx.sbx.properties.loop.lastPredicted.values)}`);
        logger.info(`Data keys: ${Object.keys(ctx.sbx.data.devicestatus)}`);
        logger.info(`Data data: ${JSON.stringify(ctx.sbx.data.devicestatus.slice(-1))}`);
        // const lastPredicted = ctx.sbx.properties.loop.lastPredicted;
        // const lastPredictedTime = lastPredicted.time;
        // const currentTime = new Date();
        // const timeDiff = Math.abs(currentTime - lastPredictedTime);
        // logger.info(`Time diff: ${timeDiff}`);
        // if (timeDiff < 360000) {
        //   for (var i = 0; i < 24; i++) {
        //     if (lastPredicted.values[i] >= 130) {
        //       logger.info('Turn light yellow');
        //     }
        //   }
        // }
        entries.list({ count: 3 }, function (err, records) {
          if (err) {
            return;
          }
          if (records) {
            if (records[0].sgv < 70) {
              logger.info('Turn light red');
            } else if (records[0].sgv > 130) {
              logger.info('Turn light yellow');
            } else if (records[0].sgv > 200) {
              logger.info('Flash light red');
            } else if (records[0].sgv > 120 && records[1].sgv > 120 && records[2].sgv > 120) {
              logger.info('Turn light yellow');

            } else {
              logger.info('Turn light green');
            }
            logger.info(`Records: ${JSON.stringify(records)}`);
          }
          console.log("govee process", records);

        });
      }

    }
  }
  return payload;
}

function options(env) {
  var config = {
    accountName: env.extendedSettings.bridge.userName
    , password: env.extendedSettings.bridge.password
  };

  var fetch_config = {
    maxCount: env.extendedSettings.bridge.maxCount || 1
    , minutes: env.extendedSettings.bridge.minutes || 1440
  };

  var interval = env.extendedSettings.bridge.interval || 60000 * 2.6; // Default: 2.6 minutes

  if (interval < 1000 || interval > 300000) {
    // Invalid interval range. Revert to default
    console.error("Invalid interval set: [" + interval + "ms]. Defaulting to 2.6 minutes.")
    interval = 60000 * 2.6 // 2.6 minutes
  }

  return {
    login: config
    , interval: interval
    , fetch: fetch_config
    , nightscout: {}
    , maxFailures: env.extendedSettings.bridge.maxFailures || 3
    , firstFetchCount: env.extendedSettings.bridge.firstFetchCount || 3
  };
}

function create(env, bus, ctx) {

  var bridge = {};

  var opts = options(env);
  var interval = opts.interval;

  mostRecentRecord = new Date().getTime() - opts.fetch.minutes * 60000;

  bridge.startEngine = function startEngine(entries) {


    opts.callback = bridged(entries, ctx);

    let last_run = new Date(0).getTime();
    let last_ondemand = new Date(0).getTime();

    function should_run() {
      // Time we expect to have to collect again
      const msRUN_AFTER = (300 + 20) * 1000;
      const msNow = new Date().getTime();

      const next_entry_expected = mostRecentRecord + msRUN_AFTER;

      if (next_entry_expected > msNow) {
        // we're not due to collect a new slot yet. Use interval
        const ms_since_last_run = msNow - last_run;
        if (ms_since_last_run < interval) {
          return false;
        }

        last_run = msNow;
        last_ondemand = new Date(0).getTime();
        console.log("DEXCOM: Running poll");
        return true;
      }

      const ms_since_last_run = msNow - last_ondemand;

      if (ms_since_last_run < interval) {
        return false;
      }
      last_run = msNow;
      last_ondemand = msNow;
      console.log("DEXCOM: Data due, running extra poll");
      return true;
    }

    let timer = setInterval(function () {
      if (!should_run()) return;


      opts.fetch.minutes = parseInt((new Date() - mostRecentRecord) / 60000);
      opts.fetch.maxCount = parseInt((opts.fetch.minutes / 5) + 1);
      opts.firstFetchCount = opts.fetch.maxCount;
      console.log("Fetching Share Data: ", 'minutes', opts.fetch.minutes, 'maxCount', opts.fetch.maxCount);
      engine(opts);
    }, 1000 /*interval*/);

    if (bus) {
      bus.on('teardown', function serverTeardown() {
        clearInterval(timer);
      });
    }
  };

  return bridge;
}

init.create = create;
init.bridged = bridged;
init.options = options;
exports = module.exports = init;
