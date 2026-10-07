import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: the browser talks to :5173 and Vite proxies API + WebSocket traffic to the backend,
// so the app uses same-origin relative URLs (identical to production behind nginx).
const target = process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/socket.io': { target, ws: true, changeOrigin: true },
    },
  },
});
