// Figures out what kind of image a buffer holds and how big it is, straight from
// the file header. We never trust the filename or the Content-Type the client sends.

export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const EXT_TYPES = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t]));

function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, minus DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xda || marker === 0xd9) return null; // hit image data without a frame header
    i += 2 + length;
  }
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** Returns { type, ext, width, height, bytes } or null if this isn't a supported image. */
export function inspectImage(buf) {
  const type = sniffType(buf);
  if (!type) return null;
  const size = type === 'image/jpeg' ? jpegSize(buf) : type === 'image/png' ? pngSize(buf) : webpSize(buf);
  return {
    type,
    ext: IMAGE_TYPES[type],
    width: size?.width ?? null,
    height: size?.height ?? null,
    bytes: buf.length,
  };
}
