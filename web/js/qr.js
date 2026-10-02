// Minimal QR Code generator (ISO/IEC 18004): byte mode, versions 1-40, error correction L/M/Q/H.
// Used for "scan to pair" on the host settings page. Dependency-free; output is an SVG string.

const ECL = { L: { ord: 0, bits: 1 }, M: { ord: 1, bits: 0 }, Q: { ord: 2, bits: 3 }, H: { ord: 3, bits: 2 } };

const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

export function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

export function dataCodewords(ver, ecl) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl.ord][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ord][ver];
}

// ---------------------------------------------------------------- Reed-Solomon over GF(2^8), poly 0x11D
function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

export function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

export function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= rsMultiply(coef, factor); });
  }
  return result;
}

// ---------------------------------------------------------------- encoder
export class QrCode {
  /** @param {string} text  @param {'L'|'M'|'Q'|'H'} ecc */
  static encode(text, ecc = 'M') {
    const ecl = ECL[ecc];
    const bytes = [...new TextEncoder().encode(text)];
    let ver, capacityBits;
    for (ver = 1; ver <= 40; ver++) {
      capacityBits = dataCodewords(ver, ecl) * 8;
      const countBits = ver < 10 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= capacityBits) break;
    }
    if (ver > 40) throw new Error('text too long for a QR code');
    const bb = [];
    const append = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
    append(0x4, 4);                                // byte mode
    append(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) append(b, 8);
    append(0, Math.min(4, capacityBits - bb.length)); // terminator
    append(0, (8 - bb.length % 8) % 8);
    for (let pad = 0xEC; bb.length < capacityBits; pad ^= 0xEC ^ 0x11) append(pad, 8);
    const data = [];
    for (let i = 0; i < bb.length; i += 8) data.push(parseInt(bb.slice(i, i + 8).join(''), 2));
    return new QrCode(ver, ecl, data);
  }

  constructor(ver, ecl, dataCodewordsArr, forcedMask = -1) {
    this.version = ver;
    this.ecl = ecl;
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this._drawFunctionPatterns();
    this.codewords = this._addEccAndInterleave(dataCodewordsArr);
    this._drawCodewords(this.codewords);
    let best = forcedMask, minPenalty = Infinity;
    if (best < 0) {
      for (let m = 0; m < 8; m++) {
        this._applyMask(m);
        this._drawFormatBits(m);
        const p = this._penalty();
        if (p < minPenalty) { best = m; minPenalty = p; }
        this._applyMask(m); // undo (XOR)
      }
    }
    this.mask = best;
    this._applyMask(best);
    this._drawFormatBits(best);
  }

  _set(x, y, dark) { this.modules[y][x] = dark; this.isFunction[y][x] = true; }

  _drawFunctionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) { this._set(6, i, i % 2 === 0); this._set(i, 6, i % 2 === 0); }
    this._finder(3, 3); this._finder(s - 4, 3); this._finder(3, s - 4);
    const pos = this.alignmentPositions();
    const n = pos.length;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this._alignment(pos[i], pos[j]);
    this._drawFormatBits(0);
    this._drawVersion();
  }

  alignmentPositions() {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  _finder(x, y) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this._set(xx, yy, d !== 2 && d !== 4);
      }
  }

  _alignment(x, y) {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) this._set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  static formatBits(ecl, mask) {
    const data = (ecl.bits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  _drawFormatBits(mask) {
    const bits = QrCode.formatBits(this.ecl, mask), s = this.size;
    for (let i = 0; i <= 5; i++) this._set(8, i, getBit(bits, i));
    this._set(8, 7, getBit(bits, 6));
    this._set(8, 8, getBit(bits, 7));
    this._set(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this._set(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) this._set(s - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this._set(8, s - 15 + i, getBit(bits, i));
    this._set(8, s - 8, true);
  }

  _drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const c = getBit(bits, i), a = this.size - 11 + (i % 3), b = Math.floor(i / 3);
      this._set(a, b, c);
      this._set(b, a, c);
    }
  }

  _addEccAndInterleave(data) {
    const ver = this.version, o = this.ecl.ord;
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[o][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[o][ver];
    const rawCodewords = Math.floor(rawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const div = rsDivisor(blockEccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    this._blockLayout = { numBlocks, blockEccLen, numShortBlocks, shortBlockLen };
    const result = [];
    for (let i = 0; i < blocks[0].length; i++)
      blocks.forEach((b, j) => { if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(b[i]); });
    return result;
  }

  /** Visits data-module coordinates in placement order (shared by drawing and the self-test reader). */
  *_dataModuleOrder() {
    const s = this.size;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - vert : vert;
          if (!this.isFunction[y][x]) yield [x, y];
        }
    }
  }

  _drawCodewords(data) {
    let i = 0;
    for (const [x, y] of this._dataModuleOrder()) {
      if (i < data.length * 8) this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
      i++;
    }
  }

  static maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  _applyMask(mask) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (!this.isFunction[y][x] && QrCode.maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
  }

  /** Simplified penalty (runs, 2x2 blocks, dark balance) — any mask is valid, this just picks a clean one. */
  _penalty() {
    const s = this.size, m = this.modules;
    let p = 0, dark = 0;
    for (let y = 0; y < s; y++) {
      let runX = 1, runY = 1;
      for (let x = 0; x < s; x++) {
        if (m[y][x]) dark++;
        if (x > 0) {
          if (m[y][x] === m[y][x - 1]) { runX++; if (runX === 5) p += 3; else if (runX > 5) p++; } else runX = 1;
          if (m[x][y] === m[x - 1][y]) { runY++; if (runY === 5) p += 3; else if (runY > 5) p++; } else runY = 1;
        }
        if (x > 0 && y > 0 && m[y][x] === m[y][x - 1] && m[y][x] === m[y - 1][x] && m[y][x] === m[y - 1][x - 1]) p += 3;
      }
    }
    const k = Math.ceil(Math.abs(dark * 20 - s * s * 10) / (s * s)) - 1;
    return p + Math.max(0, k) * 10;
  }

  /** Reads the codewords back out of the finished symbol (unmasking) — used by the self-test. */
  readCodewords() {
    const bits = [];
    for (const [x, y] of this._dataModuleOrder()) bits.push(this.modules[y][x] !== QrCode.maskBit(this.mask, x, y));
    const out = [];
    for (let i = 0; i + 8 <= bits.length && out.length < this.codewords.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ? 1 : 0);
      out.push(b);
    }
    return out;
  }

  toSvg({ border = 4, dark = '#000', light = '#fff' } = {}) {
    const n = this.size + border * 2;
    let path = '';
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (this.modules[y][x]) path += `M${x + border},${y + border}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
      `<rect width="${n}" height="${n}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
  }
}

export function qrSvg(text, opts = {}) {
  return QrCode.encode(text, opts.ecc || 'M').toSvg(opts);
}
