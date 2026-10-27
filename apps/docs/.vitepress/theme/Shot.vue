<script setup lang="ts">
// One screenshot with its caption. Phone shots are shown at phone width; a shot that has not been
// taken yet shows a placeholder, so pages can be written before their pictures exist.

import { withBase } from 'vitepress'
import { ref } from 'vue'
import { data as media } from './media.data'

const props = defineProps<{ src: string; alt: string; phone?: boolean }>()
const missing = ref(!media.includes(props.src))
</script>

<template>
  <figure class="shot" :class="{ 'shot-phone': props.phone }">
    <div v-if="missing" class="shot-missing">截图准备中</div>
    <a v-else :href="withBase(`/${props.src}`)" target="_blank" rel="noopener">
      <img :src="withBase(`/${props.src}`)" :alt="props.alt" loading="lazy" @error="missing = true" />
    </a>
    <figcaption>{{ props.alt }}</figcaption>
  </figure>
</template>
