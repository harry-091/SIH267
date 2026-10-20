import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (name) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      // two pages: the simulator and the training dashboard
      input: { main: page('index.html'), dashboard: page('dashboard.html') },
    },
  },
  // `npm run dev` + `npm run server` in two terminals: the dev server hands /api to the training server
  server: {
  proxy: {
    '/api': {
      target: 'http://localhost:3001',
      changeOrigin: true,
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq) => {
          // The local Vite proxy handles the browser-origin check.
          proxyReq.removeHeader('origin');
        });
      },
    },
  },
},
});
