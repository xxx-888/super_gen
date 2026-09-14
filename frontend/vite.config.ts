import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 大依赖单独拆 chunk：利用浏览器缓存，业务代码更新时不重新下载
        // 函数式分组保证依赖单向（arco/vendor 各自独立，业务代码引用二者），不会产生循环 chunk
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@arco-design')) return 'arco'
          if (id.includes('@xyflow')) return 'xyflow'
          return 'vendor'
        },
      },
    },
  },
})
