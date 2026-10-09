'use strict';

const { Isapi } = require('./isapi');
const { HikCamera } = require('./camera');
const { resolveFfmpeg, detectEncoder } = require('./ffmpeg');
const { AlertStream } = require('./events');
const { WebConsole } = require('./webconsole');

const PLUGIN_NAME = 'homebridge-hikvision-dvr';
const PLATFORM_NAME = 'HikvisionDVR';

// Hikvision event types treated as motion (compared lower-case).
const MOTION_EVENTS = new Set(['vmd', 'linedetection', 'fielddetection', 'regionentrance', 'regionexiting', 'pir']);

class HikvisionPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map(); // uuid -> PlatformAccessory (restored from cache)
    this.cameras = [];

    const c = this.config;
    this.host = (c.host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    this.httpPort = c.httpPort || 80;
    this.rtspPort = c.rtspPort || 554;
    this.username = c.username || 'admin';
    this.password = c.password || '';
    this.verificationCode = c.verificationCode || null;
    this.maxStreams = c.maxStreams || 2;
    this.subStreamMaxWidth = c.subStreamMaxWidth || 0;
    this.minBitrate = Number.isInteger(c.minBitrate) ? c.minBitrate : undefined;
    this.https = Boolean(c.https);
    this.debug = Boolean(c.debug);
    this.motion = c.motion !== false;
    this.motionTimeout = Number.isInteger(c.motionTimeout) && c.motionTimeout > 0 ? c.motionTimeout : 30;
    this.ffmpeg = resolveFfmpeg(c.videoProcessor);

    if (!this.host || !this.password) {
      log.error('Open the plugin settings and enter your DVR/NVR IP address, username and password.');
      return;
    }
    const port = Number(c.webConsolePort);
    this.webConsolePort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8100;
    this.webConsoleAutoLogin = c.webConsoleAutoLogin === true;
    this.webConsole = null;

    this.isapi = new Isapi({ host: this.host, port: this.httpPort, https: this.https, username: this.username, password: this.password });
    api.on('didFinishLaunching', () => {
      if (c.webConsole === true) this.startWebConsole();
      this.setup();
    });
    api.on('shutdown', () => {
      this.stopWebConsole();
      if (this.alerts) this.alerts.stop();
      this.cameras.forEach((cam) => cam.shutdown());
    });
  }

  /** Starts the web console; it reads this platform's fields on demand, so a verification code found later is seen. */
  startWebConsole() {
    try {
      this.webConsole = new WebConsole(this, this.webConsolePort);
      this.webConsole.start();
    } catch (e) {
      this.webConsole = null;
      this.log.error(`Web console failed to start: ${e.message}`);
    }
  }

  stopWebConsole() {
    try {
      if (this.webConsole) this.webConsole.stop();
    } catch (e) {
      this.log.warn(`Web console failed to stop: ${e.message}`);
    }
    this.webConsole = null;
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  async setup(attempt = 1) {
    try {
      const info = await this.isapi.deviceInfo();
      this.log.info(`Connected to ${info.model || 'device'} "${info.name}" (firmware ${info.firmware})`);

      let channels = await this.isapi.channels();
      if (!channels.length) throw new Error('No cameras found on the device');

      if (!this.verificationCode) {
        this.verificationCode = await this.isapi.verificationCode();
        if (this.verificationCode) this.log.info('Read the stream encryption (verification) code from the device');
      }

      const mode = this.config.encoder || 'auto';
      this.encoder = mode === 'auto' ? await detectEncoder(this.ffmpeg, this.log) : mode;
      this.encoderAuto = mode === 'auto';
      this.log.info(`Video: ${this.encoder === 'copy' ? 'passing DVR stream through (no transcoding)' : `transcoding with ${this.encoder}`}`);

      const overrides = new Map((this.config.cameras || []).filter((x) => x && x.channel).map((x) => [Number(x.channel), x]));
      channels = channels
        .map((ch) => ({ ...ch, name: (overrides.get(ch.channel) || {}).name || ch.name }))
        .filter((ch) => !(overrides.get(ch.channel) || {}).hidden);

      const wanted = new Set();
      for (const ch of channels) {
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${info.serial || this.host}:${ch.channel}`);
        wanted.add(uuid);
        this.addCamera(uuid, ch, info);
      }
      const stale = [...this.accessories.values()].filter((a) => !wanted.has(a.UUID));
      if (stale.length) {
        this.log.info(`Removing ${stale.length} camera(s) no longer on the device`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      }
      this.log.info(`Ready: ${channels.map((c) => c.name).join(', ')}`);
      if (this.motion) this.startMotion();
    } catch (e) {
      const delay = Math.min(attempt * 30, 300);
      this.log.error(`Setup failed: ${e.message}. Retrying in ${delay}s.`);
      if (e.code === 'AUTH') this.log.error('Check the username and password in the plugin settings.');
      setTimeout(() => this.setup(attempt + 1), delay * 1000);
    }
  }

  addCamera(uuid, ch, info) {
    const { Service, Characteristic, Categories } = this.api.hap;
    let accessory = this.accessories.get(uuid);
    const isNew = !accessory;
    if (isNew) {
      accessory = new this.api.platformAccessory(ch.name, uuid, Categories.IP_CAMERA);
    }
    accessory.context.channel = ch.channel;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Hikvision')
      .setCharacteristic(Characteristic.Model, info.model || 'DVR')
      .setCharacteristic(Characteristic.SerialNumber, `${info.serial || this.host}-${ch.channel}`)
      .setCharacteristic(Characteristic.FirmwareRevision, (info.firmware || '1.0').replace(/^V/i, '').split(' ')[0]);

    const camera = new HikCamera(this, ch.channel, ch.name);
    accessory.configureController(camera.controller);
    this.cameras.push(camera);

    let motionService = accessory.getService(Service.MotionSensor);
    let changed = false;
    if (this.motion) {
      if (!motionService) {
        motionService = accessory.addService(Service.MotionSensor, ch.name);
        changed = true;
      }
      camera.setMotionService(motionService);
    } else if (motionService) {
      accessory.removeService(motionService);
      changed = true;
    }

    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Added camera "${ch.name}" (channel ${ch.channel})`);
    } else if (changed) {
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  startMotion() {
    if (this.alerts) return;
    const byChannel = new Map(this.cameras.map((cam) => [cam.channel, cam]));
    this.alerts = new AlertStream(this.isapi, this.log);
    this.alerts.on('alert', ({ type, state, channel }) => {
      if (type !== 'videoloss' || state !== 'inactive') this.log[this.debug ? 'info' : 'debug'](`Event: ${type} ${state} channel ${channel}`);
      if (state !== 'active' || !MOTION_EVENTS.has(type.toLowerCase())) return;
      const cam = byChannel.get(channel);
      if (cam) cam.motionDetected(this.motionTimeout);
    });
    this.alerts.start();
    this.checkMotionNotify([...byChannel.values()]);
  }

  /** Motion only reaches the event stream if "Notify Surveillance Center" is ticked for it on the DVR. */
  async checkMotionNotify(cameras) {
    try {
      const xml = await this.isapi.getXml('/ISAPI/Event/triggers');
      const triggers = xml.match(/<EventTrigger(?:\s[^>]*)?>[\s\S]*?<\/EventTrigger>/g) || [];
      const silent = cameras.filter((cam) => {
        const t = triggers.find((x) => new RegExp(`<id>VMD-${cam.channel}</id>`).test(x));
        return t && !/<notificationMethod>center<\/notificationMethod>/.test(t);
      });
      if (silent.length) {
        this.log.warn(`Motion from ${silent.map((c) => c.name).join(', ')} won't reach HomeKit: on the DVR, open ` +
          'Configuration → Event → Motion → Linkage Method and tick "Notify Surveillance Center" for each camera.');
      }
    } catch (e) {
      this.log.debug(`Couldn't check the DVR's motion notification settings: ${e.message}`);
    }
  }
}

module.exports = { HikvisionPlatform, PLUGIN_NAME, PLATFORM_NAME };
