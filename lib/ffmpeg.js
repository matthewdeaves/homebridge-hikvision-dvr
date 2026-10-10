'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');

function resolveFfmpeg(configured) {
  if (configured) return configured;
  try {
    const bundled = require('ffmpeg-for-homebridge');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (e) { /* optional */ }
  return 'ffmpeg';
}

function run(ffmpeg, args, { input, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeout);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
    proc.stdin.on('error', () => { /* ignore EPIPE */ });
    proc.stdin.end(input);
  });
}

const VAAPI_CANDIDATES = ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];

function isPi() {
  return fs.existsSync('/dev/video11'); // the Pi's V4L2 M2M encoder node
}

/** The first DRM render node (normally /dev/dri/renderD128), or null when there is no usable GPU. */
function findRenderNode() {
  try {
    const nodes = fs.readdirSync('/dev/dri').filter((n) => /^renderD\d+$/.test(n)).sort();
    return nodes.length ? `/dev/dri/${nodes[0]}` : null;
  } catch (e) {
    return null;
  }
}

function listEncoders(ffmpeg) {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 10000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** Real 1-second GPU encode, exactly the way a stream uses it (software frames uploaded to the GPU). */
async function testVaapi(ffmpeg, device) {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-init_hw_device', `vaapi=va:${device}`, '-filter_hw_device', 'va',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '1', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi',
    '-b:v', '500k', '-f', 'null', '-']);
}

/**
 * Looks for an ffmpeg that can encode H.264 on the Intel/AMD GPU (VAAPI) and proves it with a real test encode.
 * Never on a Raspberry Pi. When the user set videoProcessor only that ffmpeg is tried; otherwise the bundled ffmpeg
 * (which has no VAAPI) is skipped in favour of a system ffmpeg that has it. The ffmpeg must also have libx264 (the fallback).
 * Resolves to { ffmpeg, device } or null.
 */
async function findVaapi(configured, log) {
  if (isPi()) return null;
  const device = findRenderNode();
  if (!device) return null;
  const candidates = configured ? [configured] : VAAPI_CANDIDATES.filter((c, i) => !c.startsWith('/') || fs.existsSync(c) || i === 0);
  for (const ffmpeg of candidates) {
    const encoders = await listEncoders(ffmpeg);
    if (!/h264_vaapi/.test(encoders)) continue;
    if (!/libx264/.test(encoders)) {
      log.debug(`${ffmpeg} has h264_vaapi but no libx264 (needed as the fallback), skipping it`);
      continue;
    }
    try {
      await testVaapi(ffmpeg, device);
      return { ffmpeg, device };
    } catch (e) {
      log.debug(`GPU encode test with ${ffmpeg} on ${device} failed: ${e.message}`);
    }
  }
  return null;
}

/** Pick the best working H.264 encoder: Raspberry Pi hardware encoder if it actually works, else libx264. */
async function detectEncoder(ffmpeg, log) {
  const encoders = await new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 10000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
  if (!encoders) throw new Error(`Cannot run ffmpeg at "${ffmpeg}"`);
  if (/h264_v4l2m2m/.test(encoders) && fs.existsSync('/dev/video11')) {
    try {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '1',
        '-pix_fmt', 'yuv420p', '-c:v', 'h264_v4l2m2m', '-b:v', '500k', '-f', 'null', '-']);
      return 'h264_v4l2m2m';
    } catch (e) {
      log.debug(`Hardware encoder test failed: ${e.message}`);
    }
  }
  if (/libx264/.test(encoders)) return 'libx264';
  throw new Error('ffmpeg has no usable H.264 encoder (need libx264 or h264_v4l2m2m)');
}

/**
 * Splits an Annex B byte stream into NAL units (without start codes).
 * Only use on plaintext streams (start codes can't appear inside NAL payloads there).
 */
class AnnexBSplitter {
  constructor(onNal) {
    this.onNal = onNal;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = findStart(this.buf, 0);
    if (start === -1) return;
    for (;;) {
      const next = findStart(this.buf, start.end);
      if (next === -1) break;
      this.onNal(this.buf.subarray(start.end, next.begin));
      start = next;
    }
    this.buf = this.buf.subarray(start.begin);
  }
}

function findStart(buf, from) {
  const i = buf.indexOf(Buffer.from([0, 0, 1]), from);
  if (i === -1) return -1;
  const begin = i > 0 && buf[i - 1] === 0 ? i - 1 : i;
  return { begin, end: i + 3 };
}

module.exports = { resolveFfmpeg, run, detectEncoder, findVaapi, isPi, AnnexBSplitter, spawn };
