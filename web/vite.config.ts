import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // 构建产物输出到后端 embed 目录，便于打包成桌面应用
    outDir: '../server/web_dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0', 
    allowedHosts: ['.cnb.run'],
    proxy: {
      '/api': 'http://localhost:9090',
      '/ws': {
        target: 'ws://localhost:9090',
        ws: true,
      },
    },
  },
})
