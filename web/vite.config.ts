import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

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
    // 构建产物输出到后端 embed 目录，便于打包成桌面应用
    outDir: '../server/web_dist',
    emptyOutDir: true,
  },
  server: {
    // Web 模式只用于本机调试；需要远程调试时显式传 --host。
    host: '127.0.0.1',
    allowedHosts: ['.cnb.run'],
    proxy: {
      '/api/server/ws': {
        target: 'ws://localhost:9090',
        ws: true,
      },
      '/api': 'http://localhost:9090',
      '/ws': {
        target: 'ws://localhost:9090',
        ws: true,
      },
    },
  },
})
