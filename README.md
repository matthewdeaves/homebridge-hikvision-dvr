# homebridge-hikvision-dvr

Hikvision, HiLook and other Hik-based DVR / NVR cameras in Apple HomeKit.

Enter your DVR's IP address, username and password. The plugin finds every camera,
names them the way your DVR does, and streams them to the Home app.

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
| Verification code | read from DVR | Only needed if the plugin can't read it. Use the 6-letter code on the DVR's sticker, or the one set in Hik-Connect / HiLook |
| Video processing | Automatic | Uses the Raspberry Pi hardware encoder when available, otherwise libx264. *No transcoding* passes the DVR's stream through untouched (lowest CPU, experimental) |
| Use sub stream up to width | 0 (never) | e.g. `320` serves Apple Watch views from the low-res sub stream |
| Max viewers per camera | 2 | |
| HTTP / RTSP port, HTTPS | 80 / 554 / off | |

The account needs permission to view live video. Use an **admin** account if you want the verification code read automatically.

## How it works

- Discovers cameras via ISAPI: analog DVR inputs, NVR IP channels, or a single IP camera.
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
- **Slow on a Pi**: set *Use sub stream up to width* to `640` to use the lighter sub stream for small views.

## License

MIT
