import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { editForm, field, login, useCrop } from './helpers'

// Every admin image upload goes through the crop dialog, which saves the cut-out itself.
const shots = join(import.meta.dirname, '../../test-results/image-crop-shots')

/**
 * A test picture drawn in the page: left half red, right half blue, so a turn or a flip shows
 * in which half ends up where. `noise` fills it with random pixels, which compress badly.
 */
async function picture(page: Page, width: number, height: number, type: string, noise = false) {
  const base64 = await page.evaluate(
    async ({ width, height, type, noise }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      if (noise) {
        const data = ctx.createImageData(width, height)
        for (let i = 0; i < data.data.length; i++) data.data[i] = (Math.random() * 256) | 0
        ctx.putImageData(data, 0, 0)
      } else {
        ctx.fillStyle = '#ff0000'
        ctx.fillRect(0, 0, width / 2, height)
        ctx.fillStyle = '#0000ff'
        ctx.fillRect(width / 2, 0, width / 2, height)
      }
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b as Blob), type, 0.95))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (const b of bytes) s += String.fromCharCode(b)
      return btoa(s)
    },
    { width, height, type, noise },
  )
  return {
    name: type === 'image/png' ? 'p.png' : 'p.jpg',
    mimeType: type,
    buffer: Buffer.from(base64, 'base64'),
  }
}

/** Size and the colour at a few points (as fractions of the size) of an uploaded image. */
async function inspect(page: Page, src: string, points: [number, number][]) {
  return page.evaluate(
    async ({ src, points }) => {
      const blob = await (await fetch(src)).blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      ctx.drawImage(bitmap, 0, 0)
      const colour = ([x, y]: [number, number]) => {
        const [r = 0, , b = 0] = ctx.getImageData(
          Math.floor(x * (bitmap.width - 1)),
          Math.floor(y * (bitmap.height - 1)),
          1,
          1,
        ).data
        return r > 200 && b < 60 ? 'red' : b > 200 && r < 60 ? 'blue' : `${r},${b}`
      }
      return {
        width: bitmap.width,
        height: bitmap.height,
        size: blob.size,
        type: blob.type,
        colours: points.map(colour),
      }
    },
    { src, points },
  )
}

const cropDialog = (page: Page) => page.locator('.crop-dialog:visible')
const editDialog = editForm

async function both(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

async function openCoach(page: Page) {
  await login(page)
  await page.goto('./#/coaches')
  await page.getByRole('button', { name: '新建教练' }).click()
  return editDialog(page)
}

const src = async (img: Locator) => (await img.getAttribute('src')) ?? ''

test('crops a coach photo to a square and turns it', async ({ page }) => {
  const d = await openCoach(page)
  await field(d, '照片')
    .locator('input[type=file]')
    .setInputFiles(await picture(page, 1200, 800, 'image/jpeg'))
  const crop = cropDialog(page)
  await expect(crop.locator('.reactEasyCrop_CropAreaRound')).toBeVisible()
  await crop.getByRole('button', { name: '向右旋转' }).click()
  await both(page, 'coach-photo')
  await useCrop(page)
  const img = field(d, '照片').locator('img')
  await expect(img).toHaveAttribute('src', /\/api\/uploads\/.+\.jpg$/)
  // Turned right, the red left half is now on top.
  expect(
    await inspect(page, await src(img), [
      [0.5, 0.1],
      [0.5, 0.9],
    ]),
  ).toMatchObject({
    width: 600,
    height: 600,
    type: 'image/jpeg',
    colours: ['red', 'blue'],
  })

  // Cropping the saved photo again: a flip puts red on the right.
  const before = await src(img)
  await field(d, '照片').getByRole('button', { name: '裁剪' }).click()
  await cropDialog(page).getByRole('button', { name: '向左旋转' }).click()
  await cropDialog(page).getByRole('button', { name: '水平翻转' }).click()
  await useCrop(page)
  await expect(img).not.toHaveAttribute('src', before)
  const flipped = await inspect(page, await src(img), [
    [0.1, 0.5],
    [0.9, 0.5],
  ])
  expect(flipped.colours, JSON.stringify(flipped)).toEqual(['blue', 'red'])
})

test('cuts banners to the mini program banner shape', async ({ page }) => {
  await login(page)
  await page.goto('./#/banners')
  await page.getByRole('button', { name: '新建轮播图' }).click()
  await editDialog(page)
    .locator('input[type=file]')
    .setInputFiles(await picture(page, 3000, 3000, 'image/jpeg'))
  await expect(cropDialog(page).getByRole('button', { name: '使用图片' })).toBeEnabled()
  await both(page, 'banner')
  await useCrop(page)
  const img = editDialog(page).locator('img.banner-thumb')
  const out = await inspect(page, await src(img), [
    [0.1, 0.5],
    [0.9, 0.5],
  ])
  // 686:300, at twice the size it shows on a phone.
  expect(out).toMatchObject({ width: 1372, height: 600, colours: ['red', 'blue'] })
})

test('warns when the cut-out would look blurry', async ({ page }) => {
  await login(page)
  await page.goto('./#/banners')
  await page.getByRole('button', { name: '新建轮播图' }).click()
  await editDialog(page)
    .locator('input[type=file]')
    .setInputFiles(await picture(page, 400, 200, 'image/jpeg'))
  await expect(cropDialog(page).locator('.crop-note.warning')).toContainText('模糊')
})

test('saves a large noisy PNG under the upload limit', async ({ page }) => {
  await login(page)
  await page.goto('./#/banners')
  await page.getByRole('button', { name: '新建轮播图' }).click()
  const file = await picture(page, 2400, 1800, 'image/png', true)
  expect(file.buffer.length).toBeGreaterThan(2 * 1024 * 1024)
  await editDialog(page).locator('input[type=file]').setInputFiles(file)
  await useCrop(page)
  const img = editDialog(page).locator('img.banner-thumb')
  // Too large as PNG, so it is saved as JPEG.
  await expect(img).toHaveAttribute('src', /\.jpg$/)
})

test('keeps a small PNG as PNG', async ({ page }) => {
  const d = await openCoach(page)
  await field(d, '照片')
    .locator('input[type=file]')
    .setInputFiles(await picture(page, 300, 300, 'image/png'))
  await useCrop(page)
  await expect(field(d, '照片').locator('img')).toHaveAttribute('src', /\.png$/)
})

test('refuses files it cannot read', async ({ page }) => {
  const d = await openCoach(page)
  const input = field(d, '照片').locator('input[type=file]')
  await input.setInputFiles({ name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') })
  await expect(page.locator('.t-message')).toContainText('只支持 JPG、PNG、WebP 图片')
  await expect(cropDialog(page)).toHaveCount(0)

  await input.setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('nope') })
  const crop = cropDialog(page)
  await expect(crop).toContainText('无法读取这张图片')
  await expect(crop.locator('.t-button').filter({ hasText: '使用图片' })).toHaveClass(
    /t-is-disabled/,
  )
  await expect(crop.locator('.t-button[aria-label=向右旋转]')).toHaveClass(/t-is-disabled/)
  await crop.getByRole('button', { name: '返回' }).click()
  await expect(crop).toHaveCount(0)
  await expect(field(d, '照片').locator('img')).toHaveCount(0)
})

test('uploads once on a double click and closes only after the upload', async ({ page }) => {
  const d = await openCoach(page)
  let uploads = 0
  await page.route('**/api/admin/uploads', async (route) => {
    uploads++
    await new Promise((r) => setTimeout(r, 800))
    await route.continue()
  })
  await field(d, '照片')
    .locator('input[type=file]')
    .setInputFiles(await picture(page, 800, 800, 'image/jpeg'))
  const crop = cropDialog(page)
  await expect(crop.getByRole('button', { name: '使用图片' })).toBeEnabled()
  await crop.getByRole('button', { name: '使用图片' }).dblclick()
  // Closing is ignored while the upload is on its way.
  await page.keyboard.press('Escape')
  await crop.locator('.t-dialog__close').click({ force: true })
  await expect(crop).toBeVisible()
  await expect(crop).toHaveCount(0)
  await expect(field(d, '照片').locator('img')).toBeVisible()
  expect(uploads).toBe(1)
})

test('an upload that fails keeps the dialog open to try again', async ({ page }) => {
  const d = await openCoach(page)
  await page.route('**/api/admin/uploads', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', message: '服务器开小差了' } }),
    }),
  )
  await field(d, '照片')
    .locator('input[type=file]')
    .setInputFiles(await picture(page, 800, 800, 'image/jpeg'))
  await cropDialog(page).getByRole('button', { name: '使用图片' }).click()
  await expect(page.locator('.t-message')).toContainText('服务器开小差了')
  await expect(cropDialog(page).getByRole('button', { name: '使用图片' })).toBeEnabled()
  await page.unroute('**/api/admin/uploads')
  await useCrop(page)
  await expect(field(d, '照片').locator('img')).toBeVisible()
})

test('inserts profile images at a chosen ratio and crops one again in place', async ({ page }) => {
  const d = await openCoach(page)
  const intro = field(d, '介绍')
  const editor = intro.locator('.tiptap')
  await editor.click()
  await page.keyboard.type('第一段')
  const file = await picture(page, 1200, 800, 'image/jpeg')
  await intro.locator('input[type=file]').setInputFiles(file)
  const crop = cropDialog(page)
  await expect(crop.getByText('原比例')).toBeVisible()
  await both(page, 'profile-image')
  await useCrop(page)
  const img = editor.locator('img')
  await expect(img).toHaveCount(1)
  // Kept whole and unturned, the picked file goes up as it is, without saving it again.
  expect(await inspect(page, await src(img), [])).toMatchObject({
    width: 1200,
    height: 800,
    size: file.buffer.length,
  })

  // With that image selected, 图片 adds a second one after it.
  await intro.locator('input[type=file]').setInputFiles(await picture(page, 600, 600, 'image/png'))
  await useCrop(page)
  await expect(img).toHaveCount(2)
  await expect(img.first()).toHaveAttribute('src', /\.jpg$/)
  await expect(img.last()).toHaveAttribute('src', /\.png$/)
  await img.last().click()
  await page.keyboard.press('Delete')
  await expect(img).toHaveCount(1)

  await img.click()
  await intro.getByRole('button', { name: '裁剪图片' }).click()
  await cropDialog(page).getByText('16:9').click()
  await useCrop(page)
  await expect(img).toHaveCount(1)
  const out = await inspect(page, await src(img), [])
  expect(out.width / out.height).toBeCloseTo(16 / 9, 1)
  await expect(editor).toContainText('第一段')
})

test('an upload finishing after the coach page closed does not reach the next one', async ({
  page,
}) => {
  const d = await openCoach(page)
  await page.route('**/api/admin/uploads', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    await route.continue()
  })
  await field(d, '照片')
    .locator('input[type=file]')
    .setInputFiles(await picture(page, 800, 800, 'image/jpeg'))
  await cropDialog(page).getByRole('button', { name: '使用图片' }).click()
  // The crop dialog's mask covers the page's links, so this goes by route.
  await page.goto('./#/banners')
  await page.goto('./#/coaches')
  await page.getByRole('button', { name: '新建教练' }).click()
  await page.waitForTimeout(1200)
  await expect(field(editDialog(page), '照片').locator('img')).toHaveCount(0)
  await expect(page.locator('.edit-page')).toHaveCount(1)
})
