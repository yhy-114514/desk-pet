import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

// 三段独立配置：main（Node 环境）、preload（sandbox）、renderer（浏览器环境）
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve('src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve('src/preload/index.ts') }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') }
    }
  }
})
