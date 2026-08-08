import { FileTrieNode } from "../../util/fileTrie"
import { FullSlug, resolveRelative, simplifySlug } from "../../util/path"
import { ContentDetails } from "../../plugins/emitters/contentIndex"

type MaybeHTMLElement = HTMLElement | undefined

interface ParsedOptions {
  folderClickBehavior: "collapse" | "link"
  folderDefaultState: "collapsed" | "open"
  useSavedState: boolean
  /** 默认展开的目录层级数（F5）：深度 ≤ openLevels 的文件夹无保存态时初始展开；0 = 全折叠旧行为 */
  openLevels: number
  sortFn: (a: FileTrieNode, b: FileTrieNode) => number
  filterFn: (node: FileTrieNode) => boolean
  mapFn: (node: FileTrieNode) => void
  order: "sort" | "filter" | "map"[]
}

type FolderState = {
  path: string
  collapsed: boolean
}

/**
 * 文件夹深度：slug 有效段数（顶层「1-专利法/index」=1，「1-专利法/1-总则/index」=2）。
 * trie 的文件夹 slug 以 "/index" 收尾（FullSlug 形态），计深度时剔除该尾段与空段。
 */
function folderDepth(path: string): number {
  const segments = path.split("/").filter((s) => s.length > 0)
  if (segments.length > 0 && segments[segments.length - 1] === "index") {
    segments.pop()
  }
  return segments.length
}

/**
 * 无 localStorage 保存态时的初始折叠判定（F5）：
 * folderDefaultState 为 "collapsed" 且深度超出 openLevels 才折叠——
 * openLevels: 1 时顶层目录默认展开、二级及更深仍折叠；openLevels: 0 保持旧全折叠行为。
 */
// ==== patent-kb: 消除 new Function ====
// 上游把 Explorer.tsx 的三个函数 toString() 塞进 data 属性，再在浏览器侧 eval 回来，
// 这使产物必须放行 CSP 的 'unsafe-eval'。它们本就是编译期固定的三段逻辑，
// 绕这一趟字符串没有换来任何灵活性，故直接内联。
// 顺带解掉了 quartz.layout.ts 上那两条脆弱约束：函数必须是纯函数、且体内不得定义
// 具名内部函数（否则 esbuild 的 keep-names 会注入运行期未定义的 __name 包装）。

/** 目录树排序：文件夹在前；同类先比名称的数字前缀，再按中文语序 */
function sortNodes(a: FileTrieNode, b: FileTrieNode): number {
  if (a.isFolder !== b.isFolder) {
    return a.isFolder ? -1 : 1
  }
  // 内容目录形如「1-专利法/…」、文件形如「3-2-xxx.md」，数字前缀即文档序
  const aMatch = (a.slugSegment || a.displayName || "").match(/^(\d+)/)
  const bMatch = (b.slugSegment || b.displayName || "").match(/^(\d+)/)
  const na = aMatch ? parseInt(aMatch[1], 10) : Number.MAX_SAFE_INTEGER
  const nb = bMatch ? parseInt(bMatch[1], 10) : Number.MAX_SAFE_INTEGER
  if (na !== nb) {
    return na - nb
  }
  // numeric 使「1-2」<「1-10」按数值序；zh-CN 使无前缀项按中文语序
  return (a.displayName || "").localeCompare(b.displayName || "", "zh-CN", {
    numeric: true,
    sensitivity: "base",
  })
}

/** 标签目录不进侧栏（tags 页仍可经搜索与页内标签抵达）——沿用上游默认行为 */
function keepNode(node: FileTrieNode): boolean {
  return node.slugSegment !== "tags"
}
// ==== /patent-kb ====

function defaultCollapsed(path: string, opts: ParsedOptions): boolean {
  return opts.folderDefaultState === "collapsed" && folderDepth(path) > opts.openLevels
}

// ==== patent-kb: 目录自动定位（v6）====
// 当前项（文件行 a.active，兜底目录页 .folder-container.active）不在滚动器
// 可视区内时，将其滚动到居中；已可见则完全不动。只写内层滚动器 scrollTop，
// 绝不用 scrollIntoView（会连带滚动整个文档）。
let explorerLocatePending = false

function locateExplorerActive(scroller: HTMLElement) {
  const active =
    scroller.querySelector<HTMLElement>("a.active") ??
    scroller.querySelector<HTMLElement>(".folder-container.active")
  if (!active) {
    return
  }
  const sRect = scroller.getBoundingClientRect()
  const aRect = active.getBoundingClientRect()
  const isVisible = aRect.top >= sRect.top + 4 && aRect.bottom <= sRect.bottom - 4
  if (isVisible) {
    return
  }
  const target = scroller.scrollTop + (aRect.top - sRect.top) - (sRect.height - aRect.height) / 2
  scroller.scrollTop = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight))
}
// ==== /patent-kb ====

let currentExplorerState: Array<FolderState>
function toggleExplorer(this: HTMLElement) {
  const nearestExplorer = this.closest(".explorer") as HTMLElement
  if (!nearestExplorer) return
  // 用户手动切换后清掉自动折叠标记：桌面端复位逻辑不再打断用户意图
  delete nearestExplorer.dataset.autoCollapsed
  const explorerCollapsed = nearestExplorer.classList.toggle("collapsed")
  nearestExplorer.setAttribute(
    "aria-expanded",
    nearestExplorer.getAttribute("aria-expanded") === "true" ? "false" : "true",
  )

  if (!explorerCollapsed) {
    // Stop <html> from being scrollable when mobile explorer is open
    document.documentElement.classList.add("mobile-no-scroll")
  } else {
    document.documentElement.classList.remove("mobile-no-scroll")
  }
}

function toggleFolder(evt: MouseEvent) {
  evt.stopPropagation()
  const target = evt.target as MaybeHTMLElement
  if (!target) return

  // Check if target was svg icon or button
  const isSvg = target.nodeName === "svg"

  // corresponding <ul> element relative to clicked button/folder
  const folderContainer = (
    isSvg
      ? // svg -> div.folder-container
        target.parentElement
      : // button.folder-button -> div -> div.folder-container
        target.parentElement?.parentElement
  ) as MaybeHTMLElement
  if (!folderContainer) return
  const childFolderContainer = folderContainer.nextElementSibling as MaybeHTMLElement
  if (!childFolderContainer) return

  childFolderContainer.classList.toggle("open")

  // Collapse folder container
  const isCollapsed = !childFolderContainer.classList.contains("open")
  setFolderState(childFolderContainer, isCollapsed)

  const currentFolderState = currentExplorerState.find(
    (item) => item.path === folderContainer.dataset.folderpath,
  )
  if (currentFolderState) {
    currentFolderState.collapsed = isCollapsed
  } else {
    currentExplorerState.push({
      path: folderContainer.dataset.folderpath as FullSlug,
      collapsed: isCollapsed,
    })
  }

  const stringifiedFileTree = JSON.stringify(currentExplorerState)
  // ==== patent-kb: 配额满时不得中断 nav 回调 ====
  try {
    localStorage.setItem("fileTree", stringifiedFileTree)
  } catch {
    // 目录展开状态丢失无妨；抛出则会中断本次 nav 中后续组件的初始化
  }
  // ==== /patent-kb ====
}

function createFileNode(currentSlug: FullSlug, node: FileTrieNode): HTMLLIElement {
  const template = document.getElementById("template-file") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const a = li.querySelector("a") as HTMLAnchorElement
  a.href = resolveRelative(currentSlug, node.slug)
  a.dataset.for = node.slug
  a.textContent = node.displayName

  if (currentSlug === node.slug) {
    a.classList.add("active")
  }

  return li
}

function createFolderNode(
  currentSlug: FullSlug,
  node: FileTrieNode,
  opts: ParsedOptions,
): HTMLLIElement {
  const template = document.getElementById("template-folder") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const folderContainer = li.querySelector(".folder-container") as HTMLElement
  const titleContainer = folderContainer.querySelector("div") as HTMLElement
  const folderOuter = li.querySelector(".folder-outer") as HTMLElement
  const ul = folderOuter.querySelector("ul") as HTMLUListElement

  const folderPath = node.slug
  folderContainer.dataset.folderpath = folderPath

  if (currentSlug === folderPath) {
    folderContainer.classList.add("active")
  }

  if (opts.folderClickBehavior === "link") {
    // Replace button with link for link behavior
    const button = titleContainer.querySelector(".folder-button") as HTMLElement
    const a = document.createElement("a")
    a.href = resolveRelative(currentSlug, folderPath)
    a.dataset.for = folderPath
    a.className = "folder-title"
    a.textContent = node.displayName
    button.replaceWith(a)
  } else {
    const span = titleContainer.querySelector(".folder-title") as HTMLElement
    span.textContent = node.displayName
  }

  // 折叠判定优先级：localStorage 保存态（已并入 currentExplorerState）> openLevels 默认规则
  const isCollapsed =
    currentExplorerState.find((item) => item.path === folderPath)?.collapsed ??
    defaultCollapsed(folderPath, opts)

  // if this folder is a prefix of the current path we
  // want to open it anyways
  const simpleFolderPath = simplifySlug(folderPath)
  const folderIsPrefixOfCurrentSlug =
    simpleFolderPath === currentSlug.slice(0, simpleFolderPath.length)

  if (!isCollapsed || folderIsPrefixOfCurrentSlug) {
    folderOuter.classList.add("open")
  }

  for (const child of node.children) {
    const childNode = child.isFolder
      ? createFolderNode(currentSlug, child, opts)
      : createFileNode(currentSlug, child)
    ul.appendChild(childNode)
  }

  return li
}

async function setupExplorer(currentSlug: FullSlug) {
  const allExplorers = document.querySelectorAll("div.explorer") as NodeListOf<HTMLElement>

  for (const explorer of allExplorers) {
    const dataFns = JSON.parse(explorer.dataset.dataFns || "{}")
    const opts: ParsedOptions = {
      folderClickBehavior: (explorer.dataset.behavior || "collapse") as "collapse" | "link",
      folderDefaultState: (explorer.dataset.collapsed || "collapsed") as "collapsed" | "open",
      useSavedState: explorer.dataset.savestate === "true",
      openLevels: parseInt(explorer.dataset.openLevels ?? "0", 10) || 0,
      order: dataFns.order || ["filter", "map", "sort"],
      // ==== patent-kb: 见文件末尾 sortNodes / keepNode 的说明 ====
      sortFn: sortNodes,
      filterFn: keepNode,
      mapFn: () => {},
      // ==== /patent-kb ====
    }

    // Get folder state from local storage
    // ==== patent-kb: 被污染的 localStorage 不得让整棵目录树消失 ====
    // 原为裸 JSON.parse，抛出即中断 setupExplorer，左侧目录整体不渲染。
    const storageTree = localStorage.getItem("fileTree")
    let serializedExplorerState: FolderState[] = []
    if (storageTree && opts.useSavedState) {
      try {
        const parsed = JSON.parse(storageTree)
        if (Array.isArray(parsed)) serializedExplorerState = parsed
      } catch {
        // 解析失败按「无保存状态」处理，目录树仍以默认展开态正常渲染
      }
    }
    // ==== /patent-kb ====
    const oldIndex = new Map<string, boolean>(
      serializedExplorerState.map((entry: FolderState) => [entry.path, entry.collapsed]),
    )

    const data = await fetchData
    const entries = [...Object.entries(data)] as [FullSlug, ContentDetails][]
    const trie = FileTrieNode.fromEntries(entries)

    // Apply functions in order
    for (const fn of opts.order) {
      switch (fn) {
        case "filter":
          if (opts.filterFn) trie.filter(opts.filterFn)
          break
        case "map":
          if (opts.mapFn) trie.map(opts.mapFn)
          break
        case "sort":
          if (opts.sortFn) trie.sort(opts.sortFn)
          break
      }
    }

    // Get folder paths for state management
    const folderPaths = trie.getFolderPaths()
    // 初始态优先级（F5）：有保存态用保存态；无保存态按 openLevels 规则
    currentExplorerState = folderPaths.map((path) => {
      const previousState = oldIndex.get(path)
      return {
        path,
        collapsed: previousState === undefined ? defaultCollapsed(path, opts) : previousState,
      }
    })

    const explorerUl = explorer.querySelector(".explorer-ul")
    if (!explorerUl) continue

    // Create and insert new content
    const fragment = document.createDocumentFragment()
    for (const child of trie.children) {
      const node = child.isFolder
        ? createFolderNode(currentSlug, child, opts)
        : createFileNode(currentSlug, child)

      fragment.appendChild(node)
    }
    explorerUl.insertBefore(fragment, explorerUl.firstChild)

    // ==== patent-kb: 目录自动定位（v6，替换上游死代码）====
    // 上游缺陷：`if (scrollTop)` 对字符串 "0" 恒真，首次 prenav 写入后
    // scrollIntoView 分支永不执行；且 scrollIntoView 未限定滚动容器，
    // 会连带滚动整个文档。策略：①先恢复上次滚动位置（保留用户在长树中
    // 的浏览位置）；②当前项已完整可见则不动（不与用户手动滚动打架）；
    // ③不可见才把内层滚动器 scrollTop 置为居中值。
    // 同步执行（getBoundingClientRect 强制布局），不用 rAF——后台标签页 /
    // 最小化的 Electron 窗口中 rAF 被完全挂起，定位将永不执行。
    // 若此刻容器尚不可滚（初载视口未布局 innerWidth=0，同上游 F5 复位注释
    // 所述场景），挂起定位，待布局就绪的 resize 补执行。
    {
      const scroller = explorerUl as HTMLElement
      const saved = sessionStorage.getItem("explorerScrollTop")
      if (saved !== null) {
        scroller.scrollTop = parseInt(saved, 10) || 0
      }
      if (scroller.scrollHeight > scroller.clientHeight) {
        explorerLocatePending = false
        locateExplorerActive(scroller)
      } else {
        explorerLocatePending = true
      }

      // 滚动边缘渐隐（P7）：顶/底遮罩随滚动位置显隐（样式见 custom.scss）
      const edgeHost = scroller.closest(".explorer-content") as HTMLElement | null
      if (edgeHost) {
        const edge = () => {
          edgeHost.toggleAttribute("data-edge-top", scroller.scrollTop > 2)
          edgeHost.toggleAttribute(
            "data-edge-bottom",
            scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2,
          )
        }
        scroller.addEventListener("scroll", edge, { passive: true })
        window.addCleanup(() => scroller.removeEventListener("scroll", edge))
        edge()
      }
    }
    // ==== /patent-kb ====

    // Set up event handlers
    const explorerButtons = explorer.getElementsByClassName(
      "explorer-toggle",
    ) as HTMLCollectionOf<HTMLElement>
    for (const button of explorerButtons) {
      button.addEventListener("click", toggleExplorer)
      window.addCleanup(() => button.removeEventListener("click", toggleExplorer))
    }

    // Set up folder click handlers
    if (opts.folderClickBehavior === "collapse") {
      const folderButtons = explorer.getElementsByClassName(
        "folder-button",
      ) as HTMLCollectionOf<HTMLElement>
      for (const button of folderButtons) {
        button.addEventListener("click", toggleFolder)
        window.addCleanup(() => button.removeEventListener("click", toggleFolder))
      }
    }

    const folderIcons = explorer.getElementsByClassName(
      "folder-icon",
    ) as HTMLCollectionOf<HTMLElement>
    for (const icon of folderIcons) {
      icon.addEventListener("click", toggleFolder)
      window.addCleanup(() => icon.removeEventListener("click", toggleFolder))
    }
  }
}

document.addEventListener("prenav", async () => {
  // save explorer scrollTop position
  const explorer = document.querySelector(".explorer-ul")
  if (!explorer) return
  sessionStorage.setItem("explorerScrollTop", explorer.scrollTop.toString())
})

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const currentSlug = e.detail.url
  await setupExplorer(currentSlug)

  // if mobile hamburger is visible, collapse by default
  for (const explorer of document.getElementsByClassName(
    "explorer",
  ) as HTMLCollectionOf<HTMLElement>) {
    const mobileExplorer = explorer.querySelector(".mobile-explorer")
    if (!mobileExplorer) return

    if (mobileExplorer.checkVisibility()) {
      // 记下"自动折叠"标记：Electron/预览壳首次 nav 时窗口可能尚未布局
      //（innerWidth=0，$mobile 误判成立）——布局就绪或 resize 后经
      // expandDesktopExplorers 复位，用户手动折叠（toggleExplorer）不受影响
      explorer.classList.add("collapsed")
      explorer.dataset.autoCollapsed = "true"
      explorer.setAttribute("aria-expanded", "false")

      // Allow <html> to be scrollable when mobile explorer is collapsed
      document.documentElement.classList.remove("mobile-no-scroll")
    } else {
      // 桌面端（汉堡钮不可见，F5/根级折叠核查）：根级强制展开——
      // 清掉任何残留的 collapsed class（.explorer.collapsed 会把左栏压成 1.2rem 空条），
      // 并把 aria-expanded 归位 true；根级折叠态不落 localStorage，本分支不影响移动端行为
      explorer.classList.remove("collapsed")
      delete explorer.dataset.autoCollapsed
      explorer.setAttribute("aria-expanded", "true")
    }

    mobileExplorer.classList.remove("hide-until-loaded")
  }

  // 兜底再核一帧：首次 nav 若发生在窗口布局完成之前（视口宽度 0 被误判为移动端），
  // 布局就绪后立即把自动折叠的根级复位为展开
  requestAnimationFrame(expandDesktopExplorers)
})

/**
 * 桌面端根级复位（F5/根级折叠核查）：汉堡钮不可见（桌面宽度）且根级 collapsed
 * 是"自动折叠"（nav 时移动端分支所加，带 data-auto-collapsed 标记）时展开之。
 * 用户经 toggleExplorer 手动折叠的状态（标记已清）不受影响；移动端汉堡行为不变。
 */
function expandDesktopExplorers() {
  for (const explorer of document.getElementsByClassName(
    "explorer",
  ) as HTMLCollectionOf<HTMLElement>) {
    const mobileExplorer = explorer.querySelector(".mobile-explorer")
    if (!mobileExplorer) continue
    if (!mobileExplorer.checkVisibility() && explorer.dataset.autoCollapsed === "true") {
      explorer.classList.remove("collapsed")
      delete explorer.dataset.autoCollapsed
      explorer.setAttribute("aria-expanded", "true")
    }
  }
}

window.addEventListener("resize", function () {
  // 视口跨过桌面断点（或首次布局完成触发 resize）时复位自动折叠的根级
  expandDesktopExplorers()

  // patent-kb: 初载视口未布局导致的挂起定位，布局就绪后补执行一次
  if (explorerLocatePending) {
    const scroller = document.querySelector<HTMLElement>(".explorer-ul")
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      explorerLocatePending = false
      locateExplorerActive(scroller)
    }
  }

  // Desktop explorer opens by default, and it stays open when the window is resized
  // to mobile screen size. Applies `no-scroll` to <html> in this edge case.
  const explorer = document.querySelector(".explorer")
  if (explorer && !explorer.classList.contains("collapsed")) {
    document.documentElement.classList.add("mobile-no-scroll")
    return
  }
})

function setFolderState(folderElement: HTMLElement, collapsed: boolean) {
  return collapsed ? folderElement.classList.remove("open") : folderElement.classList.add("open")
}
