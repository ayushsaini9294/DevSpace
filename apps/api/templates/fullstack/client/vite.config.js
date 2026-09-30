import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// DevSpace's Preview shows your app under a longer address; DevSpace sets it for you.
const base = process.env.DEVSPACE_PREVIEW_BASE || '/';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base,
  server: {
    // Listen on every address, so DevSpace can reach the app inside the IDE.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Allow opening the app through DevSpace's Preview address.
    allowedHosts: true,
    // Requests to api/… go to the server (port 8081), which sees them as /api/….
    proxy: {
      [`${base}api`]: {
        target: 'http://127.0.0.1:8081',
        rewrite: (path) => path.slice(base.length - 1),
      },
    },
  },
});
