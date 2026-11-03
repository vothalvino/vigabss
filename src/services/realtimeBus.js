'use strict';

// =============================================================================
// VigaBSS 5.0 — Realtime bus across processes (SEC-24)
// =============================================================================
// SSE and WebSocket clients and GraphQL subscriptions are held by whichever
// replica the browser reached, while events are produced by any replica or by
// the worker process. Each process only told its own clients, so with two or
// more replicas a user saw an event only if it happened to be produced where
// they were connected.
//
// publish() delivers to this process's handlers at once and, with REDIS_URL
// set, posts the message on one Redis pub/sub channel; every other process
// delivers it to its own handlers. Without Redis it is local only, which is
// right for a single replica. Delivery is best effort, like the SSE stream
// itself: a message published while Redis is down reaches local clients only.
// =============================================================================

const crypto = require('crypto');
const logger = require('../utils/logger').child({ service: 'realtimeBus' });

const CHANNEL = 'vigabss:realtime';
const INSTANCE_ID = crypto.randomUUID();

/** @type {Map<string, (payload: any) => void>} */
const handlers = new Map();
let publisher = null;
let subscriber = null;
let started = false;

function deliverLocal(kind, payload) {
  const handler = handlers.get(kind);
  if (!handler) return;
  try {
    handler(payload);
  } catch (err) {
    logger.warn({ err, kind }, 'Realtime handler failed');
  }
}

function onMessage(channel, raw) {
  if (channel !== CHANNEL) return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  // This process delivered its own message already.
  if (!message || message.origin === INSTANCE_ID) return;
  deliverLocal(message.kind, message.payload);
}

function start() {
  if (started) return;
  started = true;
  const url = process.env.REDIS_URL;
  if (!url) return;
  let Redis;
  try {
    Redis = require('ioredis');
  } catch {
    logger.warn('REDIS_URL is set but ioredis is not installed: realtime events stay on this process');
    return;
  }
  publisher = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3, retryStrategy: times => Math.min(times * 200, 3000) });
  subscriber = publisher.duplicate();
  publisher.on('error', err => logger.warn({ err }, 'Realtime publisher connection error'));
  subscriber.on('error', err => logger.warn({ err }, 'Realtime subscriber connection error'));
  subscriber.on('message', onMessage);
  publisher.connect().catch(() => {});
  // ioredis re-subscribes on reconnect.
  subscriber.connect()
    .then(() => subscriber.subscribe(CHANNEL))
    .catch(err => logger.warn({ err }, 'Realtime subscribe failed; waiting for reconnect'));
}

/**
 * Handle one kind of message, from this process or any other.
 * @param {string} kind
 * @param {(payload: any) => void} handler
 */
function on(kind, handler) {
  handlers.set(kind, handler);
  start();
}

/**
 * Deliver here and to every other process. The payload crosses processes as
 * JSON: a Date arrives elsewhere as its ISO string.
 * @param {string} kind
 * @param {any} payload
 */
function publish(kind, payload) {
  deliverLocal(kind, payload);
  start();
  if (!publisher) return;
  let raw;
  try {
    raw = JSON.stringify({ origin: INSTANCE_ID, kind, payload });
  } catch (err) {
    logger.warn({ err, kind }, 'Realtime payload is not serializable; delivered locally only');
    return;
  }
  publisher.publish(CHANNEL, raw).catch(err => logger.warn({ err, kind }, 'Realtime publish failed; delivered locally only'));
}

async function close() {
  const clients = [subscriber, publisher].filter(Boolean);
  subscriber = null;
  publisher = null;
  started = false;
  await Promise.all(clients.map(c => c.quit().catch(() => c.disconnect())));
}

module.exports = { on, publish, close, CHANNEL, INSTANCE_ID, _onMessage: onMessage };
