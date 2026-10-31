import { useEffect, useRef, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { RotateIcon, ZoomInIcon, ZoomOutIcon } from 'tdesign-icons-react'
import { Button, Dialog, MessagePlugin, Radio, Slider, Tooltip } from 'tdesign-react'
import { RequestError, uploadImage } from './api'

/** How each kind of image is cut, so it fits where the mini program shows it. */
export type ImageUse = {
  /** Width over height. Left out, the admin picks one, starting with the picture's own. */
  aspect?: number
  /** Shows a round mask for pictures the mini program shows in a circle. */
  round?: boolean
  /** Longest side of the saved image, in pixels. */
  maxSide: number
  /** Below this width the result looks blurry on a phone, so the dialog says so. */
  minWidth?: number
}

// The banner swiper is 686rpx by 300rpx (pages/booking/index.wxss).
export const BANNER_IMAGE: ImageUse = { aspect: 686 / 300, maxSide: 1372, minWidth: 686 }
// Coach photos show as circles, at most 136rpx across.
export const COACH_PHOTO: ImageUse = { aspect: 1, round: true, maxSide: 600, minWidth: 200 }
// Images in the coach profile fill the page width.
export const PROFILE_IMAGE: ImageUse = { maxSide: 1600 }

// The picture is read here and saved again, so it can be larger than the upload limit.
const MAX_SOURCE = 30 * 1024 * 1024
// Matches the API's upload limit.
const MAX_UPLOAD = 2 * 1024 * 1024
const ACCEPT = 'image/jpeg,image/png,image/webp'

const RATIOS = [
  { label: '原比例', value: 0 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
]

/** The picture being cropped; `file` is the picked file, absent when cropping an upload again. */
type Source = { src: string; type: string; file?: File }

/**
 * Picks an image, lets the admin crop, rotate and flip it, and uploads the result. Render
 * `element` once; `pick()` opens the file chooser and `edit(url)` reopens an uploaded image.
 * The dialog goes away with the component using this, so a late upload is dropped.
 */
export function useImageUpload(use: ImageUse, onUploaded: (url: string) => void) {
  const input = useRef<HTMLInputElement>(null)
  const [source, setSource] = useState<Source | null>(null)
  const done = useRef(onUploaded)
  done.current = onUploaded

  // Frees the picked file once the dialog closes, also when the page using it goes away.
  useEffect(
    () => () => {
      if (source?.file) URL.revokeObjectURL(source.src)
    },
    [source],
  )
  const close = () => setSource(null)

  const picked = (file: File | undefined) => {
    if (!file) return
    if (!ACCEPT.split(',').includes(file.type)) {
      void MessagePlugin.error('只支持 JPG、PNG、WebP 图片')
      return
    }
    if (file.size > MAX_SOURCE) {
      void MessagePlugin.error('图片不能超过 30MB')
      return
    }
    setSource({ src: URL.createObjectURL(file), type: file.type, file })
  }

  const element = (
    <>
      <input
        ref={input}
        hidden
        type="file"
        accept={ACCEPT}
        onChange={(e) => {
          picked(e.target.files?.[0])
          // Lets the same file be picked again.
          e.target.value = ''
        }}
      />
      {source && (
        <CropDialog
          source={source}
          use={use}
          onClose={close}
          onUploaded={(url) => {
            close()
            done.current(url)
          }}
        />
      )}
    </>
  )

  return {
    element,
    pick: () => input.current?.click(),
    edit: (url: string) => {
      const ext = url.split('.').pop()?.toLowerCase()
      setSource({
        src: url,
        type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
      })
    },
  }
}

function CropDialog({
  source,
  use,
  onClose,
  onUploaded,
}: {
  source: Source
  use: ImageUse
  onClose: () => void
  onUploaded: (url: string) => void
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [failed, setFailed] = useState(false)
  // The cropper measures its box when it mounts, so it waits for the dialog's opening animation.
  const [opened, setOpened] = useState(false)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [flip, setFlip] = useState(false)
  const [ratio, setRatio] = useState(0)
  const [area, setArea] = useState<Area | null>(null)
  const [saving, setSaving] = useState(false)
  // Set in the effect, not the initial value, so StrictMode's remount turns it back on.
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const img = new Image()
    img.onload = () => setImage(img)
    img.onerror = () => setFailed(true)
    img.src = source.src
  }, [source.src])

  const turned = rotation % 180 !== 0
  const own = image
    ? turned
      ? image.naturalHeight / image.naturalWidth
      : image.naturalWidth / image.naturalHeight
    : 1
  const aspect = use.aspect ?? (ratio || own)
  const out = area && outputSize(area, use.maxSide)
  const blurry = !!(out && use.minWidth && out.width < use.minWidth)

  const reset = () => {
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setRotation(0)
    setFlip(false)
    setRatio(0)
  }

  const save = async () => {
    if (!image || !area || saving) return
    setSaving(true)
    try {
      const file =
        source.file && untouched(image, area, rotation, flip, use.maxSide, source.file)
          ? source.file
          : await render(image, area, rotation, flip, use.maxSide, source.type)
      const url = await uploadImage(file)
      if (alive.current) onUploaded(url)
    } catch (e) {
      void MessagePlugin.error(e instanceof RequestError ? e.message : '图片处理失败，请重试')
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  return (
    <Dialog
      visible
      dialogClassName="crop-dialog"
      width={640}
      header="裁剪图片"
      cancelBtn="返回"
      confirmBtn={{ content: '使用图片', disabled: !image || !area, loading: saving }}
      onConfirm={save}
      onClose={() => {
        if (!saving) onClose()
      }}
      onOpened={() => setOpened(true)}
      closeOnOverlayClick={false}
    >
      <div className="crop-stage">
        {failed ? (
          <div className="crop-message">无法读取这张图片，请换一张</div>
        ) : image && opened ? (
          <Cropper
            image={source.src}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={aspect}
            cropShape={use.round ? 'round' : 'rect'}
            maxZoom={5}
            zoomSpeed={0.5}
            // Flipped after turning, so 水平翻转 is always left to right as the admin sees it.
            transform={`translate(${crop.x}px, ${crop.y}px)${flip ? ' scaleX(-1)' : ''} rotate(${rotation}deg) scale(${zoom})`}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={(_, pixels) => setArea(pixels)}
          />
        ) : (
          <div className="crop-message">正在读取图片</div>
        )}
      </div>
      <div className="crop-tools">
        <div className="crop-zoom">
          <Button
            shape="square"
            variant="text"
            icon={<ZoomOutIcon />}
            aria-label="缩小"
            disabled={!image || zoom <= 1}
            onClick={() => setZoom((z) => Math.max(1, z - 0.25))}
          />
          <Slider
            min={1}
            max={5}
            step={0.01}
            value={zoom}
            label={false}
            disabled={!image}
            onChange={(v) => setZoom(Number(v))}
          />
          <Button
            shape="square"
            variant="text"
            icon={<ZoomInIcon />}
            aria-label="放大"
            disabled={!image || zoom >= 5}
            onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
          />
        </div>
        <Tooltip content="向左旋转">
          <Button
            shape="square"
            variant="outline"
            icon={<RotateIcon style={{ transform: 'scaleX(-1)' }} />}
            aria-label="向左旋转"
            disabled={!image}
            onClick={() => setRotation((r) => (r + 270) % 360)}
          />
        </Tooltip>
        <Tooltip content="向右旋转">
          <Button
            shape="square"
            variant="outline"
            icon={<RotateIcon />}
            aria-label="向右旋转"
            disabled={!image}
            onClick={() => setRotation((r) => (r + 90) % 360)}
          />
        </Tooltip>
        <Button variant="outline" disabled={!image} onClick={() => setFlip((f) => !f)}>
          水平翻转
        </Button>
        <Button variant="text" disabled={!image} onClick={reset}>
          还原
        </Button>
      </div>
      {use.aspect === undefined && (
        <div className="crop-ratios">
          <span className="muted">比例</span>
          <Radio.Group
            variant="default-filled"
            size="small"
            value={ratio}
            disabled={!image}
            onChange={(v) => setRatio(Number(v))}
          >
            {RATIOS.map((r) => (
              <Radio.Button key={r.label} value={r.value}>
                {r.label}
              </Radio.Button>
            ))}
          </Radio.Group>
        </div>
      )}
      <div className={blurry ? 'crop-note warning' : 'crop-note muted'}>
        {blurry
          ? '选取的范围太小，在手机上会显得模糊，建议缩小或换一张更清晰的图片。'
          : '拖动图片调整位置，滚动或拖动滑块缩放。'}
      </div>
    </Dialog>
  )
}

/** True when the admin kept the whole picture as it was, so the picked file can go up as is. */
function untouched(
  image: HTMLImageElement,
  area: Area,
  rotation: number,
  flip: boolean,
  maxSide: number,
  file: File,
) {
  const w = image.naturalWidth
  const h = image.naturalHeight
  // The cropper's pixels are rounded.
  const whole =
    area.x <= 1 && area.y <= 1 && Math.abs(area.width - w) <= 1 && Math.abs(area.height - h) <= 1
  return whole && rotation === 0 && !flip && Math.max(w, h) <= maxSide && file.size <= MAX_UPLOAD
}

/** Size of the saved image: the cropped pixels, scaled down so the longest side fits. */
export function outputSize(area: Area, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(area.width, area.height))
  return {
    width: Math.max(1, Math.round(area.width * scale)),
    height: Math.max(1, Math.round(area.height * scale)),
  }
}

/**
 * Draws the cropped part. `area` is in the pixels of the turned picture, as the cropper gives
 * it, so the picture is turned (then flipped) around its centre inside that box and shifted by
 * the crop.
 */
async function render(
  image: HTMLImageElement,
  area: Area,
  rotation: number,
  flip: boolean,
  maxSide: number,
  type: string,
): Promise<File> {
  const size = outputSize(area, maxSide)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  const w = image.naturalWidth
  const h = image.naturalHeight
  const turned = rotation % 180 !== 0
  const boxW = turned ? h : w
  const boxH = turned ? w : h
  // PNG and WebP may be transparent, so they are saved as PNG; JPEG gets a white background.
  const png = type === 'image/png' || type === 'image/webp'
  if (!png) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size.width, size.height)
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.scale(size.width / area.width, size.height / area.height)
  ctx.translate(-area.x + boxW / 2, -area.y + boxH / 2)
  if (flip) ctx.scale(-1, 1)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.drawImage(image, -w / 2, -h / 2)

  if (png) {
    const blob = await toBlob(canvas, 'image/png')
    if (blob.size <= MAX_UPLOAD) return new File([blob], 'image.png', { type: 'image/png' })
    // Too large as PNG: fall back to JPEG over white.
    const flat = document.createElement('canvas')
    flat.width = canvas.width
    flat.height = canvas.height
    const fctx = flat.getContext('2d')
    if (!fctx) throw new Error('no canvas')
    fctx.fillStyle = '#ffffff'
    fctx.fillRect(0, 0, flat.width, flat.height)
    fctx.drawImage(canvas, 0, 0)
    return jpeg(flat)
  }
  return jpeg(canvas)
}

async function jpeg(canvas: HTMLCanvasElement): Promise<File> {
  for (const quality of [0.9, 0.8, 0.7, 0.6]) {
    const blob = await toBlob(canvas, 'image/jpeg', quality)
    if (blob.size <= MAX_UPLOAD) return new File([blob], 'image.jpg', { type: 'image/jpeg' })
  }
  throw new RequestError(400, 'too_large', '图片不能超过 2MB')
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), type, quality),
  )
}
