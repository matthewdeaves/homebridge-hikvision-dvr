'use strict';

const http = require('http');
const https = require('https');
const { parseChallenge, authorization } = require('./digest');

/**
 * Tiny ISAPI client with Digest/Basic auth (reuses the last challenge).
 */
class Isapi {
  constructor({ host, port = 80, https: secure = false, username, password, timeout = 8000 }) {
    this.host = host;
    this.port = port;
    this.secure = secure;
    this.username = username;
    this.password = password;
    this.timeout = timeout;
    this.challenge = null;
    this.authState = {};
  }

  _once(method, path, body) {
    return new Promise((resolve, reject) => {
      const headers = {};
      const auth = authorization(this.challenge, method, path, this.username, this.password, this.authState);
      if (auth) headers.Authorization = auth;
      if (body) {
        headers['Content-Type'] = 'application/xml';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = (this.secure ? https : http).request({
        host: this.host, port: this.port, method, path, headers, timeout: this.timeout, rejectUnauthorized: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error(`ISAPI ${path} timed out`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async request(method, path, body) {
    let res = await this._once(method, path, body);
    if (res.status === 401) {
      this.challenge = parseChallenge(res.headers['www-authenticate']);
      this.authState = {};
      if (!this.challenge) throw new Error('DVR rejected login and offered no auth method');
      res = await this._once(method, path, body);
      if (res.status === 401) {
        const err = new Error('DVR login failed – check username and password (too many failures can lock the account for 30 minutes)');
        err.code = 'AUTH';
        throw err;
      }
    }
    return res;
  }

  /**
   * Open a long-lived GET (e.g. the event stream). Resolves with { req, res } once the DVR answers 200;
   * the caller reads `res` and destroys `req` when done.
   */
  async stream(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { req, res } = await new Promise((resolve, reject) => {
        const headers = {};
        const auth = authorization(this.challenge, 'GET', path, this.username, this.password, this.authState);
        if (auth) headers.Authorization = auth;
        const req = (this.secure ? https : http).request({
          host: this.host, port: this.port, method: 'GET', path, headers, rejectUnauthorized: false,
        }, (res) => resolve({ req, res }));
        req.setTimeout(this.timeout, () => req.destroy(new Error(`ISAPI ${path} timed out`)));
        req.on('error', reject);
        req.end();
      });
      req.setTimeout(0); // connected: from here the caller's own watchdog decides
      if (res.statusCode === 200) return { req, res };
      res.resume();
      req.destroy();
      if (res.statusCode === 401 && attempt === 0) {
        this.challenge = parseChallenge(res.headers['www-authenticate']);
        this.authState = {};
        if (this.challenge) continue;
      }
      const err = new Error(`ISAPI GET ${path} -> HTTP ${res.statusCode}`);
      err.status = res.statusCode;
      throw err;
    }
    throw new Error(`ISAPI GET ${path} -> login failed`);
  }

  async get(path) {
    const res = await this.request('GET', path);
    if (res.status !== 200) {
      const err = new Error(`ISAPI GET ${path} -> HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.body;
  }

  async getXml(path) {
    return (await this.get(path)).toString('utf8');
  }

  async deviceInfo() {
    const xml = await this.getXml('/ISAPI/System/deviceInfo');
    return {
      name: tag(xml, 'deviceName'),
      model: tag(xml, 'model'),
      serial: tag(xml, 'serialNumber'),
      firmware: [tag(xml, 'firmwareVersion'), tag(xml, 'firmwareReleasedDate')].filter(Boolean).join(' '),
      mac: tag(xml, 'macAddress'),
    };
  }

  /**
   * Discover video channels. Works for analog DVRs (Video/inputs), NVRs (InputProxy) and single IP cameras.
   * Returns [{ channel: 1, name: 'Camera 01' }, ...]
   */
  async channels() {
    const found = new Map();
    const add = (id, name) => {
      if (Number.isInteger(id) && id > 0 && !found.has(id)) found.set(id, { channel: id, name: name || `Camera ${id}` });
    };
    try {
      const xml = await this.getXml('/ISAPI/System/Video/inputs/channels');
      for (const block of blocks(xml, 'VideoInputChannel')) {
        if (tag(block, 'videoInputEnabled') === 'false') continue;
        if (/NO VIDEO/i.test(tag(block, 'resDesc') || '')) continue;
        add(parseInt(tag(block, 'id'), 10), tag(block, 'name'));
      }
    } catch (e) { /* not an analog DVR */ }
    try {
      const xml = await this.getXml('/ISAPI/ContentMgmt/InputProxy/channels');
      for (const block of blocks(xml, 'InputProxyChannel')) add(parseInt(tag(block, 'id'), 10), tag(block, 'name'));
    } catch (e) { /* not an NVR */ }
    if (found.size === 0) {
      // Fall back to streaming channel list (e.g. single IP camera: 101/102)
      const xml = await this.getXml('/ISAPI/Streaming/channels');
      for (const block of blocks(xml, 'StreamingChannel')) {
        const id = parseInt(tag(block, 'id'), 10);
        if (id % 100 === 1) add(Math.floor(id / 100), tag(block, 'channelName'));
      }
    }
    return [...found.values()].sort((a, b) => a.channel - b.channel);
  }

  /** The Hik-Connect / HiLook / EZVIZ verification code used for stream encryption (needs admin). */
  async verificationCode() {
    try {
      const xml = await this.getXml('/ISAPI/System/Network/EZVIZ');
      return tag(xml, 'verificationCode') || null;
    } catch (e) {
      return null;
    }
  }

  /** Asks the DVR to send an IDR frame on a stream (Hikvision ISAPI; harmless on devices that lack it). */
  async requestKeyFrame(channel, stream = 1) {
    const res = await this.request('PUT', `/ISAPI/Streaming/channels/${channel * 100 + stream}/requestKeyFrame`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  }

  async snapshot(channel, stream = 1) {
    return this.get(`/ISAPI/Streaming/channels/${channel * 100 + stream}/picture`);
  }
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`));
  return m ? m[1].trim() : undefined;
}

function blocks(xml, name) {
  return xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, 'g')) || [];
}

module.exports = { Isapi };
