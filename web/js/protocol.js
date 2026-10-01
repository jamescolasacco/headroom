// Binary wire format shared with the host (host-windows/.../Session/Wire.cs). Little-endian.

export const H2C = { VIDEO: 0x01, CURSOR_POS: 0x02, AUDIO: 0x03, CURSOR_SHAPE: 0x05 };
export const C2H = { MOUSE_ABS: 0x10, MOUSE_REL: 0x11, MOUSE_BUTTON: 0x12, MOUSE_WHEEL: 0x13, KEY: 0x14, FRAME_ACK: 0x15 };
export const VIDEO_HEADER = 28;
export const VF = { KEY: 1, FIRST: 2, LAST: 4 };

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

function clamp16(v) { return Math.max(-32768, Math.min(32767, Math.round(v))); }
