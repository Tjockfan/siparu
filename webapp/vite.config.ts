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
  resolve: {
    // siparu-ui is a file: link resolved to its real path outside node_modules,
    // so bare imports from its sources must land on this app's copies, never on
    // the link's own devDependency copies (two Reacts break hooks at runtime).
    dedupe: ['react', 'react-dom', 'motion']
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The dev server only whitelists this directory by default; the linked
    // siparu-ui sources live one level up and would 403 without this.
    fs: { allow: ['..'] },
    // Dev against a local Signal K running the plugin (sandbox: 3100).
    proxy: {
      '/plugins': process.env.SK_ORIGIN ?? 'http://127.0.0.1:3100',
      '/signalk': process.env.SK_ORIGIN ?? 'http://127.0.0.1:3100'
    }
  }
})
