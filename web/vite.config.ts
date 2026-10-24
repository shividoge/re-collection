import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, API and file requests go to the guide server on 8787. In
// production the guide serves this app itself, so everything is same-origin.
const guide = process.env.GUIDE_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': guide,
      '/files': guide,
      '/health': guide,
    },
  },
});
