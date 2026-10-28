import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

// OpenField web app. The Fastify server owns OPENFIELD_PORT (default 3161);
// everything under /api (plus the live-preview websocket) proxies there so the
// browser only ever talks to one origin.
export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  // Same .env the server reads, so the proxy follows a moved server port.
  const env = { ...loadEnv(mode, root, ''), ...process.env };
  const api = Number(env.OPENFIELD_PORT) || 3161;
  const bind = env.OPENFIELD_HOST;
  const host = !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
  return {
    plugins: [react()],
    // three.js (~635 kB) is its own chunk, loaded only by Stage, Object and the 3D viewer
    build: { chunkSizeWarningLimit: 700 },
    server: {
      port: Number(env.OPENFIELD_UI_PORT) || 3160,
      // WSL on /mnt/c delivers no inotify events; poll or edits never land.
      watch: root.startsWith('/mnt/') ? { usePolling: true, interval: 300 } : undefined,
      proxy: {
        '/api': { target: `http://${host}:${api}`, changeOrigin: true },
        '/live': { target: `ws://${host}:${api}`, ws: true },
      },
    },
  };
});
