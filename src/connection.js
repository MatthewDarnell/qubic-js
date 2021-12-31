'use strict';

import WebSocket from 'isomorphic-ws';
import EventEmitter from 'eventemitter2';
import { crypto } from './crypto/index.js';
import { shiftedHexToBytes } from './utils/hex.js';

const NUMBER_OF_CONNECTIONS = 3;

export const EPOCH_OFFSET = 0;
export const EPOCH_LENGTH = 4;
export const TICK_OFFSET = EPOCH_OFFSET + EPOCH_LENGTH;
export const TICK_LENGTH = 2;

const compareResponses = function (responses) {
  let syncStatus = 0;
  let counts = {};

  for (let i = 0; i < responses.length; i++) {
    counts[responses[i]] = (counts[responses[i]] || 0) + 1;
  }

  for (const v of Object.values(counts)) {
    if (v > syncStatus) {
      syncStatus = v;
    }
  }

  return syncStatus;
};

/**
 * @function createConnection
 * @memberof module:qubic
 * @param {object} params - Connection params.
 * @param {object[]} params.computors - Specifies 3 computors to connect to, and with what options.
 * @param {string} params.computors[].url - Computor url.
 * @param {object} [params.computors[].options] - WebSocket options. Node.js only.
 * @param {number} params.synchronizationInterval - If no new tick appears after this interval an info event is emitted with updated sync status.
 * @param {string} params.adminPublicKey - Admin public key, for verification of current epoch and tick which are signed by admin.
 * @param {number} [params.reconnectTimeoutDuration=100] - Reconnect timeout duration.
 * @fires Connection#info
 * @fires Connection#open
 * @fires Connection#close
 * @fires Connection#error
 * @returns {Connection}
 * @example import { createConnection } from 'qubic-js';
 *
 * const connection = createConnection({
 *   computors: [
 *     { url: 'wss://AA.computor.com' },
 *     { url: 'wss://AB.computor.com' },
 *     { url: 'wss://AC.computor.com' },
 *   ],
 *   synchronizationInterval: 60 * 1000,
 *   adminPublicKey: '97CC65D1E59351EEFC776BCFF197533F148A8105DA84129C051F70DD9CA0FF82',
 * });
 *
 * connection.addListener('error', function (error) {
 *   console.log(error.message);
 * });
 * connection.addListener('info', console.log);
 *
 */
export const createConnection = function ({
  computors,
  synchronizationInterval,
  adminPublicKey,
  reconnectTimeoutDuration = 100,
}) {
  let sockets = [];
  let latestSynchronizationTimestamp = 0;
  let latestSyncStatus = 0;
  let synchronizationTimeout;

  const statusResponses = [];
  const responsesByKey = new Map();
  const requestsByKey = new Map();

  const onopen = function (socket) {
    for (const request of requestsByKey.values()) {
      socket.send(request);
    }
  };

  const onmessage = function (i) {
    const that = this;
    return async function (message) {
      try {
        const parsedMessage = JSON.parse(message.data);
        const { command } = parsedMessage;

        // Info command
        if (command === 0) {
          const { epoch, tick, signature } = parsedMessage;

          const buffer = new ArrayBuffer(EPOCH_LENGTH + TICK_LENGTH);
          const view = new DataView(buffer);
          view.setUint32(EPOCH_OFFSET, epoch);
          view.setUint16(TICK_OFFSET, tick);

          if (
            (await crypto).schnorrq.verify(
              shiftedHexToBytes(adminPublicKey),
              Uint8Array.from(buffer),
              Uint8Array.from(Buffer.from(signature, 'base64'))
            ) === 1
          ) {
            statusResponses[i] = message.data;
            const syncStatus = compareResponses(statusResponses);

            if (latestSyncStatus < syncStatus) {
              latestSynchronizationTimestamp = Date.now();
              latestSyncStatus = syncStatus;

              /**
               * Info event.
               *
               * @event Connection#info
               * @type {object}
               * @property {number} syncStatus - Indicates which of the 3 computors have provided the same tick and epoch.
               * 0 when offline, 3 when fully synced.
               * @property {number} epoch - Current epoch.
               * @property {number} tick - Current tick.
               */
              that.emit('info', { syncStatus, epoch, tick });

              if (syncStatus === NUMBER_OF_CONNECTIONS) {
                latestSyncStatus = 0;
                statusResponses.length = 0;
              }
            }
          }
          return;
        }

        const key =
          parsedMessage.command.toString() + (parsedMessage.identity || parsedMessage.hash);
        const responses = responsesByKey.get(key);
        if (responses !== undefined) {
          responses[i] = message.data;
          if (compareResponses(responses) >= 2) {
            responses.resolve(parsedMessage);
            responsesByKey.delete(key);
            requestsByKey.delete(key);
          } else if (responses.length === NUMBER_OF_CONNECTIONS) {
            responses.reject('Invalid responses.');
            responsesByKey.delete(key);
            requestsByKey.delete(key);
          }
        }
      } catch {
        sockets[i].close();
      }
    };
  };

  /**
   * @mixin Connection
   */

  /**
   * Terminates all 3 WebSocket connections.
   *
   * @function close
   * @memberof Connection
   */
  const close = function () {
    sockets.forEach(function (socket) {
      socket.terminate();
    });
    clearTimeout(synchronizationTimeout);
    this.emit('info', { syncStatus: 0 });
  };

  /**
   * Sends a client command to each connected computor, and compares responses before resolving.
   * Available client commands:
   *
   * | Command | Payload | Response | Description |
   * | --- | --- | --- | --- |
   * | `1` | `{ identity }` | `{ identity, identityNonce }` | Fetches `identityNonce`. |
   * | `2` | `{ identity }` | `{ identity, energy }` | Fetches `energy`. |
   * | `3` | `{ message, signature }` | `void` | Sends a transfer with `base64`-encoded `message` & `signature` fields. |
   * | `4` | `{ hash }` | `{ hash, inclusionState, tick, epoch }` or `{ hash, reason }` | Fetches status of a transfer. Rejects with reason in case account nonce has been overwritten. |
   *
   * @function sendCommand
   * @memberof Connection
   * @param {number} command - Command index, must be an integer.
   * @param {object} payload - Payload.
   * @returns {Promise<object|void>}
   */
  const sendCommand = function (command, payload) {
    return Promise.all(
      sockets.map(function (socket) {
        return socket.open;
      })
    ).then(function () {
      const key = command.toString() + (payload.identity || payload.hash);
      let responses = responsesByKey.get(key);

      if (responses === undefined) {
        const request = JSON.stringify({
          command,
          ...payload,
        });

        if (command !== 3) {
          responses = [];
          responses.promise = new Promise(function (resolve, reject) {
            responses.resolve = resolve;
            responses.reject = reject;
          });
          responsesByKey.set(key, responses);
          requestsByKey.set(key, request);
        }

        sockets.forEach(function (socket) {
          return socket.open.then(function () {
            socket.send(request);
          });
        });
      }

      if (responses !== undefined) {
        return responses.promise;
      }
    });
  };

  const connectionMixin = function () {
    const that = this;

    const synchronizationRoutine = function () {
      if (Date.now() - latestSynchronizationTimestamp > synchronizationInterval) {
        latestSyncStatus = 0;
        that.emit('info', { syncStatus: 0 });
      }
      synchronizationTimeout = setTimeout(function () {
        synchronizationRoutine();
      }, synchronizationInterval);
    };

    const open = function (index, url) {
      if (index === undefined) {
        sockets = [];
      }

      const openSocket = function (i) {
        const socket = (sockets[i] = new WebSocket(
          url || computors[i].url,
          [],
          computors[i].options
        ));
        sockets[i].computor = url || computors[i].url;

        let resolveOnOpenOrClose;
        socket.open = new Promise(function (resolve) {
          resolveOnOpenOrClose = resolve;
        });

        socket.onopen = function (event) {
          /**
           * Open event. Emitted when a WebSocket connection opens.
           *
           * @event Connection#open
           * @param {event} event - WebSocket event.
           */
          that.emit('open', event);
          onopen(socket);
          resolveOnOpenOrClose();
        };

        socket.onmessage = onmessage.call(that, i);

        socket.onerror = function (event) {
          /**
           * Error event. Emitted when a WebSocket connection errors.
           *
           * @event Connection#error
           * @param {event} event - WebSocket event.
           */
          that.emit('error', event);
        };

        socket.onclose = function (event) {
          /**
           * Close event. Emitted when a WebSocket connection closes.
           *
           * @event Connection#close
           * @param {event} event - WebSocket event.
           */
          that.emit('close', event);
          resolveOnOpenOrClose();
          setTimeout(function () {
            openSocket(i);
          }, reconnectTimeoutDuration);
        };

        socket.terminate = function () {
          socket.onclose = undefined;
          socket.close();
        };
      };

      if (index === undefined) {
        for (let i = 0; i < NUMBER_OF_CONNECTIONS; i++) {
          openSocket(i);
        }

        synchronizationRoutine(that);
      } else {
        openSocket(index);
      }
    };

    /**
     * Sets one of the 3 computors url each time.
     *
     * @function setComputorUrl
     * @param {number} index - Index of computor connection, 0, 1 or 2.
     * @param {string} url - Computor url.
     * @memberof Connection
     */
    const setComputorUrl = function (index, url) {
      if (sockets[index].url !== url) {
        sockets[index].terminate();
        open(index, url);
      }
    };

    return Object.assign(
      that,
      {
        /**
         * Opens all 3 WebSocket connections.
         *
         * @function open
         * @memberof Connection
         * @fires Connection#info
         * @fires Connection#open
         * @fires Connection#close
         * @fires Connection#error
         */
        open: function () {
          open();
        },
        close,
        sendCommand,
        setComputorUrl,
        /**
         * @function computors
         * @memberof Connection
         * @returns {string[]} Array of computor urls.
         */
        computors() {
          return sockets.map(function (socket) {
            return socket.computor;
          });
        },
      },
      EventEmitter.prototype
    );
  };

  const connection = connectionMixin.call({});
  connection.open();
  return connection;
};
