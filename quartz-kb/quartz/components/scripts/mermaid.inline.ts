import { registerEscapeHandler, removeAllChildren } from "./util"

interface Position {
  x: number
  y: number
}

class DiagramPanZoom {
  private isDragging = false
  private startPan: Position = { x: 0, y: 0 }
  private currentPan: Position = { x: 0, y: 0 }
  private scale = 1
  private readonly MIN_SCALE = 0.5
  private readonly MAX_SCALE = 3

  cleanups: (() => void)[] = []

  constructor(
    private container: HTMLElement,
    private content: HTMLElement,
  ) {
    this.setupEventListeners()
    this.setupNavigationControls()
    this.resetTransform()
  }

  private setupEventListeners() {
    // Mouse drag events
    const mouseDownHandler = this.onMouseDown.bind(this)
    const mouseMoveHandler = this.onMouseMove.bind(this)
    const mouseUpHandler = this.onMouseUp.bind(this)

    // Touch drag events
    const touchStartHandler = this.onTouchStart.bind(this)
    const touchMoveHandler = this.onTouchMove.bind(this)
    const touchEndHandler = this.onTouchEnd.bind(this)

    const resizeHandler = this.resetTransform.bind(this)

    this.container.addEventListener("mousedown", mouseDownHandler)
    document.addEventListener("mousemove", mouseMoveHandler)
    document.addEventListener("mouseup", mouseUpHandler)

    this.container.addEventListener("touchstart", touchStartHandler, { passive: false })
    document.addEventListener("touchmove", touchMoveHandler, { passive: false })
    document.addEventListener("touchend", touchEndHandler)

    window.addEventListener("resize", resizeHandler)

    this.cleanups.push(
      () => this.container.removeEventListener("mousedown", mouseDownHandler),
      () => document.removeEventListener("mousemove", mouseMoveHandler),
      () => document.removeEventListener("mouseup", mouseUpHandler),
      () => this.container.removeEventListener("touchstart", touchStartHandler),
      () => document.removeEventListener("touchmove", touchMoveHandler),
      () => document.removeEventListener("touchend", touchEndHandler),
      () => window.removeEventListener("resize", resizeHandler),
    )
  }

  cleanup() {
    for (const cleanup of this.cleanups) {
      cleanup()
    }
  }

  private setupNavigationControls() {
    const controls = document.createElement("div")
    controls.className = "mermaid-controls"

    // Zoom controls
    const zoomIn = this.createButton("+", () => this.zoom(0.1))
    const zoomOut = this.createButton("-", () => this.zoom(-0.1))
    const resetBtn = this.createButton("Reset", () => this.resetTransform())

    controls.appendChild(zoomOut)
    controls.appendChild(resetBtn)
    controls.appendChild(zoomIn)

    this.container.appendChild(controls)
  }

  private createButton(text: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button")
    button.textContent = text
    button.className = "mermaid-control-button"
    button.addEventListener("click", onClick)
    window.addCleanup(() => button.removeEventListener("click", onClick))
    return button
  }

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return // Only handle left click
    this.isDragging = true
    this.startPan = { x: e.clientX - this.currentPan.x, y: e.clientY - this.currentPan.y }
    this.container.style.cursor = "grabbing"
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.isDragging) return
    e.preventDefault()

    this.currentPan = {
      x: e.clientX - this.startPan.x,
      y: e.clientY - this.startPan.y,
    }

    this.updateTransform()
  }

  private onMouseUp() {
    this.isDragging = false
    this.container.style.cursor = "grab"
  }

  private onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return
    this.isDragging = true
    const touch = e.touches[0]
    this.startPan = { x: touch.clientX - this.currentPan.x, y: touch.clientY - this.currentPan.y }
  }

  private onTouchMove(e: TouchEvent) {
    if (!this.isDragging || e.touches.length !== 1) return
    e.preventDefault() // Prevent scrolling

    const touch = e.touches[0]
    this.currentPan = {
      x: touch.clientX - this.startPan.x,
      y: touch.clientY - this.startPan.y,
    }

    this.updateTransform()
  }

  private onTouchEnd() {
    this.isDragging = false
  }

  private zoom(delta: number) {
    const newScale = Math.min(Math.max(this.scale + delta, this.MIN_SCALE), this.MAX_SCALE)

    // Zoom around center
    const rect = this.content.getBoundingClientRect()
    const centerX = rect.width / 2
    const centerY = rect.height / 2

    const scaleDiff = newScale - this.scale
    this.currentPan.x -= centerX * scaleDiff
    this.currentPan.y -= centerY * scaleDiff

    this.scale = newScale
    this.updateTransform()
  }

  private updateTransform() {
    this.content.style.transform = `translate(${this.currentPan.x}px, ${this.currentPan.y}px) scale(${this.scale})`
  }

  private resetTransform() {
    const svg = this.content.querySelector("svg")!
    const rect = svg.getBoundingClientRect()
    const width = rect.width / this.scale
    const height = rect.height / this.scale

    this.scale = 1
    this.currentPan = {
      x: (this.container.clientWidth - width) / 2,
      y: (this.container.clientHeight - height) / 2,
    }
    this.updateTransform()
  }
}

const cssVars = [
  "--secondary",
  "--tertiary",
  "--gray",
  "--light",
  "--lightgray",
  "--highlight",
  "--dark",
  "--darkgray",
  "--codeFont",
] as const

// themechange 重渲染防抖窗口：设置页连点主题卡会连发 themechange，
// 不防抖则每次都触发一轮全量重渲。与图谱体系（graph / graphexplorer）取同值。
const THEME_CHANGE_DEBOUNCE_MS = 120

// 离屏容器样式：容器必须留在文档内并参与布局——mermaid 渲染依赖 getBBox 量取
// 文本尺寸，display:none 会让所有测量返回 0 从而画出错乱的图，故只做视口外绝对定位。
const OFFSCREEN_CONTAINER_STYLE = "position: absolute; left: -99999px; top: 0"

let mermaidImport = undefined
document.addEventListener("nav", async () => {
  const center = document.querySelector(".center") as HTMLElement
  const nodes = center.querySelectorAll("code.mermaid") as NodeListOf<HTMLElement>
  if (nodes.length === 0) return

  mermaidImport ||= await import(
    // @ts-ignore
    "https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.4.0/mermaid.esm.min.mjs"
  )
  const mermaid = mermaidImport.default

  const textMapping: WeakMap<HTMLElement, string> = new WeakMap()
  for (const node of nodes) {
    textMapping.set(node, node.innerText)
  }

  // mermaid 主题色取自 initialize 时刻的 CSS 变量快照，切主题必须重跑 initialize
  // 再重渲，否则图形沿用旧配色。渲染前（含离屏渲染前）都须先执行本函数。
  function applyMermaidConfig() {
    const computedStyleMap = cssVars.reduce(
      (acc, key) => {
        acc[key] = window.getComputedStyle(document.documentElement).getPropertyValue(key)
        return acc
      },
      {} as Record<(typeof cssVars)[number], string>,
    )

    const darkMode = document.documentElement.getAttribute("saved-theme") === "dark"
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: darkMode ? "dark" : "base",
      themeVariables: {
        fontFamily: computedStyleMap["--codeFont"],
        primaryColor: computedStyleMap["--light"],
        primaryTextColor: computedStyleMap["--darkgray"],
        primaryBorderColor: computedStyleMap["--tertiary"],
        lineColor: computedStyleMap["--darkgray"],
        secondaryColor: computedStyleMap["--secondary"],
        tertiaryColor: computedStyleMap["--tertiary"],
        clusterBkg: computedStyleMap["--light"],
        edgeLabelBackground: computedStyleMap["--highlight"],
      },
    })
  }

  // 首屏渲染：此时节点内容本就是 mermaid 源码文本，可直接原地渲染。
  async function renderMermaid() {
    applyMermaidConfig()
    await mermaid.run({ nodes })
  }

  // 渲染中的离屏容器集合：单次渲染由自身 finally 摘除，本集合仅供导航时兜底清理
  // （防抖串起的两次重渲可能时间上重叠，故用集合而非单一引用）。
  const pendingOffscreenContainers = new Set<HTMLElement>()

  // 主题切换重渲染：若直接把源码文本写回原节点再等异步渲染，用户会看到每张图
  // 闪一下 mermaid 源码。改为在视口外容器中渲染浅克隆节点，渲染成功后再替换原
  // 节点内容；任一步失败则原节点保留旧 SVG 不动（优于退回源码文本）。
  async function rerenderMermaidOffscreen() {
    applyMermaidConfig()

    const offscreen = document.createElement("div")
    offscreen.setAttribute("aria-hidden", "true")
    offscreen.style.cssText = OFFSCREEN_CONTAINER_STYLE
    document.body.appendChild(offscreen)
    pendingOffscreenContainers.add(offscreen)

    try {
      const pending: { node: HTMLElement; clone: HTMLElement }[] = []
      for (const node of nodes) {
        const sourceText = textMapping.get(node)
        if (!sourceText) continue

        // 浅克隆保留原节点属性；data-processed 必须删除，否则 mermaid.run 跳过该节点
        const clone = node.cloneNode(false) as HTMLElement
        clone.removeAttribute("data-processed")
        clone.innerHTML = sourceText
        offscreen.appendChild(clone)
        pending.push({ node, clone })
      }

      if (pending.length === 0) return

      await mermaid.run({ nodes: pending.map(({ clone }) => clone) })

      for (const { node, clone } of pending) {
        node.innerHTML = clone.innerHTML
        // 同步 mermaid.run 写在宿主元素上的属性（data-processed 等），使替换后的
        // 原节点与直接渲染所得状态一致；克隆自原节点，故属性集是原属性的超集。
        for (const attr of Array.from(clone.attributes)) {
          node.setAttribute(attr.name, attr.value)
        }
      }
    } catch (error) {
      console.error("mermaid theme re-render failed, keeping rendered diagrams", error)
    } finally {
      offscreen.remove()
      pendingOffscreenContainers.delete(offscreen)
    }
  }

  await renderMermaid()

  let themeChangeTimer: ReturnType<typeof setTimeout> | undefined
  const handleThemeChange = () => {
    clearTimeout(themeChangeTimer)
    themeChangeTimer = setTimeout(() => {
      void rerenderMermaidOffscreen()
    }, THEME_CHANGE_DEBOUNCE_MS)
  }

  document.addEventListener("themechange", handleThemeChange)
  window.addCleanup(() => {
    // 未决防抖回调必须撤销：导航后触发会渲染到已被替换的 DOM 上
    clearTimeout(themeChangeTimer)
    document.removeEventListener("themechange", handleThemeChange)
    // 导航时仍在渲染的离屏容器直接摘除，避免残留在 body 上
    for (const container of pendingOffscreenContainers) {
      container.remove()
    }
    pendingOffscreenContainers.clear()
  })

  for (let i = 0; i < nodes.length; i++) {
    const codeBlock = nodes[i] as HTMLElement
    const pre = codeBlock.parentElement as HTMLPreElement
    const clipboardBtn = pre.querySelector(".clipboard-button") as HTMLButtonElement
    const expandBtn = pre.querySelector(".expand-button") as HTMLButtonElement

    const clipboardStyle = window.getComputedStyle(clipboardBtn)
    const clipboardWidth =
      clipboardBtn.offsetWidth +
      parseFloat(clipboardStyle.marginLeft || "0") +
      parseFloat(clipboardStyle.marginRight || "0")

    // Set expand button position
    expandBtn.style.right = `calc(${clipboardWidth}px + 0.3rem)`
    pre.prepend(expandBtn)

    // query popup container
    const popupContainer = pre.querySelector("#mermaid-container") as HTMLElement
    if (!popupContainer) return

    let panZoom: DiagramPanZoom | null = null
    function showMermaid() {
      const container = popupContainer.querySelector("#mermaid-space") as HTMLElement
      const content = popupContainer.querySelector(".mermaid-content") as HTMLElement
      if (!content) return
      removeAllChildren(content)

      // Clone the mermaid content
      const mermaidContent = codeBlock.querySelector("svg")!.cloneNode(true) as SVGElement
      content.appendChild(mermaidContent)

      // Show container
      popupContainer.classList.add("active")
      container.style.cursor = "grab"

      // Initialize pan-zoom after showing the popup
      panZoom = new DiagramPanZoom(container, content)
    }

    function hideMermaid() {
      popupContainer.classList.remove("active")
      panZoom?.cleanup()
      panZoom = null
    }

    expandBtn.addEventListener("click", showMermaid)
    registerEscapeHandler(popupContainer, hideMermaid)

    window.addCleanup(() => {
      panZoom?.cleanup()
      expandBtn.removeEventListener("click", showMermaid)
    })
  }
})
