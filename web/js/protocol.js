// Binary wire format shared with the hosts (host-windows/.../Session/Wire.cs, host-macos/.../Session/Wire.swift). Little-endian.

export const H2C = { VIDEO: 0x01, CURSOR_POS: 0x02, AUDIO: 0x03, CURSOR_SHAPE: 0x05 };
export const C2H = { MOUSE_ABS: 0x10, MOUSE_REL: 0x11, MOUSE_BUTTON: 0x12, MOUSE_WHEEL: 0x13, KEY: 0x14, FRAME_ACK: 0x15, TOUCH_PINCH: 0x16 };
export const VIDEO_HEADER = 28;
export const VF = { KEY: 1, FIRST: 2, LAST: 4, REFINE: 8 }; // REFINE: the still screen sent again, sharper

const enc = new TextEncoder();

export function mouseAbs(nx, ny) {
  const b = new ArrayBuffer(9), v = new DataView(b);
  v.setUint8(0, C2H.MOUSE_ABS);
  v.setFloat32(1, nx, true);
  v.setFloat32(5, ny, true);
  return b;
}

export function mouseRel(dx, dy) {
  const b = new ArrayBuffer(5), v = new DataView(b);
  v.setUint8(0, C2H.MOUSE_REL);
  v.setInt16(1, clamp16(dx), true);
  v.setInt16(3, clamp16(dy), true);
  return b;
}

export function mouseButton(button, down) {
  return new Uint8Array([C2H.MOUSE_BUTTON, button, down ? 1 : 0]).buffer;
}

/** dx/dy in Windows wheel units (120 = one notch). +dy scrolls up / away from the user. */
export function wheel(dx, dy) {
  const b = new ArrayBuffer(5), v = new DataView(b);
  v.setUint8(0, C2H.MOUSE_WHEEL);
  v.setInt16(1, clamp16(dx), true);
  v.setInt16(3, clamp16(dy), true);
  return b;
}

/** Two native touch contacts on a capable Windows host. Scale is relative to the gesture start. */
export function touchPinch(phase, nx = 0, ny = 0, scale = 1) {
  const b = new ArrayBuffer(14), v = new DataView(b);
  v.setUint8(0, C2H.TOUCH_PINCH);
  v.setUint8(1, phase);
  v.setFloat32(2, nx, true);
  v.setFloat32(6, ny, true);
  v.setFloat32(10, scale, true);
  return b;
}

export function key(code, down) {
  const c = enc.encode(code);
  const b = new Uint8Array(3 + c.length);
  b[0] = C2H.KEY; b[1] = down ? 1 : 0; b[2] = c.length; b.set(c, 3);
  return b.buffer;
}

export function frameAck(frameId) {
  const b = new ArrayBuffer(5), v = new DataView(b);
  v.setUint8(0, C2H.FRAME_ACK);
  v.setUint32(1, frameId, true);
  return b;
}

export function parseVideoHeader(view) {
  return {
    flags: view.getUint8(1),
    epoch: view.getUint16(2, true),
    frameId: view.getUint32(4, true),
    total: view.getInt32(8, true),
    offset: view.getInt32(12, true),
    captureUs: Number(view.getBigInt64(16, true)),
    encodeMs: view.getUint16(24, true) / 10,
  };
}

/** `0x03` audio: [0x03][u8 codec: 0 Opus, 1 PCM s24le, 2 silence][u16 0][u32 seq][i64 host µs][payload]. */
export function parseAudio(data, view = new DataView(data)) {
  return { codec: view.getUint8(1), seq: view.getUint32(4, true), timeUs: Number(view.getBigInt64(8, true)), data: new Uint8Array(data, 16) };
}

/** Puts `0x01` video fragments back together: push() returns the whole frame once its last fragment is in. */
export class FrameAssembler {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.frame = null; // { frameId, epoch, buf, received, key, captureUs, encodeMs, firstAt }
  }

  reset() { this.frame = null; }

  /** One fragment; the frame { frameId, epoch, key, data, captureUs, encodeMs, receiveMs } on its last, else null. */
  push(data, view = new DataView(data)) {
    const h = parseVideoHeader(view);
    const payload = new Uint8Array(data, VIDEO_HEADER);
    let a = this.frame;
    if (h.flags & VF.FIRST) {
      a = this.frame = {
        frameId: h.frameId, epoch: h.epoch, buf: new Uint8Array(h.total), received: 0, key: (h.flags & VF.KEY) !== 0,
        captureUs: h.captureUs, encodeMs: h.encodeMs, firstAt: this.now(),
      };
    }
    if (!a || a.frameId !== h.frameId) return null; // missed the first fragment (shouldn't happen on TCP)
    a.buf.set(payload, h.offset);
    a.received += payload.length;
    if (!(h.flags & VF.LAST)) return null;
    this.frame = null;
    return { frameId: a.frameId, epoch: a.epoch, key: a.key, data: a.buf, captureUs: a.captureUs, encodeMs: a.encodeMs, receiveMs: this.now() - a.firstAt };
  }
}

function clamp16(v) { return Math.max(-32768, Math.min(32767, Math.round(v))); }
