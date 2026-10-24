import { expect, type Page, test } from '@playwright/test'
import { field, login } from './helpers'

const shots = 'test-results/venue-location'

// A stand-in for 腾讯地图's 位置选点 page: it posts a place to the admin like the real one.
const PICKER = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px sans-serif">
<button id="pick" style="margin:24px;padding:12px">选这里</button>
<script>
// Like the real page, it first reports the viewer's own position.
parent.postMessage({ module: 'locationPicker', latlng: { lat: 31.1, lng: 121.1 }, poiname: '我的位置' }, '*')
document.getElementById('pick').onclick = () => parent.postMessage({
  module: 'locationPicker', latlng: { lat: 39.9086921234, lng: 116.3974771234 },
  poiname: '飞羽乒乓球馆', poiaddress: '北京市海淀区中关村大街59号',
}, '*')
</script>`

async function openSettings(page: Page, key: string | null) {
  await page.route('**/api/admin/map', (r) => r.fulfill({ json: { tencentKey: key } }))
  await page.route('https://apis.map.qq.com/ws/staticmap/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="400"><rect width="960" height="400" fill="#8ab"/></svg>',
    }),
  )
  await page.route('https://apis.map.qq.com/tools/locpicker**', (r) =>
    r.fulfill({ contentType: 'text/html', body: PICKER }),
  )
  await login(page)
  await page.goto('./#/settings')
  return field(page, '地图坐标')
}

async function shot(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('reads coordinates from 高德 share text, plain coordinates and a pasted short link', async ({
  page,
}) => {
  const row = await openSettings(page, null)
  await expect(row.getByRole('button', { name: '在地图上选点' })).toHaveCount(0)
  const paste = row.getByPlaceholder('粘贴地图分享链接或坐标')
  const lat = row.getByPlaceholder('纬度，如：39.9087')
  const lng = row.getByPlaceholder('经度，如：116.3975')

  // A link with the point in it is read in the browser.
  await paste.fill(
    '【高德地图】巨鹿路 https://wb.amap.com/?q=31.222811749011463%2C121.46840706467624%2C%E5%B7%A8%E9%B9%BF%E8%B7%AF&src=app_C3090',
  )
  await row.getByRole('button', { name: '识别' }).click()
  await expect(page.getByText('已从高德地图读取位置')).toBeVisible()
  await expect(lat).toHaveValue('31.222812')
  await expect(lng).toHaveValue('121.468407')
  await expect(paste).toHaveValue('')
  const view = row.getByRole('link', { name: '在高德地图中查看' })
  await expect(view).toHaveAttribute('href', /position=121\.468407,31\.222812/)
  await expect(view).toHaveAttribute('target', '_blank')

  // A 高德 place page has no point in it; the box still reads the next paste.
  await paste.fill('【高德地图】球馆 https://www.amap.com/place/B000A83M61')
  await row.getByRole('button', { name: '识别' }).click()
  await expect(page.getByText(/这个高德地图链接里没有位置/)).toBeVisible()

  // Longitude first, with a Chinese comma, by pressing Enter.
  await paste.fill('116.397477，39.908692')
  await paste.press('Enter')
  await expect(page.getByText('已填入坐标')).toBeVisible()
  await expect(lat).toHaveValue('39.908692')

  // Nothing usable.
  await paste.fill('飞羽乒乓球馆')
  await row.getByRole('button', { name: '识别' }).click()
  await expect(page.getByText(/没有识别到位置/)).toBeVisible()
  await expect(lat).toHaveValue('39.908692')

  // A short link goes to the server; pasting reads it at once, and a double press asks once.
  let calls = 0
  await page.route('**/api/admin/map/resolve', async (r) => {
    calls++
    expect(r.request().postDataJSON()).toEqual({ url: 'https://surl.amap.com/4mkKGuyJ2bz' })
    await new Promise((done) => setTimeout(done, 400))
    await r.fulfill({ json: { point: { lat: 30.123456, lng: 120.654321 }, source: 'amap' } })
  })
  await paste.fill('')
  await paste.focus()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text', '飞羽乒乓球馆 https://surl.amap.com/4mkKGuyJ2bz 复制链接用高德地图打开')
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  })
  await page.keyboard.press('Enter')
  await expect(lat).toHaveValue('30.123456')
  await expect(lng).toHaveValue('120.654321')
  expect(calls).toBe(1)

  // The server's refusal is shown as it is, and the point stays.
  await page.unroute('**/api/admin/map/resolve')
  const refusal = '没能从这个百度地图链接读到位置，请改用高德地图的分享链接，或在地图上选点'
  await page.route('**/api/admin/map/resolve', (r) =>
    r.fulfill({ status: 422, json: { error: { code: 'map_link_unreadable', message: refusal } } }),
  )
  await paste.fill('https://j.map.baidu.com/d7/RyTc')
  await row.getByRole('button', { name: '识别' }).click()
  await expect(page.getByText(refusal)).toBeVisible()
  await expect(paste).toHaveValue('https://j.map.baidu.com/d7/RyTc')
  await expect(lat).toHaveValue('30.123456')

  await row.scrollIntoViewIfNeeded()
  await shot(page, 'pasted')

  // 清除 empties both, and a half-filled pair cannot be saved.
  await row.getByText('清除').click()
  await expect(lat).toHaveValue('')
  await expect(row.getByRole('link', { name: '在高德地图中查看' })).toHaveCount(0)
  await lat.fill('39.9')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('请填写完整、有效的经纬度，或都留空')).toBeVisible()
})

test('picks a point on the map when a 腾讯位置服务 key is set', async ({ page }) => {
  const row = await openSettings(page, 'TEST-KEY')
  await row.getByPlaceholder('纬度，如：39.9087').fill('31.222812')
  await row.getByPlaceholder('经度，如：116.3975').fill('121.468407')
  const map = row.locator('img.venue-location-map')
  await expect(map).toHaveAttribute('src', /center=31\.222812,121\.468407.*key=TEST-KEY/)

  await row.getByRole('button', { name: '在地图上选点' }).click()
  const dialog = page.locator('.t-dialog:visible')
  // TDesign renders a disabled button as a div.
  const use = dialog.locator('.t-button', { hasText: '使用这个位置' })
  await expect(use).toHaveClass(/t-is-disabled/)
  // Messages from anywhere but the picker are ignored.
  await page.evaluate(() =>
    window.postMessage({ module: 'locationPicker', latlng: { lat: 31.2, lng: 121.4 } }, '*'),
  )
  await page.waitForTimeout(200)
  await expect(use).toHaveClass(/t-is-disabled/)
  await expect(dialog.locator('iframe')).toHaveAttribute(
    'src',
    /locpicker\?.*key=TEST-KEY.*coord=31\.222812,121\.468407/,
  )
  await expect(dialog.getByText('搜索场馆名称或地址')).toBeVisible()
  await shot(page, 'picker-empty')
  await dialog.frameLocator('iframe').getByRole('button', { name: '选这里' }).click()
  await expect(dialog.getByText('已选：飞羽乒乓球馆，北京市海淀区中关村大街59号')).toBeVisible()
  await shot(page, 'picker-picked')
  await expect(use).not.toHaveClass(/t-is-disabled/)
  await use.click()
  await expect(page.getByText('已选择飞羽乒乓球馆')).toBeVisible()
  await expect(row.getByPlaceholder('纬度，如：39.9087')).toHaveValue('39.908692')
  await expect(row.getByPlaceholder('经度，如：116.3975')).toHaveValue('116.397477')
  await row.scrollIntoViewIfNeeded()
  await shot(page, 'with-map')

  // Closing without choosing changes nothing.
  await row.getByRole('button', { name: '在地图上选点' }).click()
  await dialog.getByRole('button', { name: '返回' }).click()
  await expect(row.getByPlaceholder('纬度，如：39.9087')).toHaveValue('39.908692')
})

test('saves the point and shows it after a reload', async ({ page }) => {
  const row = await openSettings(page, null)
  await row.getByPlaceholder('粘贴地图分享链接或坐标').fill('39.908692,116.397477')
  await row.getByRole('button', { name: '识别' }).click()
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('已保存')).toBeVisible()
  await page.reload()
  await expect(row.getByPlaceholder('纬度，如：39.9087')).toHaveValue('39.908692')
  await expect(row.getByPlaceholder('经度，如：116.3975')).toHaveValue('116.397477')
})
