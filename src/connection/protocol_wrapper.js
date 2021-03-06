;(function() {
  /**
   * Provides Pusher protocol interface for transports.
   *
   * Emits following events:
   * - connected - after establishing connection and receiving a socket id
   * - message - on received messages
   * - ping - on ping requests
   * - pong - on pong responses
   * - error - when the transport emits an error
   * - closed - after closing the transport
   * - ssl_only - after trying to connect without ssl to a ssl-only app
   * - retry - when closed connection should be retried immediately
   * - backoff - when closed connection should be retried with a delay
   * - refused - when closed connection should not be retried
   *
   * @param {AbstractTransport} transport
   */
  function ProtocolWrapper(transport) {
    Pusher.EventsDispatcher.call(this);
    this.transport = transport;
    this.bindListeners();
  }
  var prototype = ProtocolWrapper.prototype;

  Pusher.Util.extend(prototype, Pusher.EventsDispatcher.prototype);

  /** Returns whether used transport handles ping/pong by itself
   *
   * @returns {Boolean} true if ping is handled by the transport
   */
  prototype.supportsPing = function() {
    return this.transport.supportsPing();
  };

  /** Sends raw data.
   *
   * @param {String} data
   */
  prototype.send = function(data) {
    return this.transport.send(data);
  };

  /** Sends an event.
   *
   * @param {String} name
   * @param {String} data
   * @param {String} [channel]
   * @returns {Boolean} whether message was sent or not
   */
  prototype.send_event = function(name, data, channel) {
    var payload = {
      event: name,
      data: data
    };
    if (channel) {
      payload.channel = channel;
    }

    Pusher.debug('Event sent', payload);
    return this.send(JSON.stringify(payload));
  };

  /** Closes the transport.  */
  prototype.close = function() {
    this.transport.close();
  };

  /** @private */
  prototype.bindListeners = function() {
    var self = this;

    var onMessageOpen = function(message) {
      message = self.parseMessage(message);

      if (message !== undefined) {
        if (message.event === 'pusher:connection_established') {
          self.id = message.data.socket_id;
          self.transport.unbind("message", onMessageOpen);
          self.transport.bind("message", onMessageConnected);
          self.transport.bind("ping_request", onPingRequest);
          self.emit("connected", self.id);
        } else if (message.event === "pusher:error") {
          // From protocol 6 close codes are sent only once, so this only
          // happens when connection does not support close codes
          self.handleCloseCode(message.data.code, message.data.message);
          self.transport.close();
        }
      }
    };
    var onMessageConnected = function(message) {
      message = self.parseMessage(message);

      if (message !== undefined) {
        Pusher.debug('Event recd', message);

        switch (message.event) {
          case 'pusher:error':
            self.emit('error', { type: 'PusherError', data: message.data });
            break;
          case 'pusher:ping':
            self.emit("ping");
            break;
          case 'pusher:pong':
            self.emit("pong");
            break;
        }
        self.emit('message', message);
      }
    };
    var onPingRequest = function() {
      self.emit("ping_request");
    };
    var onError = function(error) {
      self.emit("error", { type: "WebSocketError", error: error });
    };
    var onClosed = function(error) {
      if (error && error.code) {
        self.handleCloseCode(error.code, error.reason);
      }
      self.transport.unbind("message", onMessageOpen);
      self.transport.unbind("message", onMessageConnected);
      self.transport.unbind("ping_request", onPingRequest);
      self.transport.unbind("error", onError);
      self.transport.unbind("closed", onClosed);
      self.transport = null;
      self.emit("closed");
    };

    this.transport.bind("message", onMessageOpen);
    this.transport.bind("error", onError);
    this.transport.bind("closed", onClosed);
  };

  /** @private */
  prototype.parseMessage = function(message) {
    try {
      var params = JSON.parse(message.data);

      if (typeof params.data === 'string') {
        try {
          params.data = JSON.parse(params.data);
        } catch (e) {
          if (!(e instanceof SyntaxError)) {
            throw e;
          }
        }
      }

      return params;
    } catch (e) {
      this.emit(
        'error', { type: 'MessageParseError', error: e, data: message.data}
      );
    }
  };

  /** @private */
  prototype.handleCloseCode = function(code, message) {
    this.emit(
      'error', { type: 'PusherError', data: { code: code, message: message } }
    );

    // See:
    // 1. https://developer.mozilla.org/en-US/docs/WebSockets/WebSockets_reference/CloseEvent
    // 2. http://pusher.com/docs/pusher_protocol
    if (code < 4000) {
      // ignore 1000 CLOSE_NORMAL, 1001 CLOSE_GOING_AWAY,
      //        1005 CLOSE_NO_STATUS, 1006 CLOSE_ABNORMAL
      // ignore 1007...3999
      // handle 1002 CLOSE_PROTOCOL_ERROR, 1003 CLOSE_UNSUPPORTED,
      //        1004 CLOSE_TOO_LARGE
      if (code >= 1002 && code <= 1004) {
        this.emit("backoff");
      }
    } else if (code === 4000) {
      this.emit("ssl_only");
    } else if (code < 4100) {
      this.emit("refused");
    } else if (code < 4200) {
      this.emit("backoff");
    } else if (code < 4300) {
      this.emit("retry");
    } else {
      // unknown error
      this.emit("refused");
    }
  };

  Pusher.ProtocolWrapper = ProtocolWrapper;
}).call(this);
