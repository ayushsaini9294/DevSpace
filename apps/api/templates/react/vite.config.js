import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // DevSpace's Preview shows your app under a longer address; DevSpace sets it for you.
  base: process.env.DEVSPACE_PREVIEW_BASE || '/',
  server: {
    // Listen on every address, so DevSpace can reach the app inside the IDE.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Allow opening the app through DevSpace's Preview address.
    allowedHosts: true,
  },
});
