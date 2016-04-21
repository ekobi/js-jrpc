/*! JRPC v3.0.0-beta
 * <https://github.com/vphantom/js-jrpc>
 * Copyright 2016 Stéphane Lavergne
 * Free software under MIT License: <https://opensource.org/licenses/MIT> */

'use strict';

/**
 * Constructor
 *
 * @typedef {Object} JRPC
 *
 * @param {Object} [options] Options to initialize with
 *
 * @return {undefined} No return value
 */
function JRPC(options) {
  this.transmitter = null;
  this.remoteTimeout = 10000;
  this.localTimeout = 5000;
  this.serial = 0;
  this.outbox = {
    requests : [],
    responses: []
  };
  this.inbox = {};
  this.localComponents = {
    'system.listComponents'      : true,
    'system.extension.dual-batch': true
  };
  this.remoteComponents = {};
  this.exposed = {};

  this.exposed['system.listComponents'] = function(params, next) {
    if (typeof params === 'object') {
      this.remoteComponents = params;
      this.remoteComponents['system._upgraded'] = true;
    }
    return next(null, this.components);
  };

  this.exposed['system.extension.dual-batch'] = function(params, next) {
    return next(null, true);
  };

  if (typeof options === 'object') {
    if (
      'remoteTimeout' in options
      && typeof options['remoteTimeout'] === 'number'
    ) {
      this.remoteTimeout = options['remoteTimeout'] * 1000;
    }

    if (
      'localTimeout' in options
      && typeof options['localTimeout'] === 'number'
    ) {
      this.localTimeout = options['localTimeout'] * 1000;
    }
  }
}


// I/O

/**
 * Send a message if there is something in the queue
 *
 * @param {JRPC~transmitCallback} callback Transmission handler
 *
 * @return {JRPC} This instance, for chaining
 */
function transmit(callback) {
  // Will call next(data, next)
  // Expect OUR next to be called with (err) so we know if it worked
  var iRes;
  var iReq;
  var msg = null;
  var outpacket = {
    responses: [],
    requests : []
  };

  if (typeof callback !== 'function') {
    callback = this.transmitter;
  }
  if (typeof callback !== 'function') {
    return this;
  }

  iRes = this.outbox.responses.length;
  iReq = this.outbox.requests.length;
  if (
    iRes > 0
    && iReq > 0
    && 'system.extension.dual-batch' in this.remoteComponents
  ) {
    // Use dual-batch extension to send it all at once
    outpacket = msg = {
      responses: this.outbox.responses,
      requests : this.outbox.requests
    };
    // Setting length=0 would preserve references and we want to renew them
    this.outbox.responses = [];
    this.outbox.requests = [];
  } else if (iRes > 0) {
    // Responses have priority over requests
    if (iRes > 1) {
      outpacket.responses = msg = this.outbox.responses;
      this.outbox.responses = [];
    } else {
      outpacket.responses.push(msg = this.outbox.responses.pop());
    }
  } else if (iReq > 0) {
    if (iReq > 1) {
      outpacket.requests = msg = this.outbox.requests;
      this.outbox.requests = [];
    } else {
      outpacket.requests.push(msg = this.outbox.requests.pop());
    }
  } else {
    return this;
  }

  // Send msg using callback
  setImmediate(
    callback.bind(
      null,
      JSON.stringify(msg),
      confirmTransmit.bind(this, outpacket)
    )
  );

  return this;
}

/**
 * Callback invoked by transmit()
 *
 * @callback JRPC~transmitCallback
 *
 * @param {string} msg                        Message to send out
 * @param {JRPC~transmitConfirmCallback} next Callback handling errors
 */

/**
 * Set transmitter callback permanently
 *
 * @param {JRPC~transmitCallback} callback Transmission handler
 *
 * @return {JRPC} This instance, for chaining
 */
function setTransmitter(callback) {
  this.transmitter = callback;
  return this.transmit();
}

/**
 * Handle transmission errors
 *
 * @type {JRPC~transmitConfirmCallback}
 *
 * @param {Object}  outpacket Outbox data of the attempted transmission
 * @param {boolean} err       Anything non-falsey means an error occured
 *
 * @return {undefined} No return value
 */
function confirmTransmit(outpacket, err) {
  if (err) {
    // Roll it all back into outbox (which may not be empty anymore)
    if (outpacket.responses.length > 0) {
      Array.prototype.push.apply(this.outbox.responses, outpacket.responses);
    }
    if (outpacket.requests.length > 0) {
      Array.prototype.push.apply(this.outbox.requests, outpacket.requests);
    }
  }
}

/**
 * Handle incoming message
 *
 * @param {string} msg JSON message to parse
 *
 * @return {JRPC} This instance, for chaining
 */
function receive(msg) {
  var requests = [];
  var responses = [];

  // If we got JSON, parse it
  if (typeof msg === 'string') {
    try {
      msg = JSON.parse(msg);
    } catch (e) {
      // The specification doesn't force us to respond in error, ignoring
      return this;
    }
  }

  // If we get a standard single-type batch, dispatch it
  if (msg.constructor === Array) {
    if (msg.length === 0) {
      return this;
    }
    // Hint of request batch
    if (typeof msg[0].method === 'string') {
      requests = msg;
    } else {
      responses = msg;
    }
  } else if (typeof msg === 'object') {
    // Could we be a 'dual-batch' extended message?
    if (
      typeof msg.requests !== 'undefined'
      && typeof msg.responses !== 'undefined'
    ) {
      requests = msg.requests;
      responses = msg.responses;
    } else if (typeof msg.method === 'string') {
      // We're a single request
      requests.push(msg);
    } else {
      // We must be a single response
      responses.push(msg);
    }
  }

  responses.forEach(deliverResponse.bind(this));
  requests.forEach(serveRequest.bind(this));
  return this;
}

/**
 * Handshake to discover remote extended capabilities
 *
 * @return {JRPC} This instance, for chaining
 */
function upgrade() {
  return this.call(
    'system.listComponents',
    this.localComponents,
    function(err, result) {
      if (!err) {
        this.remoteComponents = result;
        this.remoteComponents['system._upgraded'] = true;
      }
    }
  );
}


// Client side

/**
 * Queue up a remote method call
 *
 * @param {string}               methodName Name of method to call
 * @param {(Object|Array|null)}  params     Parameters
 * @param {JRPC~receiveCallback} next       Callback to receive result
 *
 * @return {JRPC} This instance, for chaining
 */
function call(methodName, params, next) {
  var request = {
    jsonrpc: '2.0',
    method : methodName
  };

  if (
    'system._upgraded' in this.remoteComponents
    && !(methodName in this.remoteComponents)
  ) {
    // We're upgraded, yet method name isn't found, immediate error!
    setImmediate(next.bind(null, -1001));
    return this;
  }

  this.serial++;
  request.id = this.serial;
  if (typeof params === 'object') {
    request.params = params;
  }

  this.inbox[this.serial] = next;
  this.outbox.requests.push(request);

  if (this.remoteTimeout > 0) {
    setTimeout(
      deliverResponse.bind(
        this,
        {
          jsonrpc: '2.0',
          id     : this.serial,
          error  : {
            code   : -1000,
            message: 'Timed out waiting for response'
          }
        }
      ),
      this.remoteTimeout
    );
  }

  return this;
}

/**
 * Callback invoked when remote results are ready
 *
 * @callback JRPC~receiveCallback
 *
 * @param {boolean} err    True if the result is an error or unavailable
 * @param {Object}  result The result from the remote method
 *
 * @return {undefined} No return value
 */

/**
 * Deliver a received result
 *
 * @param {Object} res The single result to parse
 *
 * @return {undefined} No return value
 */
function deliverResponse(res) {
  var err = null;
  var result = null;

  if ('id' in res && res['id'] in this.inbox) {
    if ('error' in res) {
      err = res['error'];
    } else {
      result = res['result'];
    }
    setImmediate(this.inbox[res['id']].bind(null, err, result));
    delete this.inbox[res['id']];
  }
  // Silently ignore timeout duplicate and malformed responses
}


// Server side

/**
 * Expose a single or collection of methods to remote end
 *
 * @param {(Object|String)}      subject    Name of method or direct object
 * @param {JRPC~serviceCallback} [callback] Callback to handle requests
 *
 * @return {JRPC} This instance, for chaining
 */
function expose(subject, callback) {
  var name;

  if (typeof subject === 'string') {
    this.localComponents[subject] = true;
    this.exposed[subject] = callback;
  } else if (typeof subject === 'object') {
    for (name in subject) {
      if (subject.hasOwnProperty(name)) {
        this.localComponents[name] = true;
        this.exposed[name] = subject[name];
      }
    }
  }

  return this;
}

/**
 * Callback invoked to handle calls to our side's methods
 *
 * @callback JRPC~serviceCallback
 *
 * @param {(Object|Array|null)}        params Parameters received
 * @param {JRPC~serviceResultCallback} next   Callback to send your result
 *
 * @return {undefined} No return value
 */

/**
 * Serve a request we received
 *
 * @param {Object} request Request to parse
 *
 * @return {undefined} No return value
 */
function serveRequest(request) {
  var id = request['id'] || null;
  var method = request['method'] || null;
  var params = null;

  if (!(id !== null || method !== null)) {
    return;
  }

  if (typeof method !== 'string') {
    if (id !== null) {
      setImmediate(sendResponse.bind(this, id, -32600));
    }
    return;
  }

  if (!(method in this.exposed)) {
    if (id !== null) {
      setImmediate(sendResponse.bind(this, id, -32601));
    }
    return;
  }

  if ('params' in request) {
    if (typeof request['params'] === 'object') {
      params = request['params'];
    } else {
      if (id !== null) {
        setImmediate(sendResponse.bind(this, id, -32602));
      }
      return;
    }
  }

  setImmediate(
    this.exposed[method].bind(
      null,
      params,
      sendResponse.bind(this, id)
    )
  );

  if (this.localTimeout > 0) {
    setTimeout(
      sendResponse.bind(
        this,
        id,
        {
          code   : -1002,
          message: 'Method handler timed out'
        }
      ),
      this.localTimeout
    );
  }

  return;
}

/**
 * Handle local method results
 *
 * @type {JRPC~serviceResultCallback}
 *
 * @param {number}  id     Serial number, bound, no need to supply
 * @param {boolean} err    Anything non-falsey means error and is sent
 * @param {Object}  result Any result you wish to produce
 *
 * @return {undefined} No return value
 */
function sendResponse(id, err, result) {
  var response = {
    jsonrpc: '2.0',
    id     : id
  };

  if (id === null) {
    return;
  }

  if (typeof err !== 'undefined' && err !== null && err !== false) {
    if (typeof err === 'number') {
      response.error = {
        code   : err,
        message: 'error'
      };
    } else if (typeof err === 'string') {
      response.error = {
        code   : -1,
        message: err
      };
    } else {
      response.error = {
        code   : -2,
        message: 'error',
        data   : err
      };
    }
  } else {
    response.result = result;
  }
  this.outbox.responses.push(response);
}


// Public methods

JRPC.prototype.call = call;
JRPC.prototype.expose = expose;
JRPC.prototype.upgrade = upgrade;
JRPC.prototype.receive = receive;
JRPC.prototype.transmit = transmit;
JRPC.prototype.setTransmitter = setTransmitter;

// Support Bluebird automatically if it's globally available

if (typeof Promise.promisify === 'function') {
  JRPC.prototype.callAsync = Promise.promisify(call);
}

module.exports = JRPC;
