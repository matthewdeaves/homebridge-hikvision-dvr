# homebridge-hikvision-dvr

Hikvision, HiLook and other Hik-based DVR / NVR cameras in Apple HomeKit.

Enter your DVR's IP address, username and password. The plugin finds every camera,
names them the way your DVR does, streams them to the Home app, and adds a motion sensor to each one so you
get motion notifications and automations.

**It also plays encrypted streams.** If you use the HiLook or Hik-Connect app, your recorder probably has
*video encryption* turned on. Every other player then gets garbage: VLC, go2rtc, homebridge-camera-ffmpeg and
the other camera plugins all fail, though snapshots still work. This plugin decrypts the stream itself, using the
verification code it reads from the device, so you don't need to change anything on the DVR.

## Install

1. In the Homebridge UI, open **Plugins**, search for **Hikvision DVR** and install it.
2. Fill in **IP address**, **username** and **password**, then save.
3. Turn on **Child bridge** for the plugin (the plugin tile's ⋮ menu → *Bridge Settings*) and restart Homebridge.
4. On your iPhone, open Home → **+** → **Add Accessory** → **More options…**, pick the plugin's
   bridge, and enter the code shown in the Homebridge UI. All cameras are added in one go.

If the main Homebridge bridge is already paired, step 3 is optional: the cameras appear there instead.

## Settings

Only the IP address, username and password are needed. Everything else is optional:

| Setting | Default | |
|---|---|---|
| Cameras | all | Rename or hide channels |
| Motion sensors | on | A motion sensor per camera, from the DVR's own motion detection (see below) |
| Motion reset | 30 s | How long motion stays on after the DVR's last motion event |
| Verification code | read from DVR | Only needed if the plugin can't read it. Use the 6-letter code on the DVR's sticker, or the one set in Hik-Connect / HiLook |
| Video processing | Automatic | Uses the Raspberry Pi hardware encoder when available (for views wider than 640 px; smaller views use libx264, which starts faster), otherwise libx264. *No transcoding* passes the DVR's stream through untouched (lowest CPU, experimental) |
| Use sub stream up to width | 0 (never) | e.g. `320` serves Apple Watch views from the low-res sub stream |
| Minimum bitrate | automatic | iOS often asks for only ~300 kbps; the plugin uses at least 1200 kbps for 720p+. `0` = exactly what iOS asks |
| Max viewers per camera | 2 | |
| Web console / port | off / 8100 | Serves the DVR's web page with live view, playback and motion areas working (see below) |
| Web console: log in automatically | off | Skips the console's login page by logging in with the plugin's DVR account. Anyone on your network can then use the console (see below) |
| HTTP / RTSP port, HTTPS | 80 / 554 / off | |

The account needs permission to view live video. Use an **admin** account if you want the verification code read automatically.

## Motion

Each camera gets a motion sensor driven by the DVR's own motion detection (and line-crossing / intrusion
detection if your model has it). In the Home app you can then turn on motion notifications for the camera or use
it in automations.

The DVR only sends motion to other software if **Notify Surveillance Center** is ticked. On the DVR's screen or
web page, open **Configuration → Event → Motion**, pick each camera, and under **Linkage Method** tick
**Notify Surveillance Center**. The plugin checks this on startup and says in the log which cameras need it.

Motion areas and sensitivity are set on the DVR itself (its own screen, or the Hik-Connect / HiLook app).

## Web console

Newer browsers can't run Hikvision's browser plugin, so the DVR's own web page can't show live view or playback,
or let you draw motion areas. The web console serves that same page through Homebridge with a stand-in for the
plugin, so all three work in Safari and Chrome.

To turn it on, open the plugin settings, expand **Web console**, tick **Web console** (port `8100` unless you change it),
save and restart Homebridge. You can then open it two ways:

- **In its own tab:** go to `http://<homebridge-ip>:8100/`.
- **In the Homebridge UI:** the plugin's settings screen shows an **Open web console** button and the console embedded below it. If you
  reach the Homebridge UI over HTTPS the browser won't embed a plain HTTP page, so only the button is shown.

Log in with your DVR username and password as usual, or tick **Web console: log in automatically** to skip the login page.
With it on, anyone on your home network who opens the console is logged in to the DVR as the plugin's account (usually `admin`),
and their browser receives that password (the DVR's login page also keeps it in the tab's session storage). It tries once per 30 seconds
and stops for 10 minutes if the DVR refuses the login. Add `?manual` to the login address (`/doc/page/login.asp?manual`) to log in as someone else.

Windows in a 2x2 or larger live view use the DVR's low-resolution sub stream (the main stream when you enlarge one window with a double-click),
which keeps the load on the DVR and the Homebridge machine down. Limitations:

- No audio and no two-way talk.
- At most 4 video windows play at once per browser tab (browsers allow only 6 connections to one address, and the page itself needs some). In a 3x3 or 4x4 layout the extra windows show "Max 4 video windows in the web console".
- Firmware upgrade and configuration import / export don't work through it. Use the DVR's own address for those.
- It is plain HTTP, like the DVR itself, so **don't port-forward it** or expose it to the internet.
- Tested only on a HiLook DVR-104G-F1.

## How it works

- Discovers cameras via ISAPI: analog DVR inputs, NVR IP channels, or a single IP camera.
- Listens to the DVR's ISAPI event stream (`/ISAPI/Event/notification/alertStream`) for motion, and reconnects
  if it drops.
- Fetches snapshots from the DVR's JPEG API and scales them to 16:9. Many DVRs return 4:3 snapshots even for
  16:9 cameras.
- Reads the RTSP stream with its own small client and decrypts it when needed. Encrypted NAL units are flagged by a
  Hikvision RTP header extension and are AES-128-ECB encrypted (first 4 KB) with the verification code.
- Passes the DVR's own frame timestamps to ffmpeg, which transcodes to whatever resolution HomeKit asks for. This
  also fixes the squashed "1080P Lite" (960×1080) streams that analog DVRs send.

No audio yet.

## Tested on

- **HiLook / Hikvision DVR-104G-F1** (4-channel analog DVR, firmware V3.4.891, Hik-Connect stream encryption on),
  running on a **Raspberry Pi 3 A+** with the official Homebridge image. One 720p stream uses about 1.5 CPU cores
  with the hardware encoder.

Other Hikvision DVRs, NVRs and cameras use the same ISAPI/RTSP interfaces and should work. Please open an issue
with your model either way.

## Troubleshooting

- **"Login failed"**: check the username and password. Hikvision locks the account for 30 minutes after several failures.
- **Snapshots but no video**: turn on *Debug logging*, start a stream, and check the log. If the log says the
  stream is encrypted and no code is known, enter the verification code.
- **No motion in HomeKit**: check the log for a "won't reach HomeKit" warning and tick *Notify Surveillance
  Center* as described under [Motion](#motion). Turn on *Debug logging* to see every event the DVR sends.
- **Slow on a Pi**: set *Use sub stream up to width* to `640` to use the lighter sub stream for small views.

## License

MIT
