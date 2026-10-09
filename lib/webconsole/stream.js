'use strict';

const crypto = require('crypto');
const { RtspClient } = require('../rtsp');
const { HikDecryptor } = require('../hikcrypt');
const { FlvWriter } = require('../flv');
const { spawn } = require('../ffmpeg');

const MAX_STDIN_BACKLOG = 2 * 1024 * 1024; // bytes queued for ffmpeg before we give up on a stalled pipeline
const MAX_RES_BACKLOG = 4 * 1024 * 1024; // bytes queued for a browser that isn't reading

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
    ff.on('exit', () => this.stop(true));
    res.on('close', () => this.stop());

    const decryptor = new HikDecryptor(p.verificationCode);
    const flv = new FlvWriter((buf) => {
      if (this.stopped) return;
      if (ff.stdin.writableLength > MAX_STDIN_BACKLOG) {
        this.log.debug(`${this.name} browser not keeping up, stopping`);
        this.stop();
        return;
      }
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
      if (res.writableEnded) return;
      if (res.writableLength > MAX_RES_BACKLOG) {
        this.log.debug(`${this.name} browser not keeping up, stopping`);
        this.stop();
        return;
      }
      if (!res.write(chunk)) {
        // Browser not keeping up (or paused): stop reading until it drains.
        ff.stdout.pause();
        res.once('drain', () => ff.stdout.resume());
      }
    });
  }

  async pause() {
    if (!this.playback || this.paused || !this.rtsp) return;
    this.paused = true;
    try {
      await this.rtsp.pause();
    } catch (e) {
      this.paused = false;
      this.fail(e);
      throw e;
    }
  }

  async resume() {
    if (!this.playback || !this.paused || !this.rtsp) return;
    this.paused = false;
    try {
      await this.rtsp.resume(this.scale);
    } catch (e) {
      this.paused = true;
      this.fail(e);
      throw e;
    }
  }

  /** Playback speed: 1/8 .. 8. The browser also sets playbackRate, the DVR sends faster or slower. */
  async setScale(scale) {
    if (!this.playback || !this.rtsp) return;
    const old = this.scale;
    this.scale = scale;
    if (this.paused) return;
    try {
      await this.rtsp.resume(scale);
    } catch (e) {
      this.scale = old;
      this.fail(e);
      throw e;
    }
  }

  fail(err) {
    if (this.stopped) return;
    // A playback stream that runs past the end of the recording just closes; that's not worth an error.
    if (this.playback) this.log.debug(`${this.name} ended: ${err.message}`);
    else this.log.warn(`${this.name} ${err.message}`);
    this.stop(true);
  }

  /** `drain`: the DVR side ended, so let ffmpeg flush its last fragment to the browser before closing. */
  stop(drain = false) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.rtsp) this.rtsp.stop();
    const res = this.res;
    const closeRes = () => { if (res && res.headersSent && !res.writableEnded) res.end(); };
    if (this.ffmpeg) {
      const ff = this.ffmpeg;
      try { ff.stdin.end(); } catch (e) { /* ignore */ }
      if (drain && ff.stdout && !ff.stdout.readableEnded && !ff.stdout.destroyed) {
        // EOF on stdin makes ffmpeg finish its fragment and exit; end the response once its output is read.
        ff.stdout.once('end', closeRes);
        setTimeout(closeRes, 1500).unref();
      } else {
        ff.kill('SIGTERM');
        closeRes();
      }
      setTimeout(() => ff.exitCode === null && ff.kill('SIGKILL'), 2000).unref();
      return;
    }
    closeRes();
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
