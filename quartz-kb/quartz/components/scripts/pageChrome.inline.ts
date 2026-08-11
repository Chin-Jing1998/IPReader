// 页面 chrome（正文影子滚动条）。
//（v11 曾同时承担「页头滚动收缩」，经用户验收裁决撤销，本文件只余轨道一职。）
//
// 【为什么是「影子」滚动条】全站正文的滚动者是 html/document（window 语义），侧栏 sticky
// 依赖这一滚动模型，故此处不改滚动结构，只在正文列右侧自绘一条视觉替身：轨道读取
// documentElement 的滚动几何映射出 thumb，原生滚动条槽位交由 CSS（html[data-pagescroll="on"]）
// 归零。几何换算复用 util/scrollInteraction.ts 的纯函数，与侧栏 overlay 轨道
//（explorer.inline.ts 的 bindOverlayScrollbars）同源，本文件不再自造一套换算。
//
// 【SPA 生命周期】轨道 DOM 注入 body，而 micromorph 只形变 body：它不存在于下一页的 HTML 中，
// 必须在 window.addCleanup 里自行摘除（cleanup 在 prenav 之后、morph 之前执行，见
// spa.inline.ts），否则会被 diff 当作多余节点处理并打乱 body 子节点配对。
//
// 【零 CSS 责任】轨道/thumb 外观、原生槽宽归零全部在
// quartz/styles/custom.scss 第十五节；本文件只负责行为与如下类名契约：
//   .kb-pagescroll / .kb-pagescroll-thumb / .is-visible / .is-dragging
//   html[data-pagescroll="on"] / html[data-pagescroll-drag]
import { GRAPH_SLUG, SETTINGS_SLUG } from "../../util/appPages"
import {
  computeThumbGeometry,
  hasScrollableContent,
  scrollTopFromThumbOffset,
} from "../../util/scrollInteraction"

/** 滚停后轨道淡出的延时，沿用侧栏 overlay 轨道的 850ms 手感。 */
const HIDE_DELAY = 850

/**
 * 与 quartz/styles/variables.scss 的 `$mobile`（800px）同值，亦与 explorer.inline.ts
 * 的 OVERLAY_MOBILE_QUERY 同值。移动端正文列近乎满屏，轨道无处安放，整体跳过。
 */
const MOBILE_QUERY = "(max-width: 800px)"

const REDUCE_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/** nav 后的兜底重算延时；先例见 reading.inline.ts 的 in-view 兜底刷新。 */
const RESYNC_DELAY = 250

/** 轨道左缘与正文列右缘之间的间距（px），使轨道落在右栏之前的空隙里。 */
const TRACK_GAP = 10

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

document.addEventListener("nav", () => {
  // 移动端整体跳过：html[data-pagescroll] 不落，原生滚动条天然回落（无脚本环境同理）。
  if (window.matchMedia(MOBILE_QUERY).matches) {
    return
  }

  // 应用页整体跳过：图谱总览为整页 overflow:hidden 的画布（无文档滚动），设置页自有布局。
  const slug = document.body.dataset.slug
  if (slug === GRAPH_SLUG || slug === SETTINGS_SLUG) {
    return
  }

  const track = document.createElement("div")
  track.className = "kb-pagescroll"
  track.setAttribute("aria-hidden", "true")
  const thumb = document.createElement("div")
  thumb.className = "kb-pagescroll-thumb"
  track.appendChild(thumb)
  document.body.appendChild(track)
  // 幂等写入且永不摘除：micromorph 只 diff body，html 上的属性不受换页影响；
  // CSS 靠它把原生滚动条槽位归零，中途摘除会让原生滚动条在换页间隙闪现。
  document.documentElement.dataset.pagescroll = "on"

  /** 文档纵向量度快照；每次现取，不缓存（正文高度随异步渲染与折叠交互变化）。 */
  const readMetrics = () => {
    const doc = document.documentElement
    return {
      clientHeight: doc.clientHeight,
      scrollHeight: doc.scrollHeight,
      scrollTop: doc.scrollTop,
    }
  }

  /**
   * 重算轨道横向位置与 thumb 几何；返回 thumb 当前是否应可见。
   * 会触发布局读取，故只在 rAF 帧内、以及绑定时与延时兜底各一次调用。
   */
  const sync = (): boolean => {
    const doc = document.documentElement
    const metrics = readMetrics()

    // scrollWidth 传 clientWidth 抹掉横向分支：超宽表格/代码块造成的横向溢出
    // 不应点亮纵向轨道。
    if (
      !hasScrollableContent({
        clientWidth: doc.clientWidth,
        scrollWidth: doc.clientWidth,
        clientHeight: metrics.clientHeight,
        scrollHeight: metrics.scrollHeight,
      })
    ) {
      track.classList.remove("is-visible")
      return false
    }

    const center = document.querySelector(".center")
    if (!center) {
      return false
    }
    // 贴正文列右侧：.center 的宽度随断点、阅读模式、侧栏显隐变化，故每帧现算不缓存。
    track.style.left = `${Math.round(center.getBoundingClientRect().right) + TRACK_GAP}px`

    // trackHeight 必须显式传 track.clientHeight：轨道由 CSS 的 top/bottom 收窄，
    // 与视口高度并不相等，用默认值会让 thumb 溢出轨道底端。
    const geometry = computeThumbGeometry(metrics, track.clientHeight)
    thumb.style.height = `${geometry.height}px`
    thumb.style.top = `${geometry.offset}px`
    return geometry.visible
  }

  let hideTimer: number | undefined
  const restartHideTimer = () => {
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer)
    }
    hideTimer = window.setTimeout(() => {
      hideTimer = undefined
      // 拖拽期间不隐：按住 thumb 不动也会走到这里，此时轨道必须留在屏上。
      if (track.classList.contains("is-dragging")) {
        return
      }
      track.classList.remove("is-visible")
    }, HIDE_DELAY)
  }

  // rAF 节流：scroll 与 resize 共用一个挂起标志位，每帧至多重算一次；
  // reveal 标志区分二者——只有滚动才点亮轨道，尺寸变化仅重算几何。
  let framePending = false
  let revealPending = false
  const scheduleFrame = (reveal: boolean) => {
    if (reveal) {
      revealPending = true
    }
    if (framePending) {
      return
    }
    framePending = true
    requestAnimationFrame(() => {
      framePending = false
      const shouldReveal = revealPending
      revealPending = false
      if (!sync() || !shouldReveal) {
        return
      }
      track.classList.add("is-visible")
      restartHideTimer()
    })
  }

  const onScroll = () => scheduleFrame(true)
  const onResize = () => scheduleFrame(false)

  let dragStartClientY = 0
  let dragStartTop = 0

  const onThumbPointerDown = (evt: PointerEvent) => {
    // preventDefault 挡掉文本选择与原生拖拽；setPointerCapture 使后续 move/up 一律
    // 回流到 thumb，指针滑出轨道也不丢事件，故这些监听挂在 thumb 上即可。
    evt.preventDefault()
    thumb.setPointerCapture(evt.pointerId)
    dragStartClientY = evt.clientY
    dragStartTop = parseFloat(thumb.style.top) || 0
    track.classList.add("is-dragging")
    // 供 CSS 关闭全局 user-select：拖拽跨越正文时不应顺带选中文字。
    document.documentElement.dataset.pagescrollDrag = "on"
  }

  const onThumbPointerMove = (evt: PointerEvent) => {
    if (!track.classList.contains("is-dragging")) {
      return
    }
    const maxOffset = Math.max(track.clientHeight - thumb.offsetHeight, 0)
    const offset = clamp(dragStartTop + (evt.clientY - dragStartClientY), 0, maxOffset)
    // behavior 固定 "instant"：拖拽要求 thumb 与指针严格同步，平滑滚动会产生拖尾。
    // **不可写 "auto"** —— 按 CSSOM View 规范，"auto" 是「听 CSS scroll-behavior 的」，
    // 而 base.scss 给 html 落的正是 `scroll-behavior: smooth`，写 "auto" 等于要平滑滚动：
    // 实测拖 120px 后 150ms 只走到目标位移的 1/6（4.9px/120px），拇指严重滞后于指针。
    // 只有 "instant" 才是规范里「无条件瞬时」的那一档。
    // thumb 的 top 不在此处直接写，由 scroll 事件驱动的下一帧 sync 统一回写。
    window.scrollTo({
      top: scrollTopFromThumbOffset(offset, readMetrics(), track.clientHeight, thumb.offsetHeight),
      behavior: "instant",
    })
  }

  const onThumbPointerUp = (evt: PointerEvent) => {
    if (!track.classList.contains("is-dragging")) {
      return
    }
    if (thumb.hasPointerCapture(evt.pointerId)) {
      thumb.releasePointerCapture(evt.pointerId)
    }
    track.classList.remove("is-dragging")
    delete document.documentElement.dataset.pagescrollDrag
    restartHideTimer()
  }

  /** 轨道空白处点击：把点击点当作 thumb 的新中心，走与拖拽相同的逆映射。 */
  const onTrackPointerDown = (evt: PointerEvent) => {
    if (evt.target === thumb) {
      return
    }
    const trackRect = track.getBoundingClientRect()
    const maxOffset = Math.max(track.clientHeight - thumb.offsetHeight, 0)
    const offset = clamp(evt.clientY - trackRect.top - thumb.offsetHeight / 2, 0, maxOffset)
    window.scrollTo({
      top: scrollTopFromThumbOffset(offset, readMetrics(), track.clientHeight, thumb.offsetHeight),
      behavior: window.matchMedia(REDUCE_MOTION_QUERY).matches ? "auto" : "smooth",
    })
  }

  document.addEventListener("scroll", onScroll, { passive: true })
  window.addEventListener("resize", onResize)
  thumb.addEventListener("pointerdown", onThumbPointerDown)
  thumb.addEventListener("pointermove", onThumbPointerMove)
  thumb.addEventListener("pointerup", onThumbPointerUp)
  thumb.addEventListener("pointercancel", onThumbPointerUp)
  track.addEventListener("pointerdown", onTrackPointerDown)

  // 首次同步不经 rAF：后台标签页中 rAF 被挂起，首帧几何将永远停在初值
  //（同款教训见 reading.inline.ts 与 explorer.inline.ts）。
  sync()
  // mermaid 图、局部图谱等异步渲染会在首帧之后改变文档高度，延时兜底重算一次。
  const resyncTimer = window.setTimeout(() => sync(), RESYNC_DELAY)

  window.addCleanup(() => {
    document.removeEventListener("scroll", onScroll)
    window.removeEventListener("resize", onResize)
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer)
    }
    window.clearTimeout(resyncTimer)
    // 拖拽中被程序化跳转打断时，全局禁选态会滞留在 html 上，此处复位；
    // data-pagescroll 属常驻开关（见上），不在此清除。
    delete document.documentElement.dataset.pagescrollDrag
    // track/thumb 上的 pointer 监听随节点移除自然失效，无须逐一摘除。
    track.remove()
  })
})
