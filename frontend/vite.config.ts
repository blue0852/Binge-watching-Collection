import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendPort = Number(process.env.PORT) || 3002;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 开发时把 /api 请求代理到后端（后端只监听回环，避免 localhost 解析到 ::1）
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // 把播放器与框架拆开，首屏不需要下载 hls.js
        manualChunks: {
          hls: ['hls.js'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
