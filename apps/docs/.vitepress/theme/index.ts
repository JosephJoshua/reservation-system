import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import Clip from './Clip.vue'
import Shot from './Shot.vue'
import Shots from './Shots.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Shot', Shot)
    app.component('Shots', Shots)
    app.component('Clip', Clip)
  },
} satisfies Theme
