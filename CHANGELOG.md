# Changelog

## 1.3.0

Smoother live video when Homebridge runs on a PC or server (anything that isn't a Raspberry Pi).

- On a machine with 4 or more cores and no Pi hardware encoder, software-encoded streams use the same two-stage path as the Pi's hardware encoder: libx264 (`veryfast` preset, for a cleaner picture than `ultrafast`) encodes at a constant 25 fps and a copy-only sender stamps the frames exactly 40 ms apart. DVRs deliver frames unevenly (about 20 fps with irregular gaps on a DVR-104G), and passing their timing through showed as judder.
- Raspberry Pi behaviour is unchanged.

## 1.2.2

Fixes video freezing and high load on a Raspberry Pi when several cameras are opened at once (for example the 4-camera grid on an Apple TV).

- With *Video processing* on Automatic, the plugin now chooses how to serve each stream by how many are being viewed at the same time. One viewer gets the main stream at up to 1280x720; two get the main stream at up to 960x540; three or more get the DVR's sub stream scaled to 640x360 at 800 kbps (the Pi hardware encoder runs four of these at 25 fps; a fifth is passed through unchanged). The DVR can only deliver about 5.5 Mbit/s in total, so several main streams at once gave about 13 fps anyway.
- The choice is made for each stream when it starts and the log says which path was used and why. When the grid is closed, the next single view is back on the best path.
- A failing hardware encode no longer switches the whole plugin to libx264 until restart. Only that stream falls back (to libx264 at up to 640 px wide, or pass-through if two are already running). Only if nothing else is encoding in hardware is the encoder treated as wedged, and then it is avoided for 10 minutes and tried again, not for good.
- Waits up to 8 s (was 6 s) for the hardware encoder's first output before falling back.
- Live view starts much faster on a Pi: the first picture now arrives in about 0.5 s for a single view and 0.7-0.9 s per tile in the grid (was 2.5 s and 2.6-5 s). The hardware path was throwing away its first keyframe (about 2 s) and probing its input for longer than needed. When the DVR joins a sub stream mid-picture-group (which used to delay a tile by 2-3 s), the plugin now asks it for a keyframe.
- Hardware *decoding* on the Pi was tested and is not used: it started slower, used more CPU and dropped frames.

## 1.2.1

- The plugin's settings page in the Homebridge UI shows an **Open web console** button and the console's address, instead of trying to embed the console (the DVR's pages don't work well inside the Homebridge UI, which also blocks their dialogs).
- The address text is readable in the dark theme.

## 1.2.0

**Web console** (off by default): the DVR's own web page served through Homebridge, with a stand-in for Hikvision's obsolete browser plugin, so live view, playback and motion-area drawing work in Safari and Chrome.

- Open it at `http://<homebridge-ip>:8100/` or with the **Open web console** button on the plugin's settings screen in the Homebridge UI.
- Live view (up to 4 video windows at once per tab), snapshots, clip recording, digital zoom, full screen. Multi-window views use the DVR's sub stream; an enlarged window switches to the main stream.
- Playback with pause, 1/4x to 4x speed (smooth in Safari too) and the timeline, whose clock matches the time burnt into the picture. Normal cursors instead of the DVR's garbled ones. The DVR allows one playback at a time; a second one says so in its window.
- Saved clips and snapshots download to your browser's Downloads folder.
- Motion grid, video tamper and privacy mask areas can be drawn and saved.
- New settings: **Web console**, **Web console port** (8100) and **Log in automatically** (off). Auto-login logs every visitor in to the DVR as the plugin's account, so only use it on a trusted network. Logout still works: it stays logged out until you open the console's address again.
- Not supported through it: audio, two-way talk, firmware upgrade, config import/export. It's plain HTTP, so don't expose it to the internet.
- The plugin settings now use a custom Homebridge UI page (adds `@homebridge/plugin-ui-utils`), and the plugin is single-instance. The password and verification code fields are now hidden.

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
