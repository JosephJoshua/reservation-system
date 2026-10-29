import { describe, expect, it } from 'vitest'
import { stripImageMetadata } from './services/image-meta'

const seg = (marker: number, payload: Buffer) => {
  const head = Buffer.alloc(4)
  head.writeUInt16BE(0xff00 | marker, 0)
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}

/** EXIF with orientation 6 and a GPS IFD holding a latitude, little-endian as phones write it. */
function exifWithGps() {
  const tiff = Buffer.alloc(80)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(2, 8)
  // Orientation = 6.
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(6, 18)
  // GPS IFD pointer.
  tiff.writeUInt16LE(0x8825, 22)
  tiff.writeUInt16LE(4, 24)
  tiff.writeUInt32LE(1, 26)
  tiff.writeUInt32LE(38, 30)
  tiff.writeUInt32LE(0, 34)
  tiff.writeUInt16LE(1, 38)
  tiff.writeUInt16LE(0x0001, 40) // GPSLatitudeRef
  tiff.writeUInt16LE(2, 42)
  tiff.writeUInt32LE(2, 44)
  tiff.write('N\0', 46, 'latin1')
  tiff.write('GPS-31.2304-121.4737', 54, 'latin1')
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
}

const jfif = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))
const icc = seg(0xe2, Buffer.from('ICC_PROFILE\0colour', 'latin1'))
const scan = Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9])

describe('image metadata', () => {
  it('drops EXIF with GPS, XMP and comments from a JPEG and keeps its orientation', () => {
    const xmp = seg(
      0xe1,
      Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:gps>31.23</x:gps>', 'latin1'),
    )
    const comment = seg(0xfe, Buffer.from('iPhone 15 Pro', 'latin1'))
    const photo = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jfif,
      seg(0xe1, exifWithGps()),
      xmp,
      icc,
      comment,
      scan,
    ])
    const out = stripImageMetadata(photo, 'jpg')
    const text = out.toString('latin1')
    expect(text).not.toContain('GPS-31.2304')
    expect(text).not.toContain('x:gps')
    expect(text).not.toContain('iPhone')
    expect(text).toContain('ICC_PROFILE')
    // Still a JPEG, JFIF first, its scan untouched, and turned the same way.
    expect(out.subarray(0, 2 + jfif.length)).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xd8]), jfif]),
    )
    expect(out.subarray(out.length - scan.length)).toEqual(scan)
    const app1 = out.subarray(2 + jfif.length)
    expect(app1.readUInt16BE(0)).toBe(0xffe1)
    expect(app1.subarray(4, 10).toString('latin1')).toBe('Exif\0\0')
    // MM, then IFD0 at 8 with one entry: tag 0x0112, SHORT, value 6.
    expect(app1.readUInt16BE(10 + 10)).toBe(0x0112)
    expect(app1.readUInt16BE(10 + 18)).toBe(6)
  })

  it('leaves a JPEG without metadata as it is', () => {
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, scan])
    expect(stripImageMetadata(photo, 'jpg')).toEqual(photo)
    // A truncated header too.
    const short = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
    expect(stripImageMetadata(short, 'jpg')).toEqual(short)
  })

  it('drops text and EXIF chunks from a PNG', () => {
    const chunk = (kind: string, body: Buffer) => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(body.length)
      return Buffer.concat([len, Buffer.from(kind, 'latin1'), body, Buffer.alloc(4)])
    }
    const ihdr = chunk('IHDR', Buffer.alloc(13))
    const idat = chunk('IDAT', Buffer.from([1, 2, 3]))
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const png = Buffer.concat([
      sig,
      ihdr,
      chunk('tEXt', Buffer.from('Comment\0secret', 'latin1')),
      chunk('eXIf', exifWithGps().subarray(6)),
      idat,
      chunk('IEND', Buffer.alloc(0)),
    ])
    const out = stripImageMetadata(png, 'png')
    expect(out).toEqual(Buffer.concat([sig, ihdr, idat, chunk('IEND', Buffer.alloc(0))]))
  })

  it('drops EXIF and XMP chunks from a WebP and its header flags', () => {
    const chunk = (kind: string, body: Buffer) => {
      const len = Buffer.alloc(4)
      len.writeUInt32LE(body.length)
      return Buffer.concat([
        Buffer.from(kind, 'latin1'),
        len,
        body,
        body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
      ])
    }
    const flags = Buffer.alloc(10)
    flags[0] = 0x0c
    const body = Buffer.concat([
      chunk('VP8X', flags),
      chunk('VP8 ', Buffer.from([9, 9, 9, 9])),
      chunk('EXIF', exifWithGps().subarray(6)),
      chunk('XMP ', Buffer.from('<x:gps/>', 'latin1')),
    ])
    const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1')
    head.writeUInt32LE(body.length + 4, 4)
    const out = stripImageMetadata(Buffer.concat([head, body]), 'webp')
    expect(out.toString('latin1')).not.toContain('GPS-31')
    expect(out.toString('latin1')).not.toContain('x:gps')
    expect(out.readUInt32LE(4)).toBe(out.length - 8)
    expect(out[20]).toBe(0)
  })
})
