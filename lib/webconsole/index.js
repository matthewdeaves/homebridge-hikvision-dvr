'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { ConsoleStream } = require('./stream');

const CLIENT_JS = path.join(__dirname, 'client.js');
const PREFIX = '/__hwp/';
const MAX_STREAMS = 8; // global safety cap; the page itself limits to 4 per tab (browsers allow 6 connections per host)
const MAX_CONTROL_BODY = 4096;
const DVR_TIME = /^\d{8}T\d{6}Z$/;
const SCALES = [0.125, 0.25, 0.5, 1, 2, 4]; // what the DVR's RTSP server accepts

/**
 * Serves the DVR's own web pages through the Pi, adding a stand-in for Hikvision's browser plugin
 * (application/hwp-webvideo-plugin), so live view, playback and area drawing work in modern browsers.
 */
class WebConsole {
  constructor(platform, port) {
    this.platform = platform;
    this.log = platform.log;
    this.port = port;
    this.streams = new Map(); // id -> ConsoleStream
    this.server = null;
    this.clientJs = null;
  }

  start() {
    this.clientJs = fs.readFileSync(CLIENT_JS);
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        // Pathname only: the query can carry the page's login (auth=). Ordinary page requests failing is routine (the DVR is slow).
        this.log[String(req.url).startsWith(PREFIX) ? 'warn' : 'debug'](`Web console: ${req.method} ${String(req.url).split('?')[0]}: ${e.message}`);
        if (!res.headersSent) res.writeHead(e.status || 502, { 'Content-Type': 'text/plain' });
        res.end(String(e.message));
      });
    });
    this.server.on('error', (e) => this.log.error(`Web console could not start on port ${this.port}: ${e.message}`));
    this.server.listen(this.port, () => this.log.info(`Web console: http://<this-homebridge>:${this.port}/`));
  }

  stop() {
    for (const s of this.streams.values()) s.stop();
    if (this.server) this.server.close();
  }

  async handle(req, res) {
    if (!req.url.startsWith(PREFIX)) return this.proxy(req, res);
    const url = new URL(req.url, 'http://x');
    const route = url.pathname.slice(PREFIX.length);

    if (route === 'client.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(this.clientJs);
    }

    // DNS rebinding guard: a page on an attacker's hostname can point it at this machine and pass same-origin checks.
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('Forbidden host');
    }

    if (route === 'autologin' && req.method === 'GET') {
      // Opt-in: hands the plugin's DVR login to the console's login page. Refuse anything but same-site requests.
      const site = req.headers['sec-fetch-site'];
      const origin = req.headers.origin;
      const foreign = (site && site !== 'same-origin' && site !== 'none') || (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host);
      if (!this.platform.webConsoleAutoLogin || foreign) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ username: this.platform.username, password: this.platform.password }));
    }

    if (route === 'stream' && req.method === 'GET') {
      if (this.streams.size >= MAX_STREAMS) throw new Error('Too many open video windows');
      const start = url.searchParams.get('start') || undefined;
      const end = url.searchParams.get('end') || undefined;
      if ((start && !DVR_TIME.test(start)) || (end && !DVR_TIME.test(end))) throw httpError(400, 'Bad start/end time');
      const creds = await this.credentials(req, url.searchParams.get('auth'));
      const stream = new ConsoleStream({
        platform: this.platform,
        url: url.searchParams.get('url') || '',
        creds,
        start,
        end,
        sub: url.searchParams.get('sub') === '1',
      });
      this.streams.set(stream.id, stream);
      res.on('close', () => this.streams.delete(stream.id));
      const onOpen = () => {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-store',
          'X-Hwp-Stream': stream.id,
          'Access-Control-Expose-Headers': 'X-Hwp-Stream, X-Hwp-Start',
          ...(stream.realStart ? { 'X-Hwp-Start': stream.realStart } : {}),
        });
        res.flushHeaders();
      };
      try {
        await stream.pipe(res, onOpen);
      } catch (e) {
        stream.stop();
        this.log.warn(`${stream.name} ${e.message}`);
        if (res.headersSent) return res.end();
        // A refusal by the DVR itself (e.g. 453 Not Enough Bandwidth: one playback at a time) goes to the page as it was.
        if (e.rtspStatus) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message, rtspStatus: e.rtspStatus, reason: e.rtspReason }));
        }
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        return res.end(String(e.message));
      }
      return undefined;
    }

    if (route === 'control' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req, MAX_CONTROL_BODY)).toString('utf8') || '{}');
      } catch (e) {
        throw httpError(e.status || 400, e.status ? e.message : 'Bad request');
      }
      if (!body || typeof body !== 'object') throw httpError(400, 'Bad request');
      const stream = this.streams.get(body.id);
      if (!stream) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end('{"error":"no such stream"}');
      }
      if (body.op === 'pause') await stream.pause();
      else if (body.op === 'resume') await stream.resume();
      else if (body.op === 'scale') await stream.setScale(nearestScale(Number(body.value) || 1));
      else if (body.op === 'stop') stream.stop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  /**
   * The page hands the plugin its login as base64 ":user:password" (digest login) or "::sessionId" (session login).
   * A user/password goes straight to the DVR's RTSP server, which checks it. A session is checked against the DVR
   * with the browser's own cookies; if it's live, the plugin's configured account opens the stream.
   */
  async credentials(req, auth) {
    const decoded = auth ? Buffer.from(auth, 'base64').toString('utf8') : '';
    const m = decoded.match(/^:([^:]+):(.*)$/s);
    if (m && m[1] !== '') return { username: m[1], password: m[2] };

    const res = await this.forward('GET', '/ISAPI/Security/userCheck', pickHeaders(req.headers, ['cookie', 'authorization']));
    res.setTimeout(15000, () => res.destroy(new Error('DVR timed out')));
    const text = (await readBody(res, 65536)).toString('utf8');
    const status = text.match(/<statusValue>\s*(\d+)\s*<\/statusValue>/i); // some firmwares answer 200 with an error body
    if (res.statusCode !== 200 || (status && status[1] !== '200')) throw httpError(401, 'Not logged in to the DVR');
    return { username: this.platform.username, password: this.platform.password };
  }

  forward(method, pathname, headers, body) {
    const p = this.platform;
    return new Promise((resolve, reject) => {
      const req = (p.https ? https : http).request({
        host: p.host, port: p.httpPort, method, path: pathname, headers: { ...headers, host: `${p.host}:${p.httpPort}` },
        rejectUnauthorized: false, timeout: 15000,
      }, (r) => {
        req.setTimeout(0); // the idle timeout only covers waiting for headers; a long video body is fine
        resolve(r);
      });
      req.on('timeout', () => req.destroy(new Error('DVR timed out')));
      req.on('error', reject);
      if (body && body.pipe) {
        body.on('error', (e) => req.destroy(e));
        body.pipe(req);
      }
      else req.end(body);
    });
  }

  async proxy(req, res) {
    const p = this.platform;
    const headers = { ...req.headers };
    delete headers['accept-encoding']; // we may need to edit HTML
    delete headers.connection;
    const dvrOrigin = `${p.https ? 'https' : 'http'}://${p.host}${p.httpPort === (p.https ? 443 : 80) ? '' : `:${p.httpPort}`}`;
    if (headers.origin) headers.origin = dvrOrigin;
    if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, dvrOrigin);

    const up = await this.forward(req.method, req.url, headers, req);
    const out = { ...up.headers };
    delete out.connection;
    if (out.location) out.location = out.location.replace(/^https?:\/\/[^/]+/, '');
    // Upstream dies mid-body -> drop the browser's connection; browser leaves -> drop upstream.
    up.on('aborted', () => res.destroy());
    up.on('error', () => res.destroy());
    res.on('close', () => { if (!up.complete) up.destroy(); });

    const type = String(out['content-type'] || '');
    const isPage = /text\/html/i.test(type) || /\.(asp|html?)(\?|$)/i.test(req.url.split('#')[0]);
    if (!isPage || req.method !== 'GET' || up.statusCode !== 200 || out['content-encoding']) {
      res.writeHead(up.statusCode, out);
      return up.pipe(res);
    }

    // Top-level pages get the plugin stand-in before any of the DVR's own scripts run.
    let html = (await readBody(up)).toString('latin1'); // byte-transparent, so non-UTF-8 pages survive
    if (/<html/i.test(html)) {
      const tag = `<script src="${PREFIX}client.js"></script>`;
      const head = /<head(\s[^>]*)?>/i;
      html = head.test(html) ? html.replace(head, (h) => h + tag) : tag + html;
    }
    const buf = Buffer.from(html, 'latin1');
    delete out['transfer-encoding'];
    out['content-length'] = buf.length;
    res.writeHead(up.statusCode, out);
    return res.end(buf);
  }
}

function nearestScale(v) {
  return SCALES.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Host header is an IP literal, localhost, this machine's name or *.local; anything else may be a DNS-rebinding page. */
function hostAllowed(header) {
  const m = String(header || '').toLowerCase().match(/^(\[[^\]]+\]|[^:]*)(?::\d+)?$/);
  if (!m) return false;
  const host = m[1].replace(/^\[|\]$/g, '');
  if (net.isIP(host) || host === 'localhost' || host.endsWith('.local')) return true;
  return host !== '' && host === os.hostname().toLowerCase().replace(/\.local$/, '');
}

function readBody(stream, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (max && size > max) {
        reject(httpError(413, 'Body too large'));
        stream.removeListener('data', onData);
        stream.resume(); // discard the rest; destroying would drop the connection before the 413 is sent
        return;
      }
      chunks.push(c);
    };
    stream.on('data', onData);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function pickHeaders(headers, names) {
  const out = {};
  for (const n of names) if (headers[n]) out[n] = headers[n];
  return out;
}

module.exports = { WebConsole };
