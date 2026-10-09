'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { parseChallenge, authorization } = require('./digest');

/**
 * Minimal RTSP client (RTP over TCP interleaved) for H.264 video.
 *
 * Emits:
 *   'sdp'   (info)                    after DESCRIBE: { sps, pps, raw }
 *   'nal'   (nal: Buffer, timestamp, flagged, marker)
 *           one complete H.264 NAL unit (no start code), its RTP timestamp (90 kHz), whether the
 *           first RTP packet of the NAL carried a Hikvision header extension (marks encrypted NALs),
 *           and whether it ends an access unit (RTP marker bit)
 *   'error' (err)
 *   'close'
 */
class RtspClient extends EventEmitter {
  constructor(url, { username, password, timeout = 10000, userAgent = 'homebridge-hikvision-dvr' } = {}) {
    super();
    this.url = new URL(url);
    this.username = username !== undefined ? username : decodeURIComponent(this.url.username);
    this.password = password !== undefined ? password : decodeURIComponent(this.url.password);
    this.url.username = '';
    this.url.password = '';
    this.timeout = timeout;
    this.userAgent = userAgent;

    this.cseq = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.challenge = null;
    this.authState = {};
    this.session = null;
    this.fuBuffer = null;
    this.closed = false;
    this.keepAliveTimer = null;
    this.dataTimer = null;
  }

  get baseUrl() {
    return this.url.toString();
  }

  async start() {
    await this._connect();
    const describe = await this._request('DESCRIBE', this.baseUrl, { Accept: 'application/sdp' });
    const sdp = describe.body.toString('utf8');
    const base = describe.headers['content-base'] || describe.headers['content-location'] || this.baseUrl;
    const track = parseSdp(sdp);
    if (!track) throw new Error('No H.264 video track in SDP');
    this.emit('sdp', { sps: track.sps, pps: track.pps, raw: sdp });

    const controlUrl = resolveControl(base, track.control);
    const setup = await this._request('SETUP', controlUrl, {
      Transport: `RTP/AVP/TCP;unicast;interleaved=${track.channel * 2}-${track.channel * 2 + 1}`,
    });
    const sessionHeader = setup.headers['session'];
    if (!sessionHeader) throw new Error('RTSP SETUP returned no Session header');
    const [session, ...params] = sessionHeader.split(';');
    this.session = session.trim();
    const timeoutParam = params.map((p) => p.trim()).find((p) => p.startsWith('timeout='));
    const sessionTimeout = timeoutParam ? parseInt(timeoutParam.slice(8), 10) : 60;
    this.rtpChannel = track.channel * 2;

    this.playBase = base;
    await this._request('PLAY', base, { Range: 'npt=0.000-' });

    const keepAliveMs = Math.max(5, Math.min(sessionTimeout, 60) - 10) * 1000;
    this.keepAliveTimer = setInterval(() => {
      this._request('GET_PARAMETER', base, {}).catch(() => { /* ignored; data watchdog handles dead links */ });
    }, keepAliveMs);
    this._kickDataWatchdog();
  }

  /** Pause a playback (recording) stream. The no-data watchdog is off until resume(). */
  async pause() {
    this.paused = true;
    clearTimeout(this.dataTimer);
    await this._request('PAUSE', this.playBase, {});
  }

  /** Resume (or change speed of) a playback stream. `scale` 2 = double speed, 0.5 = half. */
  async resume(scale = 1) {
    this.paused = false;
    await this._request('PLAY', this.playBase, scale === 1 ? {} : { Scale: String(scale) });
    this._kickDataWatchdog();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAliveTimer);
    clearTimeout(this.dataTimer);
    try {
      if (this.session && this.socket && !this.socket.destroyed) {
        this._send('TEARDOWN', this.baseUrl, {});
        this.socket.end();
      }
    } catch (e) { /* ignore */ }
    setTimeout(() => this.socket && this.socket.destroy(), 500).unref();
    for (const { reject } of this.pending.values()) reject(new Error('RTSP client stopped'));
    this.pending.clear();
  }

  _kickDataWatchdog() {
    clearTimeout(this.dataTimer);
    if (this.paused) return;
    this.dataTimer = setTimeout(() => this._fail(new Error('No RTP data received for 10s')), this.timeout);
  }

  _fail(err) {
    if (this.closed) return;
    this.emit('error', err);
    this.stop();
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const port = this.url.port ? parseInt(this.url.port, 10) : 554;
      this.socket = net.connect({ host: this.url.hostname, port });
      this.socket.setNoDelay(true);
      const timer = setTimeout(() => {
        this.socket.destroy();
        reject(new Error(`RTSP connect timeout to ${this.url.hostname}:${port}`));
      }, this.timeout);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
        this._fail(err);
      });
      this.socket.on('close', () => {
        const wasClosed = this.closed;
        this.closed = true;
        clearInterval(this.keepAliveTimer);
        clearTimeout(this.dataTimer);
        for (const { reject: r } of this.pending.values()) r(new Error('RTSP connection closed'));
        this.pending.clear();
        if (!wasClosed) this.emit('error', new Error('RTSP connection closed by DVR'));
        this.emit('close');
      });
      this.socket.on('data', (chunk) => this._onData(chunk));
    });
  }

  _send(method, url, headers) {
    const cseq = ++this.cseq;
    const lines = [`${method} ${url} RTSP/1.0`, `CSeq: ${cseq}`, `User-Agent: ${this.userAgent}`];
    if (this.session) lines.push(`Session: ${this.session}`);
    const auth = authorization(this.challenge, method, url, this.username, this.password, this.authState);
    if (auth) lines.push(`Authorization: ${auth}`);
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    this.socket.write(lines.join('\r\n') + '\r\n\r\n');
    return cseq;
  }

  async _request(method, url, headers, retried = false) {
    const res = await new Promise((resolve, reject) => {
      const cseq = this._send(method, url, headers);
      const timer = setTimeout(() => {
        this.pending.delete(cseq);
        reject(new Error(`RTSP ${method} timed out`));
      }, this.timeout);
      this.pending.set(cseq, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    if (res.status === 401 && !retried) {
      this.challenge = parseChallenge(res.headers['www-authenticate']);
      this.authState = {};
      if (!this.challenge) throw new Error('RTSP 401 without usable WWW-Authenticate challenge');
      return this._request(method, url, headers, true);
    }
    if (res.status === 401) throw new Error('RTSP authentication failed (check username/password)');
    if (res.status < 200 || res.status >= 300) throw new Error(`RTSP ${method} failed: ${res.status} ${res.reason}`);
    return res;
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length === 0) return;
      if (this.buffer[0] === 0x24) {
        if (this.buffer.length < 4) return;
        const channel = this.buffer[1];
        const length = this.buffer.readUInt16BE(2);
        if (this.buffer.length < 4 + length) return;
        const packet = this.buffer.subarray(4, 4 + length);
        this.buffer = this.buffer.subarray(4 + length);
        if (channel === this.rtpChannel) this._onRtp(packet);
        continue;
      }
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.buffer.length > 65536) this._fail(new Error('RTSP stream out of sync'));
        return;
      }
      const head = this.buffer.subarray(0, headerEnd).toString('utf8');
      if (!head.startsWith('RTSP/')) {
        // Out of sync: skip to the next '$' frame marker or response line.
        const next = this.buffer.indexOf(0x24, 1);
        this.buffer = next === -1 ? Buffer.alloc(0) : this.buffer.subarray(next);
        continue;
      }
      const lines = head.split('\r\n');
      const [, status, ...reason] = lines[0].split(' ');
      const headers = {};
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (headers[key] === undefined) headers[key] = value;
        else headers[key] = [].concat(headers[key], value);
      }
      const contentLength = parseInt(headers['content-length'] || '0', 10);
      if (this.buffer.length < headerEnd + 4 + contentLength) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + contentLength);
      this.buffer = this.buffer.subarray(headerEnd + 4 + contentLength);
      const cseq = parseInt(headers['cseq'], 10);
      const pending = this.pending.get(cseq);
      if (pending) {
        this.pending.delete(cseq);
        pending.resolve({ status: parseInt(status, 10), reason: reason.join(' '), headers, body });
      }
    }
  }

  _onRtp(packet) {
    if (packet.length < 12 || (packet[0] >> 6) !== 2) return;
    this._kickDataWatchdog();
    const csrcCount = packet[0] & 0x0f;
    const hasExtension = (packet[0] & 0x10) !== 0;
    const hasPadding = (packet[0] & 0x20) !== 0;
    const timestamp = packet.readUInt32BE(4);
    const marker = (packet[1] & 0x80) !== 0;
    let offset = 12 + csrcCount * 4;
    let flagged = false;
    if (hasExtension) {
      if (packet.length < offset + 4) return;
      flagged = packet.readUInt16BE(offset) === 0x4000;
      offset += 4 + packet.readUInt16BE(offset + 2) * 4;
    }
    let end = packet.length;
    if (hasPadding) end -= packet[packet.length - 1];
    if (offset >= end) return;
    const payload = packet.subarray(offset, end);
    const type = payload[0] & 0x1f;

    if (type >= 1 && type <= 23) {
      this.fuBuffer = null;
      this.emit('nal', Buffer.from(payload), timestamp, flagged, marker);
    } else if (type === 24) { // STAP-A
      this.fuBuffer = null;
      let p = 1;
      while (p + 2 <= payload.length) {
        const size = payload.readUInt16BE(p);
        p += 2;
        if (size === 0 || p + size > payload.length) break;
        this.emit('nal', Buffer.from(payload.subarray(p, p + size)), timestamp, flagged, marker && p + size >= payload.length);
        p += size;
      }
    } else if (type === 28) { // FU-A
      if (payload.length < 2) return;
      const start = (payload[1] & 0x80) !== 0;
      const endBit = (payload[1] & 0x40) !== 0;
      if (start) {
        this.fuBuffer = [Buffer.from([(payload[0] & 0xe0) | (payload[1] & 0x1f)]), Buffer.from(payload.subarray(2))];
        this.fuFlagged = flagged;
      } else if (this.fuBuffer) {
        this.fuBuffer.push(Buffer.from(payload.subarray(2)));
      }
      if (endBit && this.fuBuffer) {
        const nal = Buffer.concat(this.fuBuffer);
        this.fuBuffer = null;
        this.emit('nal', nal, timestamp, this.fuFlagged, marker);
      }
    }
  }
}

function parseSdp(sdp) {
  const lines = sdp.split(/\r?\n/);
  let inVideo = false;
  let mediaIndex = -1;
  let track = null;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      mediaIndex++;
      inVideo = line.startsWith('m=video');
      if (inVideo && !track) track = { control: null, channel: mediaIndex, sps: null, pps: null, payloadType: line.split(' ')[3] };
      else if (track && track.done === undefined && !inVideo) track.done = true;
      continue;
    }
    if (!inVideo || !track || track.done) continue;
    if (line.startsWith('a=control:')) track.control = line.slice(10).trim();
    const fmtp = line.match(/^a=fmtp:\d+\s+(.*)$/);
    if (fmtp) {
      const sprop = fmtp[1].split(';').map((s) => s.trim()).find((s) => s.startsWith('sprop-parameter-sets='));
      if (sprop) {
        const [sps, pps] = sprop.slice('sprop-parameter-sets='.length).split(',');
        if (sps) track.sps = Buffer.from(sps, 'base64');
        if (pps) track.pps = Buffer.from(pps, 'base64');
      }
    }
  }
  if (track) {
    // Interleaved channel numbers are assigned per SETUP, not per SDP media index; we only set up video.
    track.channel = 0;
  }
  return track;
}

function resolveControl(base, control) {
  if (!control || control === '*') return base;
  if (/^rtsp:\/\//i.test(control)) return control;
  return base.endsWith('/') ? base + control : base + '/' + control;
}

module.exports = { RtspClient, parseSdp };
