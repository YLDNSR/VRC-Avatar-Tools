import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  base: './',
  publicDir: resolve(import.meta.dirname, 'src/public'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        viewer: resolve(import.meta.dirname, 'src/viewer.html'),
        capture: resolve(import.meta.dirname, 'src/capture.html'),
      },
    },
  },
});
