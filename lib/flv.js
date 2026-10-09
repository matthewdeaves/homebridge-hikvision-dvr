'use strict';

/**
 * Wraps H.264 NAL units into an FLV stream so ffmpeg gets the camera's real (RTP) timestamps
 * instead of guessing them from arrival time, which jitters when frames arrive in bursts.
 */
class FlvWriter {
  constructor(write) {
    this.write = write;
    this.headerSent = false;
    this.sps = null;
    this.pps = null;
    this.configSent = null;
    this.au = [];
    this.auTs = null;
    this.lastTs = null;
    this.ms = 0;
  }

  /**
   * @param {Buffer} nal NAL unit without start code
   * @param {number} ts RTP timestamp (90 kHz)
   * @param {boolean} last true if this NAL ends the access unit (RTP marker bit)
   */
  push(nal, ts, last = false) {
    if (this.auTs !== null && ts !== this.auTs) this.flush();
    const type = nal[0] & 0x1f;
    if (type === 7) this.sps = nal;
    if (type === 8) this.pps = nal;
    if (type === 9) return; // access unit delimiter
    this.auTs = ts;
    this.au.push(nal);
    if (last) this.flush();
  }

  setParameterSets(sps, pps) {
    if (sps) this.sps = sps;
    if (pps) this.pps = pps;
  }

  flush() {
    if (!this.au.length) return;
    const nals = this.au;
    const ts = this.auTs;
    this.au = [];
    this.auTs = null;
    if (!this.sps || !this.pps) return;

    if (this.lastTs !== null) {
      const delta = (ts - this.lastTs) | 0; // handles 32-bit wrap
      if (delta > 0 && delta < 90000 * 5) this.ms += delta / 90;
      else this.ms += 40; // jump or reset in the camera clock: assume one frame
    }
    this.lastTs = ts;
    const time = Math.round(this.ms);

    if (!this.headerSent) {
      this.write(Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x01, 0, 0, 0, 9, 0, 0, 0, 0]));
      this.headerSent = true;
    }
    const config = Buffer.concat([this.sps, this.pps]);
    if (!this.configSent || !this.configSent.equals(config)) {
      this.configSent = config;
      const sps = this.sps;
      const record = Buffer.concat([
        Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]), sps,
        Buffer.from([1, this.pps.length >> 8, this.pps.length & 0xff]), this.pps,
      ]);
      this._tag(time, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), record]));
    }

    const key = nals.some((n) => (n[0] & 0x1f) === 5);
    const parts = [Buffer.from([key ? 0x17 : 0x27, 1, 0, 0, 0])];
    for (const nal of nals) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(nal.length);
      parts.push(len, nal);
    }
    this._tag(time, Buffer.concat(parts));
  }

  _tag(time, data) {
    const header = Buffer.alloc(11);
    header[0] = 9;
    header.writeUIntBE(data.length, 1, 3);
    header.writeUIntBE(time & 0xffffff, 4, 3);
    header[7] = (time >>> 24) & 0xff;
    const prev = Buffer.alloc(4);
    prev.writeUInt32BE(11 + data.length);
    this.write(Buffer.concat([header, data, prev]));
  }
}

module.exports = { FlvWriter };
