/**
 * Removes the metadata a camera or editor writes into an image (EXIF with the GPS position and
 * the phone's make, XMP, IPTC, comments, PNG text chunks), keeping the pixels as they are. A
 * JPEG keeps only its EXIF orientation, so a phone photo still shows the right way up. Works on
 * the bytes, without decoding the image. Anything it does not recognise is kept as sent.
 */
export function stripImageMetadata(data: Buffer, type: 'jpg' | 'png' | 'webp'): Buffer {
  if (type === 'jpg') return stripJpeg(data)
  if (type === 'png') return stripPng(data)
  return stripWebp(data)
}

// APP1 (EXIF, XMP), APP13 (Photoshop, IPTC) and comments. APP0 (JFIF), APP2 (ICC colour profile)
// and APP14 (Adobe colour transform) are needed to show the image right and stay.
const JPEG_DROPPED = new Set([0xe1, 0xed, 0xfe])

function stripJpeg(data: Buffer): Buffer {
  const parts: Buffer[] = [data.subarray(0, 2)]
  let orientation: number | null = null
  let at = 2
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) break
    const marker = data[at + 1] as number
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at++
      continue
    }
    // Start of scan: the image data follows, with no more metadata segments to look for.
    if (marker === 0xda) break
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(data.subarray(at, at + 2))
      at += 2
      continue
    }
    const end = at + 2 + data.readUInt16BE(at + 2)
    if (JPEG_DROPPED.has(marker)) {
      if (marker === 0xe1) orientation ??= exifOrientation(data.subarray(at + 4, end))
    } else {
      parts.push(data.subarray(at, Math.min(end, data.length)))
    }
    at = end
  }
  if (at < data.length) parts.push(data.subarray(at))
  if (orientation !== null && orientation !== 1) {
    // After JFIF's APP0, which comes first when there is one.
    const afterJfif = parts[1]?.[0] === 0xff && parts[1]?.[1] === 0xe0 ? 2 : 1
    parts.splice(afterJfif, 0, orientationSegment(orientation))
  }
  return Buffer.concat(parts)
}

/** The orientation tag of an APP1 EXIF payload, if it has one. */
function exifOrientation(app1: Buffer): number | null {
  if (app1.length < 14 || app1.subarray(0, 6).toString('latin1') !== 'Exif\0\0') return null
  const tiff = app1.subarray(6)
  const little = tiff.subarray(0, 2).toString('latin1') === 'II'
  const u16 = (o: number) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = (o: number) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  try {
    const ifd = u32(4)
    const count = u16(ifd)
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12
      if (u16(entry) === 0x0112) {
        const value = u16(entry + 8)
        return value >= 1 && value <= 8 ? value : null
      }
    }
  } catch {
    // A truncated EXIF block: no orientation.
  }
  return null
}

/** An APP1 EXIF segment holding the orientation and nothing else. */
function orientationSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8) // one entry
  tiff.writeUInt16BE(0x0112, 10) // orientation
  tiff.writeUInt16BE(3, 12) // SHORT
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt16BE(orientation, 18)
  tiff.writeUInt32BE(0, 22) // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const head = Buffer.alloc(4)
  head.writeUInt16BE(0xffe1, 0)
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}

// Text, the EXIF chunk and the last-modified time.
const PNG_DROPPED = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])

function stripPng(data: Buffer): Buffer {
  const parts: Buffer[] = [data.subarray(0, 8)]
  let at = 8
  while (at + 12 <= data.length) {
    const end = at + 12 + data.readUInt32BE(at)
    if (!PNG_DROPPED.has(data.subarray(at + 4, at + 8).toString('latin1'))) {
      parts.push(data.subarray(at, Math.min(end, data.length)))
    }
    at = end
  }
  if (at < data.length) parts.push(data.subarray(at))
  return Buffer.concat(parts)
}

function stripWebp(data: Buffer): Buffer {
  const parts: Buffer[] = []
  let at = 12
  while (at + 8 <= data.length) {
    const size = data.readUInt32LE(at + 4)
    const end = at + 8 + size + (size % 2)
    const kind = data.subarray(at, at + 4).toString('latin1')
    if (kind !== 'EXIF' && kind !== 'XMP ') {
      const chunk = Buffer.from(data.subarray(at, Math.min(end, data.length)))
      // The extended header says which of them the file has.
      if (kind === 'VP8X' && chunk.length > 8) chunk[8] = (chunk[8] as number) & ~0x0c
      parts.push(chunk)
    }
    at = end
  }
  if (at < data.length) parts.push(data.subarray(at))
  const body = Buffer.concat(parts)
  const head = Buffer.from(data.subarray(0, 12))
  head.writeUInt32LE(body.length + 4, 4)
  return Buffer.concat([head, body])
}
