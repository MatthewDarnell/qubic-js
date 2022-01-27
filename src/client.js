'use strict';

import { connection as _connection } from './connection.js';
import { transaction } from './transaction.js';
import { identity } from './identity.js';
import level from 'level';
import path from 'path';
import bigInt from 'big-integer';

/* globals Connection */

/**
 * @function client
 * @memberof module:qubic
 * @param {object} options - Client options.
 * @param {string} options.seed - Seed in 55 lowercase latin chars.
 * @param {number} [options.index=0] - Identity index.
 * @param {Connection} [options.connection] - Client connection.
 * @param {object[]} [options.computors] - Specifies 3 computors to connect to, and with what options.
 * Ignored when connection option is used.
 * @param {string} options.computors[].url - Computor url.
 * @param {object} [options.computors[].options] - WebSocket options.
 * @param {number} [options.synchronizationInterval] - If no new tick appears after this interval an info event is emitted with updated sync status.
 * Ignored when connection option is used.
 * @param {string} [options.adminPublicKey] - Admin public key, for verification of current epoch and tick which are signed by admin.
 * Ignored when connection option is used.
 * @param {number} [options.reconnectTimeoutDuration=100] - Reconnect timeout duration. Ignored when connection option is used.
 * @param {object} [options.db] - Database implementing the [level interface](https://github.com/Level/level), for storing transfers.
 * @param {string} [options.dbPath] - Database path.
 * @fires Connection#info
 * @fires Connection#open
 * @fires Connection#close
 * @fires Connection#error
 * @fires Client#inclusion
 * @fires Client#rejection
 * @returns {Client}
 * @example import qubic from 'qubic-js';
 *
 * const client = qubic.client({
 *   seed: 'vmscmtbcqjbqyqcckegsfdsrcgjpeejobolmimgorsqwgupzhkevreu',
 *   computors: [
 *     { url: 'wss://AA.computor.com' },
 *     { url: 'wss://AB.computor.com' },
 *     { url: 'wss://AC.computor.com' },
 *   ],
 *   synchronizationInterval: 60 * 1000,
 *   adminPublicKey: '97CC65D1E59351EEFC776BCFF197533F148A8105DA84129C051F70DD9CA0FF82',
 * });
 *
 * client.addListener('error', function (error) {
 *   console.log(error.message);
 * });
 * client.addListener('info', console.log);
 *
 */
export const client = function ({
  seed,
  index = 0,
  connection,
  computors,
  synchronizationInterval,
  adminPublicKey,
  reconnectTimeoutDuration,
  db,
  dbPath,
}) {
  connection =
    connection ||
    _connection({
      computors,
      synchronizationInterval,
      adminPublicKey,
      reconnectTimeoutDuration,
    });
  const id = identity(seed, index);
  db = Promise.resolve(
    db ||
      id.then(function (id) {
        return level(path.join(dbPath || './', id));
      })
  );
  const infoListeners = [];
  const emittersByEnvironment = new Map();

  const clientMixin = function () {
    const that = this;

    const onTransaction = function (key) {
      const infoListener = async function ({ syncStatus }) {
        if (syncStatus > 2) {
          const response = await connection.sendCommand(4, { messageDigest: key });
          if (response.inclusionState === true) {
            (await db).del(key).then(function () {
              that.removeListener('info', infoListener);
              /**
               * Inclusion event.
               *
               * @event Client#inclusion
               * @type {object}
               * @property {string} messageDigest - Hash of included transfer in uppercase hex.
               * @property {number} epoch - Epoch at which transfer was included.
               * @property {number} tick - Tick at which transfer was included.
               */
              that.emit('inclusion', {
                messageDigest: key,
                inclusionState: true,
                tick: response.tick,
                epoch: response.epoch,
              });
            });
          } else if (response.reason) {
            /**
             * Rejection event.
             *
             * @event Client#rejection
             * @type {object}
             * @property {string} messageDigest - Hash of rejected transfer in uppercase hex.
             * @property {string} reason - Reason of rejection.
             */
            that.emit('rejection', { messageDigest: key, reason: response.reason });
          }
        }
      };
      that.addListener('info', infoListener);
      infoListeners.push(infoListener);
    };

    db.then(function (db) {
      db.on('put', onTransaction);
      db.createKeyStream().on('data', onTransaction);
    });

    /**
     * @mixin Client
     * @mixes Connection
     */
    return Object.assign(this, {
      /**
       * @type {string} Client identity in uppercase hex.
       * @memberof Client
       */
      get identity() {
        return id;
      },

      /* eslint-disable jsdoc/no-undefined-types */
      /**
       * Sends energy to recipient.
       *
       * @function transaction
       * @memberof Client
       * @param {object} params
       * @param {string} params.recipientIdentity - Recipient identity in uppercase hex.
       * @param {bigint} params.energy - Transferred energy to recipient identity.
       * @param {TypedArray} params.effectPayload - Effect payload.
       * @returns {Transaction} Transaction object.
       */
      /* eslint-enable jsdoc/no-undefined-types */
      async transaction(params) {
        const [{ identityNonce }, { energy }] = await Promise.all([
          connection.sendCommand(1, { identity: await id }),
          params.recipientIdentity
            ? connection.sendCommand(2, { identity: await id })
            : { energy: undefined },
        ]);

        if (energy !== undefined && bigInt(energy).lesser(params.energy)) {
          throw new Error('Insufficient energy.');
        }

        const { messageDigest, message, signature } = await transaction({
          seed,
          index,
          senderIdentity: await id,
          identityNonce,
          energy: params.energy,
          recipientIdentity: params.recipientIdentity,
          effectPayload: params.effectPayload,
        });

        return (await db)
          .put(messageDigest, JSON.stringify({ message, signature }))
          .then(function () {
            connection.sendCommand(3, {
              message,
              signature,
            });
            return {
              messageDigest,
              message,
              signature,
            };
          });
      },

      /**
       * Subcribes to an environment.
       *
       * @function addEnvironmentListener
       * @memberof Client
       * @param {string} environment - Environment hash.
       * @param {Function} listener
       *
       * @example const listener = function (data) {
       *   console.log(data);
       * };
       *
       * client.addEvironmentListener(
       *   'BPFJANADOGBDLNNONDILEMAICAKMEEGBFPJBKPBCEDFJIALDONODMAIMDBFKCFEE',
       *   listener
       * );
       *
       */
      addEnvironmentListener(environment, listener) {
        let emitter = emittersByEnvironment.get(environment);
        if (emitter === undefined) {
          emitter = connection.sendCommand(5, { environmentDigest: environment });
          emittersByEnvironment.set(environment, emitter);
        }
        emitter.addListener('data', listener);
      },

      /**
       * Unsubscribes from an environment.
       *
       * @function removeEnvironmentListener
       * @memberof Client
       * @param {string} environment - Environment hash.
       * @param {Function} listener
       */
      removeEnvironmentListener(environment, listener) {
        let emitter = emittersByEnvironment.get(environment);
        if (emitter !== undefined) {
          connection.sendCommand(6, { environmentDigest: environment });
          emitter.removeListener('data', listener);
          emittersByEnvironment.delete(environment);
        }
      },

      /**
       * Closes database and connections to computors.
       *
       * @function terminate
       * @memberof Client
       * @param {object} [options]
       * @param {boolean} [options.closeConnection = true]
       */
      async terminate({ closeConnection } = { closeConnection: true }) {
        if (closeConnection) {
          connection.close();
        }
        (await db).close();
        for (const listener of infoListeners) {
          connection.removeListener('info', listener);
        }
      },

      /**
       * Launches client by opening database and connections to computors.
       *
       * @function launch
       * @memberof Client
       * @fires Connection#info
       * @fires Connection#open
       * @fires Connection#close
       * @fires Connection#error
       * @fires Client#inclusion
       * @fires Client#rejection
       */
      async launch() {
        connection.open();
        (await db).open();
        (await db).on('put', onTransaction);
        (await db).createKeyStream().on('data', onTransaction);
      },
    });
  };

  return clientMixin.call(connection);
};
