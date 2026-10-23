import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: '/coach/',
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '/api': 'http://localhost:8787' },
  },
})
