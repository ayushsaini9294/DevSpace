/// <reference types="node" />
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * public/ holds files for the demo's static hosting (Cloudflare: `_headers`; unknown paths fall back to index.html by default)
 * and its media (`demo/`). Only the demo build (VITE_DEMO=1) keeps them.
 */
function demoHostingFilesOnlyInDemo(): Plugin {
  let outDir = 'dist';
  return {
    name: 'devspace-demo-hosting-files',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      if (process.env.VITE_DEMO === '1') return;
      await Promise.all(
        ['_headers', 'demo'].map((name) =>
          rm(resolve(outDir, name), { recursive: true, force: true }),
        ),
      );
    },
  };
}

export default defineConfig({
  // The site's folder: '/' normally; the GitHub Pages demo builds with VITE_BASE=/DevSpace/.
  base: process.env.VITE_BASE || '/',
  plugins: [react(), tailwindcss(), demoHostingFilesOnlyInDemo()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // No /ide here: each copy's IDE runs on its own address (<copyId>.<IDE_BASE_URL host>),
      // never on the app's origin.
      '/api': 'http://localhost:3000',
      // Live updates (Phase 9): Socket.io on the API's port, WebSocket included. The Origin
      // header is kept (no changeOrigin), because the API only accepts sockets from APP_ORIGIN.
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
