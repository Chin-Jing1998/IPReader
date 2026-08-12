export interface ScrollEdgeMetrics {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  /**
   * 列表末尾那条不承载内容的占位项高度——OverflowList.tsx 追加的 `li.overflow-end`，
   * base.scss 固定 0.5rem（8px）。它照样计入 scrollHeight，故判「下方是否还有内容」
   * 时必须扣除：不扣的话，只要可视高度落在「真实内容高 + 占位高」这个窗口内，
   * 底部渐隐就会为一条空占位亮起，而全部真实条目其实完整可见。
   * 实测右栏反链卡（窗口 1440×812/814/816）：clientHeight 307/309/311 对
   * scrollHeight 315，末条链接底缘尚在容器内 0.09–4.09px，渐隐却已生效。
   * 缺省 0：无占位项的滚动器按原语义走，既有调用方无需改动。
   */
  spacerHeight?: number
}

export interface ScrollEdgeState {
  top: boolean
  bottom: boolean
}

const EDGE_TOLERANCE = 2

export function getScrollEdgeState({
  scrollTop,
  clientHeight,
  scrollHeight,
  spacerHeight = 0,
}: ScrollEdgeMetrics): ScrollEdgeState {
  return {
    // 顶部判据不减 spacerHeight：占位项在列表末尾，与「上方是否还有内容」无关。
    top: scrollTop > EDGE_TOLERANCE,
    bottom: scrollTop + clientHeight < scrollHeight - spacerHeight - EDGE_TOLERANCE,
  }
}

export function createScrollEdgeScript(id: string): string {
  return `
document.addEventListener("nav", () => {
  const ul = document.getElementById("${id}")
  if (!ul) return

  // 与上方 getScrollEdgeState 同构（那个函数是本段判据的带单测镜像）。本函数产出的是
  // 注入页面的裸脚本，无法 import 纯函数，**两处必须同时改**：只改一处会出现「单测绿
  // 而线上错」或反之。contentScrollHeight 扣除末尾 li.overflow-end 的高度，理由见
  // ScrollEdgeMetrics.spacerHeight 的注释；与 explorer.inline.ts 的同名函数一致口径。
  const contentScrollHeight = () => {
    const tail = ul.lastElementChild
    return tail && tail.classList.contains("overflow-end")
      ? ul.scrollHeight - tail.getBoundingClientRect().height
      : ul.scrollHeight
  }

  const updateEdgeFade = () => {
    ul.classList.toggle("gradient-top-active", ul.scrollTop > ${EDGE_TOLERANCE})
    ul.classList.toggle(
      "gradient-active",
      ul.scrollTop + ul.clientHeight < contentScrollHeight() - ${EDGE_TOLERANCE},
    )
  }

  ul.addEventListener("scroll", updateEdgeFade, { passive: true })
  window.addCleanup(() => ul.removeEventListener("scroll", updateEdgeFade))
  updateEdgeFade()
})
`
}
