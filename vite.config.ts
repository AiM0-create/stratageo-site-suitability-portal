import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Base path: uses VITE_BASE_PATH env var if set, otherwise defaults to repo name for GitHub Pages.
  // Vercel sets VITE_BASE_PATH='/' via env var so assets resolve correctly.
  base: process.env.VITE_BASE_PATH || '/stratageo-site-suitability-portal/',

  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  server: {
    port: 3000,
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          recharts: ['recharts'],
        },
      },
    },
  },
});
