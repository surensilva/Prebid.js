import {uniques, flatten, adUnitsFilter} from './utils';
import {getPriceBucketString} from './cpmBucketManager';
import {NATIVE_KEYS, nativeBidIsValid} from './native';

var CONSTANTS = require('./constants.json');
var AUCTION_END = CONSTANTS.EVENTS.AUCTION_END;
var utils = require('./utils.js');
var events = require('./events');

var objectType_function = 'function';

var externalCallbacks = {byAdUnit: [], all: [], oneTime: null, timer: false};
var _granularity = CONSTANTS.GRANULARITY_OPTIONS.MEDIUM;
let _customPriceBucket;
var defaultBidderSettingsMap = {};

exports.setCustomPriceBucket = function(customConfig) {
  _customPriceBucket = customConfig;
};

/**
 * Returns a list of bidders that we haven't received a response yet
 * @return {array} [description]
 */
exports.getTimedOutBidders = function () {
  return $$PREBID_GLOBAL$$._bidsRequested
    .map(getBidderCode)
    .filter(uniques)
    .filter(bidder => $$PREBID_GLOBAL$$._bidsReceived
      .map(getBidders)
      .filter(uniques)
      .indexOf(bidder) < 0);
};

function timestamp() { return new Date().getTime(); }

function getBidderCode(bidSet) {
  return bidSet.bidderCode;
}

function getBidders(bid) {
  return bid.bidder;
}

function bidsBackAdUnit(adUnitCode) {
  const requested = $$PREBID_GLOBAL$$._bidsRequested
    .map(request => request.bids
      .filter(adUnitsFilter.bind(this, $$PREBID_GLOBAL$$._adUnitCodes))
      .filter(bid => bid.placementCode === adUnitCode))
    .reduce(flatten, [])
    .map(bid => {
      return bid.bidder === 'indexExchange' ?
          bid.sizes.length :
          1;
    }).reduce(add, 0);

  const received = $$PREBID_GLOBAL$$._bidsReceived.filter(bid => bid.adUnitCode === adUnitCode).length;
  return requested === received;
}

function add(a, b) {
  return a + b;
}

function bidsBackAll() {
  const requested = $$PREBID_GLOBAL$$._bidsRequested
    .map(request => request.bids)
    .reduce(flatten, [])
    .filter(adUnitsFilter.bind(this, $$PREBID_GLOBAL$$._adUnitCodes))
    .map(bid => {
      return bid.bidder === 'indexExchange' ?
        bid.sizes.length :
        1;
    }).reduce((a, b) => a + b, 0);

  const received = $$PREBID_GLOBAL$$._bidsReceived
    .filter(adUnitsFilter.bind(this, $$PREBID_GLOBAL$$._adUnitCodes)).length;

  return requested === received;
}

exports.bidsBackAll = function () {
  return bidsBackAll();
};

function getBidderRequest(bidder, adUnitCode) {
  return $$PREBID_GLOBAL$$._bidsRequested.find(request => {
    return request.bids
        .filter(bid => bid.bidder === bidder && bid.placementCode === adUnitCode).length > 0;
  }) || { start: null, requestId: null };
}

/*
 *   This function should be called to by the bidder adapter to register a bid response
 */
exports.addBidResponse = function (adUnitCode, bid) {
  if (!adUnitCode) {
    utils.logWarn('No adUnitCode supplied to addBidResponse, response discarded');
    return;
  }

  if (bid) {

    if (bid.mediaType === 'native' && !nativeBidIsValid(bid)) {
      utils.logError(`Native bid response does not contain all required assets. This bid won't be addeed to the auction`);
      return;
    }

    const { requestId, start } = getBidderRequest(bid.bidderCode, adUnitCode);
    Object.assign(bid, {
      requestId: requestId,
      responseTimestamp: timestamp(),
      requestTimestamp: start,
      cpm: bid.cpm || 0,
      bidder: bid.bidderCode,
      adUnitCode
    });

    bid.timeToRespond = bid.responseTimestamp - bid.requestTimestamp;

    if (bid.timeToRespond > $$PREBID_GLOBAL$$.cbTimeout + $$PREBID_GLOBAL$$.timeoutBuffer) {
      const timedOut = true;

      exports.executeCallback(timedOut);
    }

    //emit the bidAdjustment event before bidResponse, so bid response has the adjusted bid value
    events.emit(CONSTANTS.EVENTS.BID_ADJUSTMENT, bid);

    //emit the bidResponse event
    events.emit(CONSTANTS.EVENTS.BID_RESPONSE, bid);

    //append price strings
    const priceStringsObj = getPriceBucketString(bid.cpm, _customPriceBucket);
    bid.pbLg = priceStringsObj.low;
    bid.pbMg = priceStringsObj.med;
    bid.pbHg = priceStringsObj.high;
    bid.pbAg = priceStringsObj.auto;
    bid.pbDg = priceStringsObj.dense;
    bid.pbCg = priceStringsObj.custom;

    //if there is any key value pairs to map do here
    var keyValues = {};
    if (bid.bidderCode && (bid.cpm > 0 || bid.dealId ) ) {
      keyValues = getKeyValueTargetingPairs(bid.bidderCode, bid);
    }

    bid.adserverTargeting = keyValues;
    $$PREBID_GLOBAL$$._bidsReceived.push(bid);
  }

  if (bid && bid.adUnitCode && bidsBackAdUnit(bid.adUnitCode)) {
    triggerAdUnitCallbacks(bid.adUnitCode);
  }

  if (bidsBackAll()) {
    exports.executeCallback();
  }
};

function getKeyValueTargetingPairs(bidderCode, custBidObj) {
  var keyValues = {};
  var bidder_settings = $$PREBID_GLOBAL$$.bidderSettings;

  //1) set the keys from "standard" setting or from prebid defaults
  if (custBidObj && bidder_settings) {
    //initialize default if not set
    const standardSettings = getStandardBidderSettings();
    setKeys(keyValues, standardSettings, custBidObj);
  }

  //2) set keys from specific bidder setting override if they exist
  if (bidderCode && custBidObj && bidder_settings && bidder_settings[bidderCode] && bidder_settings[bidderCode][CONSTANTS.JSON_MAPPING.ADSERVER_TARGETING]) {
    setKeys(keyValues, bidder_settings[bidderCode], custBidObj);
    custBidObj.alwaysUseBid = bidder_settings[bidderCode].alwaysUseBid;
    custBidObj.sendStandardTargeting = bidder_settings[bidderCode].sendStandardTargeting;
  }

  //2) set keys from standard setting. NOTE: this API doesn't seem to be in use by any Adapter
  else if (defaultBidderSettingsMap[bidderCode]) {
    setKeys(keyValues, defaultBidderSettingsMap[bidderCode], custBidObj);
    custBidObj.alwaysUseBid = defaultBidderSettingsMap[bidderCode].alwaysUseBid;
    custBidObj.sendStandardTargeting = defaultBidderSettingsMap[bidderCode].sendStandardTargeting;
  }

  // set native key value targeting
  if (custBidObj.native) {
    Object.keys(custBidObj.native).forEach(asset => {
      const key = NATIVE_KEYS[asset];
      const value = custBidObj.native[asset];
      if (key) {keyValues[key] = value;}
    });
  }

  return keyValues;
}

exports.getKeyValueTargetingPairs = function() {
  return getKeyValueTargetingPairs(...arguments);
};

function setKeys(keyValues, bidderSettings, custBidObj) {
  var targeting = bidderSettings[CONSTANTS.JSON_MAPPING.ADSERVER_TARGETING];
  custBidObj.size = custBidObj.getSize();

  utils._each(targeting, function (kvPair) {
    var key = kvPair.key;
    var value = kvPair.val;

    if (keyValues[key]) {
      utils.logWarn('The key: ' + key + ' is getting ovewritten');
    }

    if (utils.isFn(value)) {
      try {
        value = value(custBidObj);
      } catch (e) {
        utils.logError('bidmanager', 'ERROR', e);
      }
    }

    if (
      (typeof bidderSettings.suppressEmptyKeys !== "undefined" && bidderSettings.suppressEmptyKeys === true ||
      key === "hb_deal") && // hb_deal is suppressed automatically if not set
      (
        utils.isEmptyStr(value) ||
        value === null ||
        value === undefined
      )
    ) {
      utils.logInfo("suppressing empty key '" + key + "' from adserver targeting");
    } else {
      keyValues[key] = value;
    }

  });

  return keyValues;
}

exports.setPriceGranularity = function setPriceGranularity(granularity) {
  var granularityOptions = CONSTANTS.GRANULARITY_OPTIONS;
  if (Object.keys(granularityOptions).filter(option => granularity === granularityOptions[option])) {
    _granularity = granularity;
  } else {
    utils.logWarn('Prebid Warning: setPriceGranularity was called with invalid setting, using' +
      ' `medium` as default.');
    _granularity = CONSTANTS.GRANULARITY_OPTIONS.MEDIUM;
  }
};

exports.registerDefaultBidderSetting = function (bidderCode, defaultSetting) {
  defaultBidderSettingsMap[bidderCode] = defaultSetting;
};

exports.executeCallback = function (timedOut) {
  // if there's still a timeout running, clear it now
  if (!timedOut && externalCallbacks.timer) {
    clearTimeout(externalCallbacks.timer);
  }

  if (externalCallbacks.all.called !== true) {
    processCallbacks(externalCallbacks.all);
    externalCallbacks.all.called = true;

    if (timedOut) {
      const timedOutBidders = exports.getTimedOutBidders();

      if (timedOutBidders.length) {
        events.emit(CONSTANTS.EVENTS.BID_TIMEOUT, timedOutBidders);
      }
    }
  }

  //execute one time callback
  if (externalCallbacks.oneTime) {
    events.emit(AUCTION_END);
    try {
      processCallbacks([externalCallbacks.oneTime]);
    }
    catch(e){
      utils.logError('Error executing bidsBackHandler', null, e);
    }
    finally {
      externalCallbacks.oneTime = null;
      externalCallbacks.timer = false;
      $$PREBID_GLOBAL$$.clearAuction();
    }
  }
};

exports.externalCallbackReset = function () {
  externalCallbacks.all.called = false;
};

function triggerAdUnitCallbacks(adUnitCode) {
  //todo : get bid responses and send in args
  var singleAdUnitCode = [adUnitCode];
  processCallbacks(externalCallbacks.byAdUnit, singleAdUnitCode);
}

function processCallbacks(callbackQueue, singleAdUnitCode) {
  if (utils.isArray(callbackQueue)) {
    callbackQueue.forEach(callback => {
      const adUnitCodes = singleAdUnitCode || $$PREBID_GLOBAL$$._adUnitCodes;
      const bids = [$$PREBID_GLOBAL$$._bidsReceived
                      .filter(adUnitsFilter.bind(this, adUnitCodes))
                      .reduce(groupByPlacement, {})];

      callback.apply($$PREBID_GLOBAL$$, bids);
    });
  }
}

/**
 * groupByPlacement is a reduce function that converts an array of Bid objects
 * to an object with placement codes as keys, with each key representing an object
 * with an array of `Bid` objects for that placement
 * @returns {*} as { [adUnitCode]: { bids: [Bid, Bid, Bid] } }
 */
function groupByPlacement(bidsByPlacement, bid) {
  if (!bidsByPlacement[bid.adUnitCode])
    bidsByPlacement[bid.adUnitCode] = { bids: [] };

  bidsByPlacement[bid.adUnitCode].bids.push(bid);

  return bidsByPlacement;
}

/**
 * Add a one time callback, that is discarded after it is called
 * @param {Function} callback
 * @param timer Timer to clear if callback is triggered before timer time's out
 */
exports.addOneTimeCallback = function (callback, timer) {
  externalCallbacks.oneTime = callback;
  externalCallbacks.timer = timer;
};

exports.addCallback = function (id, callback, cbEvent) {
  callback.id = id;
  if (CONSTANTS.CB.TYPE.ALL_BIDS_BACK === cbEvent) {
    externalCallbacks.all.push(callback);
  } else if (CONSTANTS.CB.TYPE.AD_UNIT_BIDS_BACK === cbEvent) {
    externalCallbacks.byAdUnit.push(callback);
  }
};

//register event for bid adjustment
events.on(CONSTANTS.EVENTS.BID_ADJUSTMENT, function (bid) {
  adjustBids(bid);
});

function adjustBids(bid) {
  var code = bid.bidderCode;
  var bidPriceAdjusted = bid.cpm;
  if (code && $$PREBID_GLOBAL$$.bidderSettings && $$PREBID_GLOBAL$$.bidderSettings[code]) {
    if (typeof $$PREBID_GLOBAL$$.bidderSettings[code].bidCpmAdjustment === objectType_function) {
      try {
        bidPriceAdjusted = $$PREBID_GLOBAL$$.bidderSettings[code].bidCpmAdjustment.call(null, bid.cpm, Object.assign({}, bid));
      }
      catch (e) {
        utils.logError('Error during bid adjustment', 'bidmanager.js', e);
      }
    }
  }

  if (bidPriceAdjusted >= 0) {
    bid.cpm = bidPriceAdjusted;
  }
}

exports.adjustBids = function() {
  return adjustBids(...arguments);
};

function getStandardBidderSettings() {
  let bidder_settings = $$PREBID_GLOBAL$$.bidderSettings;
  if (!bidder_settings[CONSTANTS.JSON_MAPPING.BD_SETTING_STANDARD]) {
    bidder_settings[CONSTANTS.JSON_MAPPING.BD_SETTING_STANDARD] = {
      adserverTargeting: [
        {
          key: 'hb_bidder',
          val: function (bidResponse) {
            return bidResponse.bidderCode;
          }
        }, {
          key: 'hb_adid',
          val: function (bidResponse) {
            return bidResponse.adId;
          }
        }, {
          key: 'hb_pb',
          val: function (bidResponse) {
            if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.AUTO) {
              return bidResponse.pbAg;
            } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.DENSE) {
              return bidResponse.pbDg;
            } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.LOW) {
              return bidResponse.pbLg;
            } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.MEDIUM) {
              return bidResponse.pbMg;
            } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.HIGH) {
              return bidResponse.pbHg;
            } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.CUSTOM) {
              return bidResponse.pbCg;
            }
          }
        }, {
          key: 'hb_size',
          val: function (bidResponse) {
            return bidResponse.size;
          }
        }, {
          key: 'hb_deal',
          val: function (bidResponse) {
            return bidResponse.dealId;
          }
        }
      ]
    };
  }
  return bidder_settings[CONSTANTS.JSON_MAPPING.BD_SETTING_STANDARD];
}

function getStandardBidderAdServerTargeting() {
  return getStandardBidderSettings()[CONSTANTS.JSON_MAPPING.ADSERVER_TARGETING];
}

exports.getStandardBidderAdServerTargeting = getStandardBidderAdServerTargeting;
