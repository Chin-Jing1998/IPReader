// 键盘翻页（v6）：← / [ 上一节，→ / ] 下一节。
// 无状态设计：每次按键现读 .page-nav 的 data-prev / data-next（micromorph
// 换页后属性天然是新值，零重绑逻辑）；导航优先走 SPA 路由保留换页体验。
const NEXT_KEYS = new Set(["ArrowRight", "]"])
const PREV_KEYS = new Set(["ArrowLeft", "["])

function isTypingContext(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) {
    return false
  }
  const tag = el.tagName
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable ||
    el.getAttribute("role") === "textbox"
  )
}

function isBlockedContext(): boolean {
  // 搜索模态打开（方向键用于结果导航）
  if (document.querySelector(".search-container.active")) {
    return true
  }
  // 全局图弹窗打开
  if (document.querySelector(".global-graph-outer.active")) {
    return true
  }
  // 图谱总览专页：整页为画布应用
  if (document.body.dataset.slug === "0-图谱总览/index") {
    return true
  }
  // 设置专页：整页为设置面板应用，非阅读页面
  if (document.body.dataset.slug === "设置/index") {
    return true
  }
  // 移动端目录抽屉展开
  if (
    document.documentElement.classList.contains("mobile-no-scroll") ||
    document.body.classList.contains("mobile-no-scroll")
  ) {
    return true
  }
  return false
}

function onKeydown(e: KeyboardEvent) {
  // 中文输入法组字期间绝不劫持（keyCode 229 兼容旧内核）
  if (e.isComposing || e.keyCode === 229) {
    return
  }
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
    return
  }
  const isNext = NEXT_KEYS.has(e.key)
  const isPrev = PREV_KEYS.has(e.key)
  if (!isNext && !isPrev) {
    return
  }
  if (isTypingContext() || isBlockedContext()) {
    return
  }

  const nav = document.querySelector<HTMLElement>(".page-nav")
  const href = isNext ? nav?.dataset.next : nav?.dataset.prev
  if (!href) {
    return
  }

  e.preventDefault()
  const url = new URL(href, window.location.toString())
  if (typeof window.spaNavigate === "function") {
    window.spaNavigate(url)
  } else {
    window.location.assign(url.toString())
  }
}

document.addEventListener("nav", () => {
  document.addEventListener("keydown", onKeydown)
  window.addCleanup(() => document.removeEventListener("keydown", onKeydown))
})
