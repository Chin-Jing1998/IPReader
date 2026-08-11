import { computePosition, flip, inline, shift } from "@floating-ui/dom"
import { normalizeRelativeURLs } from "../../util/path"
import {
  createPopoverReturnState,
  isPopoverReturnTarget,
  popoverLinkAction,
  type PopoverReturnState,
} from "../../util/popoverInteraction"
import { fetchCanonical } from "./util"

const p = new DOMParser()
const CLICK_PREVIEW_DELAY = 250
const POPOVER_RETURN_KEY = "kb-popover-return"
let activeAnchor: HTMLAnchorElement | null = null
let hoverTimer: ReturnType<typeof setTimeout> | undefined
let clickTimer: ReturnType<typeof setTimeout> | undefined
let pendingClickLink: HTMLAnchorElement | null = null

function isPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
}

function isLocalLink(link: HTMLAnchorElement): boolean {
  try {
    return new URL(link.href, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

function readReturnState(): PopoverReturnState | null {
  try {
    const raw = sessionStorage.getItem(POPOVER_RETURN_KEY)
    if (!raw) return null
    const state = JSON.parse(raw) as Partial<PopoverReturnState>
    if (typeof state.from !== "string" || typeof state.to !== "string") return null
    return { from: state.from, to: state.to }
  } catch {
    return null
  }
}

function writeReturnState(state: PopoverReturnState): void {
  try {
    sessionStorage.setItem(POPOVER_RETURN_KEY, JSON.stringify(state))
  } catch {
    // 隐私模式或存储配额不足时，预览内链仍可正常导航，只是不显示返回按钮。
  }
}

function clearReturnState(): void {
  try {
    sessionStorage.removeItem(POPOVER_RETURN_KEY)
  } catch {
    // sessionStorage 不可用时无需额外处理。
  }
}

function targetInfo(link: HTMLAnchorElement): { url: URL; hash: string } {
  const url = new URL(link.href, window.location.href)
  const hash = decodeURIComponent(url.hash)
  url.hash = ""
  url.search = ""
  return { url, hash }
}

function isClickPreviewActive(): boolean {
  return document.querySelector(".popover.click-preview.active-popover") !== null
}

function scrollToHash(popoverInner: HTMLElement | null, hash: string): void {
  if (!popoverInner || hash === "") return
  const targetAnchor = `#popover-internal-${hash.slice(1)}`
  const heading = popoverInner.querySelector(targetAnchor) as HTMLElement | null
  if (heading) {
    // leave ~12px of buffer when scrolling to a heading
    popoverInner.scroll({ top: heading.offsetTop - 12, behavior: "instant" })
  }
}

async function getOrCreatePopover(
  link: HTMLAnchorElement,
): Promise<{ element: HTMLElement; hash: string } | null> {
  if (link.dataset.noPopover === "true") return null

  const { url: targetUrl, hash } = targetInfo(link)
  const popoverId = `popover-${targetUrl.pathname}`
  const previous = document.getElementById(popoverId)

  // dont refetch if there's already a popover
  if (previous) {
    return { element: previous, hash }
  }

  const response = await fetchCanonical(targetUrl).catch((err) => {
    console.error(err)
  })

  if (!response) return null
  const contentType = response.headers.get("Content-Type") ?? "text/html"
  const [contentTypeCategory, typeInfo] = contentType.split("/")

  const popoverElement = document.createElement("div")
  popoverElement.id = popoverId
  popoverElement.classList.add("popover")
  popoverElement.setAttribute("role", "dialog")
  popoverElement.addEventListener("click", onPopoverClick)
  const popoverInner = document.createElement("div")
  popoverInner.classList.add("popover-inner")
  popoverInner.dataset.contentType = contentType
  popoverElement.appendChild(popoverInner)

  switch (contentTypeCategory) {
    case "image": {
      const img = document.createElement("img")
      img.src = targetUrl.toString()
      img.alt = targetUrl.pathname

      popoverInner.appendChild(img)
      break
    }
    case "application":
      if (typeInfo === "pdf") {
        const pdf = document.createElement("iframe")
        pdf.src = targetUrl.toString()
        popoverInner.appendChild(pdf)
      }
      break
    default: {
      const contents = await response.text()
      const html = p.parseFromString(contents, "text/html")
      normalizeRelativeURLs(html, targetUrl)
      // prepend all IDs inside popovers to prevent duplicates
      html.querySelectorAll("[id]").forEach((el) => {
        const targetID = `popover-internal-${el.id}`
        el.id = targetID
      })
      const elts = [...html.getElementsByClassName("popover-hint")]
      if (elts.length === 0) return null

      elts.forEach((elt) => popoverInner.appendChild(elt))
      break
    }
  }

  // 两个并发请求可能同时完成，只有第一个结果进入文档。
  const existing = document.getElementById(popoverId)
  if (existing) {
    return { element: existing, hash }
  }

  document.body.appendChild(popoverElement)
  return { element: popoverElement, hash }
}

function clearActivePopover(): void {
  activeAnchor = null
  document.body.classList.remove("popover-modal-open")
  const allPopoverElements = document.querySelectorAll<HTMLElement>(".popover")
  allPopoverElements.forEach((popoverElement) => {
    popoverElement.classList.remove("active-popover", "click-preview")
    popoverElement.removeAttribute("aria-modal")
  })
}

function activatePopover(
  link: HTMLAnchorElement,
  popoverElement: HTMLElement,
  hash: string,
  mode: "hover" | "click",
  clientX?: number,
  clientY?: number,
): void {
  clearActivePopover()
  activeAnchor = link
  popoverElement.classList.add("active-popover")
  popoverElement.classList.toggle("click-preview", mode === "click")

  if (mode === "click") {
    popoverElement.setAttribute("aria-modal", "true")
    document.body.classList.add("popover-modal-open")
    popoverElement.style.removeProperty("transform")
  } else if (clientX !== undefined && clientY !== undefined) {
    void computePosition(link, popoverElement, {
      strategy: "fixed",
      middleware: [inline({ x: clientX, y: clientY }), shift(), flip()],
    }).then(({ x, y }) => {
      if (popoverElement.classList.contains("active-popover")) {
        Object.assign(popoverElement.style, {
          transform: `translate(${x.toFixed()}px, ${y.toFixed()}px)`,
        })
      }
    })
  }

  scrollToHash(popoverElement.querySelector<HTMLElement>(".popover-inner"), hash)
}

async function showHoverPopover(
  link: HTMLAnchorElement,
  clientX: number,
  clientY: number,
): Promise<void> {
  activeAnchor = link
  const result = await getOrCreatePopover(link)
  if (!result || activeAnchor !== link || isClickPreviewActive()) return
  activatePopover(link, result.element, result.hash, "hover", clientX, clientY)
}

async function showClickPreview(link: HTMLAnchorElement): Promise<void> {
  if (link.dataset.noPopover === "true") return
  clearTimeout(hoverTimer)
  clearActivePopover()
  activeAnchor = link
  const result = await getOrCreatePopover(link)
  if (!result || activeAnchor !== link) return
  activatePopover(link, result.element, result.hash, "click")
}

function navigateToLink(link: HTMLAnchorElement): void {
  const url = new URL(link.href, window.location.href)
  writeReturnState(createPopoverReturnState(window.location.href, url.toString()))
  clearActivePopover()
  window.spaNavigate(url)
}

function onPopoverClick(this: HTMLElement, event: MouseEvent): void {
  if (event.target === this) {
    event.preventDefault()
    event.stopPropagation()
    clearActivePopover()
    return
  }

  const target = event.target instanceof Element ? event.target : null
  const link = target?.closest<HTMLAnchorElement>("a")
  if (!link || !this.contains(link) || !isLocalLink(link) || !isPrimaryClick(event)) return
  if (link.target === "_blank" || "routerIgnore" in link.dataset) return

  event.preventDefault()
  event.stopPropagation()
  navigateToLink(link)
}

function onLinkEnter(this: HTMLAnchorElement, event: MouseEvent): void {
  if (isClickPreviewActive()) return
  const { clientX, clientY } = event
  clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => {
    void showHoverPopover(this, clientX, clientY)
  }, 150)
}

function onLinkLeave(): void {
  clearTimeout(hoverTimer)
  // 单击预览是模态状态，鼠标离开原链接不能关闭它。
  if (!isClickPreviewActive()) clearActivePopover()
}

function onLinkClick(this: HTMLAnchorElement, event: MouseEvent): void {
  if (!isPrimaryClick(event) || this.dataset.noPopover === "true") return

  // 必须在链接本身截断冒泡，避免 spa.inline.ts 的全局路由立即跳转。
  event.preventDefault()
  event.stopPropagation()
  clearTimeout(hoverTimer)

  if (popoverLinkAction(event.detail) === "navigate") {
    pendingClickLink = null
    clearTimeout(clickTimer)
    navigateToLink(this)
    return
  }

  clearTimeout(clickTimer)
  pendingClickLink = this
  clickTimer = setTimeout(() => {
    const link = pendingClickLink
    pendingClickLink = null
    if (link) void showClickPreview(link)
  }, CLICK_PREVIEW_DELAY)
}

function onPrenav(): void {
  clearTimeout(hoverTimer)
  clearTimeout(clickTimer)
  pendingClickLink = null
  clearActivePopover()
  document.querySelectorAll(".popover").forEach((popover) => popover.remove())
}

function mountReturnButton(): void {
  const state = readReturnState()
  if (!state) return

  if (!isPopoverReturnTarget(window.location.href, state)) {
    clearReturnState()
    return
  }

  if (document.querySelector("[data-popover-return]")) return
  const center = document.querySelector<HTMLElement>(".center")
  if (!center) return

  const bar = document.createElement("div")
  bar.className = "popover-return-bar"
  bar.dataset.popoverReturn = "true"
  const button = document.createElement("button")
  button.type = "button"
  button.className = "popover-return-button"
  button.setAttribute("aria-label", "返回正文")
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  icon.setAttribute("class", "popover-return-icon")
  icon.setAttribute("aria-hidden", "true")
  icon.setAttribute("viewBox", "0 0 24 24")
  icon.setAttribute("focusable", "false")
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path")
  arrow.setAttribute("d", "M20 17v-1a7 7 0 0 0-7-7H5m4-4L5 9l4 4")
  arrow.setAttribute("fill", "none")
  arrow.setAttribute("stroke", "currentColor")
  arrow.setAttribute("stroke-width", "3")
  arrow.setAttribute("stroke-linecap", "round")
  arrow.setAttribute("stroke-linejoin", "round")
  icon.appendChild(arrow)
  const label = document.createElement("span")
  label.className = "popover-return-label"
  label.textContent = "返回正文"
  button.append(icon, label)
  bar.appendChild(button)

  const onClick = () => {
    const current = readReturnState()
    if (!current) return
    clearReturnState()
    window.spaNavigate(new URL(current.from, window.location.href))
  }

  button.addEventListener("click", onClick)
  center.insertBefore(bar, center.firstChild)
  window.addCleanup(() => button.removeEventListener("click", onClick))
  window.addCleanup(() => bar.remove())
}

document.addEventListener("prenav", onPrenav)
document.addEventListener("nav", () => {
  mountReturnButton()
  const links = [...document.querySelectorAll(".center article a.internal")] as HTMLAnchorElement[]
  for (const link of links) {
    link.addEventListener("mouseenter", onLinkEnter)
    link.addEventListener("mouseleave", onLinkLeave)
    link.addEventListener("click", onLinkClick)
    window.addCleanup(() => {
      clearTimeout(hoverTimer)
      clearTimeout(clickTimer)
      link.removeEventListener("mouseenter", onLinkEnter)
      link.removeEventListener("mouseleave", onLinkLeave)
      link.removeEventListener("click", onLinkClick)
    })
  }
})
