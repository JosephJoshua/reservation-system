import { navigateOnce } from '../../utils/nav'

// The consent row shown before the student's details are first collected.
Component({
  properties: {
    checked: { type: Boolean, value: false },
  },

  methods: {
    toggle() {
      // Flipped here first, so a second tap before the page re-renders sees the new value.
      const checked = !this.data.checked
      this.setData({ checked })
      this.triggerEvent('change', { checked })
    },

    open(e: WechatMiniprogram.TouchEvent) {
      navigateOnce(`/pages/policy/index?kind=${e.currentTarget.dataset.kind}`)
    },
  },
})
