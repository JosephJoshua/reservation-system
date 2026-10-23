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
  },

  async onLoad(query: Record<string, string | undefined>) {
    const kind = (['agreement', 'privacy'] as Kind[]).find((k) => k === query.kind) ?? 'booking'
    wx.setNavigationBarTitle({ title: TITLES[kind] })
    try {
      // Public, so the policies can be read before logging in or agreeing to anything.
      const policies = await publicApi<CatalogDto['policies']>('GET', '/policies')
      const lines = policies[kind]
        .split('\n')
        .map((text) => ({ text, heading: /^[一二三四五六七八九十]+、/.test(text) }))
      this.setData({ state: 'ready', lines: policies[kind].trim() ? lines : [] })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },
})
