import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so worklet/CSS asset URLs resolve under any deploy path
  // (subdirectory hosting otherwise 404s the worklets and silently disables them)
  base: './',
  server: { port: 5173 },
  // Vite 8/Rolldown bug: __BUNDLED_DEV__ is not injected into production build
  define: { __BUNDLED_DEV__: false },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: { manualChunks: id => id.includes('wavesurfer') ? 'wavesurfer' : undefined }
    }
  },
  // AudioWorklet files must be served as separate modules (not bundled)
  assetsInclude: ['**/*.worklet.js']
})
