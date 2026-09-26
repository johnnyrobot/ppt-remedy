import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    // `npm run dev:api` serves the Worker (API + built assets) on 8787.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
