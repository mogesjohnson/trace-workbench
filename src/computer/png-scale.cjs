'use strict';

// Integer box downscale for the 8-bit RGB/RGBA non-interlaced PNGs the capture path produces.
// Pixels in the scaled image map back to window-local physical pixels by multiplying by `factor`.
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_MAX_EDGE = 1280;

function chunks(buffer) {
  const list = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) return null;
    list.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return list;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decode(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  const list = chunks(buffer);
  const header = list?.[0];
  if (!header || header.type !== 'IHDR' || header.data.length !== 13) return null;
  const width = header.data.readUInt32BE(0), height = header.data.readUInt32BE(4);
  const [bitDepth, colorType, , , interlace] = header.data.subarray(8);
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0 || !width || !height) return null;
  const channels = colorType === 6 ? 4 : 3, stride = width * channels;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(list.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data))); }
  catch { return null; }
  if (raw.length !== (stride + 1) * height) return null;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], source = y * (stride + 1) + 1, row = y * stride, previous = row - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[source + x];
      const a = x >= channels ? pixels[row + x - channels] : 0, b = y ? pixels[previous + x] : 0;
      const c = x >= channels && y ? pixels[previous + x - channels] : 0;
      let out;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + a; break;
        case 2: out = value + b; break;
        case 3: out = value + ((a + b) >> 1); break;
        case 4: out = value + paeth(a, b, c); break;
        default: return null;
      }
      pixels[row + x] = out & 255;
    }
  }
  return { width, height, channels, colorType, pixels };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function encode({ width, height, channels, colorType, pixels }) {
  const stride = width * channels, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = colorType;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Returns { data, width, height, factor }. factor 1 means the source was already small enough,
 * or its format is unsupported (`reason` says which); the original bytes are returned then. */
function downscalePng(buffer, maxEdge = DEFAULT_MAX_EDGE) {
  const image = decode(buffer);
  if (!image) return { data: buffer, factor: 1, reason: 'unsupported_png_format' };
  const factor = Math.ceil(Math.max(image.width, image.height) / maxEdge);
  if (factor <= 1) return { data: buffer, width: image.width, height: image.height, factor: 1 };
  const width = Math.ceil(image.width / factor), height = Math.ceil(image.height / factor), channels = image.channels;
  const pixels = new Uint8Array(width * height * channels), sums = new Uint32Array(channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sums.fill(0);
      let count = 0;
      for (let sy = y * factor; sy < Math.min((y + 1) * factor, image.height); sy++) {
        for (let sx = x * factor; sx < Math.min((x + 1) * factor, image.width); sx++) {
          const offset = (sy * image.width + sx) * channels;
          for (let c = 0; c < channels; c++) sums[c] += image.pixels[offset + c];
          count++;
        }
      }
      const out = (y * width + x) * channels;
      for (let c = 0; c < channels; c++) pixels[out + c] = Math.round(sums[c] / count);
    }
  }
  return { data: encode({ width, height, channels, colorType: image.colorType, pixels }), width, height, factor };
}

module.exports = { downscalePng, decode, encode, DEFAULT_MAX_EDGE };
