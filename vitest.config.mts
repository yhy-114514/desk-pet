import { defineConfig } from 'vitest/config'

// 只跑纯逻辑单测（渲染进程状态机 / 随机动作池 + 主进程聊天会话 / SSE 解析），
// 不加载 electron / PixiJS / 素材，用 node 环境即可。
export default defineConfig({
  test: {
    include: ['src/renderer/src/**/*.test.ts', 'src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
    environment: 'node'
  }
})
