// 图谱总览专页交互脚本（W3）：
// 1) 初始化：经 window.__graphRender（graph.inline.ts 暴露的渲染入口）在 .ge-canvas 上
//    渲染 depth:-1 全量图（nodeClickMode:"panel"），避免本脚本重复打包 d3/pixi；
// 2) 节点选中：监听 panel 模式图谱冒泡的 graphnodeselect 事件，取节点 slug 末段 id，
//    拉取 /static/content/{id}.json（Map 缓存）渲染右侧玻璃侧栏——
//    标题+面包屑 / 简介 / 详解 / 原文（折叠）/ 相关知识点 chips / 前往文档页；
// 3) 容器节点（slug 末段为 index，目录名"N-中文名"不含 id、无内容卡片可取）：
//    降级为“标题 + 目录级提示 + 子节点 chips（由 contentIndex links 推导）”；
// 4) 搜索定位：在 contentIndex 中前缀/包含匹配 title，命中后经 controller.focus
//    描边高亮 + 平移居中（不重建）；术语节点在 hidden 层时临时降为 dimmed 再定位；
//    目标不在数据集才回落到以命中 slug 为中心的重建渲染；
// 5) 术语层三态钮（隐藏/弱化/显示）→ controller.setTermLayer；重置视图 → controller.resetView；
// 6) SPA 生命周期：document "nav" 挂载、window.addCleanup 清理；themechange/resize
//    重渲染（V5-B：重建保持术语层模式，resize 另快照并恢复缩放平移）。
import type { ContentDetails } from "../../plugins/emitters/contentIndex"
import type { GraphController, SavedTransform } from "./graph.inline"
import type { TermLayerMode } from "../Graph"
import {
  FullSlug,
  SimpleSlug,
  getFullSlug,
  joinSegments,
  pathToRoot,
  resolveRelative,
  simplifySlug,
} from "../../util/path"

// ---------- 内容卡片数据结构（与 site 生成器产出的 /static/content/{id}.json 对齐，按需取用） ----------

/** 章节卡片的相关知识点条目 */
type RelatedEntry = { id: string; label: string; reason?: string }
/** 术语卡片的出处条目 */
type OccurrenceEntry = { nodeId: string; nodeLabel: string; breadcrumb?: string[] }
/** 术语卡片的关联术语条目 */
type RelatedTermEntry = { id: string; label: string; relation?: string }
/** 术语卡片的法条引用条目 */
type LawRefEntry = { lawKey?: string; fullCite?: string; nodeId?: string }

/** 内容卡片（章节与术语字段并集，均可缺省） */
type ContentCard = {
  id: string
  label?: string
  breadcrumb?: string[]
  // 章节字段
  brief?: string
  narrative?: Array<{ type?: string; text?: string }>
  related?: RelatedEntry[]
  original?: string
  // 术语字段
  definition?: string
  occurrences?: Record<string, OccurrenceEntry[]>
  laws?: LawRefEntry[]
  relatedTerms?: RelatedTermEntry[]
}

// 节点/卡片 id 白名单形状（law-01-01 / 01-01-01 / term-0028 等），拒绝异常载荷
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/

// 术语出处的 domain 键 → 工具书中文名（与内容仓库目录名对应）
const DOMAIN_NAMES: Record<string, string> = {
  "patent-law": "专利法",
  "implementation-rules": "实施细则",
  "examination-guideline": "审查指南",
  "infringement-guide": "侵权判定指南",
  "mechanical-drafting-rules": "机械撰写规范",
  "chemistry-drafting-rules": "化学撰写规范",
  "oa-response-guide": "答复审查意见指南",
}

// 相关知识点 chips 数量上限（术语出处可能很多，避免面板被 chips 淹没）
const MAX_CHIPS = 40

// 内容卡片缓存：id → Promise（去重并发请求；null 表示该 id 无卡片或请求失败）
const cardCache = new Map<string, Promise<ContentCard | null>>()

function fetchCard(id: string): Promise<ContentCard | null> {
  const cached = cardCache.get(id)
  if (cached) return cached
  // 相对路径取数（F9）：以当前页 slug 反推站点根，先例见 renderPage.tsx 的
  // contentIndexPath；绝对路径 /static/… 在子路径部署或 file:// 场景下会 404
  const url = joinSegments(
    pathToRoot(getFullSlug(window)),
    "static/content/" + encodeURIComponent(id) + ".json",
  )
  const p = fetch(url)
    .then((res) => (res.ok ? (res.json() as Promise<ContentCard>) : null))
    .catch(() => null)
  cardCache.set(id, p)
  return p
}

// ---------- slug / id 工具 ----------

/** SimpleSlug → FullSlug：容器（尾斜杠或根"/"）补 index，叶子原样 */
function toFullSlug(slug: SimpleSlug): FullSlug {
  if (slug === "/") return "index" as FullSlug
  if (slug.endsWith("/")) return `${slug}index` as FullSlug
  return slug as unknown as FullSlug
}

/** 是否容器节点（slug 以斜杠结尾，对应目录 index 页） */
function isContainerSlug(slug: SimpleSlug): boolean {
  return slug === "/" || slug.endsWith("/")
}

/** 取叶子 slug 的末段作为内容卡片 id */
function leafId(slug: SimpleSlug): string | null {
  const last = slug.split("/").pop() ?? ""
  return NODE_ID_RE.test(last) ? last : null
}

/**
 * 卡片内 id → 站内 FullSlug：
 * 1) 叶子：contentIndex 中末段 === id 直接命中；
 * 2) 容器：找末段以 "<id>-" 开头且层级差最小的后代叶子，向上剥目录得容器 …/index。
 */
async function resolveIdToFullSlug(id: string): Promise<FullSlug | null> {
  const data = await fetchData
  const slugs = Object.keys(data) as FullSlug[]

  for (const slug of slugs) {
    if (slug.split("/").pop() === id) return slug
  }

  const prefix = id + "-"
  const idDepth = id.split("-").length
  let best: { parts: string[]; extra: number } | null = null
  for (const slug of slugs) {
    const parts = slug.split("/")
    const last = parts[parts.length - 1]
    if (last === "index" || !last.startsWith(prefix)) continue
    const extra = last.split("-").length - idDepth
    if (extra >= 1 && (best === null || extra < best.extra)) {
      best = { parts, extra }
    }
  }
  if (best !== null) {
    const dirSlug = best.parts.slice(0, best.parts.length - best.extra).join("/")
    const indexSlug = `${dirSlug}/index` as FullSlug
    if (indexSlug in data) return indexSlug
  }
  return null
}

// ---------- DOM 构建小工具（一律 textContent 填充，不用 innerHTML 注入数据） ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// ---------- 主流程：每次 SPA 导航时挂载 ----------

document.addEventListener("nav", async () => {
  const explorer = document.querySelector(".graph-explorer") as HTMLElement | null
  if (!explorer) return

  const canvas = explorer.querySelector(".ge-canvas") as HTMLElement | null
  const panelEmpty = explorer.querySelector(".ge-panel-empty") as HTMLElement | null
  const panelContent = explorer.querySelector(".ge-panel-content") as HTMLElement | null
  const searchInput = explorer.querySelector(".ge-search-input") as HTMLInputElement | null
  const searchBtn = explorer.querySelector(".ge-search-btn") as HTMLButtonElement | null
  const searchStatus = explorer.querySelector(".ge-search-status") as HTMLElement | null
  const resetBtn = explorer.querySelector(".ge-reset") as HTMLButtonElement | null
  if (!canvas || !panelEmpty || !panelContent) return

  // v8：右侧栏未点击节点时整体隐藏，点击节点后显现
  const panelBox = panelContent!.closest(".ge-panel") as HTMLElement | null
  if (panelBox) panelBox.hidden = true

  // 宿主页自身的 FullSlug（0-图谱总览/index），作为全景渲染与相对路径解析的基准
  const hostSlug = getFullSlug(window)
  // 当前图谱渲染中心（重建兜底时会切到目标节点以获得高亮色）
  let centerSlug: FullSlug = hostSlug
  // 图渲染控制器（V4-B1 契约）：focus / setTermLayer / resetView / destroy
  let controller: GraphController | null = null
  let disposed = false

  // 术语层三态钮（GraphExplorer.tsx 工具条内 SSR 产出）
  const termButtons = Array.from(explorer.querySelectorAll<HTMLButtonElement>(".ge-term-btn"))

  /** 三态钮选中态与 controller 实际术语层模式对齐（重建后模式回落 data-cfg 默认，也经此同步） */
  function syncTermButtons() {
    const mode: TermLayerMode = controller?.getTermLayer() ?? "hidden"
    for (const btn of termButtons) {
      const active = btn.dataset.termMode === mode
      btn.classList.toggle("active", active)
      btn.setAttribute("aria-pressed", active ? "true" : "false")
    }
  }

  // （原 applyFullBleed 已移除：宿主页的宽度改由 graphexplorer.scss 的专属栅格
  //   承担——删掉空置的右栏网格列后，正文区本就铺满可用宽度，无需再用内联
  //   style.width 向右溢出。脚本与样式不再争夺同一属性。）

  // ---------- 域图例点击切换（v12） ----------
  // 七部文档域图例按钮（data-section = slug 顶层数字前缀）：点击切换
  // 该域全部节点与连接关系的隐藏/显示；状态在重建（themechange/resize/
  // 术语层 hidden）后经 renderCanvas 恢复。
  const legendButtons = Array.from(
    explorer.querySelectorAll<HTMLButtonElement>(".ge-legend-item[data-section]"),
  )
  const hiddenSections = new Set<string>()
  // 选中态（v14）：graphexplorer 侧持有，重建（theme/resize/术语层）后恢复
  let selectedSlug: SimpleSlug | null = null
  let selectedHops: 1 | 2 = 1

  function syncLegendButtons() {
    for (const btn of legendButtons) {
      const section = btn.dataset.section!
      const hidden = hiddenSections.has(section)
      btn.classList.toggle("hidden", hidden)
      btn.setAttribute("aria-pressed", String(!hidden))
    }
  }

  function applySectionHidden(section: string, hidden: boolean) {
    if (hidden) {
      hiddenSections.add(section)
    } else {
      hiddenSections.delete(section)
    }
    controller?.setSectionHidden(section, hidden)
    // v14：选中节点所在域被图例隐藏 → 清除选中态（节点不可见，闪烁无意义）
    if (hidden && selectedSlug !== null && selectedSlug.startsWith(section + "-")) {
      controller?.setSelected(null)
      selectedSlug = null
      showEmptyState()
    }
    syncLegendButtons()
  }

  for (const btn of legendButtons) {
    const toggle = () => {
      const section = btn.dataset.section!
      applySectionHidden(section, !hiddenSections.has(section))
    }
    btn.addEventListener("click", toggle)
    window.addCleanup?.(() => btn.removeEventListener("click", toggle))
  }
  syncLegendButtons()

  // ---------- 图谱渲染（复用 graph.inline.ts 暴露的入口） ----------
  // termOverride（V5-B BUG-1）：themechange/resize 重建路径传入上一实例的术语层
  // 模式，重建后不回落 data-cfg 默认（hidden）；未传时按 data-cfg 初始值渲染。
  // restoreTransform：resize 重建路径传入重建前的缩放平移快照，重建后恢复
  //（保持缩放级别与视野中心；focus 高亮不要求保留）。
  async function renderCanvas(
    slug: FullSlug,
    termOverride?: TermLayerMode,
    restoreTransform?: SavedTransform | null,
  ) {
    const render = window.__graphRender
    if (!render || disposed) return
    centerSlug = slug
    controller?.destroy()
    controller = null
    controller = await render(canvas!, slug, termOverride)
    if (restoreTransform) controller.applyTransform(restoreTransform)
    // 重建后恢复域隐藏状态（v12：themechange/resize 重建路径不丢图例状态）
    for (const s of hiddenSections) controller.setSectionHidden(s, true)
    // 重建后恢复选中态（v14）
    if (selectedSlug !== null) controller.setSelected(selectedSlug, selectedHops)
    // 重建后按 controller 实际术语层模式同步三态钮（传 termOverride 时不回落）
    syncTermButtons()
  }

  // ---------- 面板四段渲染 ----------

  /** 面包屑：以 slug 目录路径呈现（去掉末段叶子/index），保底显示根 */
  function buildBreadcrumb(slug: SimpleSlug): string {
    const parts = slug.split("/").filter((p) => p.length > 0)
    if (!isContainerSlug(slug)) parts.pop()
    return parts.length > 0 ? parts.join(" / ") : "知识库根目录"
  }

  function sectionHeading(text: string): HTMLElement {
    return el("h4", "ge-sec-title", text)
  }

  // 章节卡正文软上限：超过此字符数的部分收在「显示剩余 N 字」之后。
  // 实测 original 长度 p50=309、p90=3178、max=175236——90% 的节点一次直出无压力，
  // 余下 93 个长节点若全量直出会产生数万像素的滚动条。
  const ORIGINAL_SOFT_CAP = 4000

  /**
   * 把 original 全文切成可渲染的块。
   * 数据实测：段落以空行分隔、段内无单换行；234/1192 张卡含 markdown 标题行。
   */
  function splitOriginal(text: string): { tag: "h5" | "p"; text: string }[] {
    return text
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const head = /^#{1,6}\s+(.*)$/.exec(s)
        return head ? { tag: "h5" as const, text: head[1] } : { tag: "p" as const, text: s }
      })
  }

  /**
   * 章节卡正文：原「简介 / 详解 / 原文折叠」三段实为同一段文字的三次呈现
   * （narrative 归一后与 original 完全相同者占 80.4%，brief 是 original 前缀者
   * 占 63.2%），故合并为单段并直出 original，不再有折叠。
   */
  function buildOriginalSection(text: string): HTMLElement {
    const box = el("div", "ge-body-text")
    const blocks = splitOriginal(text)
    let used = 0
    let cut = blocks.length
    for (let i = 0; i < blocks.length; i++) {
      used += blocks[i].text.length
      if (used > ORIGINAL_SOFT_CAP && i > 0) {
        cut = i
        break
      }
    }
    const render = (b: { tag: "h5" | "p"; text: string }) =>
      el(b.tag, b.tag === "h5" ? "ge-body-sub" : undefined, b.text)
    for (const b of blocks.slice(0, cut)) box.appendChild(render(b))
    if (cut >= blocks.length) return box

    const restBlocks = blocks.slice(cut)
    const rest = el("div", "ge-body-rest")
    rest.hidden = true
    for (const b of restBlocks) rest.appendChild(render(b))
    const restChars = restBlocks.reduce((n, b) => n + b.text.length, 0)
    const more = el("button", "ge-body-more", `显示剩余 ${restChars} 字`)
    more.type = "button"
    more.addEventListener("click", () => {
      rest.hidden = false
      more.remove()
    })
    box.appendChild(more)
    box.appendChild(rest)
    return box
  }

  /** 相关知识点 chip：点击=派发新 graphnodeselect 刷新面板，并重渲染图谱高亮该节点 */
  function buildChip(label: string, hint: string | undefined, id: string): HTMLElement {
    const chip = el("button", "ge-chip", label)
    chip.type = "button"
    if (hint) chip.title = hint
    chip.addEventListener("click", async () => {
      const target = await resolveIdToFullSlug(id)
      if (target === null) {
        setStatus(`「${label}」暂未收录为独立页面`)
        return
      }
      void selectNode(target)
    })
    return chip
  }

  /** 容器子节点 chip：已知 SimpleSlug，直接定位 */
  function buildSlugChip(label: string, slug: SimpleSlug): HTMLElement {
    const chip = el("button", "ge-chip", label)
    chip.type = "button"
    chip.addEventListener("click", () => void selectNode(toFullSlug(slug)))
    return chip
  }

  /** 底部「前往文档页」按钮：SPA 跳转到该节点的文档页 */
  function buildGotoButton(target: FullSlug): HTMLElement {
    const wrap = el("div", "ge-goto")
    const btn = el("button", "ge-goto-btn", "前往文档页 →")
    btn.type = "button"
    btn.addEventListener("click", () => {
      const url = resolveRelative(hostSlug, target)
      window.spaNavigate(new URL(url, window.location.toString()))
    })
    wrap.appendChild(btn)
    return wrap
  }

  function showPanelDom(nodes: HTMLElement[]) {
    panelEmpty!.hidden = true
    panelContent!.hidden = false
    panelContent!.replaceChildren(...nodes)
    panelContent!.scrollTop = 0
    // 面板本身是滚动容器，重置滚动位置
    const panel = panelContent!.closest(".ge-panel") as HTMLElement | null
    if (panel) {
      panel.hidden = false
      panel.scrollTop = 0
    }
  }

  function showEmptyState() {
    panelContent!.hidden = true
    panelContent!.replaceChildren()
    panelEmpty!.hidden = false
    // v8：未点击节点时右栏整体隐藏
    const panel = panelContent!.closest(".ge-panel") as HTMLElement | null
    if (panel) panel.hidden = true
  }

  function setStatus(text: string) {
    if (searchStatus) searchStatus.textContent = text
  }

  /** 容器节点降级面板：标题 + 目录级提示 + 子节点 chips（由 contentIndex links 推导） */
  function renderContainerPanel(
    slug: SimpleSlug,
    details: ContentDetails | undefined,
    data: Record<string, ContentDetails>,
  ) {
    const nodes: HTMLElement[] = []
    const title = details?.title ?? decodeURIComponent(slug)
    nodes.push(el("h3", "ge-title", title))
    nodes.push(el("nav", "ge-breadcrumb", buildBreadcrumb(slug)))
    nodes.push(
      el(
        "p",
        "ge-hint",
        "该节点为目录级页面，未生成独立内容卡片；可点击下方子节点继续浏览，或前往文档页查看完整列表。",
      ),
    )

    // 子节点 chips：取该 index 页 links 中位于本目录之下的条目（含子目录 index 与叶子）
    const links = details?.links ?? []
    const children = links.filter((l) => l !== slug && l.startsWith(slug))
    const chipSource = children.length > 0 ? children : links
    if (chipSource.length > 0) {
      nodes.push(sectionHeading("子节点"))
      const box = el("div", "ge-chips")
      for (const child of chipSource.slice(0, MAX_CHIPS)) {
        const childDetails = data[toFullSlug(child)]
        const label = childDetails?.title ?? decodeURIComponent(child)
        box.appendChild(buildSlugChip(label, child))
      }
      nodes.push(box)
    }

    nodes.push(buildGotoButton(toFullSlug(slug)))
    showPanelDom(nodes)
  }

  /** 术语出处统计（definition 为空时充当简介） */
  function occurrenceCount(card: ContentCard): number {
    let n = 0
    for (const list of Object.values(card.occurrences ?? {})) n += list.length
    return n
  }

  /**
   * 叶子节点面板。
   * 章节卡：标题面包屑 / 正文（original 直出）/ 相关知识点 chips
   * 术语卡：标题面包屑 / 释义 / 出处（可点击定位）/ 相关知识点 chips
   *
   * 章节卡原有的「简介 / 详解 / 原文折叠」三段已合并——三者内容高度重合
   * （详见 buildOriginalSection 注释），并排呈现等于同一段文字读三遍。
   */
  function renderCardPanel(
    slug: SimpleSlug,
    details: ContentDetails | undefined,
    card: ContentCard,
  ) {
    const isTerm = card.id.startsWith("term-")
    const nodes: HTMLElement[] = []

    // 段一：标题 + 面包屑
    nodes.push(el("h3", "ge-title", details?.title ?? card.label ?? card.id))
    nodes.push(el("nav", "ge-breadcrumb", buildBreadcrumb(slug)))

    if (isTerm) {
      // 术语卡无 original，保留「释义 + 出处」两段：出处是可点击的导航，不是正文复读
      nodes.push(sectionHeading("释义"))
      nodes.push(
        card.definition
          ? el("p", "ge-brief", card.definition)
          : el("p", "ge-brief", `本术语暂无独立释义，共出现于 ${occurrenceCount(card)} 处章节。`),
      )
      const detail = el("div", "ge-narrative")
      for (const [domain, entries] of Object.entries(card.occurrences ?? {})) {
        if (entries.length === 0) continue
        detail.appendChild(el("h5", "ge-occ-domain", DOMAIN_NAMES[domain] ?? domain))
        const ul = el("ul", "ge-occ-list")
        for (const entry of entries) {
          const li = el("li")
          const link = el("button", "ge-occ-link", entry.nodeLabel)
          link.type = "button"
          if (entry.breadcrumb && entry.breadcrumb.length > 0) {
            link.title = entry.breadcrumb.join(" / ")
          }
          link.addEventListener("click", async () => {
            const target = await resolveIdToFullSlug(entry.nodeId)
            if (target !== null) void selectNode(target)
          })
          li.appendChild(link)
          ul.appendChild(li)
        }
        detail.appendChild(ul)
      }
      if (detail.childNodes.length > 0) {
        nodes.push(sectionHeading("出处"))
        nodes.push(detail)
      }
    } else if (card.original) {
      // 章节卡：正文单段直出
      nodes.push(sectionHeading("正文"))
      nodes.push(buildOriginalSection(card.original))
    } else if (card.brief) {
      // 极少数无 original 的章节卡，回落到 brief
      nodes.push(sectionHeading("正文"))
      nodes.push(el("p", "ge-brief", card.brief))
    } else {
      nodes.push(el("p", "ge-brief ge-muted", "（本节暂无正文）"))
    }

    // 段五：相关知识点 chips（章节 related；术语 relatedTerms + laws + 出处节点，去重限量）
    const chips: HTMLElement[] = []
    const seen = new Set<string>()
    const pushChip = (id: string | undefined, label: string | undefined, hint?: string) => {
      if (!id || !label || seen.has(id) || !NODE_ID_RE.test(id)) return
      if (chips.length >= MAX_CHIPS) return
      seen.add(id)
      chips.push(buildChip(label, hint, id))
    }
    if (isTerm) {
      for (const t of card.relatedTerms ?? []) pushChip(t.id, t.label, t.relation)
      for (const law of card.laws ?? [])
        pushChip(law.nodeId, law.fullCite || law.lawKey || law.nodeId, "法条依据")
      for (const entries of Object.values(card.occurrences ?? {})) {
        for (const entry of entries) pushChip(entry.nodeId, entry.nodeLabel, "出处章节")
      }
    } else {
      for (const rel of card.related ?? []) pushChip(rel.id, rel.label, rel.reason)
    }
    if (chips.length > 0) {
      nodes.push(sectionHeading("相关知识点"))
      const box = el("div", "ge-chips")
      for (const chip of chips) box.appendChild(chip)
      nodes.push(box)
    }

    nodes.push(buildGotoButton(toFullSlug(slug)))
    showPanelDom(nodes)
  }

  /** 面板总入口：按 slug 分流容器/叶子；叶子取卡片失败时降级为容器式提示 */
  async function showPanel(slug: SimpleSlug) {
    const data = await fetchData
    const details = data[toFullSlug(slug)] as ContentDetails | undefined

    if (isContainerSlug(slug)) {
      renderContainerPanel(slug, details, data)
      return
    }

    const id = leafId(slug)
    const card = id !== null ? await fetchCard(id) : null
    if (disposed) return
    if (card !== null) {
      renderCardPanel(slug, details, card)
    } else {
      // 内容卡片缺失（如 /static/content 尚未同步）：给出可跳转的降级面板
      const nodes: HTMLElement[] = []
      nodes.push(el("h3", "ge-title", details?.title ?? decodeURIComponent(slug)))
      nodes.push(el("nav", "ge-breadcrumb", buildBreadcrumb(slug)))
      nodes.push(el("p", "ge-hint", "该节点暂无内容卡片数据，可前往文档页阅读全文。"))
      nodes.push(buildGotoButton(toFullSlug(slug)))
      showPanelDom(nodes)
    }
  }

  /**
   * 定位选中（F2）：刷新面板 + 图内定位。
   * 1) 优先 controller.focus（描边高亮 + 400ms 平移居中，不重建、保留当前布局）；
   * 2) focus 未命中且目标是术语节点（9- 前缀，默认被 termLayer:"hidden" 剔出数据集）：
   *    临时 setTermLayer("dimmed") 后重试 focus，并在状态条提示；
   * 3) 仍未命中才走原重建兜底（以目标为中心重渲染，目标获 --secondary 高亮色）。
   */
  async function selectNode(target: FullSlug) {
    const simple = simplifySlug(target)
    void showPanel(simple)
    if (controller !== null) {
      if (controller.focus(simple)) {
        // v14：定位成功 → 图内选中该节点（相关节点亮起闪烁）
        controller.setSelected(simple, 1)
        selectedSlug = simple
        selectedHops = 1
        return
      }
      if (simple.startsWith("9-")) {
        await controller.setTermLayer("dimmed")
        syncTermButtons()
        setStatus("已临时显示术语层")
        if (controller.focus(simple)) {
          controller.setSelected(simple, 1)
          selectedSlug = simple
          selectedHops = 1
          return
        }
      }
      // v12：目标节点所在文档域被图例隐藏——focus 必然未命中且重建后仍
      // 不可见（renderCanvas 会恢复域隐藏状态），直接提示，不做无意义重建
      const sectionMatch = simple.match(/^(\d+)-/)
      if (sectionMatch !== null && controller.getHiddenSections().has(sectionMatch[1])) {
        setStatus("该文档域已隐藏，请先在顶部图例中恢复显示")
        return
      }
    }
    // 重建兜底：以目标为中心重渲染，重建后由 renderCanvas 恢复选中态
    selectedSlug = simple
    selectedHops = 1
    void renderCanvas(target)
  }

  // ---------- 事件挂载 ----------

  // 图内点击：panel 模式的 graphnodeselect 自 canvas 冒泡至此。
  // v15 语义：单击不切换选中——相关节点/选中节点仅刷新右栏信息；
  // 暗色（非相关）节点单击不响应，须双击才显示信息与相关节点；
  // 空白点击（detail.slug === null）清除选中并隐藏面板
  const onNodeSelect = (ev: Event) => {
    const detail = (ev as CustomEvent<{ slug?: unknown; dbl?: unknown }>).detail
    if (!detail) return
    if (detail.slug === null) {
      controller?.setSelected(null)
      selectedSlug = null
      showEmptyState()
      return
    }
    if (typeof detail.slug !== "string") return
    const simple = simplifySlug(detail.slug as FullSlug)
    if (detail.dbl === true) {
      // 双击：切换选中到该节点（相关节点常亮），右栏显示其信息
      controller?.setSelected(simple, 1)
      selectedSlug = simple
      selectedHops = 1
      void showPanel(simple)
      return
    }
    // 单击：有选中且目标为暗色（非选中集）节点 → 不响应（须双击）
    if (selectedSlug !== null && controller !== null && !controller.isInSelectedSet(simple)) {
      return
    }
    // 单击选中节点/相关节点（或无选中时的任意节点）：仅刷新右栏，不切换选中
    void showPanel(simple)
  }
  explorer.addEventListener("graphnodeselect", onNodeSelect)

  // 搜索定位：contentIndex 中 title 前缀匹配优先、包含匹配次之，取第一命中
  async function locateByQuery() {
    const query = (searchInput?.value ?? "").trim()
    if (query.length === 0) return
    const data = await fetchData
    const entries = Object.entries(data) as Array<[FullSlug, ContentDetails]>
    // 排除宿主页自身与 tags 页
    const candidates = entries.filter(([slug]) => slug !== hostSlug && !slug.startsWith("tags/"))
    const hit =
      candidates.find(([, d]) => (d.title ?? "").startsWith(query)) ??
      candidates.find(([, d]) => (d.title ?? "").includes(query)) ??
      candidates.find(([slug]) => slug.includes(query))
    if (!hit) {
      setStatus(`未找到含「${query}」的节点`)
      return
    }
    setStatus(`已定位：${hit[1].title ?? hit[0]}`)
    void selectNode(hit[0])
  }
  const onSearchKey = (ev: KeyboardEvent) => {
    if (ev.key === "Enter") void locateByQuery()
  }
  const onSearchClick = () => void locateByQuery()
  searchInput?.addEventListener("keydown", onSearchKey)
  searchBtn?.addEventListener("click", onSearchClick)

  // 重置视图：controller.resetView 回全景（zoomToFit + 清 focus 高亮，不销毁不重建）
  // + 清空侧栏与状态；controller 缺失（渲染入口未就绪）时回落重建
  const onReset = () => {
    setStatus("")
    if (searchInput) searchInput.value = ""
    showEmptyState()
    // v14：重置同时清除选中态（恢复默认全景）
    controller?.setSelected(null)
    selectedSlug = null
    selectedHops = 1
    if (controller !== null) {
      controller.resetView()
    } else {
      void renderCanvas(hostSlug)
    }
  }
  resetBtn?.addEventListener("click", onReset)

  // 术语层三态钮：点击 → controller.setTermLayer（hidden↔其它内部重建但引用不变；
  // dimmed↔shown 仅改透明度），完成后同步选中态
  const onTermModeClick = async (ev: Event) => {
    const btn = ev.currentTarget as HTMLButtonElement
    const mode = btn.dataset.termMode as TermLayerMode | undefined
    if (mode === undefined || controller === null) return
    await controller.setTermLayer(mode)
    syncTermButtons()
  }
  for (const btn of termButtons) {
    btn.addEventListener("click", onTermModeClick)
  }

  // 主题切换：图内颜色为渲染时快照，需重渲染取新主题色；
  // 术语层模式随重建保持（BUG-1），三态钮不回落
  const onThemeChange = () => void renderCanvas(centerSlug, controller?.getTermLayer())
  document.addEventListener("themechange", onThemeChange)

  // 视口变化：按新尺寸重渲染（防抖）；
  // 重建前快照术语层模式与缩放平移（BUG-1），重建后恢复——缩放不重置
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const onResize = () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      const termMode = controller?.getTermLayer()
      const transform = controller?.getTransform() ?? null
      void renderCanvas(centerSlug, termMode, transform)
    }, 250)
  }
  window.addEventListener("resize", onResize)

  // ---------- 初始渲染 ----------
  await renderCanvas(hostSlug)

  // F8：JS 渲染成功（画布内已出现 canvas 元素）后隐藏生成器预置的降级告警段；
  // 告警段本体保留在产物 HTML 中，脚本未执行/渲染失败时仍然可见，充当兜底
  if (canvas.querySelector("canvas") !== null) {
    const fallbackNote = document.querySelector(
      'body[data-slug="0-图谱总览/index"] article > blockquote',
    ) as HTMLElement | null
    if (fallbackNote !== null) fallbackNote.hidden = true
  }

  // ---------- SPA 清理（下一次导航前由 spa.inline 统一调用） ----------
  window.addCleanup(() => {
    disposed = true
    clearTimeout(resizeTimer)
    explorer.removeEventListener("graphnodeselect", onNodeSelect)
    searchInput?.removeEventListener("keydown", onSearchKey)
    searchBtn?.removeEventListener("click", onSearchClick)
    resetBtn?.removeEventListener("click", onReset)
    for (const btn of termButtons) {
      btn.removeEventListener("click", onTermModeClick)
    }
    document.removeEventListener("themechange", onThemeChange)
    window.removeEventListener("resize", onResize)
    controller?.destroy()
    controller = null
  })
})
