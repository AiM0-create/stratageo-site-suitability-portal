import path from 'path';
import { readFileSync } from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig(({ command }) => ({
  // Injected at build time so the UI version badge always matches package.json
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // In serve (dev) mode, always use '/' so local URLs are simple and /api/* routing works.
  // In build mode, respect VITE_BASE_PATH (set to '/' by Vercel) or default to the
  // GitHub Pages sub-path so static asset URLs resolve correctly after `npm run build`.
  base: command === 'serve'
    ? '/'
    : (process.env.VITE_BASE_PATH || '/stratageo-site-suitability-portal/'),

  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  server: {
    // Use 5173 so `vercel dev` can own port 3000 without conflict.
    // When running `npm run dev` alone, the proxy below forwards /api/* to
    // the vercel dev function runtime on 3000.
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
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
}));
