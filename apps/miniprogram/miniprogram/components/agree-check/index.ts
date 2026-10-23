import { navigateOnce } from '../../utils/nav'

// The consent row shown before the student's details are first collected.
Component({
  properties: {
    checked: { type: Boolean, value: false },
  },

  methods: {
    toggle() {
      this.triggerEvent('change', { checked: !this.data.checked })
    },

    open(e: WechatMiniprogram.TouchEvent) {
      navigateOnce(`/pages/policy/index?kind=${e.currentTarget.dataset.kind}`)
    },
  },
})
