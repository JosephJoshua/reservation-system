import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { miniprogramDir, miniprogramStyles } from './mp-styles.ts'

export default defineConfig({
  plugins: [react(), miniprogramStyles()],
  base: '/admin/',
  // The mini program's own styles and assets, for the previews in src/preview.
  resolve: { alias: { '@mp': miniprogramDir } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:8787' },
  },
})
