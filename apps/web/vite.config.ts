import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // No /ide here: the IDE runs on its own site (IDE_ORIGIN), never on the app's origin.
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
