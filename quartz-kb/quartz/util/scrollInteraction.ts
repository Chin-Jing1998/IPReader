// 本模块只放滚动相关的纯函数（不触碰 DOM，可被 `tsx --test` 直接单测），职责有二：
// 1. 自绘 overlay 滚动条的几何映射——computeThumbGeometry 把容器滚动量换算成
//    thumb 的高度与偏移，scrollTopFromThumbOffset 是其逆映射（拖拽时用）；
//    真实 DOM 侧的轨道注入与事件绑定在 components/scripts/explorer.inline.ts。
// 2. hasScrollableContent——判定容器是否真的存在可滚动溢出。
// 历史：原 shouldChainWheelToPage（把侧栏边界滚轮转发给正文）与「阻止滚动穿透」
// 相悖已删除，阻断改由 CSS `overscroll-behavior: contain` 承担；原
// getSidebarScrollbarPresentation（原生滚动槽/拇指分离）随 overlay 方案废弃。

export interface ScrollContainerMetrics {
  clientWidth: number
  scrollWidth: number
  clientHeight: number
  scrollHeight: number
}

/** overlay 滚动条几何换算所需的容器纵向量度。 */
export interface ScrollMetrics {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}

/** thumb 在轨道内的呈现结果；不可见时高度与偏移均为 0。 */
export interface ThumbGeometry {
  visible: boolean
  height: number
  offset: number
}

const EDGE_TOLERANCE = 1

/** thumb 的最小高度，防止极长内容把 thumb 压成不可命中的细线。 */
export const MIN_THUMB_HEIGHT = 28

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 判断侧栏内容是否确实存在可滚动溢出。 */
export function hasScrollableContent({
  clientWidth,
  scrollWidth,
  clientHeight,
  scrollHeight,
}: ScrollContainerMetrics): boolean {
  return scrollWidth > clientWidth + EDGE_TOLERANCE || scrollHeight > clientHeight + EDGE_TOLERANCE
}

/**
 * 由容器滚动量算出 overlay thumb 的几何。
 * trackHeight 缺省取可视高度（轨道与滚动器等高的常规情形）；纵向无溢出时返回不可见。
 */
export function computeThumbGeometry(
  { clientHeight, scrollHeight, scrollTop }: ScrollMetrics,
  trackHeight: number = clientHeight,
): ThumbGeometry {
  if (scrollHeight <= clientHeight + EDGE_TOLERANCE) {
    return { visible: false, height: 0, offset: 0 }
  }

  const height = clamp((trackHeight * clientHeight) / scrollHeight, MIN_THUMB_HEIGHT, trackHeight)
  const scrollable = scrollHeight - clientHeight
  const offset =
    scrollable > 0
      ? clamp((trackHeight - height) * (scrollTop / scrollable), 0, trackHeight - height)
      : 0

  return { visible: true, height, offset }
}

/**
 * computeThumbGeometry 偏移量的逆映射：由拖拽后的 thumb 偏移反推 scrollTop，
 * 并钳制在 [0, maxScrollTop]；轨道与 thumb 等高（无可拖动余量）时返回 0。
 */
export function scrollTopFromThumbOffset(
  offset: number,
  { clientHeight, scrollHeight }: ScrollMetrics,
  trackHeight: number,
  thumbHeight: number,
): number {
  const draggableTrack = trackHeight - thumbHeight
  if (draggableTrack <= 0) {
    return 0
  }

  const maxScrollTop = Math.max(scrollHeight - clientHeight, 0)
  return clamp((offset / draggableTrack) * maxScrollTop, 0, maxScrollTop)
}
