'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { ConsoleStream } = require('./stream');

const CLIENT_JS = path.join(__dirname, 'client.js');
const PREFIX = '/__hwp/';
const MAX_STREAMS = 8;

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
  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.log.warn(`Web console: ${req.method} ${req.url}: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
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
      return fs.createReadStream(CLIENT_JS).pipe(res);
    }

    if (route === 'stream' && req.method === 'GET') {
      if (this.streams.size >= MAX_STREAMS) throw new Error('Too many open video windows');
      const creds = await this.credentials(req, url.searchParams.get('auth'));
      const stream = new ConsoleStream({
        platform: this.platform,
        url: url.searchParams.get('url') || '',
        creds,
        start: url.searchParams.get('start') || undefined,
        end: url.searchParams.get('end') || undefined,
      });
      this.streams.set(stream.id, stream);
      res.on('close', () => this.streams.delete(stream.id));
      const onOpen = () => {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-store',
          'X-Hwp-Stream': stream.id,
          'Access-Control-Expose-Headers': 'X-Hwp-Stream',
        });
        res.flushHeaders();
      };
      try {
        await stream.pipe(res, onOpen);
      } catch (e) {
        stream.stop();
        this.log.warn(`${stream.name} ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(String(e.message));
      }
      return undefined;
    }

    if (route === 'control' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const stream = this.streams.get(body.id);
      if (!stream) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end('{"error":"no such stream"}');
      }
      if (body.op === 'pause') await stream.pause();
      else if (body.op === 'resume') await stream.resume();
      else if (body.op === 'scale') await stream.setScale(Number(body.value) || 1);
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
    res.resume();
    if (res.statusCode !== 200) {
      const err = new Error('Not logged in to the DVR');
      err.status = 401;
      throw err;
    }
    return { username: this.platform.username, password: this.platform.password };
  }

  forward(method, pathname, headers, body) {
    const p = this.platform;
    return new Promise((resolve, reject) => {
      const req = (p.https ? https : http).request({
        host: p.host, port: p.httpPort, method, path: pathname, headers: { ...headers, host: `${p.host}:${p.httpPort}` },
        rejectUnauthorized: false, timeout: 15000,
      }, resolve);
      req.on('timeout', () => req.destroy(new Error('DVR timed out')));
      req.on('error', reject);
      if (body && body.pipe) body.pipe(req);
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

    const type = String(out['content-type'] || '');
    const isPage = /text\/html/i.test(type) || /\.(asp|html?)(\?|$)/i.test(req.url.split('#')[0]);
    if (!isPage || req.method !== 'GET' || up.statusCode !== 200) {
      res.writeHead(up.statusCode, out);
      return up.pipe(res);
    }

    // Top-level pages get the plugin stand-in before any of the DVR's own scripts run.
    let html = (await readBody(up)).toString('utf8');
    if (/<html/i.test(html)) {
      const tag = `<script src="${PREFIX}client.js"></script>`;
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + tag) : tag + html;
    }
    const buf = Buffer.from(html, 'utf8');
    delete out['transfer-encoding'];
    out['content-length'] = buf.length;
    res.writeHead(up.statusCode, out);
    return res.end(buf);
  }
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
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
