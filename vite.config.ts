import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  worker: { format: 'es' },
  build: { target: 'es2022' }
});
