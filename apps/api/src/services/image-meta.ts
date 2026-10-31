import { ApiError } from '../errors'

/**
 * Removes the metadata a camera or editor writes into an image (EXIF with the GPS position and
 * the phone's make, XMP, IPTC, comments, PNG text chunks), keeping the pixels as they are. A
 * JPEG keeps only its EXIF orientation, so a phone photo still shows the right way up. Anything
 * after the image itself goes too: a second image appended to a JPEG (MPO, gain maps), the video
 * of a motion photo, data past a PNG's end or a WebP's RIFF size. Works on the bytes, without
 * decoding the image. A file too odd to go through is refused.
 */
export function stripImageMetadata(data: Buffer, type: 'jpg' | 'png' | 'webp'): Buffer {
  if (type === 'jpg') return stripJpeg(data)
  if (type === 'png') return stripPng(data)
  return stripWebp(data)
}

const unreadable = () => new ApiError(400, 'bad_image', '图片无法识别，请换一张')

/**
 * The output as ranges of the input, with adjacent ones joined, so a file of many small parts
 * costs no more than one of a few large ones.
 */
class Pieces {
  private readonly parts: (Buffer | [number, number])[] = []
  constructor(private readonly data: Buffer) {}

  keep(start: number, end: number) {
    const to = Math.min(end, this.data.length)
    if (to <= start) return
    const last = this.parts[this.parts.length - 1]
    if (Array.isArray(last) && last[1] === start) last[1] = to
    else this.parts.push([start, to])
  }

  add(bytes: Buffer) {
    this.parts.push(bytes)
  }

  /** A place to fill in later, which `set` fills. */
  mark() {
    this.parts.push(Buffer.alloc(0))
    return this.parts.length - 1
  }

  set(index: number, bytes: Buffer) {
    this.parts[index] = bytes
  }

  join() {
    return Buffer.concat(
      this.parts.map((p) => (Array.isArray(p) ? this.data.subarray(p[0], p[1]) : p)),
    )
  }
}

// APP1 (EXIF, XMP), APP13 (Photoshop, IPTC) and comments. APP0 (JFIF), APP2 (ICC colour profile)
// and APP14 (Adobe colour transform) are needed to show the image right and stay, before the
// first scan. Between the scans of a progressive JPEG no APPn or comment is needed at all.
const JPEG_DROPPED = new Set([0xe1, 0xed, 0xfe])
const isApp = (marker: number) => (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe
// A real JPEG has a few dozen segments, a progressive one a few more for each scan.
const MAX_JPEG_SEGMENTS = 1000

function stripJpeg(data: Buffer): Buffer {
  const out = new Pieces(data)
  out.keep(0, 2)
  let orientation: number | null = null
  let scanned = false
  let segments = 0
  // Where the orientation goes: after JFIF's APP0, which comes first when there is one.
  let slot = -1
  let at = 2
  while (at + 2 <= data.length) {
    if (slot === -1 && !(at === 2 && data[at] === 0xff && data[at + 1] === 0xe0)) slot = out.mark()
    if (data[at] !== 0xff) {
      // Stray bytes where a marker belongs: skipped up to the next marker, as libjpeg does.
      const next = data.indexOf(0xff, at)
      if (next === -1) break
      at = next
      continue
    }
    const marker = data[at + 1] as number
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at++
      continue
    }
    if (++segments > MAX_JPEG_SEGMENTS) throw unreadable()
    // End of the image: whatever follows (another image, a video) is left out.
    if (marker === 0xd9) {
      out.keep(at, at + 2)
      break
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.keep(at, at + 2)
      at += 2
      continue
    }
    if (at + 4 > data.length) {
      out.keep(at, data.length)
      break
    }
    const end = at + 2 + data.readUInt16BE(at + 2)
    if (marker === 0xda) {
      // The scan header, then its entropy-coded data up to the next marker. FF00 is a coded 0xFF
      // and RSTn restart markers belong to the scan.
      out.keep(at, end)
      let next = end
      for (;;) {
        next = data.indexOf(0xff, next)
        if (next === -1 || next + 1 >= data.length) {
          next = data.length
          break
        }
        const b = data[next + 1] as number
        if (b === 0x00 || (b >= 0xd0 && b <= 0xd7) || b === 0xff) {
          next += b === 0xff ? 1 : 2
          continue
        }
        break
      }
      out.keep(end, next)
      scanned = true
      at = next
      continue
    }
    if (marker === 0xe1 && !scanned) orientation ??= exifOrientation(data.subarray(at + 4, end))
    const dropped = scanned ? isApp(marker) : JPEG_DROPPED.has(marker)
    if (!dropped) out.keep(at, end)
    at = end
  }
  if (orientation !== null && orientation !== 1 && slot !== -1) {
    out.set(slot, orientationSegment(orientation))
  }
  return out.join()
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
    const count = Math.min(u16(ifd), 500)
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
  const out = new Pieces(data)
  out.keep(0, 8)
  let at = 8
  while (at + 12 <= data.length) {
    const kind = data.toString('latin1', at + 4, at + 8)
    const end = at + 12 + data.readUInt32BE(at)
    if (!PNG_DROPPED.has(kind)) out.keep(at, end)
    at = end
    // Nothing after the image's end.
    if (kind === 'IEND') return out.join()
  }
  out.keep(at, data.length)
  return out.join()
}

function stripWebp(data: Buffer): Buffer {
  // Nothing past what the RIFF header says the file holds.
  const size = Math.min(data.length, 8 + data.readUInt32LE(4))
  const out = new Pieces(data)
  out.add(Buffer.from(data.subarray(0, 12)))
  let at = 12
  while (at + 8 <= size) {
    const length = data.readUInt32LE(at + 4)
    const end = Math.min(at + 8 + length + (length % 2), size)
    const kind = data.toString('latin1', at, at + 4)
    if (kind === 'VP8X' && end - at > 8) {
      // The extended header says which of them the file has.
      const chunk = Buffer.from(data.subarray(at, end))
      chunk[8] = (chunk[8] as number) & ~0x0c
      out.add(chunk)
    } else if (kind !== 'EXIF' && kind !== 'XMP ') {
      out.keep(at, end)
    }
    at = end
  }
  out.keep(at, size)
  const joined = out.join()
  joined.writeUInt32LE(joined.length - 8, 4)
  return joined
}
