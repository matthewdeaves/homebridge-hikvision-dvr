# Changelog

## 1.2.0

**Web console** (off by default): the DVR's own web page served through Homebridge, with a stand-in for Hikvision's obsolete browser plugin, so live view, playback and motion-area drawing work in Safari and Chrome.

- Open it at `http://<homebridge-ip>:8100/` or from the plugin's settings screen in the Homebridge UI, which shows it embedded.
- Live view (up to 4 video windows at once per tab), snapshots, clip recording, digital zoom, full screen. Multi-window views use the DVR's sub stream; an enlarged window switches to the main stream.
- Playback with pause, 1/8x to 4x speed and the timeline (with normal cursors instead of the DVR's garbled ones).
- Motion grid, video tamper and privacy mask areas can be drawn and saved.
- New settings: **Web console**, **Web console port** (8100) and **Log in automatically** (off). Auto-login logs every visitor in to the DVR as the plugin's account, so only use it on a trusted network.
- Not supported through it: audio, two-way talk, firmware upgrade, config import/export. It's plain HTTP, so don't expose it to the internet.
- The plugin settings now use a custom Homebridge UI page (adds `@homebridge/plugin-ui-utils`), and the plugin is single-instance.

**Faster, more reliable HomeKit streams**

- Video starts in about half a second instead of 1.5 s or more: the decoder was discarding the first second of the DVR's frames because its keyframes carry no recovery point.
- Automatic video processing uses libx264 for views up to 640 px wide (quicker to start, about 0.85 of one Pi 3 core); the Pi hardware encoder is still used for larger views. Choosing the hardware encoder explicitly is unchanged.
- If the Pi hardware encoder fails to start or produces no video within 6 s of getting the first frame (its kernel driver can wedge until the Pi is rebooted), the stream switches to libx264 and stays there until Homebridge restarts, instead of spinning forever.

## 1.1.1

- Ship this changelog in the package, so the Homebridge UI can show it.

## 1.1.0

- **Each camera now has a HomeKit motion sensor**, driven by the DVR's own motion detection (also line crossing, intrusion, region entrance/exit and PIR on models that have them). Use it for motion notifications in the Home app or in automations.
- Reads the DVR's ISAPI event stream (`/ISAPI/Event/notification/alertStream`), reconnects by itself, and has a heartbeat watchdog for dropped connections.
- On startup the log says which cameras need **Notify Surveillance Center** ticked on the DVR (Configuration → Event → Motion → Linkage Method). Without it, the DVR doesn't send motion to other software.
- New settings: **Motion sensors** (on by default) and **Motion reset** (30 s).
- With *Debug logging* on, every DVR event is logged.

## 1.0.0

- Auto-discovers cameras on Hikvision / HiLook DVRs, NVRs and IP cameras (just enter IP, username, password).
- Decrypts Hik-Connect / HiLook encrypted streams automatically (verification code read from the device).
- Uses the Raspberry Pi hardware encoder when available, libx264 otherwise.
- Fixes squashed 960x1080 "1080P Lite" streams and 4:3 snapshots.
