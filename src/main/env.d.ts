// 迁移脚本以 `?raw` 内联成字符串进 bundle：打包后不用再从 asar 里读 .sql 文件
declare module '*.sql?raw' {
  const content: string
  export default content
}
