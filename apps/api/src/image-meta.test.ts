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

  it('keeps one image only: no APPn between scans, nothing after its end', () => {
    const sos = (data: number[]) =>
      Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from(data)])
    // Coded data with a coded 0xFF (FF00) and a restart marker in it.
    const scan1 = sos([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])
    const scan2 = sos([0x78, 0xff, 0x00, 0x9a])
    const dht = seg(0xc4, Buffer.from([0x10, 1, 2, 3]))
    const gps = seg(0xe1, exifWithGps())
    const tail = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      gps,
      Buffer.from('....ftypmp42 motion photo video', 'latin1'),
    ])
    const photo = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jfif,
      scan1,
      gps,
      seg(0xfe, Buffer.from('between scans', 'latin1')),
      dht,
      scan2,
      Buffer.from([0xff, 0xd9]),
      tail,
    ])
    const out = stripImageMetadata(photo, 'jpg')
    expect(out).toEqual(
      Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        jfif,
        scan1,
        dht,
        scan2,
        Buffer.from([0xff, 0xd9]),
      ]),
    )
  })

  it('skips stray bytes before a marker and still drops the EXIF after them', () => {
    const photo = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jfif,
      Buffer.from([0x00, 0x00]),
      seg(0xe1, exifWithGps()),
      scan,
    ])
    const out = stripImageMetadata(photo, 'jpg')
    expect(out.includes(Buffer.from('GPS-31.2304', 'latin1'))).toBe(false)
    expect(out.subarray(-scan.length)).toEqual(scan)
  })

  it('refuses a JPEG of thousands of tiny segments quickly', () => {
    const b = Buffer.alloc(5 * 1024 * 1024)
    b[0] = 0xff
    b[1] = 0xd8
    for (let i = 2; i + 3 < b.length; i += 4) {
      b[i] = 0xff
      b[i + 1] = 0xe0
      b[i + 3] = 2
    }
    const started = performance.now()
    expect(() => stripImageMetadata(b, 'jpg')).toThrow('图片无法识别')
    expect(performance.now() - started).toBeLessThan(200)
  })

  it('goes through a PNG of many tiny chunks without a copy per chunk', () => {
    const b = Buffer.alloc(5 * 1024 * 1024)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
    for (let i = 8; i + 12 <= b.length; i += 12) b.write('IDAT', i + 4, 'latin1')
    const started = performance.now()
    expect(stripImageMetadata(b, 'png').length).toBe(b.length)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('cuts a PNG after IEND and a WebP after its RIFF size', () => {
    const chunk = (kind: string, body: Buffer) => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(body.length)
      return Buffer.concat([len, Buffer.from(kind, 'latin1'), body, Buffer.alloc(4)])
    }
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const png = Buffer.concat([
      sig,
      chunk('IHDR', Buffer.alloc(13)),
      chunk('IEND', Buffer.alloc(0)),
    ])
    const extra = Buffer.from('GPS 31.23N appended', 'latin1')
    expect(stripImageMetadata(Buffer.concat([png, extra]), 'png')).toEqual(png)
    const vp8 = Buffer.concat([
      Buffer.from('VP8 ', 'latin1'),
      Buffer.from([4, 0, 0, 0, 9, 9, 9, 9]),
    ])
    const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1')
    head.writeUInt32LE(vp8.length + 4, 4)
    const webp = Buffer.concat([head, vp8])
    expect(stripImageMetadata(Buffer.concat([webp, extra]), 'webp')).toEqual(webp)
  })
})
