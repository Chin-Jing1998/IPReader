// 阅读辅助（v6）：①回到顶部 FAB＋阅读进度环；②TOC 当前小节强调。
// 同一滚动监听驱动（passive + rAF 节流，每帧至多 1 次样式写入）。
// 初始态同步执行一次（不经 rAF——后台标签页中 rAF 被挂起，见 explorer.inline.ts 同款教训）；
// TOC 的 in-view 由上游 IntersectionObserver 异步就位，nav 后另设短延时兜底刷新。
const RING_CIRC = 97.39 // 2π × r(15.5)，与 ReadingAids.tsx 的 SVG 半径对应

function updateAids(fab: HTMLElement, ring: SVGCircleElement | null) {
  const doc = document.documentElement
  const max = Math.max(1, doc.scrollHeight - doc.clientHeight)
  const p = Math.min(1, Math.max(0, doc.scrollTop / max))
  if (ring) {
    ring.style.strokeDashoffset = String(Math.round(RING_CIRC * (1 - p) * 100) / 100)
  }
  fab.classList.toggle("is-visible", doc.scrollTop > doc.clientHeight * 0.8)

  // TOC 当前小节：上游 in-view 是「已越过标题」的累积集合，取最后一个作当前位置
  const inView = document.querySelectorAll(".toc-content a.in-view")
  const current = inView.length ? inView[inView.length - 1] : null
  for (const el of document.querySelectorAll(".toc-content a.toc-current")) {
    if (el !== current) {
      el.classList.remove("toc-current")
    }
  }
  if (current) {
    current.classList.add("toc-current")
  }
}

document.addEventListener("nav", () => {
  const fab = document.querySelector<HTMLElement>(".reading-fab")
  if (!fab) {
    return
  }
  const ring = fab.querySelector<SVGCircleElement>(".reading-fab-ring")

  let ticking = false
  const onScroll = () => {
    if (!ticking) {
      ticking = true
      requestAnimationFrame(() => {
        ticking = false
        updateAids(fab, ring)
      })
    }
  }
  const onClick = () => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" })
  }

  document.addEventListener("scroll", onScroll, { passive: true })
  fab.addEventListener("click", onClick)
  window.addCleanup(() => {
    document.removeEventListener("scroll", onScroll)
    fab.removeEventListener("click", onClick)
  })

  updateAids(fab, ring)
  // in-view 由 IntersectionObserver 首批回调异步就位，此处兜底刷新一次
  setTimeout(() => updateAids(fab, ring), 250)
})
