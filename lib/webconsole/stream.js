'use strict';

const crypto = require('crypto');
const { RtspClient } = require('../rtsp');
const { HikDecryptor } = require('../hikcrypt');
const { FlvWriter } = require('../flv');
const { spawn } = require('../ffmpeg');

/**
 * One browser video window: DVR RTSP (live or playback) -> decrypt -> ffmpeg (copy) -> fragmented MP4.
 * The fMP4 bytes go to `res`, where the page's Media Source player picks them up.
 */
class ConsoleStream {
  /**
   * @param {object} opts
   * @param {object} opts.platform  plugin platform (host, rtspPort, verificationCode, ffmpeg, log, debug)
   * @param {string} opts.url       stream URL the page asked the plugin to play
   * @param {{username: string, password: string}} opts.creds
   * @param {string} [opts.start]   playback start, yyyyMMddThhmmssZ
   * @param {string} [opts.end]     playback end
   * @param {boolean} [opts.sub]    live only: use the channel's sub stream instead of the main stream the page asked for
   */
  constructor({ platform, url, creds, start, end, sub }) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.platform = platform;
    this.log = platform.log;
    this.creds = creds;
    this.trackId = parseTrackId(url);
    if (!this.trackId) throw new Error(`Can't find a channel in "${url}"`);
    this.playback = Boolean(start);
    if (sub && !this.playback && this.trackId % 100 === 1) this.trackId += 1; // 101 -> 102
    this.start = start;
    this.end = end;
    this.rtsp = null;
    this.ffmpeg = null;
    this.stopped = false;
    this.paused = false;
    this.scale = 1;
    this.res = null;
  }

  get rtspUrl() {
    const { host, rtspPort } = this.platform;
    if (!this.playback) return `rtsp://${host}:${rtspPort}/Streaming/Channels/${this.trackId}`;
    const q = `starttime=${this.start}${this.end ? `&endtime=${this.end}` : ''}`;
    return `rtsp://${host}:${rtspPort}/Streaming/tracks/${this.trackId}?${q}`;
  }

  get name() {
    return `[Web console ch ${this.trackId}${this.playback ? ' playback' : ''}]`;
  }

  /** Opens the DVR stream and pipes fMP4 into `res` (an http.ServerResponse); `onOpen` writes the headers. */
  async pipe(res, onOpen) {
    this.res = res;
    const p = this.platform;
    const logLevel = ['-hide_banner', '-loglevel', p.debug ? 'warning' : 'error'];
    this.ffmpeg = spawn(p.ffmpeg, [...logLevel, '-fflags', '+nobuffer+discardcorrupt+genpts', '-probesize', '32768',
      '-analyzeduration', '0', '-f', 'flv', '-i', 'pipe:0', '-an', '-sn', '-dn', '-c:v', 'copy',
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    const ff = this.ffmpeg;
    ff.stdin.on('error', () => { /* EPIPE when ffmpeg exits */ });
    ff.stderr.on('data', (d) => this.log.debug(`${this.name} ffmpeg: ${String(d).trim()}`));
    ff.on('error', (e) => this.fail(new Error(`ffmpeg failed to start: ${e.message}`)));
    ff.on('exit', () => this.stop());
    res.on('close', () => this.stop());

    const decryptor = new HikDecryptor(p.verificationCode);
    const flv = new FlvWriter((buf) => {
      if (ff.stdin.writable && ff.exitCode === null) ff.stdin.write(buf);
    });
    let started = false;
    let sawFlag = false;
    const rtsp = new RtspClient(this.rtspUrl, { ...this.creds, userAgent: 'homebridge-hikvision-dvr web console' });
    this.rtsp = rtsp;
    rtsp.on('sdp', (sdp) => flv.setParameterSets(sdp.sps, sdp.pps));
    rtsp.on('nal', (nal, ts, flagged, marker) => {
      // Playback streams are plain; the decryptor's self-check alone would garble ~1 NAL in 256 there.
      if (flagged) sawFlag = true;
      const plain = sawFlag ? decryptor.process(nal, flagged) : nal;
      const type = plain[0] & 0x1f;
      if (!started) {
        if (type !== 7 && type !== 8 && type !== 5) return;
        started = true;
      }
      flv.push(plain, ts, marker);
    });
    rtsp.on('error', (e) => this.fail(e));

    await rtsp.start();
    this.log.debug(`${this.name} streaming ${this.rtspUrl}`);
    // The response only starts once the DVR has accepted the stream, so a refusal reaches the page as an HTTP error.
    if (onOpen) onOpen();
    ff.stdout.on('data', (chunk) => {
      if (!res.writableEnded && !res.write(chunk)) {
        // Browser not keeping up (or paused): stop reading until it drains.
        ff.stdout.pause();
        res.once('drain', () => ff.stdout.resume());
      }
    });
  }

  async pause() {
    if (!this.playback || this.paused || !this.rtsp) return;
    this.paused = true;
    await this.rtsp.pause();
  }

  async resume() {
    if (!this.playback || !this.paused || !this.rtsp) return;
    this.paused = false;
    await this.rtsp.resume(this.scale);
  }

  /** Playback speed: 1/8 .. 8. The browser also sets playbackRate, the DVR sends faster or slower. */
  async setScale(scale) {
    if (!this.playback || !this.rtsp) return;
    this.scale = scale;
    if (!this.paused) await this.rtsp.resume(scale);
  }

  fail(err) {
    if (this.stopped) return;
    // A playback stream that runs past the end of the recording just closes; that's not worth an error.
    if (this.playback) this.log.debug(`${this.name} ended: ${err.message}`);
    else this.log.warn(`${this.name} ${err.message}`);
    this.stop();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.rtsp) this.rtsp.stop();
    if (this.ffmpeg) {
      const ff = this.ffmpeg;
      try { ff.stdin.end(); } catch (e) { /* ignore */ }
      ff.kill('SIGTERM');
      setTimeout(() => ff.exitCode === null && ff.kill('SIGKILL'), 2000).unref();
    }
    if (this.res && this.res.headersSent && !this.res.writableEnded) this.res.end();
  }
}

/**
 * RTSP track id: 101 = channel 1 main stream, 102 = sub stream, etc. Accepts the URL forms the DVR's pages use:
 * rtsp .../channels/101, and the secure-HTTP form /SDK/play/100/004 or /SDK/playback/100 (id is stream - 1 there).
 */
function parseTrackId(url) {
  const sdk = String(url).match(/\/SDK\/play(?:back)?\/(\d{3,})/i);
  if (sdk) return parseInt(sdk[1], 10) + 1;
  const m = String(url).match(/(?:channels|tracks|playback)\/(\d{3,})/i);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = { ConsoleStream, parseTrackId };
