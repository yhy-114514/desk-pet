// 窗口落点的纯计算（无 electron 依赖，可直接被 vitest 单测）：
// 上次的位置还在某块屏幕上就用它，否则回到主屏右下角——
// 拔掉副屏后窗口跑到「不存在的屏幕」上，是最典型的「鱼不见了」。

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 至少露出这么多像素才算看得见（只露一条边等于找不到） */
export const MIN_VISIBLE = 80
/** 默认落点离屏幕边缘的距离 */
export const MARGIN = 24

export interface Point {
  x: number
  y: number
}

/** 窗口矩形是否与任一屏幕工作区重叠出足够大的一块 */
export function isVisibleOn(rect: Rect, displays: Rect[]): boolean {
  return displays.some((display) => {
    const width =
      Math.min(rect.x + rect.width, display.x + display.width) - Math.max(rect.x, display.x)
    const height =
      Math.min(rect.y + rect.height, display.y + display.height) - Math.max(rect.y, display.y)
    return width >= MIN_VISIBLE && height >= MIN_VISIBLE
  })
}

/** 主屏右下角（桌宠的常驻位置） */
export function cornerPosition(size: { width: number; height: number }, display: Rect): Point {
  return {
    x: display.x + display.width - size.width - MARGIN,
    y: display.y + display.height - size.height - MARGIN
  }
}

/**
 * 决定窗口这次该摆在哪：记住的位置仍可见就沿用，
 * 否则（首次启动 / 那块屏被拔了 / 分辨率变小）回主屏右下角。
 */
export function resolvePosition(
  saved: Point | null,
  size: { width: number; height: number },
  displays: Rect[],
  primary: Rect
): Point {
  if (saved && isVisibleOn({ ...saved, ...size }, displays)) return saved
  return cornerPosition(size, primary)
}
