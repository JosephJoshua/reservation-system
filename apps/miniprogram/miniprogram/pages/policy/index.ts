import { errorMessage } from '../../utils/api'
import { getCatalog } from '../../utils/data'

const TITLES = { booking: '预约须知', agreement: '用户协议' } as const

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    text: '',
    error: '',
    emptyIcon: { name: 'file', size: '112rpx' },
  },

  async onLoad(query: Record<string, string | undefined>) {
    const kind = query.kind === 'agreement' ? 'agreement' : 'booking'
    wx.setNavigationBarTitle({ title: TITLES[kind] })
    try {
      const catalog = await getCatalog()
      this.setData({ state: 'ready', text: catalog.policies[kind] })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },
})
