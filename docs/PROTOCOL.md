# Headroom wire protocol (v1)

This is the contract between a **host** (Windows today, macOS next) and the **web client**. Any host
that speaks it works with the same client.

Transport: one WebSocket at `wss://<host>:7443/ws` (`ws://` only on loopback). Text frames carry
JSON control messages, and binary frames carry media and input. Binary layouts are little-endian.

## 1. Handshake

1. The client opens the socket and sends `hello` within 10 s:
   ```json
   { "t": "hello", "token": "<device bearer token>", "client": { "name": "iPhone", "platform": "ios", "ua": "…" } }
   ```
2. The host answers with either `error` followed by a close, or `welcome`:
   ```json
   { "t": "welcome", "session": "id", "host": { "id", "name", "machine", "os", "osVersion", "version" },
     "monitors": [ { "id": "\\\\.\\DISPLAY1", "name": "DELL U2720Q", "x": 0, "y": 0, "width": 3840, "height": 2160,
                     "primary": true, "refreshHz": 60, "scale": 1.5, "rotation": 0 } ],
     "device": { "id", "name" },
     "permissions": { "input": true, "clipboard": true, "files": true, "audio": true },
     "limits": { "maxFps": 60, "maxBitrateKbps": 40000 }, "elevated": false, "hostTimeUs": 123 }
   ```
   Error codes are `unauthorized`, `rate-limited` (with `retryAfter` in seconds) and `bad-request`.
3. The client starts or changes the stream with `start`. It can send `start` again at any time to switch
   monitor, fps or resolution:
   ```json
   { "t": "start", "monitor": "\\\\.\\DISPLAY1", "maxFps": 60, "maxBitrateKbps": 20000,
     "maxWidth": 0, "maxHeight": 0, "audio": true }
   ```

Tokens come from pairing (`POST /api/pair`, see §6) and are never placed in URLs.

## 2. Video

Before the first frame of each *epoch*, the host sends `video-config`:
```json
{ "t": "video-config", "epoch": 3, "codec": "avc1.64002a", "description": "<base64 avcC>",
  "width": 1920, "height": 1080, "sourceWidth": 3840, "sourceHeight": 2160,
  "monitor": "\\\\.\\DISPLAY1", "encoder": "NVIDIA H.264 Encoder MFT", "hardware": true, "fullRange": false }
```
- The client configures a WebCodecs `VideoDecoder` with `codec` and `description`. Chunks are AVCC:
  4-byte length-prefixed NAL units with no SPS, PPS, AUD or SEI.
- A new epoch starts after a monitor switch, a resolution change or an encoder rebuild. The first frame
  of an epoch is always an IDR.
- The host's SPS declares `bitstream_restriction` with `max_num_reorder_frames = 0`, and no B-frames are
  used. Without that, browser decoders buffer frames: Chrome about 4, Safari about 16.

**`0x01` video fragment** (host → client). Frames are cut into fragments of up to 64 KiB so that other
messages can interleave.

| offset | size | field |
|---|---|---|
| 0 | 1 | type = 0x01 |
| 1 | 1 | flags: 1 key, 2 first fragment, 4 last fragment |
| 2 | 2 | epoch (u16) |
| 4 | 4 | frameId (u32, increasing) |
| 8 | 4 | total frame length |
| 12 | 4 | offset of this fragment |
| 16 | 8 | capture time, host clock µs (i64; also used as the decoder timestamp) |
| 24 | 2 | encode time, 0.1 ms units |
| 26 | 2 | reserved |
| 28 | … | payload |

**`0x15` frame ack** (client → host): `[0x15][u32 frameId]`. The client sends it **as soon as the last
fragment arrives**. The host uses acks for flow control, which works as follows:
- It never queues frames. It encodes only while unacknowledged bytes are below about 1.5× the
  bandwidth-delay product.
- It derives delivery rate and queueing delay from the acks.
- An AIMD controller adjusts the encoder bitrate between the min and max limits.

`{"t":"keyframe"}` (client → host) asks for an IDR, for example after a decoder error or on returning
from the background.

## 3. Cursor

The host sends the cursor separately so the client can draw it locally with no latency.

- **`0x05` cursor shape**: `[0x05][u8 flags][u16 rsv][u32 id][u16 w][u16 h][u16 hotX][u16 hotY][RGBA w·h·4]`.
  When `w == 0`, the client should reuse the cached shape with that `id`. The id is a content hash.
- **`0x02` cursor position**: `[0x02][u8 flags: 1=visible][u16 rsv][i32 x][i32 y]`, in source-monitor
  pixels relative to the monitor's top-left corner.

## 4. Input (client → host)

| type | layout | meaning |
|---|---|---|
| `0x10` | `[f32 nx][f32 ny]` | absolute pointer move, normalized 0..1 across the streamed monitor |
| `0x11` | `[i16 dx][i16 dy]` | relative move (pointer lock) |
| `0x12` | `[u8 button][u8 down]` | buttons: 0 left, 1 middle, 2 right, 3 back, 4 forward |
| `0x13` | `[i16 dx][i16 dy]` | wheel in Windows units (120 = one notch; fractions allowed). +dy scrolls up, +dx scrolls right |
| `0x14` | `[u8 flags: 1=down][u8 len][ASCII code]` | a key, as a W3C `KeyboardEvent.code` (positional; the host's layout applies) |

JSON input messages:
- `{"t":"text","s":"…"}` types text layout-independently (Unicode injection). It is used for soft
  keyboards, dictation, IME and "type clipboard".
- `{"t":"locks","caps":bool,"num":bool}` syncs Caps Lock and Num Lock state.
- `{"t":"release"}` releases everything this viewer holds. The client sends it on blur or hide; the host
  also does it on disconnect.
- `{"t":"special","action":"cad"|"lock"|"taskmgr"}` sends Ctrl+Alt+Del (SAS, service mode only), locks
  the workstation, or opens Task Manager.

Keyboard *translation* happens client-side. The Mac profile maps Cmd+C to Ctrl+C, Cmd alone to Win, and
so on. The host only ever sees plain key codes.

## 5. Other messages

- **Clipboard**: `{"t":"clip","text":"…"}` goes in both directions. `{"t":"clip-get"}` asks the host for
  its current clipboard.
- **Audio**: `{"t":"audio","enabled":bool}` turns audio on or off. The host sends **`0x03` audio** as
  `[0x03][3 rsv][u32 seq][i64 host µs][Opus packet]`: 48 kHz stereo, 10 ms CELT frames. The host sends
  nothing during silence, so the client re-buffers on sequence gaps.
- **Files**: `{"t":"file-token","path":"…","id":"…"}` makes the host reply with `file-token` and a
  2-minute single-use `token` for `GET /api/files/download?t=`.
- **Host → client**:
  - `status`, with `capture`: `ok` | `secure-desktop` | `unavailable` | `starting`
  - `stats`, with `fps`, `kbps`, `targetKbps`, `encodeMs`, `frameRttMs` and `minRttMs`
  - `notice`, a message for the user
  - `monitors`, the monitor list
- **Liveness**: the client sends `{"t":"ping","id":n,"ts":clientMs}` every second and the host replies
  `{"t":"pong","id":n,"ts":…,"host":µs}`. Either side closes after 20 s of silence.

## 6. HTTP API (same origin as the WebSocket)

| method | path | auth | purpose |
|---|---|---|---|
| GET | `/api/info` | none | host identity, whether a password is set, TOTP requirement |
| POST | `/api/pair` | password + optional TOTP, or a one-time `code` | returns `{token, device, host}` |
| GET | `/api/me` | Bearer | token health check |
| GET | `/api/files/list?path=` | Bearer | directory listing; empty path lists roots |
| POST | `/api/files/upload?dir=&name=` | Bearer | raw body; saved under a non-clashing name |
| GET | `/api/files/download?t=` | ephemeral token | file download |
| GET | `/headroom-ca.crt`, `/headroom-ca.mobileconfig` | none | local CA for device trust |
| * | `/api/admin/*` | loopback only | password, pairing codes, devices, settings |

CORS on `/api/*` is `*` because auth uses bearer tokens, not cookies. The host also answers Chrome's
Private Network Access preflight. Failed authentication is rate-limited per IP: 5 free attempts, then
exponential backoff up to 15 minutes, plus a global cap.
