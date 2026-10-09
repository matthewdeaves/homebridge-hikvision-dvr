# Changelog

## Unreleased

- **Web console** (off by default): serves the DVR's own web page through Homebridge with a stand-in for Hikvision's obsolete browser plugin, so live view, playback and motion-area drawing work in Safari and Chrome. Open it at `http://<homebridge-ip>:8100/` or from the plugin's settings screen in the Homebridge UI, which now also shows it embedded.
- New settings: **Web console** and **Web console port** (8100).
- No audio, two-way talk or firmware upgrade / import / export through it. It is plain HTTP, so don't expose it to the internet.
- The plugin settings now use a custom Homebridge UI page (adds `@homebridge/plugin-ui-utils`), and the plugin is marked as single-instance.

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
