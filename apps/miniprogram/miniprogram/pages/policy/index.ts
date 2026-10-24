import type { CatalogDto } from '../../lib/shared'
import { errorMessage, publicApi } from '../../utils/api'

const TITLES = { booking: '预约须知', agreement: '用户协议', privacy: '隐私政策' } as const
type Kind = keyof typeof TITLES

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    // Lines like 一、… are section headings.
    lines: [] as { text: string; heading: boolean }[],
    error: '',
    emptyIcon: { name: 'file', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
  },

  kind: 'booking' as Kind,

  onLoad(query: Record<string, string | undefined>) {
    this.kind = (['agreement', 'privacy'] as Kind[]).find((k) => k === query.kind) ?? 'booking'
    wx.setNavigationBarTitle({ title: TITLES[this.kind] })
    this.load()
  },

  async load() {
    try {
      // Public, so the policies can be read before logging in or agreeing to anything.
      const policies = await publicApi<CatalogDto['policies']>('GET', '/policies')
      const text = policies[this.kind]
      const lines = text
        .split('\n')
        .map((line) => ({ text: line, heading: /^[一二三四五六七八九十]+、/.test(line) }))
      this.setData({ state: 'ready', lines: text.trim() ? lines : [] })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
