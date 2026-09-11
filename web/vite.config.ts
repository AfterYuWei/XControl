import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const mobileHost = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Tauri injects TAURI_DEV_HOST when a physical mobile device must reach
    // Vite over the development machine's LAN address.
    host: mobileHost ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: mobileHost ? { protocol: 'ws', host: mobileHost, port: 1421 } : undefined,
    allowedHosts: ['.cnb.run', ...(mobileHost ? [mobileHost] : [])],
  },
})
