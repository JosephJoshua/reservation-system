// Wraps every page. Puts the resolved theme class on a wrapper so TDesign and app tokens follow the
// 外观 setting, and paints the native bars whenever the page shows or the theme changes.
import { applyNativeTheme, currentTheme, onThemeChange, type Theme } from '../../utils/theme'

const state = new WeakMap<object, { shown: boolean; unsubscribe: () => void }>()

Component({
  data: {
    // Empty until attached, which leaves the system theme from the media queries.
    theme: '' as Theme | '',
  },

  lifetimes: {
    attached() {
      state.set(this, { shown: false, unsubscribe: onThemeChange(() => this.sync()) })
      this.sync()
    },
    detached() {
      state.get(this)?.unsubscribe()
      state.delete(this)
    },
  },

  pageLifetimes: {
    show() {
      const s = state.get(this)
      if (s) s.shown = true
      this.sync()
    },
    hide() {
      const s = state.get(this)
      if (s) s.shown = false
    },
  },

  methods: {
    sync() {
      const theme = currentTheme()
      if (theme !== this.data.theme) this.setData({ theme })
      // Native bar calls act on whichever page is on top, so only the shown page makes them.
      if (!state.get(this)?.shown) return
      const pages = getCurrentPages()
      const top = pages[pages.length - 1]
      if (top) applyNativeTheme(theme, top.route)
    },
  },
})
