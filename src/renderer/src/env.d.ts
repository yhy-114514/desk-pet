// Vite 的 import.meta.glob 类型声明（项目未引入 vite/client 全量类型）
interface ImportMeta {
  glob(pattern: string, options?: Record<string, unknown>): Record<string, unknown>
}
