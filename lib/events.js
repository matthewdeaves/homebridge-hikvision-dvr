'use strict';

const { EventEmitter } = require('events');

const HEARTBEAT_TIMEOUT = 60 * 1000; // DVRs send a videoloss heartbeat every few seconds
const MAX_BUFFER = 64 * 1024;

/**
 * Long-lived reader for /ISAPI/Event/notification/alertStream.
 * Emits 'alert' with { type, state, channel } for every EventNotificationAlert,
 * and reconnects by itself. Call stop() to end it.
 */
class AlertStream extends EventEmitter {
  constructor(isapi, log) {
    super();
    this.isapi = isapi;
    this.log = log;
    this.req = null;
    this.stopped = false;
    this.attempt = 0;
    this.watchdog = null;
    this.retryTimer = null;
    this.healthy = false;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.retryTimer);
    if (this.req) this.req.destroy();
    this.req = null;
  }

  async connect() {
    if (this.stopped) return;
    let buffer = '';
    try {
      const { req, res } = await this.isapi.stream('/ISAPI/Event/notification/alertStream');
      if (this.stopped) return req.destroy();
      this.req = req;
      this.attempt = 0;
      if (!this.healthy) this.log.info('Listening for motion events');
      this.healthy = true;
      this.kick();
      const fail = (e) => { if (this.req === req) this.retry(e); };

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        this.kick();
        buffer += chunk;
        let m;
        let end = 0;
        const re = /<EventNotificationAlert[\s\S]*?<\/EventNotificationAlert>/g;
        while ((m = re.exec(buffer)) !== null) {
          end = re.lastIndex;
          const alert = parseAlert(m[0]);
          if (alert) this.emit('alert', alert);
        }
        buffer = buffer.slice(end);
        if (buffer.length > MAX_BUFFER) buffer = '';
      });
      res.on('error', fail);
      res.on('end', () => fail(new Error('DVR closed the event stream')));
      req.on('error', fail);
    } catch (e) {
      this.retry(e);
    }
  }

  kick() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.req) this.req.destroy(new Error('no data from DVR for 60s'));
    }, HEARTBEAT_TIMEOUT);
  }

  retry(err) {
    if (this.stopped || this.retryTimer) return;
    clearTimeout(this.watchdog);
    if (this.req) this.req.destroy();
    this.req = null;
    this.attempt++;
    const delay = Math.min(this.attempt * 10, 120);
    // Warn once when a working stream drops; further failures go to debug until it reconnects.
    const msg = `Motion event stream: ${err.message}. Reconnecting in ${delay}s.`;
    if (this.healthy || this.attempt === 1) this.log.warn(msg);
    else this.log.debug(msg);
    this.healthy = false;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay * 1000);
  }
}

function parseAlert(xml) {
  const type = tag(xml, 'eventType');
  if (!type) return null;
  const channel = parseInt(tag(xml, 'channelID') || tag(xml, 'dynChannelID') || tag(xml, 'videoInputChannelID') || '0', 10);
  return { type, state: tag(xml, 'eventState') || 'active', channel };
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`));
  return m ? m[1].trim() : undefined;
}

module.exports = { AlertStream, parseAlert };
