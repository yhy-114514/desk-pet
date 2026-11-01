import { screen } from 'electron'

// Win32 光标裁剪（ClipCursor）：拖拽起（drag_enter）期间把光标锁在原位，动作播完再释放。
// 注意：这是桌面级全局裁剪，异常路径必须保证释放（index.ts 里加了兜底超时与 will-quit 释放）。

type ClipCursorFn = (
  rect: { left: number; top: number; right: number; bottom: number } | null
) => void

// 非 Windows 平台不加载 user32，函数退化为空操作。
// koffi 的原生二进制按「平台 + 架构」分包发布（@koromix/koffi-darwin-x64 之类），
// npm 只装当前机器那一份。CI 在 arm64 机器上装依赖、顺手打 x64 的包，包里就只有
// arm64 那份——顶层 import 会让 Intel Mac 一启动就「Cannot find the native Koffi
// module」直接崩。ClipCursor 本来就是 Win32 API，mac 上完全用不到，所以只按需加载。
let clipCursor: ClipCursorFn | null = null

if (process.platform === 'win32') {
  const koffi = require('koffi') as typeof import('koffi')
  const RECT = koffi.struct('RECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long'
  })
  const user32 = koffi.load('user32.dll')
  clipCursor = user32.func('bool __stdcall ClipCursor(const RECT *lpRect)') as ClipCursorFn
}

/** 把光标裁剪在 (dipX, dipY) 这一点（1×1 矩形 = 原地锁定）。 */
export function lockCursor(dipX: number, dipY: number): void {
  if (!clipCursor) return
  // 传入的是 DIP，需转成物理像素再交给 Win32
  const p = screen.dipToScreenPoint({ x: dipX, y: dipY })
  const x = Math.round(p.x)
  const y = Math.round(p.y)
  clipCursor({ left: x, top: y, right: x + 1, bottom: y + 1 })
}

/** 解除光标裁剪，光标恢复自由移动。 */
export function unlockCursor(): void {
  clipCursor?.(null)
}
