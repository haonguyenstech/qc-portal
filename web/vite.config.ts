import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Web UI runs on 5175; backend on 5174. Healthcare app owns 5173.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5174', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:5174', ws: true },
    },
  },
})
