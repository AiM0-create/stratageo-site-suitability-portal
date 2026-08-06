import path from 'path';
import { readFileSync } from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

/**
 * v1.12.0 — fail the build if VITE_MAPBOX_TOKEN is a Mapbox SECRET token.
 *
 * Vite inlines env vars as string literals, so an `sk.` token ends up embedded
 * in the bundle regardless of any runtime guard. That is exactly what happened
 * on the first v1.12.0 deploy: the build succeeded, and GitHub push protection
 * rejected the gh-pages push with an opaque "git failed with exit code 1".
 *
 * Failing here turns that into a one-line, obvious error at the build step, and
 * guarantees a secret token can never be written into a publishable artifact.
 */
function assertNotSecretMapboxToken() {
  const t = (process.env.VITE_MAPBOX_TOKEN || '').trim();
  if (t.startsWith('sk.')) {
    throw new Error(
      'VITE_MAPBOX_TOKEN is a Mapbox SECRET token (starts with "sk."). Secret ' +
      'tokens can modify your Mapbox account and must never be embedded in a ' +
      'browser bundle. Revoke it in the Mapbox console and replace it with a ' +
      'PUBLIC token (starts with "pk.") restricted to this site. ' +
      'A token becomes "sk." as soon as any Secret scope is ticked when creating it.',
    );
  }
}

export default defineConfig(({ command }) => {
  assertNotSecretMapboxToken();
  return ({
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
          // v1.12.0 — Mapbox GL JS is ~1.9 MB raw. Split out so it does not sit
          // in the entry chunk blocking first paint: the login screen and the
          // chat have no map, and the browser can fetch this in parallel.
          mapbox: ['mapbox-gl'],
        },
      },
    },
  },
  });
});
