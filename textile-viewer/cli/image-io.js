// Minimal zero-dependency image writers for Node CLI verification output.
// PPM (P6) is used for numeric reference images that tests diff byte-for-byte;
// PNG uses a stored (zlib level 0) encoder so screenshots are viewable too.

import zlib from 'node:zlib';

export function writePPM(rgba, size) {
  const header = Buffer.from(`P6\n${size} ${size}\n255\n`, 'ascii');
  const body = Buffer.alloc((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    body[j] = rgba[i];
    body[j + 1] = rgba[i + 1];
    body[j + 2] = rgba[i + 2];
  }
  return Buffer.concat([header, body]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePNG(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 0 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Nearest-neighbor upscale a tileable RGBA texture (for 16x reference images).
export function upscaleNearest(rgba, srcSize, factor) {
  const dstSize = srcSize * factor;
  const out = new Uint8ClampedArray(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < dstSize; x++) {
      const sx = Math.floor(x / factor);
      const si = (sy * srcSize + sx) * 4;
      const di = (y * dstSize + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return { data: out, size: dstSize };
}
