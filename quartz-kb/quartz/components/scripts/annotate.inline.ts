// 选中文本标注（v7 需求7）：复制 / 高亮 / 下划线 / 笔记。
//
// 渲染走 DOM 包裹（<mark class="kb-mark">）而非 CSS Custom Highlight API。
// 后者在 Electron 22（Chromium 108）上有两处硬伤：::highlight() 的
// text-decoration 要到 Chromium 118–121 才绘制，下划线做不出来；而该伪元素
// 又忽略 background-image，连伪下划线的退路也没有。另外笔记需要可点击的锚点，
// Highlight API 的 Range 挂不上事件。DOM 包裹三种标记同一条路径，样式也统一。
//
// 与 micromorph 的配合：prenav 先把标记全部解包，交给 morph 的永远是产物原样的
// 干净树；nav 后按新页重新锚定并包裹。二者顺序由 spa.inline.ts 保证。
import { computePosition, flip, inline, offset, shift } from "@floating-ui/dom"
import {
  invalidateBlocks,
  listBlocks,
  rangeFromSelector,
  selectorFromRange,
} from "./annotate-anchor"
import type { Annotation, ColorKey } from "./annotate-store"
import { applyImport, buildExport, load, loadAll, newId, save } from "./annotate-store"

const COLORS: { key: ColorKey; label: string }[] = [
  { key: "yellow", label: "黄" },
  { key: "green", label: "绿" },
  { key: "blue", label: "蓝" },
  { key: "pink", label: "粉" },
]

const SELECT_DEBOUNCE = 120
const MAX_SELECT_LEN = 2000

/** 正文容器：目录页是 .center > .popover-hint > article，故用后代选择器 */
function getArticle(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".center article")
}

/** 与 pageNav.inline.ts 同一套判定：这些浮层打开时不响应选区 */
function isBlocked(): boolean {
  return (
    document.querySelector(".search-container.active") !== null ||
    document.querySelector(".global-graph-outer.active") !== null ||
    document.documentElement.classList.contains("mobile-no-scroll")
  )
}

// ---------- 渲染：把一条标注包成若干 <mark> ----------

/** 收集 range 覆盖到的文本节点片段，逐段包裹（surroundContents 跨元素会抛错） */
function wrapRange(range: Range, anno: Annotation): void {
  const walker = document.createTreeWalker(
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? (range.commonAncestorContainer.parentNode as Node)
      : range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
  )
  const targets: Text[] = []
  let node = walker.nextNode() as Text | null
  while (node !== null) {
    if (range.intersectsNode(node) && (node.textContent?.length ?? 0) > 0) {
      targets.push(node)
    }
    node = walker.nextNode() as Text | null
  }

  for (const text of targets) {
    let piece = text
    // 首尾节点按选区边界切开，中间节点整段包
    if (piece === range.endContainer && range.endOffset < (piece.textContent?.length ?? 0)) {
      piece.splitText(range.endOffset)
    }
    if (piece === range.startContainer && range.startOffset > 0) {
      piece = piece.splitText(range.startOffset)
    }
    if ((piece.textContent?.length ?? 0) === 0) {
      continue
    }
    const mark = document.createElement("mark")
    mark.className = "kb-mark"
    mark.dataset.annoId = anno.id
    mark.dataset.kind = anno.kind
    mark.dataset.color = anno.color
    if (anno.note) {
      mark.dataset.hasNote = "1"
      mark.title = anno.note
    }
    piece.replaceWith(mark)
    mark.appendChild(piece)
  }
}

/** 节点所在的已有标记（自身或最近祖先） */
function markAt(node: Node | null): Element | null {
  if (node === null) {
    return null
  }
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return el?.closest("mark.kb-mark") ?? null
}

/**
 * 选区是否与已有标记相交。两种情形都要查：
 *   端点落在某个标记内部 —— 此时 cloneContents 里只有文本节点、没有 mark 元素；
 *   选区整个跨过某个标记 —— 此时端点在标记之外，须看克隆片段。
 */
function overlapsExisting(range: Range): boolean {
  if (markAt(range.startContainer) !== null || markAt(range.endContainer) !== null) {
    return true
  }
  return range.cloneContents().querySelector("mark.kb-mark") !== null
}

/** 解包全部标记，把 DOM 还原成产物原样 */
function unwrapAll(): void {
  for (const mark of Array.from(document.querySelectorAll<HTMLElement>("mark.kb-mark"))) {
    const parent = mark.parentNode
    if (!parent) {
      continue
    }
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark)
    }
    parent.removeChild(mark)
    parent.normalize()
  }
}

document.addEventListener("nav", () => {
  const article = getArticle()
  const toolbar = document.querySelector<HTMLElement>(".kb-anno-toolbar")
  const drawer = document.querySelector<HTMLElement>(".kb-anno-drawer")
  if (!article || !toolbar || !drawer) {
    return
  }
  // micromorph 原地改 DOM、复用同一个 article 元素，块列表缓存的键因而不变，
  // 内容却已是新页——每次 nav 先丢弃缓存，否则会按上一页的块去锚定
  invalidateBlocks(article)

  const slug = document.body.dataset.slug ?? ""
  let items: Annotation[] = load(slug)
  let pending: Range | null = null

  const orphans = new Set<string>()

  // ---------- 应用与刷新 ----------

  function applyAll(): void {
    unwrapAll()
    orphans.clear()
    // 同块内自后向前应用，避免先包的 mark 让后一条的偏移失效
    const ordered = items
      .slice()
      .sort(
        (a, b) =>
          b.selector.blockIndex - a.selector.blockIndex || b.selector.start - a.selector.start,
      )
    let healed = false
    for (const anno of ordered) {
      const hit = rangeFromSelector(article!, anno.selector)
      if (hit === null) {
        orphans.add(anno.id)
        continue
      }
      if (hit.moved) {
        Object.assign(anno.selector, hit.moved)
        healed = true
      }
      wrapRange(hit.range, anno)
    }
    // 自愈结果落盘：下次访问即回到 O(1) 的精确命中路径
    if (healed) {
      save(slug, items)
    }
    renderDrawer()
  }

  // ---------- 提示（非阻塞） ----------
  // 一律不用 alert/prompt：二者在桌面端会弹出原生模态框，打断阅读、抢走焦点，
  // 还会把选区一并清掉。提示就地显示在工具条内，两秒后自行消失。
  const tipBox = toolbar.querySelector<HTMLElement>(".kb-anno-tip")
  let tipTimer: ReturnType<typeof setTimeout> | undefined

  function tip(message: string): void {
    if (!tipBox) {
      return
    }
    tipBox.textContent = message
    tipBox.hidden = false
    toolbar!.hidden = false
    clearTimeout(tipTimer)
    tipTimer = setTimeout(() => {
      tipBox.hidden = true
      if (composeBox?.hidden !== false) {
        toolbar!.hidden = true
      }
    }, 2000)
  }

  function persist(): void {
    if (!save(slug, items)) {
      tip("本地存储已满，请先导出备份")
    }
  }

  // ---------- 工具条 ----------

  const composeBox = toolbar.querySelector<HTMLElement>(".kb-anno-compose")
  const noteInput = toolbar.querySelector<HTMLTextAreaElement>(".kb-anno-input")

  function closeCompose(): void {
    if (composeBox) {
      composeBox.hidden = true
    }
    if (noteInput) {
      noteInput.value = ""
    }
  }

  function hideToolbar(): void {
    toolbar!.hidden = true
    closeCompose()
    pending = null
  }

  async function showToolbarFor(range: Range): Promise<void> {
    pending = range
    toolbar!.hidden = false
    const rect = range.getBoundingClientRect()
    const virtual = {
      getBoundingClientRect: () => rect,
      getClientRects: () => range.getClientRects(),
    }
    const { x, y } = await computePosition(virtual, toolbar!, {
      strategy: "fixed",
      placement: "top",
      middleware: [offset(8), inline(), flip({ padding: 8 }), shift({ padding: 8 })],
    })
    toolbar!.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }

  function createFromPending(kind: Annotation["kind"], color: ColorKey, note: string): void {
    if (!pending) {
      return
    }
    // 重叠拒绝：叠加底色在中文小字上不可读，删除语义也会含混。
    // 须在 selectorFromRange 之前判——后者按块内偏移取文本，看不出重叠。
    if (overlapsExisting(pending)) {
      tip("该范围已有批注")
      return
    }
    const selector = selectorFromRange(article!, pending)
    if (selector === null) {
      tip("请在同一段落内选择")
      return
    }
    const now = new Date().toISOString()
    items = items.concat({
      id: newId(),
      slug,
      kind,
      color,
      note,
      selector,
      createdAt: now,
      updatedAt: now,
    })
    persist()
    hideToolbar()
    window.getSelection()?.removeAllRanges()
    applyAll()
  }

  function removeAnno(id: string): void {
    items = items.filter((a) => a.id !== id)
    persist()
    applyAll()
  }

  // ---------- 抽屉（本页批注列表 + 导出导入） ----------

  const listBox = drawer.querySelector<HTMLElement>(".kb-anno-list")

  function renderDrawer(): void {
    if (!listBox) {
      return
    }
    listBox.textContent = ""
    if (items.length === 0) {
      const empty = document.createElement("p")
      empty.className = "kb-anno-empty"
      empty.textContent = "本页暂无批注。选中正文中的文字即可高亮、划线或写笔记。"
      listBox.appendChild(empty)
      return
    }
    const ordered = items
      .slice()
      .sort(
        (a, b) =>
          a.selector.blockIndex - b.selector.blockIndex || a.selector.start - b.selector.start,
      )
    for (const anno of ordered) {
      const row = document.createElement("div")
      row.className = "kb-anno-row"
      row.dataset.annoRow = anno.id
      row.dataset.color = anno.color
      if (orphans.has(anno.id)) {
        row.dataset.orphan = "1"
      }
      const quote = document.createElement("p")
      quote.className = "kb-anno-quote"
      quote.textContent = anno.selector.exact
      row.appendChild(quote)
      if (anno.note) {
        const note = document.createElement("p")
        note.className = "kb-anno-note"
        note.textContent = anno.note
        row.appendChild(note)
      }
      if (orphans.has(anno.id)) {
        const warn = document.createElement("p")
        warn.className = "kb-anno-warn"
        warn.textContent = "原文已变动，无法定位（内容保留，可手动删除）"
        row.appendChild(warn)
      }
      const del = document.createElement("button")
      del.type = "button"
      del.className = "kb-anno-del"
      del.textContent = "删除"
      del.addEventListener("click", () => removeAnno(anno.id))
      row.appendChild(del)
      // 点击条目滚动到正文对应位置
      row.addEventListener("click", (e) => {
        if (e.target === del) {
          return
        }
        const mark = document.querySelector<HTMLElement>(`mark.kb-mark[data-anno-id="${anno.id}"]`)
        if (mark) {
          mark.scrollIntoView({ block: "center", behavior: "smooth" })
          mark.classList.add("is-flash")
          setTimeout(() => mark.classList.remove("is-flash"), 1200)
        }
      })
      listBox.appendChild(row)
    }
  }

  const drawerTipBox = drawer.querySelector<HTMLElement>(".kb-anno-drawer-tip")
  let drawerTipTimer: ReturnType<typeof setTimeout> | undefined

  function drawerTip(message: string): void {
    if (!drawerTipBox) {
      return
    }
    drawerTipBox.textContent = message
    drawerTipBox.hidden = false
    clearTimeout(drawerTipTimer)
    drawerTipTimer = setTimeout(() => {
      drawerTipBox.hidden = true
    }, 3000)
  }

  function doExport(): void {
    const all = loadAll()
    if (all.length === 0) {
      drawerTip("当前没有可导出的批注")
      return
    }
    const blob = new Blob([JSON.stringify(buildExport(all), null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `专利知识库-批注-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function doImport(file: File): void {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const result = applyImport(JSON.parse(String(reader.result)))
        items = load(slug)
        applyAll()
        // 跳过数须如实报出——静默丢弃条目会让用户以为导入完整
        const skippedNote = result.skipped > 0 ? `，跳过 ${result.skipped} 条格式不符的` : ""
        drawerTip(`导入完成：新增 ${result.added} 条，更新 ${result.updated} 条${skippedNote}`)
      } catch (err) {
        drawerTip(`导入失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    reader.onerror = () => drawerTip("读取文件失败")
    reader.readAsText(file)
  }

  // ---------- 事件绑定 ----------

  let selTimer: ReturnType<typeof setTimeout> | undefined
  const onSelectionChange = () => {
    clearTimeout(selTimer)
    selTimer = setTimeout(() => {
      if (isBlocked()) {
        hideToolbar()
        return
      }
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        hideToolbar()
        return
      }
      const range = sel.getRangeAt(0)
      const len = range.toString().length
      if (len === 0 || len > MAX_SELECT_LEN || !article!.contains(range.commonAncestorContainer)) {
        hideToolbar()
        return
      }
      void showToolbarFor(range)
    }, SELECT_DEBOUNCE)
  }

  // 按下工具条时阻止焦点转移，否则选区会被清空。
  // 笔记输入框例外——它需要拿到焦点才能打字。
  const onToolbarDown = (e: Event) => {
    if ((e.target as HTMLElement).closest(".kb-anno-input") === null) {
      e.preventDefault()
    }
  }

  const onToolbarClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
    if (!btn) {
      return
    }
    const act = btn.dataset.act
    if (act === "copy") {
      const text = pending?.toString() ?? ""
      // 剪贴板 API 需要用户手势；被拒时就地提示，不弹阻塞式对话框
      navigator.clipboard.writeText(text).then(
        () => {
          hideToolbar()
          window.getSelection()?.removeAllRanges()
        },
        () => tip("复制被浏览器拒绝，请手动复制"),
      )
      return
    }
    if (act === "underline") {
      createFromPending("underline", "blue", "")
      return
    }
    if (act === "note-cancel") {
      closeCompose()
      return
    }
    if (act === "note-save") {
      const note = noteInput?.value.trim() ?? ""
      if (note === "") {
        tip("笔记内容为空")
        return
      }
      createFromPending("note", "yellow", note)
      return
    }
    if (act === "note") {
      if (composeBox) {
        composeBox.hidden = false
        noteInput?.focus()
      }
      return
    }
    if (act === "color") {
      createFromPending("highlight", (btn.dataset.color as ColorKey) ?? "yellow", "")
    }
  }

  // 点击正文里已有的标记 → 打开抽屉并定位到该条（笔记全文在那里可读可改）。
  // 标记自身的 title 已带笔记内容，悬停即可速览。
  const onArticleClick = (e: Event) => {
    const mark = (e.target as HTMLElement).closest<HTMLElement>("mark.kb-mark")
    if (!mark) {
      return
    }
    drawer!.hidden = false
    renderDrawer()
    const row = drawer!.querySelector<HTMLElement>(`[data-anno-row="${mark.dataset.annoId}"]`)
    if (row) {
      row.scrollIntoView({ block: "nearest" })
      row.classList.add("is-active")
      setTimeout(() => row.classList.remove("is-active"), 1500)
    }
  }

  const fab = document.querySelector<HTMLElement>(".kb-anno-fab")
  const onFab = () => {
    drawer.hidden = !drawer.hidden
    if (!drawer.hidden) {
      renderDrawer()
    }
  }
  const closeBtn = drawer.querySelector<HTMLElement>(".kb-anno-close")
  const onClose = () => {
    drawer.hidden = true
  }
  // 标识符与选择器都避开小写「export」子串：inline 脚本装载器
  // （quartz/cli/handlers.js:274）对源码做无边界的 text.replace("export", "")，
  // 首个匹配无论出现在标识符还是字符串里都会被抹掉——曾因 exportBtn 被截成
  // Btn 而在运行期抛 ReferenceError。
  const dumpBtn = drawer.querySelector<HTMLElement>('[data-act="dump"]')
  const importInput = drawer.querySelector<HTMLInputElement>(".kb-anno-import")
  const onImportPick = () => {
    const file = importInput?.files?.[0]
    if (file) {
      doImport(file)
    }
    if (importInput) {
      importInput.value = ""
    }
  }

  // 笔记框内：⌘/Ctrl+Enter 保存，Esc 取消（阻止冒泡，免得 Esc 传到搜索模态）
  const onNoteKey = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) {
      return
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      const note = noteInput?.value.trim() ?? ""
      if (note === "") {
        tip("笔记内容为空")
        return
      }
      createFromPending("note", "yellow", note)
      return
    }
    if (e.key === "Escape") {
      e.stopPropagation()
      closeCompose()
    }
  }

  document.addEventListener("selectionchange", onSelectionChange)
  toolbar.addEventListener("mousedown", onToolbarDown)
  toolbar.addEventListener("click", onToolbarClick)
  noteInput?.addEventListener("keydown", onNoteKey)
  article.addEventListener("click", onArticleClick)
  fab?.addEventListener("click", onFab)
  closeBtn?.addEventListener("click", onClose)
  dumpBtn?.addEventListener("click", doExport)
  importInput?.addEventListener("change", onImportPick)

  // prenav 先解包，micromorph 拿到的永远是产物原样的干净树
  const onPrenav = () => unwrapAll()
  document.addEventListener("prenav", onPrenav, { once: true })

  window.addCleanup(() => {
    clearTimeout(selTimer)
    clearTimeout(tipTimer)
    clearTimeout(drawerTipTimer)
    document.removeEventListener("selectionchange", onSelectionChange)
    document.removeEventListener("prenav", onPrenav)
    toolbar.removeEventListener("mousedown", onToolbarDown)
    toolbar.removeEventListener("click", onToolbarClick)
    noteInput?.removeEventListener("keydown", onNoteKey)
    article.removeEventListener("click", onArticleClick)
    fab?.removeEventListener("click", onFab)
    closeBtn?.removeEventListener("click", onClose)
    dumpBtn?.removeEventListener("click", doExport)
    importInput?.removeEventListener("change", onImportPick)
    unwrapAll()
  })

  // 首屏同步应用一次（不经 rAF：后台标签页中 rAF 被挂起）
  void listBlocks
  void COLORS
  applyAll()
})
