<script setup lang="ts">
// A short screen recording of a whole task. Muted and inline, so it also plays inside WeChat.

import { withBase } from 'vitepress'
import { ref } from 'vue'
import { data as media } from './media.data'

const props = defineProps<{ src: string; title: string; phone?: boolean; poster?: string }>()
const missing = ref(!media.includes(props.src))
</script>

<template>
  <figure class="clip" :class="{ 'shot-phone': props.phone }">
    <div v-if="missing" class="shot-missing">视频准备中</div>
    <video
      v-else
      :src="withBase(`/${props.src}`)"
      :poster="props.poster ? withBase(`/${props.poster}`) : undefined"
      controls
      muted
      playsinline
      preload="metadata"
      @error="missing = true"
    />
    <figcaption>视频：{{ props.title }}</figcaption>
  </figure>
</template>
