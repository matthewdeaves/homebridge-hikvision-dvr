/*
 * homebridge-hikvision-dvr web console: a stand-in for Hikvision's browser plugin.
 *
 * The DVR's pages look for the NPAPI type application/hwp-webvideo-plugin, add an <embed> of it, and call
 * HWP_* methods on that element. This script runs before the page's own scripts, says the plugin is installed,
 * and implements the methods: video comes from the Homebridge plugin as fragmented MP4 and plays in <video>
 * through Media Source Extensions. Area drawing (motion grid, privacy mask, tamper) is done on a canvas.
 */
(function () {
  'use strict';
  if (window.__hwpConsole) return;
  window.__hwpConsole = true;

  var MIME = 'application/hwp-webvideo-plugin';
  var PREFIX = '/__hwp/';
  var MediaSourceImpl = window.MediaSource || window.ManagedMediaSource;
  var lastError = 0;

  // ---------- plugin detection ----------

  (function patchDetection() {
    var fake = { type: MIME, description: 'Hikvision web video (Homebridge web console)', suffixes: '' };
    fake.enabledPlugin = { name: 'Homebridge web console', description: fake.description, filename: '', length: 1, 0: fake };
    var list = [];
    try { for (var i = 0; i < navigator.mimeTypes.length; i++) list.push(navigator.mimeTypes[i]); } catch (e) { /* none */ }
    list.push(fake);
    list[MIME] = fake;
    list.namedItem = function (n) { return n === MIME ? fake : null; };
    list.item = function (i) { return list[i] || null; };
    try { Object.defineProperty(navigator, 'mimeTypes', { get: function () { return list; }, configurable: true }); } catch (e) { /* ignore */ }
    try {
      if (navigator.plugins && typeof navigator.plugins.refresh !== 'function') navigator.plugins.refresh = function () {};
    } catch (e) { /* ignore */ }
  })();

  // ---------- small helpers ----------

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function xmlDoc(str) {
    try { return new DOMParser().parseFromString(String(str || ''), 'text/xml'); } catch (e) { return null; }
  }

  function xmlText(doc, name) {
    if (!doc) return '';
    var n = doc.getElementsByTagName(name)[0];
    return n ? n.textContent.trim() : '';
  }

  function callPage(name) {
    var fn = window[name];
    if (typeof fn !== 'function') return;
    var args = Array.prototype.slice.call(arguments, 1);
    setTimeout(function () { try { fn.apply(window, args); } catch (e) { console.warn('[hwp]', name, e); } }, 0);
  }

  /** "20261009T083000Z" as the DVR means it: local time, despite the Z. */
  function parseDvrTime(s) {
    var m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN;
  }

  function download(blob, name) {
    var a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  (function addStyles() {
    var css = [
      '.hwp-root{position:relative;width:100%;height:100%;background:#000;overflow:hidden;user-select:none;-webkit-user-select:none}',
      '.hwp-root.hwp-hidden{width:0;height:0}',
      '.hwp-grid{position:absolute;inset:0;display:grid;gap:1px;background:#333}',
      '.hwp-wnd{position:relative;background:#111;overflow:hidden;outline:1px solid #333;outline-offset:-1px}',
      '.hwp-wnd.hwp-sel{outline:2px solid #d6262f;outline-offset:-2px;z-index:1}',
      '.hwp-wnd video{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;background:#000}',
      '.hwp-wnd canvas{position:absolute;inset:0;width:100%;height:100%}',
      '.hwp-msg{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;color:#bbb;font:13px/1.4 sans-serif;pointer-events:none;padding:0 8px}',
      '.hwp-zoombox{position:absolute;border:1px solid #d6262f;background:rgba(214,38,47,.15);pointer-events:none}',
    ].join('\n');
    var add = function () { var s = el('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
    if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
  })();

  // ---------- fragmented MP4 box splitter ----------

  /** Splits a byte stream into complete top-level MP4 boxes. */
  function BoxSplitter(onBox) {
    this.buf = new Uint8Array(0);
    this.onBox = onBox;
  }
  BoxSplitter.prototype.push = function (chunk) {
    var b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf, 0);
    b.set(chunk, this.buf.length);
    var off = 0;
    while (b.length - off >= 8) {
      var size = ((b[off] << 24) >>> 0) + (b[off + 1] << 16) + (b[off + 2] << 8) + b[off + 3];
      if (size < 8 || b.length - off < size) break;
      var type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
      this.onBox(type, b.subarray(off, off + size));
      off += size;
    }
    this.buf = b.slice(off);
  };

  function codecFromInit(init) {
    for (var i = 4; i + 8 < init.length; i++) {
      if (init[i] === 0x61 && init[i + 1] === 0x76 && init[i + 2] === 0x63 && init[i + 3] === 0x43) { // 'avcC'
        var h = function (n) { return (n < 16 ? '0' : '') + n.toString(16); };
        return 'avc1.' + h(init[i + 5]) + h(init[i + 6]) + h(init[i + 7]);
      }
    }
    return 'avc1.4d401f';
  }

  // ---------- one video window ----------

  function Pane(player, index) {
    this.player = player;
    this.index = index;
    this.root = el('div', 'hwp-wnd');
    this.video = el('video', '', this.root);
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.disableRemotePlayback = true;
    this.canvas = el('canvas', '', this.root);
    this.msg = el('div', 'hwp-msg', this.root);
    this.session = null;
    this.zoom = null;
    var self = this;
    this.root.addEventListener('mousedown', function () { player.select(self.index); });
    this.root.addEventListener('dblclick', function () { player.toggleSolo(self.index); });
  }

  Pane.prototype.say = function (text) { this.msg.textContent = text || ''; };

  Pane.prototype.play = function (url, auth, start, end) {
    this.stop();
    var self = this;
    var s = {
      url: url, auth: auth, start: start, end: end, playback: Boolean(start),
      startMs: parseDvrTime(start), endMs: parseDvrTime(end), abort: new AbortController(), id: null, ms: null, sb: null,
      queue: [], init: null, firstPts: null, saving: null, paused: false, rate: 1, ended: false, endedReason: null,
    };
    this.session = s;
    this.say('Connecting…');
    if (!MediaSourceImpl) { this.say('This browser has no Media Source support'); return -1; }

    var q = 'url=' + encodeURIComponent(url) + '&auth=' + encodeURIComponent(auth || '');
    if (start) q += '&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end || '');

    s.ms = new MediaSourceImpl();
    this.video.src = URL.createObjectURL(s.ms);
    var opened = new Promise(function (resolve) { s.ms.addEventListener('sourceopen', resolve, { once: true }); });

    var splitter = new BoxSplitter(function (type, box) {
      if (type === 'ftyp' || type === 'moov') {
        s.init = s.init ? concat(s.init, box) : box.slice();
        if (type === 'moov') opened.then(function () { self.setupBuffer(s); });
        return;
      }
      if (type === 'moof') s.pendingMoof = box.slice();
      else if (type === 'mdat' && s.pendingMoof) {
        var frag = concat(s.pendingMoof, box);
        s.pendingMoof = null;
        s.queue.push(frag);
        if (s.saving) s.saving.push(frag);
        self.pump(s);
      }
    });

    // The DVR streams on past the end time it was given; finish playback there ourselves.
    if (s.playback && !isNaN(s.endMs)) {
      this.video.ontimeupdate = function () {
        if (self.session === s && !s.ended && self.osdTime() * 1000 >= s.endMs) self.finish(s);
      };
    }

    fetch(PREFIX + 'stream?' + q, { signal: s.abort.signal, cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error(res.status === 401 ? 'Not logged in' : 'HTTP ' + res.status);
      s.id = res.headers.get('X-Hwp-Stream');
      var reader = res.body.getReader();
      var read = function () {
        return reader.read().then(function (r) {
          if (r.done) return self.ended(s, 'end');
          splitter.push(r.value);
          return s.paused && s.playback ? waitWhilePaused(s).then(read) : read();
        });
      };
      return read();
    }).catch(function (e) {
      if (self.session !== s || e.name === 'AbortError') return;
      self.ended(s, 'error', e.message);
    });
    return 0;
  };

  function concat(a, b) {
    var c = new Uint8Array(a.length + b.length);
    c.set(a, 0);
    c.set(b, a.length);
    return c;
  }

  function waitWhilePaused(s) {
    return new Promise(function (resolve) {
      (function check() { if (!s.paused || s.abort.signal.aborted) resolve(); else setTimeout(check, 200); })();
    });
  }

  Pane.prototype.setupBuffer = function (s) {
    if (this.session !== s || s.sb) return;
    try {
      s.sb = s.ms.addSourceBuffer('video/mp4; codecs="' + codecFromInit(s.init) + '"');
    } catch (e) {
      this.ended(s, 'error', 'Browser can\'t play this video: ' + e.message);
      return;
    }
    var self = this;
    s.sb.addEventListener('updateend', function () { self.pump(s); });
    s.queue.unshift(s.init);
    this.pump(s);
  };

  Pane.prototype.pump = function (s) {
    if (this.session !== s || !s.sb || s.sb.updating || s.ms.readyState !== 'open') return;
    var v = this.video;
    var buffered = v.buffered;
    if (buffered.length) {
      var startB = buffered.start(0);
      var endB = buffered.end(buffered.length - 1);
      if (s.firstPts === null) s.firstPts = startB;
      if (!s.playback && endB - v.currentTime > 1.5) v.currentTime = Math.max(endB - 0.3, startB);
      if (v.currentTime - startB > 30) { s.sb.remove(startB, v.currentTime - 10); return; }
    }
    var next = s.queue.shift();
    if (!next) return;
    try {
      s.sb.appendBuffer(next);
    } catch (e) {
      if (e.name === 'QuotaExceededError' && buffered.length) {
        s.queue.unshift(next);
        s.sb.remove(buffered.start(0), Math.max(buffered.start(0) + 1, v.currentTime - 2));
      }
      return;
    }
    if (this.msg.textContent) this.say('');
    if (v.paused && !s.paused) v.play().catch(function () {});
  };

  Pane.prototype.finish = function (s) {
    this.control('stop');
    s.abort.abort();
    this.ended(s, 'end');
  };

  Pane.prototype.ended = function (s, reason, detail) {
    if (this.session !== s || s.ended) return;
    s.ended = true;
    if (reason === 'error') this.say(detail || 'Stream failed');
    else if (!s.playback) this.say('Stream ended');
    if (s.playback) callPage('PluginEventHandler', reason === 'error' ? 0 : 2, this.index, 0);
  };

  Pane.prototype.control = function (op, value) {
    var s = this.session;
    if (!s || !s.id) return Promise.resolve();
    return fetch(PREFIX + 'control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, op: op, value: value }),
    }).catch(function () {});
  };

  Pane.prototype.stop = function () {
    var s = this.session;
    if (!s) return;
    this.session = null;
    s.abort.abort();
    try { if (s.ms && s.ms.readyState === 'open') s.ms.endOfStream(); } catch (e) { /* ignore */ }
    this.video.ontimeupdate = null;
    this.video.removeAttribute('src');
    try { this.video.load(); } catch (e) { /* ignore */ }
    this.say('');
    this.setZoom(null);
  };

  Pane.prototype.pause = function () {
    var s = this.session;
    if (!s) return -1;
    s.paused = true;
    this.video.pause();
    this.control('pause');
    return 0;
  };

  Pane.prototype.resume = function () {
    var s = this.session;
    if (!s) return -1;
    s.paused = false;
    this.control('resume');
    this.video.play().catch(function () {});
    return 0;
  };

  Pane.prototype.setRate = function (rate) {
    var s = this.session;
    if (!s || !s.playback) return -1;
    s.rate = rate;
    this.video.playbackRate = rate;
    this.control('scale', rate);
    return 0;
  };

  /** Seconds since 1970 of the frame on screen (playback); what HWP_GetOSDTime returns. */
  Pane.prototype.osdTime = function () {
    var s = this.session;
    if (!s || !s.playback || isNaN(s.startMs) || s.firstPts === null) return 0;
    return Math.floor((s.startMs + (this.video.currentTime - s.firstPts) * 1000) / 1000);
  };

  Pane.prototype.capture = function (name) {
    var v = this.video;
    if (!this.session || !v.videoWidth) return -1;
    var c = el('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    // DVR "1080P Lite" streams are anamorphic (960x1080); save what the window shows.
    if (c.width * 9 < c.height * 16 * 0.8) c.width = Math.round(c.height * 16 / 9);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(function (b) { if (b) download(b, (name || 'capture_' + stamp()) + '.jpg'); }, 'image/jpeg', 0.92);
    return 0;
  };

  Pane.prototype.startSave = function () {
    var s = this.session;
    if (!s || !s.init) return -1;
    s.saving = [s.init];
    return 0;
  };

  Pane.prototype.stopSave = function (name) {
    var s = this.session;
    if (!s || !s.saving) return -1;
    var parts = s.saving;
    s.saving = null;
    if (parts.length > 1) download(new Blob(parts, { type: 'video/mp4' }), (name || 'clip_' + stamp()) + '.mp4');
    return 0;
  };

  /** Digital zoom: rect in 0..1 window coordinates, or null to reset. */
  Pane.prototype.setZoom = function (rect) {
    this.zoom = rect;
    var v = this.video;
    if (!rect) { v.style.transform = ''; v.style.transformOrigin = ''; return; }
    var sx = 1 / Math.max(rect.w, 0.02);
    var sy = 1 / Math.max(rect.h, 0.02);
    v.style.transformOrigin = '0 0';
    v.style.transform = 'scale(' + sx + ',' + sy + ') translate(' + (-rect.x * 100) + '%,' + (-rect.y * 100) + '%)';
  };

  // ---------- area drawing (motion grid, rectangles) ----------

  function Drawing(pane) {
    this.pane = pane;
    this.canvas = pane.canvas;
    this.type = null;        // 'grid' | 'roi'
    this.enabled = false;
    this.rows = 18;
    this.cols = 22;
    this.cells = [];
    this.rects = [];         // [{x,y,w,h}] in 0..1, top-left origin
    this.maxRegions = 4;
    this.resX = 704;
    this.resY = 576;
    this.drag = null;
    var self = this;
    this.canvas.addEventListener('mousedown', function (e) { self.down(e); });
    window.addEventListener('mousemove', function (e) { self.move(e); });
    window.addEventListener('mouseup', function (e) { self.up(e); });
    new ResizeObserver(function () { self.render(); }).observe(this.canvas);
  }

  Drawing.prototype.pos = function (e) {
    var r = this.canvas.getBoundingClientRect();
    return { x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) };
  };

  Drawing.prototype.setGrid = function (doc) {
    this.type = 'grid';
    this.rows = parseInt(xmlText(doc, 'rowGranularity'), 10) || 18;
    this.cols = parseInt(xmlText(doc, 'columnGranularity'), 10) || 22;
    var hex = xmlText(doc, 'gridMap');
    var perRow = Math.ceil(this.cols / 8) * 2; // hex digits per row
    this.padBits = {};      // unused bits at the end of each row, kept as the DVR sent them
    this.cells = [];
    for (var r = 0; r < this.rows; r++) {
      var row = [];
      for (var c = 0; c < this.cols; c++) {
        var digit = parseInt(hex.charAt(r * perRow + (c >> 2)), 16) || 0;
        row.push(Boolean(digit & (8 >> (c & 3))));
      }
      for (var pc = this.cols; pc < perRow * 4; pc++) {
        if (parseInt(hex.charAt(r * perRow + (pc >> 2)), 16) & (8 >> (pc & 3))) this.padBits[r * 100 + pc] = true;
      }
      this.cells.push(row);
    }
    this.render();
  };

  Drawing.prototype.gridXml = function () {
    var perRow = Math.ceil(this.cols / 8) * 2;
    var hex = '';
    for (var r = 0; r < this.rows; r++) {
      for (var d = 0; d < perRow; d++) {
        var v = 0;
        for (var b = 0; b < 4; b++) {
          var c = d * 4 + b;
          if (c < this.cols ? this.cells[r] && this.cells[r][c] : this.padBits && this.padBits[r * 100 + c]) v |= 8 >> b;
        }
        hex += v.toString(16);
      }
    }
    return "<?xml version='1.0'?><MoveDetection><videoFormat>PAL</videoFormat><RegionType>grid</RegionType>" +
      '<Grid><rowGranularity>' + this.rows + '</rowGranularity><columnGranularity>' + this.cols + '</columnGranularity></Grid>' +
      '<DisplayMode>transparent</DisplayMode><gridMap>' + hex + '</gridMap></MoveDetection>';
  };

  /** ISAPI region coordinates have their origin at the bottom left. */
  Drawing.prototype.setRoi = function (doc) {
    this.type = 'roi';
    this.resX = parseInt(xmlText(doc, 'HorizontalResolution'), 10) || 704;
    this.resY = parseInt(xmlText(doc, 'VerticalResolution'), 10) || 576;
    this.maxRegions = parseInt(xmlText(doc, 'MaxRegionNum'), 10) || 4;
    this.rects = [];
    var regions = doc.getElementsByTagName('DetectionRegion');
    for (var i = 0; i < regions.length; i++) {
      var xs = [];
      var ys = [];
      var pts = regions[i].getElementsByTagName('RegionCoordinates');
      for (var j = 0; j < pts.length; j++) {
        xs.push(+xmlText(pts[j], 'positionX'));
        ys.push(+xmlText(pts[j], 'positionY'));
      }
      if (!xs.length) continue;
      var x0 = Math.min.apply(Math, xs) / this.resX;
      var x1 = Math.max.apply(Math, xs) / this.resX;
      var y0 = 1 - Math.max.apply(Math, ys) / this.resY;
      var y1 = 1 - Math.min.apply(Math, ys) / this.resY;
      if (x1 > x0 && y1 > y0) this.rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    this.render();
  };

  Drawing.prototype.roiXml = function () {
    var self = this;
    var pt = function (x, y) {
      return '<RegionCoordinates><positionX>' + Math.round(x * self.resX) + '</positionX><positionY>' +
        Math.round((1 - y) * self.resY) + '</positionY></RegionCoordinates>';
    };
    var out = "<?xml version='1.0' encoding='utf-8'?><DetectionRegionInfo><videoFormat>PAL</videoFormat><RegionType>roi</RegionType>" +
      '<ROI><HorizontalResolution>' + this.resX + '</HorizontalResolution><VerticalResolution>' + this.resY + '</VerticalResolution></ROI>' +
      '<DisplayMode>transparent</DisplayMode><MaxRegionNum>' + this.maxRegions + '</MaxRegionNum><DetectionRegionList>';
    this.rects.forEach(function (r) {
      // bottom-left, bottom-right, top-right, top-left (getPluginRegionCoordinates sorts them anyway)
      out += '<DetectionRegion><RegionCoordinatesList>' + pt(r.x, r.y + r.h) + pt(r.x + r.w, r.y + r.h) +
        pt(r.x + r.w, r.y) + pt(r.x, r.y) + '</RegionCoordinatesList></DetectionRegion>';
    });
    return out + '</DetectionRegionList></DetectionRegionInfo>';
  };

  Drawing.prototype.xml = function () {
    if (this.type === 'grid') return this.gridXml();
    if (this.type === 'roi') return this.roiXml();
    return '';
  };

  Drawing.prototype.clear = function () {
    if (this.type === 'grid') this.cells.forEach(function (row) { row.fill(false); });
    this.rects = [];
    this.render();
  };

  Drawing.prototype.down = function (e) {
    if (!this.enabled || e.button !== 0) return;
    e.preventDefault();
    var p = this.pos(e);
    if (this.type === 'grid') {
      var c = Math.min(Math.floor(p.x * this.cols), this.cols - 1);
      var r = Math.min(Math.floor(p.y * this.rows), this.rows - 1);
      this.drag = { from: p, to: p, erase: Boolean(this.cells[r] && this.cells[r][c]) };
    } else if (this.type === 'roi') {
      if (this.rects.length >= this.maxRegions) return;
      this.drag = { from: p, to: p };
    }
    this.render();
  };

  Drawing.prototype.move = function (e) {
    if (!this.drag) return;
    this.drag.to = this.pos(e);
    this.render();
  };

  Drawing.prototype.up = function () {
    var d = this.drag;
    if (!d) return;
    this.drag = null;
    var x0 = Math.min(d.from.x, d.to.x);
    var x1 = Math.max(d.from.x, d.to.x);
    var y0 = Math.min(d.from.y, d.to.y);
    var y1 = Math.max(d.from.y, d.to.y);
    if (this.type === 'grid') {
      var c0 = Math.floor(x0 * this.cols);
      var c1 = Math.min(Math.floor(x1 * this.cols), this.cols - 1);
      var r0 = Math.floor(y0 * this.rows);
      var r1 = Math.min(Math.floor(y1 * this.rows), this.rows - 1);
      for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) this.cells[r][c] = !d.erase;
    } else if (this.type === 'roi' && x1 - x0 > 0.01 && y1 - y0 > 0.01) {
      this.rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    this.render();
  };

  Drawing.prototype.render = function () {
    var cv = this.canvas;
    var w = cv.clientWidth;
    var h = cv.clientHeight;
    if (!w || !h) return;
    var dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    cv.style.cursor = this.enabled ? 'crosshair' : '';
    cv.style.pointerEvents = this.enabled ? 'auto' : 'none';
    if (this.type === 'grid') {
      var cw = w / this.cols;
      var ch = h / this.rows;
      g.fillStyle = 'rgba(255, 210, 0, 0.28)';
      g.strokeStyle = 'rgba(255, 210, 0, 0.75)';
      g.lineWidth = 1;
      for (var r = 0; r < this.rows; r++) {
        for (var c = 0; c < this.cols; c++) {
          if (!this.cells[r] || !this.cells[r][c]) continue;
          g.fillRect(c * cw, r * ch, cw, ch);
          g.strokeRect(c * cw + 0.5, r * ch + 0.5, cw - 1, ch - 1);
        }
      }
    } else if (this.type === 'roi') {
      g.fillStyle = 'rgba(214, 38, 47, 0.25)';
      g.strokeStyle = 'rgba(214, 38, 47, 0.95)';
      g.lineWidth = 2;
      this.rects.forEach(function (rc) {
        g.fillRect(rc.x * w, rc.y * h, rc.w * w, rc.h * h);
        g.strokeRect(rc.x * w, rc.y * h, rc.w * w, rc.h * h);
      });
    }
    if (this.drag) {
      var d = this.drag;
      g.strokeStyle = '#fff';
      g.setLineDash([4, 3]);
      g.strokeRect(Math.min(d.from.x, d.to.x) * w, Math.min(d.from.y, d.to.y) * h,
        Math.abs(d.to.x - d.from.x) * w, Math.abs(d.to.y - d.from.y) * h);
      g.setLineDash([]);
    }
  };

  // ---------- the plugin object ----------

  function Player(embed) {
    this.embed = embed;
    this.panes = [];
    this.layout = 0;
    this.selected = 0;
    this.solo = -1;
    this.playMode = 0;
    this.zoomWnd = -1;
    this.localConfig = loadLocalConfig();
    this.root = el('div', 'hwp-root');
    this.grid = el('div', 'hwp-grid', this.root);
    var hidden = String(embed.getAttribute('width')) === '1' || String(embed.getAttribute('height')) === '1';
    if (hidden) this.root.classList.add('hwp-hidden');
    embed.style.display = 'none';
    embed.parentNode.insertBefore(this.root, embed);
    this.arrange(parseInt(embed.getAttribute('wndtype'), 10) || 1);
    this.drawing = new Drawing(this.panes[0]);
    this.select(0);
    this.watchRemoval();
    this.initZoom();
  }

  Player.prototype.watchRemoval = function () {
    var self = this;
    var timer = setInterval(function () {
      if (!self.embed.isConnected) {
        clearInterval(timer);
        self.panes.forEach(function (p) { p.stop(); });
        self.root.remove();
      }
    }, 1000);
  };

  /** Hikvision window types: 1 = 1x1, 2 = 2x2, 3 = 3x3, 4 = 4x4 (also seen: 1+5, 1+7; treated as 3x3 and 4x4). */
  Player.prototype.arrange = function (type) {
    var n = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 3, 6: 4 }[type] || 1;
    this.layout = n;
    this.solo = -1;
    this.grid.style.gridTemplateColumns = 'repeat(' + n + ', 1fr)';
    this.grid.style.gridTemplateRows = 'repeat(' + n + ', 1fr)';
    while (this.panes.length < n * n) this.panes.push(new Pane(this, this.panes.length));
    for (var i = 0; i < this.panes.length; i++) {
      var p = this.panes[i];
      if (i < n * n) { if (p.root.parentNode !== this.grid) this.grid.appendChild(p.root); p.root.style.display = ''; } else { p.stop(); p.root.style.display = 'none'; }
    }
    if (this.selected >= n * n) this.select(0);
  };

  Player.prototype.toggleSolo = function (i) {
    var n = this.layout;
    if (n === 1) return;
    if (this.solo === i) {
      this.solo = -1;
      this.grid.style.gridTemplateColumns = 'repeat(' + n + ', 1fr)';
      this.grid.style.gridTemplateRows = 'repeat(' + n + ', 1fr)';
      this.panes.forEach(function (p, k) { p.root.style.display = k < n * n ? '' : 'none'; });
    } else {
      this.solo = i;
      this.grid.style.gridTemplateColumns = '1fr';
      this.grid.style.gridTemplateRows = '1fr';
      this.panes.forEach(function (p, k) { p.root.style.display = k === i ? '' : 'none'; });
    }
  };

  Player.prototype.select = function (i) {
    this.selected = i;
    this.panes.forEach(function (p, k) { p.root.classList.toggle('hwp-sel', k === i); });
    callPage('GetSelectWndInfo', "<?xml version='1.0'?><RealPlayInfo><SelectWnd>" + i + '</SelectWnd></RealPlayInfo>');
  };

  Player.prototype.pane = function (i) {
    var k = parseInt(i, 10);
    return this.panes[isNaN(k) ? this.selected : k] || null;
  };

  /** Drag a rectangle in a zoom-enabled window to zoom into it; click (no drag) to zoom back out. */
  Player.prototype.initZoom = function () {
    var self = this;
    var start = null;
    var box = null;
    this.grid.addEventListener('mousedown', function (e) {
      var p = self.pane(self.zoomWnd);
      if (!p || self.drawing.enabled || !p.root.contains(e.target)) return;
      var r = p.root.getBoundingClientRect();
      start = { p: p, r: r, x: e.clientX, y: e.clientY };
      box = el('div', 'hwp-zoombox', p.root);
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!start) return;
      var x0 = Math.min(start.x, e.clientX) - start.r.left;
      var y0 = Math.min(start.y, e.clientY) - start.r.top;
      box.style.left = x0 + 'px';
      box.style.top = y0 + 'px';
      box.style.width = Math.abs(e.clientX - start.x) + 'px';
      box.style.height = Math.abs(e.clientY - start.y) + 'px';
    });
    window.addEventListener('mouseup', function (e) {
      if (!start) return;
      var s = start;
      start = null;
      box.remove();
      var w = Math.abs(e.clientX - s.x) / s.r.width;
      var h = Math.abs(e.clientY - s.y) / s.r.height;
      if (w < 0.03 || h < 0.03) { s.p.setZoom(null); return; }
      var z = s.p.zoom || { x: 0, y: 0, w: 1, h: 1 };
      s.p.setZoom({
        x: z.x + ((Math.min(s.x, e.clientX) - s.r.left) / s.r.width) * z.w,
        y: z.y + ((Math.min(s.y, e.clientY) - s.r.top) / s.r.height) * z.h,
        w: w * z.w,
        h: h * z.h,
      });
    });
  };

  // ---------- local settings (what the native plugin keeps on disk) ----------

  var LOCAL_DEFAULTS = {
    ProtocolType: '0', StreamType: '0', PackgeSize: '2', PlayWndType: '0', BuffNumberType: '1', PlayPerformance: '0',
    IVSMode: '0', CaptureFileFormat: '0', RecordPath: 'Downloads', CapturePath: 'Downloads', PlaybackFilePath: 'Downloads',
    PlaybackPicPath: 'Downloads', DownloadPath: 'Downloads', IVSPath: 'Downloads', DeviceCapturePath: 'Downloads',
    SecretKey: '', OSDCameraName: '1', OSDTime: '1', RulesInfo: '1', PosInfo: '1', SnapCount: '1',
  };

  function loadLocalConfig() {
    var cfg = {};
    for (var k in LOCAL_DEFAULTS) cfg[k] = LOCAL_DEFAULTS[k];
    try {
      var saved = JSON.parse(localStorage.getItem('hwpLocalConfig') || '{}');
      for (var s in saved) cfg[s] = saved[s];
    } catch (e) { /* storage unavailable */ }
    cfg.ProtocolType = '0'; // RTSP/TCP: the stand-in only speaks RTSP
    return cfg;
  }

  function localConfigXml(cfg) {
    var out = "<?xml version='1.0' encoding='utf-8'?><LocalConfigInfo>";
    for (var k in cfg) out += '<' + k + '>' + String(cfg[k]).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</' + k + '>';
    return out + '</LocalConfigInfo>';
  }

  // ---------- HWP_* methods ----------

  var players = new WeakMap();

  function playerFor(embed) {
    var p = players.get(embed);
    if (!p && embed.parentNode) {
      p = new Player(embed);
      players.set(embed, p);
    }
    return p;
  }

  var OK = function () { return 0; };
  var FAIL = function () { lastError = 1; return -1; };

  var methods = {
    HWP_Play: function (p, url, auth, wnd, start, end) {
      var pane = p.pane(wnd);
      return pane ? pane.play(url, auth, start, end) : -1;
    },
    HWP_ReversePlay: FAIL,
    HWP_Stop: function (p, wnd) { var pane = p.pane(wnd); if (pane) pane.stop(); return 0; },
    StopRealPlayAll: function (p) { p.panes.forEach(function (x) { x.stop(); }); return 0; },
    HWP_StopRealPlayAll: function (p) { p.panes.forEach(function (x) { x.stop(); }); return 0; },
    HWP_Pause: function (p, wnd) { var pane = p.pane(wnd); return pane ? pane.pause() : -1; },
    HWP_Resume: function (p, wnd) {
      var pane = p.pane(wnd);
      if (!pane) return -1;
      if (pane.session && pane.session.rate !== 1) pane.setRate(1);
      return pane.resume();
    },
    HWP_Fast: function (p, wnd) {
      var pane = p.pane(wnd);
      if (!pane || !pane.session) return -1;
      return pane.setRate(Math.min((pane.session.rate || 1) * 2, 4));
    },
    HWP_Slow: function (p, wnd) {
      var pane = p.pane(wnd);
      if (!pane || !pane.session) return -1;
      return pane.setRate(Math.max((pane.session.rate || 1) / 2, 0.125));
    },
    HWP_FrameForward: function (p, wnd) {
      var pane = p.pane(wnd);
      if (!pane || !pane.session) return -1;
      if (!pane.session.paused) pane.pause();
      pane.video.currentTime += 0.04;
      return 0;
    },
    HWP_GetOSDTime: function (p, wnd) { var pane = p.pane(wnd); return pane ? pane.osdTime() : 0; },
    HWP_ArrangeWindow: function (p, type) { p.arrange(parseInt(type, 10)); return 0; },
    HWP_CapturePicture: function (p, wnd, name) { var pane = p.pane(wnd); return pane ? pane.capture(name) : -1; },
    HWP_StartSave: function (p, wnd) { var pane = p.pane(wnd); return pane ? pane.startSave() : -1; },
    HWP_StopSave: function (p, wnd, name) { var pane = p.pane(wnd); return pane ? pane.stopSave(name) : -1; },
    HWP_FullScreenDisplay: function (p, on) {
      try {
        if (on === false) { if (document.fullscreenElement) document.exitFullscreen(); } else (p.root.requestFullscreen || p.root.webkitRequestFullscreen).call(p.root);
      } catch (e) { return -1; }
      return 0;
    },
    HWP_EnableZoom: function (p, wnd) { p.zoomWnd = parseInt(wnd, 10); return 0; },
    HWP_DisableZoom: function (p, wnd) { var pane = p.pane(wnd); if (pane) pane.setZoom(null); p.zoomWnd = -1; return 0; },
    HWP_SetPlayModeType: function (p, mode) { p.playMode = parseInt(mode, 10) || 0; return 0; },
    HWP_SetDrawStatus: function (p, on) { p.drawing.enabled = Boolean(on); p.drawing.render(); return 0; },
    HWP_SetRegionInfo: function (p, xml) {
      var doc = xmlDoc(xml);
      if (!doc) return -1;
      if (xmlText(doc, 'RegionType') === 'grid' || doc.getElementsByTagName('gridMap').length) p.drawing.setGrid(doc);
      else p.drawing.setRoi(doc);
      return 0;
    },
    HWP_GetRegionInfo: function (p) { return p.drawing.xml(); },
    HWP_ClearRegion: function (p) { p.drawing.clear(); return 0; },
    HWP_GetLocalConfig: function (p) { return localConfigXml(p.localConfig); },
    HWP_SetLocalConfig: function (p, xml) {
      var doc = xmlDoc(xml);
      var root = doc && doc.documentElement;
      if (!root) return -1;
      for (var i = 0; i < root.children.length; i++) p.localConfig[root.children[i].tagName] = root.children[i].textContent;
      try { localStorage.setItem('hwpLocalConfig', JSON.stringify(p.localConfig)); } catch (e) { /* ignore */ }
      return 0;
    },
    HWP_GetLastError: function () { return lastError; },
    HWP_GetHttpErrorInfo: function () { return ''; },
    HWP_SetSecretKey: OK,                                // the Homebridge plugin already has the stream key
    HWP_GetEncryptString: function (p, type, flag, s) { return s; },
    HWP_GetDecryptString: function (p, type, flag, s) { return s; },
    HWP_CheckPluginUpdate: function () { return false; },
    HWP_OpenSound: OK,
    HWP_CloseSound: OK,
    HWP_SetVolume: OK,
    HWP_OpenDirectory: OK,
    HWP_SetTimeBarMode: OK,
    HWP_SetPlayBackType: OK,
    HWP_SetPlaybackDrawType: OK,
    HWP_SetTrsPlayBackParam: OK,
    HWP_ClearWndItemFileList: OK,
    HWP_SetZeroChanInfo: OK,
    HWP_EnablePDC: OK,
    HWP_EnableIVS: OK,
    HWP_SetOriginalString: OK,
    HWP_SR_Init: OK,
    HWP_SR_PTZ: OK,
    HWP_SR_Zoom: OK,
    HWP_SetSnapDrawMode: OK,
    HWP_SetSnapLineInfo: OK,
    HWP_GetSnapLineInfo: function () { return ''; },
    HWP_SetSnapPolygonInfo: OK,
    HWP_GetSnapPolygonInfo: function () { return ''; },
    HWP_ClearSnapInfo: OK,
    HWP_ClearTargetPolygon: OK,
    HWP_GetDrawLineInfo: function () { return ''; },
    HWP_ClearDrawLineInfo: OK,
    HWP_SetTextOverlay: OK,
    HWP_GetTextOverlay: function () { return ''; },
    HWP_StartVoiceTalk: FAIL,
    HWP_StopVoiceTalk: OK,
    // File transfers (firmware upgrade, config import/export) go through the DVR's own pages instead.
    HWP_OpenFileBrowser: function () { return ''; },
    HWP_UploadFile: FAIL,
    HWP_StartAsynUpload: FAIL,
    HWP_StopAsynUpload: OK,
    HWP_GetUploadErrorInfo: function () { return ''; },
    HWP_StartUpgradeEx: FAIL,
    HWP_UpgradeStatus: function () { return -1; },
    HWP_UpgradeProgress: function () { return 0; },
    HWP_StopUpgrade: OK,
    HWP_ImportDeviceConfig: FAIL,
    HWP_ExportDeviceConfig: FAIL,
    HWP_ExportDeviceLog: FAIL,
    HWP_ExportReport: FAIL,
    HWP_ExportFile: FAIL,
    HWP_GetIpcImportErrorInfo: function () { return ''; },
  };

  Object.keys(methods).forEach(function (name) {
    var impl = methods[name];
    Object.defineProperty(HTMLEmbedElement.prototype, name, {
      configurable: true,
      value: function () {
        if (String(this.getAttribute('type')).toLowerCase() !== MIME) return -1;
        var p = playerFor(this);
        if (!p) return -1;
        try {
          return impl.apply(null, [p].concat(Array.prototype.slice.call(arguments)));
        } catch (e) {
          console.warn('[hwp]', name, e);
          lastError = 1;
          return -1;
        }
      },
    });
  });

  // Build the player as soon as the page inserts the <embed>, so the windows show before the first call.
  new MutationObserver(function (records) {
    records.forEach(function (r) {
      r.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        var embeds = n.tagName === 'EMBED' ? [n] : n.querySelectorAll ? n.querySelectorAll('embed') : [];
        Array.prototype.forEach.call(embeds, function (e) {
          if (String(e.getAttribute('type')).toLowerCase() === MIME) playerFor(e);
        });
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
