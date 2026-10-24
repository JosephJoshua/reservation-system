import {
  setThemeSetting,
  THEME_SETTING_LABELS,
  type ThemeSetting,
  themeSetting,
} from '../../utils/theme'

const OPTIONS = (['system', 'light', 'dark'] as const).map((value) => ({
  value,
  label: THEME_SETTING_LABELS[value],
}))

Page({
  data: {
    options: OPTIONS,
    setting: 'system' as ThemeSetting,
  },

  onLoad() {
    this.setData({ setting: themeSetting() })
  },

  choose(e: WechatMiniprogram.TouchEvent) {
    const setting = e.currentTarget.dataset.value as ThemeSetting
    if (setting === this.data.setting) return
    try {
      setThemeSetting(setting)
    } catch {
      wx.showToast({ title: '设置失败，请重试', icon: 'none' })
      return
    }
    this.setData({ setting })
  },
})
