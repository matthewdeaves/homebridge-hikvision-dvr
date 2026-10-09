'use strict';

const dgram = require('dgram');
const crypto = require('crypto');
const { RtspClient } = require('./rtsp');
const { HikDecryptor } = require('./hikcrypt');
const { FlvWriter } = require('./flv');
const { run, spawn, AnnexBSplitter } = require('./ffmpeg');

const START_CODE = Buffer.from([0, 0, 0, 1]);
const PROFILES = ['baseline', 'main', 'high'];
const LEVELS = ['3.1', '3.2', '4.0'];
const SOFTWARE_MAX_WIDTH = 640; // auto mode: views up to this width use libx264 even on a Pi
const HW_TIMEOUT = 6000; // ms to wait for the hardware encoder's first output

/**
 * HomeKit camera streaming delegate for one DVR channel.
 */
class HikCamera {
  constructor(platform, channel, name) {
    this.platform = platform;
    this.log = platform.log;
    this.hap = platform.api.hap;
    this.channel = channel;
    this.name = name;
    this.pending = new Map();
    this.sessions = new Map();
    this.snapshotCache = null;
    this.snapshotPromise = null;
    this.motionService = null;
    this.motionTimer = null;

    const hap = this.hap;
    const resolutions = [
      [1920, 1080, 30], [1280, 720, 30], [640, 360, 30], [480, 270, 30], [320, 180, 30],
      [1280, 960, 30], [1024, 768, 30], [640, 480, 30], [480, 360, 30], [320, 240, 15],
    ];
    this.controller = new hap.CameraController({
      cameraStreamCount: platform.maxStreams,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions,
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
      },
    });
  }

  rtspUrl(stream) {
    const { host, rtspPort } = this.platform;
    return `rtsp://${host}:${rtspPort}/Streaming/Channels/${this.channel * 100 + stream}`;
  }

  // ---------- motion ----------

  setMotionService(service) {
    this.motionService = service;
    service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
  }

  /** Called for every "active" motion event; stays on until `timeout` seconds pass with no new event. */
  motionDetected(timeout) {
    if (!this.motionService) return;
    if (!this.motionTimer) {
      this.log.info(`[${this.name}] Motion detected`);
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, true);
    }
    clearTimeout(this.motionTimer);
    this.motionTimer = setTimeout(() => {
      this.motionTimer = null;
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      this.log.debug(`[${this.name}] Motion cleared`);
    }, timeout * 1000);
  }

  // ---------- snapshots ----------

  async handleSnapshotRequest(request, callback) {
    try {
      callback(undefined, await this.snapshot(request.width, request.height));
    } catch (e) {
      this.log.warn(`[${this.name}] Snapshot failed: ${e.message}`);
      if (this.snapshotCache) callback(undefined, this.snapshotCache.image);
      else callback(e);
    }
  }

  async snapshot(width, height) {
    if (this.snapshotCache && Date.now() - this.snapshotCache.time < 5000 && this.snapshotCache.w === width) {
      return this.snapshotCache.image;
    }
    if (!this.snapshotPromise) {
      this.snapshotPromise = (async () => {
        const jpeg = await this.platform.isapi.snapshot(this.channel, 1);
        let image = jpeg;
        try {
          // DVR snapshots are 4:3 (e.g. 704x576) even for 16:9 cameras; scale to the size HomeKit asked for.
          image = await run(this.platform.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0',
            '-vf', `scale=${width}:${height}`, '-frames:v', '1', '-q:v', '4', '-f', 'mjpeg', 'pipe:1'], { input: jpeg, timeout: 8000 });
        } catch (e) {
          this.log.debug(`[${this.name}] Snapshot resize failed, using original: ${e.message}`);
        }
        this.snapshotCache = { image, time: Date.now(), w: width };
        return image;
      })().finally(() => { this.snapshotPromise = null; });
    }
    return this.snapshotPromise;
  }

  // ---------- streaming ----------

  async prepareStream(request, callback) {
    try {
      const socket = dgram.createSocket(request.addressVersion === 'ipv6' ? 'udp6' : 'udp4');
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, () => { socket.removeListener('error', reject); resolve(); });
      });
      socket.on('error', (e) => this.log.debug(`[${this.name}] RTCP socket error: ${e.message}`));
      const ssrc = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff || 1;
      this.pending.set(request.sessionID, {
        address: request.targetAddress,
        port: request.video.port,
        srtp: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64'),
        ssrc,
        socket,
      });
      callback(undefined, {
        video: { port: socket.address().port, ssrc, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
      });
    } catch (e) {
      this.log.error(`[${this.name}] Failed to prepare stream: ${e.message}`);
      callback(e);
    }
  }

  handleStreamRequest(request, callback) {
    switch (request.type) {
      case 'start': {
        const info = this.pending.get(request.sessionID);
        this.pending.delete(request.sessionID);
        if (!info) return callback(new Error('Unknown session'));
        this.startStream(request.sessionID, info, request.video, callback);
        break;
      }
      case 'reconfigure':
        callback();
        break;
      case 'stop':
        this.stopStream(request.sessionID);
        callback();
        break;
      default:
        callback();
    }
  }

  startStream(sessionID, info, video, callback) {
    const p = this.platform;
    const useSub = p.subStreamMaxWidth > 0 && video.width <= p.subStreamMaxWidth;
    const stream = useSub ? 2 : 1;
    // 'h264_v4l2m2m' | 'libx264' | 'copy'. Small views are cheap in software and start faster, and the Pi's hardware
    // encoder can wedge (no output, ever) after a kernel driver error, so only auto-pick it for larger views.
    let mode = p.encoder;
    if (mode === 'h264_v4l2m2m' && (p.hwBroken || (p.encoderAuto && video.width <= SOFTWARE_MAX_WIDTH))) mode = 'libx264';
    const fps = Math.min(video.fps, 25);
    // iOS often asks for ~300 kbps even on Wi-Fi, which looks poor; apply a resolution-based floor.
    const floor = p.minBitrate !== undefined ? p.minBitrate : video.width >= 1280 ? 1200 : video.width >= 640 ? 600 : 300;
    const bitrate = Math.max(video.max_bit_rate, floor, 100);
    const log = this.log;
    const tag = `[${this.name}]`;

    log.info(`${tag} Starting ${video.width}x${video.height}@${fps} ${bitrate}kbps from ${useSub ? 'sub' : 'main'} stream (${mode})`);

    const session = { procs: [], rtsp: null, socket: info.socket, timer: null, stopped: false };
    this.sessions.set(sessionID, session);

    const srtpOut = ['-payload_type', String(video.pt), '-ssrc', String(info.ssrc), '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', info.srtp,
      `srtp://${info.address}:${info.port}?rtcpport=${info.port}&pkt_size=${video.mtu}`];
    const logLevel = ['-hide_banner', '-loglevel', p.debug ? 'warning' : 'error'];
    // Decrypted camera video arrives as FLV carrying the DVR's own timestamps.
    // showall: the DVR's keyframes carry no recovery point, so without it the decoder drops ~1 s of frames before the first output.
    const input = [...logLevel, '-fflags', '+nobuffer+discardcorrupt', '-flags', 'low_delay', '-flags2', '+showall',
      '-probesize', '32768', '-analyzeduration', '0', '-f', 'flv', '-i', 'pipe:0', '-an', '-sn', '-dn'];
    const scale = `scale=${video.width}:${video.height}:flags=fast_bilinear,format=yuv420p`;

    let first; // the ffmpeg process fed by the RTSP stream
    let flv;
    let sdp = null;
    const launch = (mode) => {
      if (mode === 'copy') {
        // DVR main streams are often anamorphic (e.g. 960x1080 "1080P Lite"); tell the player the display aspect is 16:9.
        first = this.spawn(session, [...input, '-c:v', 'copy', '-bsf:v', `h264_metadata=sample_aspect_ratio=${useSub ? '16/11' : '2/1'}`, ...srtpOut]);
      } else if (mode === 'libx264') {
        first = this.spawn(session, [...input, '-vf', scale, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
          '-profile:v', PROFILES[video.profile] || 'main', '-level:v', LEVELS[video.level] || '3.1', '-bf', '0',
          '-r', String(fps), '-g', String(fps * 2), '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
          ...srtpOut]);
      } else {
        // Pi hardware encoder doesn't repeat SPS/PPS before keyframes, which HomeKit needs.
        // Encode to a pipe, re-insert SPS/PPS in Node, and let a second (copy-only) ffmpeg do SRTP.
        // The encoder output is constant frame rate, so the sender can number frames itself.
        const sender = this.spawn(session, [...logLevel, '-fflags', '+nobuffer', '-probesize', '32768', '-analyzeduration', '0',
          '-f', 'h264', '-framerate', String(fps), '-i', 'pipe:0', '-c:v', 'copy', ...srtpOut]);
        first = this.spawn(session, [...input, '-vf', scale, '-r', String(fps), '-c:v', 'h264_v4l2m2m', '-g', String(fps * 2),
          '-b:v', `${bitrate}k`, '-f', 'h264', 'pipe:1']);
        let sps = null;
        let pps = null;
        let lastWasParam = false;
        const splitter = new AnnexBSplitter((nal) => {
          const type = nal[0] & 0x1f;
          if (type === 7) sps = Buffer.from(nal);
          if (type === 8) pps = Buffer.from(nal);
          if (type === 5 && !lastWasParam && sps && pps) {
            write(sender, Buffer.concat([START_CODE, sps, START_CODE, pps]));
          }
          lastWasParam = type === 7 || type === 8;
          write(sender, Buffer.concat([START_CODE, nal]));
        });
        first.stdout.on('data', (chunk) => {
          splitter.push(chunk);
          clearTimeout(session.hwTimer);
        });
        // No encoded output at all means the hardware encoder is wedged: switch this session to libx264 (and later ones).
        session.hwTimer = setTimeout(() => {
          if (session.stopped) return;
          p.hwBroken = true;
          log.warn(`${tag} Hardware encoder produced no video in ${HW_TIMEOUT / 1000}s (the Pi's video driver may need a reboot), using libx264`);
          for (const proc of session.procs.splice(0)) {
            proc.replaced = true;
            proc.kill('SIGTERM');
            setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 5000).unref();
          }
          started = false;
          launch('libx264');
        }, HW_TIMEOUT);
      }
      flv = new FlvWriter((buf) => write(first, buf));
      if (sdp) flv.setParameterSets(sdp.sps, sdp.pps);
    };

    let started = false;
    launch(mode);

    // RTSP -> decrypt -> ffmpeg
    const decryptor = new HikDecryptor(p.verificationCode);
    const rtsp = new RtspClient(this.rtspUrl(stream), { username: p.username, password: p.password });
    session.rtsp = rtsp;
    let warnedEncrypted = false;
    rtsp.on('sdp', (s) => {
      sdp = s;
      flv.setParameterSets(s.sps, s.pps);
    });
    rtsp.on('nal', (nal, ts, flagged, marker) => {
      if (flagged && !p.verificationCode && !warnedEncrypted) {
        warnedEncrypted = true;
        log.error(`${tag} This stream is encrypted but no verification code is known. Enter it in the plugin settings.`);
      }
      const plain = decryptor.process(nal, flagged);
      const type = plain[0] & 0x1f;
      if (!started) {
        if (type !== 7 && type !== 8 && type !== 5) return; // start on a keyframe
        started = true;
      }
      flv.push(plain, ts, marker);
    });
    rtsp.on('error', (e) => {
      if (session.stopped) return;
      log.error(`${tag} DVR stream error: ${e.message}`);
      this.forceStop(sessionID);
    });

    rtsp.start().then(() => {
      log.debug(`${tag} RTSP playing ${this.rtspUrl(stream)}`);
      callback();
    }).catch((e) => {
      log.error(`${tag} Could not open DVR stream: ${e.message}`);
      this.stopStream(sessionID);
      callback(e);
    });

    // Stop if the iPhone stops sending RTCP (app closed, network gone).
    const timeoutMs = Math.max(video.rtcp_interval * 10, 30) * 1000;
    const kick = () => {
      clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        log.info(`${tag} No RTCP from viewer for ${timeoutMs / 1000}s, stopping stream`);
        this.forceStop(sessionID);
      }, timeoutMs);
    };
    info.socket.on('message', kick);
    kick();
  }

  spawn(session, args) {
    const tag = `[${this.name}]`;
    this.log.debug(`${tag} ffmpeg ${args.join(' ').replace(/srtp_out_params \S+/, 'srtp_out_params ***')}`);
    const proc = spawn(this.platform.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.on('error', () => { /* EPIPE when ffmpeg exits */ });
    proc.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (text) this.log[this.platform.debug ? 'info' : 'debug'](`${tag} ffmpeg: ${text}`);
    });
    proc.on('error', (e) => this.log.error(`${tag} Failed to start ffmpeg (${this.platform.ffmpeg}): ${e.message}`));
    proc.on('exit', (code, signal) => {
      if (!session.stopped && !proc.replaced && code !== 0) {
        this.log.error(`${tag} ffmpeg exited unexpectedly (code ${code}, signal ${signal}). Enable debug for details.`);
        for (const [id, s] of this.sessions) if (s === session) this.forceStop(id);
      }
    });
    session.procs.push(proc);
    return proc;
  }

  forceStop(sessionID) {
    if (!this.sessions.has(sessionID)) return;
    this.stopStream(sessionID);
    try {
      this.controller.forceStopStreamingSession(sessionID);
    } catch (e) { /* session may already be gone */ }
  }

  stopStream(sessionID) {
    const pending = this.pending.get(sessionID);
    if (pending) {
      this.pending.delete(sessionID);
      try { pending.socket.close(); } catch (e) { /* ignore */ }
    }
    const session = this.sessions.get(sessionID);
    if (!session) return;
    this.sessions.delete(sessionID);
    session.stopped = true;
    clearTimeout(session.timer);
    if (session.rtsp) session.rtsp.stop();
    for (const proc of session.procs) {
      try { proc.stdin.end(); } catch (e) { /* ignore */ }
      proc.kill('SIGTERM');
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 5000).unref();
    }
    clearTimeout(session.hwTimer);
    try { session.socket.close(); } catch (e) { /* ignore */ }
    this.log.info(`[${this.name}] Stream stopped`);
  }

  shutdown() {
    clearTimeout(this.motionTimer);
    for (const id of [...this.sessions.keys()]) this.stopStream(id);
  }
}

function write(proc, buf) {
  if (proc.stdin.writable && proc.exitCode === null) proc.stdin.write(buf);
}

module.exports = { HikCamera };
