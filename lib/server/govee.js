'use strict';

var _ = require('lodash');
var THIRTY_MINUTES = 30 * 60 * 1000;
var DEFAULT_GROUPS = ['default'];
const axios = require('axios');


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

//
// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
//
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}



var Alarm = function (level, group, label) {
  this.level = level;
  this.group = group;
  this.label = label;
  this.silenceTime = THIRTY_MINUTES;
  this.lastAckTime = 0;
};

// list of alarms with their thresholds
var alarms = {};
var api_key = 'a9e51c2e-4ff9-4bd3-9d99-1a970c43198b'
var govee_headers = { 'Govee-API-Key': api_key }

function init(env, ctx) {

  function govee() {
    return govee;
  }

  govee.process = function process(sbx) {
    logger.info(`Sbx: ${JSON.stringify(sbx)}`);
    ctx.entries.list({ count: 5 }, function (err, records) {
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
        } else {
          if (records[0].sgv > 120 && records[1].sgv > 120 && records[2].sgv > 120) {
            logger.info('Turn light yellow');
          }
        }
        logger.info(`Records: ${JSON.stringify(records)}`);
      }
      console.log("govee process", records);

    });

    const data = {
      "device": "F3:AF:C1:9A:3E:D5:7B:65",
      "model": "H6057",
      "cmd": {
        "name": "turn",
        "value": "on"
      }
    }

    const postData = JSON.stringify(data);
    const options = {
      url: 'https://developer-api.govee.com/v1/devices/control', // Replace with the target hostname
      method: 'PUT',              // HTTP method (GET, POST, PUT, DELETE, etc.)
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Govee-API-Key': api_key,
      },
      data: postData,
    };

    axios(options)
      .then((response) => {
        console.log('Response:', response.data);
      })
      .catch((error) => {
        console.error('Error:', error);
      });


    var notifyGroups = _.map(requests.notifies, function eachNotify(notify) {
      return notify.group;
    });

    var alarmGroups = _.map(_.values(alarms), function eachAlarm(alarm) {
      return alarm.group;
    });

    var groups = _.uniq(notifyGroups.concat(alarmGroups));

    if (_.isEmpty(groups)) {
      groups = DEFAULT_GROUPS.slice();
    }

    _.each(groups, function eachGroup(group) {
      var highestAlarm = govee.findHighestAlarm(group);

      if (highestAlarm) {
        var snoozedBy = govee.snoozedBy(highestAlarm, group);
        if (snoozedBy) {
          logSnoozingEvent(highestAlarm, snoozedBy);
          govee.ack(snoozedBy.level, group, snoozedBy.lengthMills, true);
        } else {
          emitNotification(highestAlarm);
        }
      } else {
        autoAckAlarms(group);
      }
    });

    govee.findUnSnoozeable().forEach(function eachInfo(notify) {
      emitNotification(notify);
    });
  };
  return govee();
}

module.exports = init;
