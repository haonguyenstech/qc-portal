import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Single source of truth for the displayed version: the monorepo root package.json.
// Injected at build time so the sidebar reflects the actual installed version and
// updates automatically on every `qc-portal --update` rebuild.
const { version } = JSON.parse(
  readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
) as { version: string }

// Web UI runs on 5175; backend on 5174. Healthcare app owns 5173.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5175,
    // Match on the trailing slash (RegExp keys start with ^) so ONLY real API
    // paths (/api/…) and the websocket (/ws…) are proxied. A bare '/api' prefix
    // would also swallow client routes like /api-testing and break a hard reload.
    proxy: {
      '^/api/': { target: 'http://127.0.0.1:5174', changeOrigin: true },
      '^/ws(/|$)': { target: 'ws://127.0.0.1:5174', ws: true },
    },
  },
})
