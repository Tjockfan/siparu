import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Signal K mounts the webapp at /<package-name>/, so all asset URLs must be
  // relative, never absolute-from-root.
  base: './',
  build: {
    outDir: '../public',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Dev against a local Signal K running the plugin (sandbox: 3100).
    proxy: {
      '/plugins': process.env.SK_ORIGIN ?? 'http://127.0.0.1:3100',
      '/signalk': process.env.SK_ORIGIN ?? 'http://127.0.0.1:3100'
    }
  }
})
