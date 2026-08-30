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
// 5) 术语层三态钮（隐藏/弱化/显示）→ controller.setTermLayer；重置视图 → controller.resetView
//    （C-4 起重置一并回到「全部」标签态：恢复全部非术语组显示）；
// 5b) 国家/标签导航行（C-4）：点击某法域标签 → 非术语组按「全集 − groupsOfField(标签)」
//    批量 setSectionHidden；「全部」清空非术语组隐藏；标签高亮不另存状态，
//    由 hiddenSections 反解（空集 → 全部；恰为某标签的补集 → 该标签；
//    其余 → 自定义态，无标签高亮）；
// 5c) 标签层级化（阶段5.3 批 B2）：点标签时图例行同步收窄为「只列该法域的组」——
//    非本法域的图例钮以 hidden **属性**整体撤出行内（区别于组显隐的 .hidden 置灰**类**），
//    该呈现态存于模块级 activeFieldFilter，不参与 hiddenSections 与标签高亮反解；
// 5d) 标签联动重布局与术语过滤（阶段5.3 批 B3）：点标签时另做两件事——
//    controller.setTermFieldFilter(标签) 让术语层随法域收窄（术语的法域归属取自
//    出处索引），controller.relayoutVisible() 把可见子集就地收敛并重新入框
//    （「全部」则 restoreBaseLayout 回首帧基线）；两者内部已含入框，故不再叠加
//    resetView。单个图例钮 toggle 与扩展段控刻意**不动布局**（组级微调是增量操作，
//    每点一次就抖一次全图不可用）；
// 5e) 左栏目录联动（阶段5.3 批 B4 建立；阶段5.4 反转后仅剩单向）——
//    阶段5.4 反转：图谱页目录点击＝直达文档（跳转不再被取消），本模块的
//    「收 kb:graphlocate（目录 ⇒ 图谱定位）」监听随之撤销；搜索定位链路与
//    「发 kb:graphfield（图谱 ⇒ 目录）」过滤联动保留——applyField() 收尾与
//    「重置视图」各派发一次，载荷即当前标签（含哨兵 FIELD_ALL），由目录侧
//    把非本法域的 field 分支整支隐去；
// 5f) 目录导航抽屉（阶段5.7 波B）：画布左上角浮动抽屉，「法域 → 书 → 章 → 节」三层，
//    数据由 util/graphToc.ts 从 window.__graphIndex 折出（惰性：首次点开才建树与建 DOM），
//    点目录行 = selectNode(该目录 index 页)，与图内定位、搜索定位同一条语义；
//    域组被隐藏的行置灰但仍可点（走 selectNode 既有拒绝分支提示恢复方式），
//    置灰同步挂在 syncAll() 尾部（tocDirty 门控），钉住态存 localStorage；
// 6) SPA 生命周期：document "nav" 挂载、window.addCleanup 清理；themechange/resize
//    重渲染（V5-B：重建保持术语层模式；resize 与 themechange 均快照并恢复缩放平移，
//    themechange 另走交叉淡入——新画布叠加淡入完成后才销毁旧实例）。
import type { GraphContentDetails } from "../../plugins/emitters/contentIndex"
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
import { GRAPH_SLUG } from "../../util/appPages"
import {
  GRAPH_FIELD_EVENT,
  resolveSingleClickAction,
  type GraphFieldDetail,
} from "../../util/graphInteraction"
// 域组表：零依赖共享模块（不经 graph.inline.ts 转出，避免把 d3/pixi 打进本包）
import {
  groupOfSlug,
  groupsOfField,
  EXT_GROUP_IDS,
  FIELD_ALL,
  FIELD_TABS,
  NON_TERM_GROUP_IDS,
  SECTION_GROUPS,
} from "../../util/graphSections"
// 目录抽屉数据层（波B-B1）：同为零运行期依赖的纯逻辑模块，与 graphSections 同规约
import { buildGraphToc, type TocEntry, type TocFieldNode } from "../../util/graphToc"

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

// 术语出处的 domain 键 → 工具书中文名（与内容仓库目录名对应）。
// 唯一用途：renderCardPanel 渲染术语卡「出处」列表的分组小标题（domain → 中文名），
// 数据源是构建期产出的静态卡片 /static/content/term-*.json（occurrences 字段），
// 与本模块的图谱节点渲染是两条独立链路，不受 excludeSlugs／SECTION_GROUPS 影响。
// ⚠️ mechanical-drafting-rules／chemistry-drafting-rules 两条目勿因阶段5.1
// 将「5-机械撰写规范」「6-化学撰写规范」从 SECTION_GROUPS 摘组、经
// appPages.GRAPH_HIDDEN_BOOKS 排出图谱节点数据集，就误判为死代码而删除——
// 已核实现存 term-*.json 中仍有 41／64 张术语卡片的 occurrences 命中这两个
// domain（这两部书的正文与术语出处索引并未随之删除，出处面板仍会展示其条目），
// 删除会导致这些卡片的出处小标题回落显示英文 domain 键而非中文书名，属可见的
// 体验回退。仅当术语出处数据管线（site/scripts，本批未改动）未来也停止收录
// 这两部书时，方可安全删除。
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

// 状态条消息自动消失窗口（阶段5.4）。用户反馈：提示不得驻留搜索框旁——
// 所有经 setStatus 写入的提示（搜索未命中/已定位/法域空术语/临时术语层等）
// 在 4s 后自动清空；新写入会撤销旧计时并重新起算，显式清空（重置视图）立即生效。
const STATUS_AUTO_CLEAR_MS = 4000

// themechange 重建防抖窗口（与 graph.inline.ts 的同名常量同值）：
// 设置页连点主题卡会连发 themechange，专页全量图重建代价高，只重建最后一次
const THEME_CHANGE_DEBOUNCE_MS = 120

// ---------- 扩展段规模文案（阶段5.3 批 B2：动态派生，根治滞后） ----------
// 「N 个扩展法域（M 部文献）」一律从 SECTION_GROUPS 运行期派生：
// N = tier === "ext" 的组数，M = 这些组 prefixes 长度合计。
// 此前两处写死「6 个扩展法域（80 部文献）」，在阶段5.1（摘组 + 新增组 15）与
// 阶段5.2（召回 main 5/6、新增域 91）两轮改组后双双滞后；改为派生后组表怎么变、
// 文案跟着变，不会有第三次。GraphExplorer.tsx 的段控 title 用同源派生（构建期算），
// 与本处同值——两侧都以组表为唯一事实源，不再各写各的数字。
const EXT_TIER_GROUPS = SECTION_GROUPS.filter((g) => g.tier === "ext")
const EXT_BOOK_COUNT = EXT_TIER_GROUPS.reduce((n, g) => n + g.prefixes.length, 0)
const EXT_SCALE_TEXT = `${EXT_TIER_GROUPS.length} 个扩展法域（${EXT_BOOK_COUNT} 部文献）`
/** 扩展段组号集合（tier === "ext" 派生），供图例过滤时区分主干段与扩展段 */
const EXT_GROUP_SET: ReadonlySet<string> = new Set(EXT_TIER_GROUPS.map((g) => g.id))

// ---------- 法域过滤状态（阶段5.3 批 B2） ----------
// 当前生效的法域标签：FIELD_ALL 表示不过滤，其余取 FIELD_TABS 中的法域名。
// 与 hiddenSections 的分工必须分清，二者正交、互不代偿：
//   hiddenSections    组的**图内**显隐（谁的节点还画在图上），标签高亮由它反解；
//   activeFieldFilter 图例行的**呈现**范围（谁的钮还列在图例里）＋（B3 起）术语层
//                     法域过滤与子集重布局的驱动源；不参与 activeField() 反解，
//                     故既有状态机语义一字未动。
// B3 起它有了第二个消费点：renderCanvas 的重建恢复段据它重放
// controller.setTermFieldFilter + relayoutVisible，selectNode 据它解释「术语不在
// 当前法域」。置于模块级正是为此——这些消费点不都在同一个挂载闭包的书写顺序内。
// ⚠️ 模块级变量跨 SPA 导航存活，而 hiddenSections 每次挂载新建为空集，
// 故每次 nav 挂载必须显式复位为 FIELD_ALL（见挂载处），否则会出现
// 「图例只剩商标一组、图上却全域可见」的失配。
let activeFieldFilter: string = FIELD_ALL

/**
 * 取图谱专用的四字段索引（阶段5.6 波2-2.1，产出见
 * plugins/emitters/contentIndex.tsx）。本文件的三个消费点（resolveIdToFullSlug /
 * showPanel / locateByQuery）只用 slug、title、links，全在四字段之内。
 *
 * window.__graphIndex 是与 graph.inline.ts 汇合的去重位：两者被分别独立打包，
 * 抽不出公共模块，故这三行在两处各写一份、共享同一个 Promise——图谱总览页同时
 * 加载两个脚本，若各 fetch 一次即多付一份 5.7MB 的解析。
 */
const graphIndex = (): Promise<GraphContentIndex> =>
  (window.__graphIndex ??= fetch(
    joinSegments(pathToRoot(getFullSlug(window)), "static/contentIndexGraph.json"),
  ).then((r) => r.json() as Promise<GraphContentIndex>))

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
  const data = await graphIndex()
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

  // v8：右侧栏未点击节点时整体隐藏，点击节点后显现。
  // ⚠️ 唯一写入口纪律（R4）的**唯一豁免**：本行是挂载时的初始态写入，不得改经
  // setPanelVisible——那个函数体里读 controller，而 `let controller` 声明在本行之下，
  // 此刻调用会踩 TDZ（ReferenceError 直接打死整个挂载闭包，图与目录全不出）。
  // 豁免无代价：此刻渲染实例尚未创建，初始尺寸由其构造期量测承接，无同步可言。
  const panelBox = panelContent!.closest(".ge-panel") as HTMLElement | null
  if (panelBox) panelBox.hidden = true

  // 宿主页自身的 FullSlug（0-图谱总览/index），作为全景渲染与相对路径解析的基准
  const hostSlug = getFullSlug(window)
  // 当前图谱渲染中心（重建兜底时会切到目标节点以获得高亮色）
  let centerSlug: FullSlug = hostSlug
  // 图渲染控制器（V4-B1 契约）：focus / setTermLayer / resetView / destroy
  let controller: GraphController | null = null
  let disposed = false
  // 重建在途标志（阶段5.10 波A 步5）：renderCanvas 的 await 期间为真。
  // 期间容器尺寸的变化不必也不该走 syncSize——新实例的构造期量测本就现取容器尺寸，
  // 而 controller 此刻指向的是即将退场（或尚未装上）的实例。A.2 会把它并入
  // 「请求 + 排水」的并发互斥结构，语义不变。
  let renderBusy = false

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

  // ---------- 域图例点击切换（v12 / v17） ----------
  // 域组图例按钮（data-section = util/graphSections.ts 的**组号**，非 slug 顶层
  // 数字前缀）：点击切换该组全部节点与连接关系的隐藏/显示；状态在重建
  //（themechange/resize/术语层 hidden）后经 renderCanvas 恢复。
  // 图例共 15 项，与 SECTION_GROUPS 的 15 个组一一对应：主干七书各一项、
  // 扩展法域 7 组各一项、术语 1 项。术语项是不可点的 span（由术语层三态钮控制，
  // data-section 只落在其色点上、不落在项本身），故下面的选择器只命中 14 枚按钮。
  const legendButtons = Array.from(
    explorer.querySelectorAll<HTMLButtonElement>(".ge-legend-item[data-section]"),
  )
  // 段分隔发丝线，SSR 顺序固定（GraphExplorer.tsx）：[0] 切「主干|扩展」，
  // [1] 切「扩展|术语」。B2 起随法域过滤结果一并决定去留，见 syncLegendButtons。
  const legendSeps = Array.from(
    explorer.querySelectorAll<HTMLElement>(".ge-legend > .ge-legend-sep"),
  )
  const hiddenSections = new Set<string>()
  // B2：模块级的法域过滤态跨 SPA 导航存活，每次挂载显式复位，
  // 与本次新建的空 hiddenSections（即「全部」态）对齐
  activeFieldFilter = FIELD_ALL
  // 选中态（v14）：graphexplorer 侧持有，重建（theme/resize/术语层）后恢复。
  // 阶段5.10 波C-b：单值 selectedSlug 升为**锚点集合**，供目录复选框多选。
  // 一切增删必经 commitSelection（本文件的唯一写入口），散着写 add/delete 必然
  // 漏掉「目录勾选态回写 / 清空钮计数 / 右栏形态」三件配套事项之一。
  const selectedAnchors = new Set<SimpleSlug>()
  let selectedHops: 1 | 2 = 1
  /**
   * 锚点数上限。取 12 的依据：
   * ① 高亮成本——每个锚点带一跳邻域，12 个锚点的并集在全量图上约占 4–6% 节点，
   *    再多则「常亮」与「变暗」的对比消失，多选反而看不清；
   * ② canRasterizeLabel 对锚点破例放行标签光栅化，破例数须有界（graph.inline.ts
   *    同名常量是渲染层兜底，两处字面量同值）；
   * ③ 右栏 chips 一屏放得下 12 枚，不必再加滚动。
   */
  const MAX_SELECTED_ANCHORS = 12
  /**
   * 「锚点集合变过、但 UI 尚未回写」的脏位。批量路径（法域标签一次切 15 组）
   * 每组都可能剔掉几个锚点，逐次回写右栏会排出十几次异步面板渲染、还可能后发先至；
   * 故批量路径一律 commitSelection(..., { ui: "defer" }) 只改集合与渲染器，
   * 由收尾的 syncAll() → flushSelectionUi() 统一补一次。
   */
  let selectionDirty = false

  /**
   * 图例项状态回写，两个正交维度同处一函数：
   *   ① 组显隐（hiddenSections）→ `.hidden` **类**：钮仍在行内，画成置灰删除线态；
   *   ② 法域过滤（activeFieldFilter，B2）→ `hidden` **属性**：钮整个撤出图例行。
   * 二者互不干涉：被 ① 置灰的组照样可被 ② 撤下，反之亦然；单个图例钮 toggle 组显隐
   * 的行为一字未改（被 ② 撤下的钮既不可见也不可点，无须另设守卫）。
   * 顺带按过滤结果决定「扩展」段控与两条段分隔线的去留（理由见函数末注释）。
   */
  function syncLegendButtons() {
    // FIELD_ALL（含挂载初始态）→ null，即不过滤，与 B2 之前的行为逐字等价
    const inField =
      activeFieldFilter === FIELD_ALL ? null : new Set(groupsOfField(activeFieldFilter))
    let mainShown = 0
    let extShown = 0
    for (const btn of legendButtons) {
      const groupId = btn.dataset.section!
      const hidden = hiddenSections.has(groupId)
      btn.classList.toggle("hidden", hidden)
      btn.setAttribute("aria-pressed", String(!hidden))
      const outOfField = inField !== null && !inField.has(groupId)
      btn.hidden = outOfField
      if (outOfField) continue
      if (EXT_GROUP_SET.has(groupId)) extShown++
      else mainShown++
    }
    // 「扩展」段控：当前法域下一个 ext 组都不剩时随之撤下（FIELD_ALL 恒显）。
    // 现有六法域各自都含至少一个 ext 组，故该条件当下恒为假；保留是为将来新增
    // 纯主干法域时不必回头补逻辑。段控的三态类与 title 仍由 syncGroupCtl 写。
    if (groupCtl) groupCtl.hidden = extShown === 0
    // 段分隔发丝线：只在其两侧都还有可见项时保留，否则会在行首留下一条悬空竖线
    //（切到「商标」「著作权」等不含主干组的法域时，主干段被整段撤空，正是此情形）。
    // [1] 切「扩展|术语」，术语项恒显，故只看 ext 侧。
    if (legendSeps[0]) legendSeps[0].hidden = mainShown === 0 || extShown === 0
    if (legendSeps[1]) legendSeps[1].hidden = extShown === 0
  }

  /**
   * 单组显隐落地，**不触发任何 UI 同步**：更新集合 → 通知渲染器 → 必要时清选中。
   * 批量路径（扩展段控、标签行）循环调用本函数后统一 syncAll() 一次，
   * 避免 13 次单组切换触发 13 轮全量 UI 回写。
   */
  function setSectionHiddenRaw(groupId: string, hidden: boolean) {
    if (hidden) {
      hiddenSections.add(groupId)
    } else {
      hiddenSections.delete(groupId)
    }
    controller?.setSectionHidden(groupId, hidden)
    // v14/v17：选中节点所在**域组**被图例隐藏 → 清除该锚点（节点不可见，闪烁无意义）。
    // C-4：标签切换走的也是本函数，故「切标签把选中节点所在组切没了」自动等价处理。
    // 波C-b：由「整批清空」改为**按谓词剔除子集**——多选下另外几个锚点可能落在
    // 仍然可见的域组里，把它们一并清掉等于让一次组隐藏吞掉用户其余的勾选。
    // ⚠️ 不得写 slug.startsWith(groupId + "-")：组号是分组标识、不是 slug 的
    // 字面前缀，组号 "10"（专利扩展）会误吞 slug "10-植物新品种纠纷解释/…"
    //（该目录前缀实属组号 "11" 品种布图），产生静默错判。必须经 groupOfSlug 归一后比对，
    // 该函数内的 /^(\d+)-/ 锚定到首个「-」，天然精确到目录号边界。
    // 回归断言见 quartz/util/graphSections.test.ts。
    if (hidden && selectedAnchors.size > 0) {
      const kept = Array.from(selectedAnchors).filter((s) => groupOfSlug(s) !== groupId)
      // UI 回写延后：批量路径（法域标签一次切 15 组）收尾由 syncAll() 统一补做
      if (kept.length !== selectedAnchors.size) commitSelection(kept, { ui: "defer" })
    }
  }

  /** 单组显隐 + UI 同步（图例项自身点击的入口） */
  function applySectionHidden(groupId: string, hidden: boolean) {
    setSectionHiddenRaw(groupId, hidden)
    syncAll()
  }

  for (const btn of legendButtons) {
    const toggle = () => {
      const groupId = btn.dataset.section!
      applySectionHidden(groupId, !hiddenSections.has(groupId))
    }
    btn.addEventListener("click", toggle)
    window.addCleanup?.(() => btn.removeEventListener("click", toggle))
  }

  // ---------- 扩展段总控（v17） ----------
  // 一次切换全部扩展法域组的显隐（规模见 EXT_SCALE_TEXT，从组表派生、不写死）：
  // 非全隐 → 全隐 → 全显。
  // 三态（全显 / 部分隐 / 全隐）由 syncGroupCtl 从 hiddenSections 与 EXT_GROUP_IDS
  // 的交集推导，单独点击某个扩展项后段控自动落到 partial，无需另存状态。
  const groupCtl = explorer.querySelector<HTMLButtonElement>(
    '.ge-legend-groupctl[data-section-group="ext"]',
  )

  function syncGroupCtl() {
    if (!groupCtl) return
    const hiddenCount = EXT_GROUP_IDS.filter((id) => hiddenSections.has(id)).length
    const allHidden = hiddenCount === EXT_GROUP_IDS.length
    groupCtl.classList.toggle("hidden", allHidden)
    groupCtl.classList.toggle("partial", hiddenCount > 0 && !allHidden)
    groupCtl.setAttribute("aria-pressed", String(!allHidden))
    // 文案中的组数与部数取 EXT_SCALE_TEXT（组表派生），与 SSR 的初始 title 同值；
    // 段控自身的 hidden 属性由 syncLegendButtons 按法域过滤结果写，此处不碰
    groupCtl.title = allHidden
      ? `点击恢复全部 ${EXT_SCALE_TEXT}`
      : `一次隐藏全部 ${EXT_SCALE_TEXT}，只留主干七书骨架`
  }

  if (groupCtl) {
    const toggleGroup = () => {
      const allHidden = EXT_GROUP_IDS.every((id) => hiddenSections.has(id))
      for (const id of EXT_GROUP_IDS) setSectionHiddenRaw(id, !allHidden)
      syncAll()
    }
    groupCtl.addEventListener("click", toggleGroup)
    window.addCleanup?.(() => groupCtl.removeEventListener("click", toggleGroup))
  }

  // ---------- 国家/标签层级导航行（C-4） ----------
  // 「中国 → 六法域标签」的第二级：标签是粗粒度导航（一次切一整片法域），
  // 图例行仍是组级微调，两者共写同一份 hiddenSections，故不另存标签状态——
  // 当前高亮哪枚标签一律由 hiddenSections 反解（activeField），
  // 从根上杜绝「标签记着 A、图例已被改成 B」的两处状态机漂移。
  // 术语组不属 NON_TERM_GROUP_IDS，标签切换永不触碰术语层三态钮。
  const fieldTabs = Array.from(explorer.querySelectorAll<HTMLButtonElement>(".ge-field-tab"))

  /** 当前被隐藏的非术语组**数量**（术语组由三态钮独管，不参与标签判定） */
  function hiddenNonTermCount(): number {
    return NON_TERM_GROUP_IDS.filter((id) => hiddenSections.has(id)).length
  }

  /**
   * 隐藏集 → 标签的反解，三态：
   *   空集              → FIELD_ALL（「全部」高亮）
   *   恰为某标签的补集  → 该标签高亮
   *   其余（图例微调后）→ null（自定义态，七枚标签均不高亮）
   */
  function activeField(): string | null {
    const hiddenCount = hiddenNonTermCount()
    if (hiddenCount === 0) return FIELD_ALL
    for (const field of FIELD_TABS) {
      const shown = groupsOfField(field)
      // 数量相等 + 该标签的组一个都没被隐藏 ⇒ 隐藏集恰等于该标签的补集
      if (hiddenCount !== NON_TERM_GROUP_IDS.length - shown.length) continue
      if (shown.every((id) => !hiddenSections.has(id))) return field
    }
    return null
  }

  function syncFieldTabs() {
    const active = activeField()
    for (const btn of fieldTabs) {
      // active 为 null（自定义态）时 dataset.field 不可能等于 null，天然全部落灰
      const on = btn.dataset.field === active
      btn.classList.toggle("active", on)
      btn.setAttribute("aria-pressed", String(on))
    }
  }

  /**
   * 全部 UI 状态的唯一同步入口：图例项 + 扩展段控 + 标签行 + 目录抽屉置灰。
   * 任何改动 hiddenSections 的路径收尾都必须调它（且只调它），四处状态由此同源。
   * 波B 追加的 syncTocDimmed 是目录置灰的**唯一**同步接口（内含 tocDirty 门控：
   * 抽屉关着只置脏、打开时补做），故目录不必再去订阅任何事件。
   */
  function syncAll() {
    syncLegendButtons()
    syncGroupCtl()
    syncFieldTabs()
    syncTocDimmed()
    // 波C-b：批量剔除锚点后的目录勾选态、清空钮计数与右栏形态在此统一补做
    //（脏位门控：集合没变过就一动不动，点图例钮不会把没受影响的右栏收掉）
    flushSelectionUi()
  }

  /**
   * 空域提示（B3）：切到某法域后，若术语层正在显示（dimmed/shown）而该法域一个
   * 术语都没有，明确告知原因——否则用户只看到「术语层开着却不见术语」，会当成缺陷。
   * 术语的法域归属取自**出处索引**（术语页自身的出处链接），现仅专利、商标两域有
   * 抽取产出（实测专利 852 / 商标 209 / 其余四域 0），故这条提示在著作权、竞争法、
   * 品种布图、综合程序四域恒会出现，属如实告知而非异常。
   * 术语层 hidden 时不提示：本就无术语可言，提示反而是噪音。
   * 走既有 .ge-search-status 通道，不新建提示通道——下次搜索/定位/重置自然覆盖。
   */
  function notifyEmptyTermField(field: string) {
    if (field === FIELD_ALL || controller === null) return
    if (controller.getTermLayer() === "hidden") return
    if (controller.getTermFieldCount(field) > 0) return
    setStatus(`「${field}」法域暂无术语（术语抽取现仅覆盖专利/商标两域）`)
  }

  /**
   * 切到某标签：hiddenSections = 非术语全集 − groupsOfField(field)，逐组落地。
   * field 传 FIELD_ALL 表示「全部」，等价于清空非术语组隐藏。
   * B2 起同时置 activeFieldFilter，使图例行收窄为只列该法域的组。
   * B3 起另联动两件事（见文件头 5d）：术语层随法域过滤 + 可见子集重布局。
   */
  function applyField(field: string) {
    const shown = new Set(field === FIELD_ALL ? NON_TERM_GROUP_IDS : groupsOfField(field))
    // 非法标签（组表未登记）不得把整图切空，直接忽略
    if (shown.size === 0) return
    // B2：图例过滤态与组显隐同批落地。刻意置于上面的合法性守卫**之后**——
    // 非法标签若也写进过滤态，会把图例行清空却不改任何组显隐，凭空造出新的失配态。
    activeFieldFilter = field
    for (const id of NON_TERM_GROUP_IDS) setSectionHiddenRaw(id, !shown.has(id))
    syncAll()
    // B3：术语过滤先于重布局——可见子集含哪些术语，决定收敛出的子集形状。
    // 「全部」还原全景基线（基线已收敛时往返零漂移，见 graph.inline.ts
    // restoreBaseLayout 注释），其余收拢可见子集；两者内部都已整图入框，
    // 故不再叠加 resetView（叠加会打断入框过渡）。
    if (field === FIELD_ALL) {
      controller?.setTermFieldFilter(null)
      controller?.restoreBaseLayout()
    } else {
      controller?.setTermFieldFilter(field)
      controller?.relayoutVisible()
    }
    // 锚点被本次过滤隐掉时逐个剔除：非术语节点的情形已由 setSectionHiddenRaw
    // 内的组比对处理，此处补的是**术语被法域过滤隐掉**的情形（术语组永不进
    // hiddenSections，那条路径覆盖不到），否则会留下「满屏变暗、却找不到高亮节点」
    // 的悬空选中态。波C-b：同样只剔不可见的那几个，可见的锚点原样保留。
    if (selectedAnchors.size > 0 && controller !== null) {
      const ctl = controller
      const kept = Array.from(selectedAnchors).filter((s) => ctl.isNodeVisible(s))
      if (kept.length !== selectedAnchors.size) commitSelection(kept, { ui: "defer" })
    }
    // 上面两段（组隐藏剔除在 setSectionHiddenRaw 内、法域过滤剔除在此）都只改集合，
    // UI 一次性在此补做——syncAll() 已在前面调过，故这里显式再冲一次脏位
    flushSelectionUi()
    notifyEmptyTermField(field)
    // B4：收尾广播给左栏目录树，使其只显示该法域的分支（FIELD_ALL 即恢复全显）。
    // 置于函数最末——图内状态（组显隐 / 术语过滤 / 布局 / 选中）全部落定后才对外
    // 宣告，目录侧收到时看到的必是终态；非法标签在上面的守卫处已 return，不会派发。
    notifyFieldChange(field)
  }

  /**
   * 法域标签广播（B4）。唯一派发点收敛在此函数，applyField 与 onReset 都经它，
   * 避免两处各写一遍 CustomEvent 构造。接收方与门控见 util/graphInteraction.ts。
   */
  function notifyFieldChange(field: string) {
    const detail: GraphFieldDetail = { field }
    document.dispatchEvent(new CustomEvent(GRAPH_FIELD_EVENT, { detail }))
  }

  for (const btn of fieldTabs) {
    const onFieldClick = () => {
      const field = btn.dataset.field
      if (field === undefined) return
      applyField(field)
    }
    btn.addEventListener("click", onFieldClick)
    window.addCleanup?.(() => btn.removeEventListener("click", onFieldClick))
  }

  // ---------- 目录导航抽屉（阶段5.7 波B-B4） ----------
  // 画布左上角的浮动抽屉，「法域 → 书 → 章 → 节」三层，点目录行等同 selectNode 定位。
  // 数据层在 util/graphToc.ts（纯逻辑、可单测），本节只管 DOM 与状态。
  //
  // 本节整体置于首次 syncAll() **之前**，是刻意的时序安排而非随手插入：syncAll 尾部
  // 已追加 syncTocDimmed()，而后者读 tocTree / tocOpen 两个闭包变量。若本节挪到
  // syncAll() 首调之后，那两个 let 尚在暂时性死区，首调即抛 ReferenceError——
  // 阶段5.3 批 B3 的 controller TDZ 缺陷正是同一形状（详见 smoke.cjs 步 29 的注释）。
  //
  // 惰性三级，抽屉不点则一分不付：
  //   ① 数据树在首次点开时才 buildGraphToc（实测约 3–6ms，输入是页面已解析完的
  //      window.__graphIndex，零额外网络）；
  //   ② DOM 首建只物化 6 法域行 + 83 书行 = 89 行（定案④：法域全展、书行全折）；
  //   ③ 章（1124）与节（82）的 DOM 在父行首次展开时才物化，展开态不持久化。
  // 三者合起来使「不用目录的用户」在首开路径上与波B 之前逐字等价。
  const TOC_PINNED_KEY = "graph-toc-pinned"

  /**
   * 钉住态读写一律 try/catch 兜底（先例见 graph.inline.ts 的 getVisited/addToVisited）：
   * localStorage 在隐私模式、配额写满或被扩展改写时会抛，而钉住只是一个体验偏好，
   * 读写失败退化为「本次不钉住」即可，不该让整个抽屉——乃至挂载回调后续的代码——挂掉。
   */
  function readTocPinned(): boolean {
    try {
      return localStorage.getItem(TOC_PINNED_KEY) === "true"
    } catch {
      return false
    }
  }

  function writeTocPinned(pinned: boolean) {
    try {
      if (pinned) localStorage.setItem(TOC_PINNED_KEY, "true")
      else localStorage.removeItem(TOC_PINNED_KEY)
    } catch {
      /* 偏好写入失败不影响本次会话内的钉住行为 */
    }
  }

  const tocToggle = explorer.querySelector<HTMLButtonElement>(".ge-toc-toggle")
  const tocDrawer = explorer.querySelector<HTMLElement>(".ge-toc-drawer")
  const tocPinBtn = explorer.querySelector<HTMLButtonElement>(".ge-toc-pin")
  const tocCloseBtn = explorer.querySelector<HTMLButtonElement>(".ge-toc-close")
  const tocClearBtn = explorer.querySelector<HTMLButtonElement>(".ge-toc-clear")
  const tocTreeBox = explorer.querySelector<HTMLElement>(".ge-toc-tree")

  // 全部目录状态放挂载闭包内（不放模块级）：模块级变量跨 SPA 导航存活，
  // 会把上一次挂载的树与 DOM 引用带到新页面上——activeFieldFilter 那条注释
  // 记的正是这类失配。钉住态是唯一需要跨导航保留的，走 localStorage 而非模块级变量。
  let tocTree: TocFieldNode[] | null = null
  let tocBuilding: Promise<void> | null = null
  let tocOpen = false
  // 置灰同步的脏位：抽屉关着时 syncAll 只置脏，打开时补做一次（关着的抽屉没有
  // 可见性可言，为它遍历 89–1200 行 DOM 是白付；打开时补做即可保证所见即所得）
  let tocDirty = false
  let tocPinned = readTocPinned()
  // 行/子容器 → 数据条目：折叠展开时据此惰性物化子层，不必把整棵树的 DOM 一次造完
  const tocEntryOf = new WeakMap<HTMLElement, TocEntry>()

  /** 造一行目录（书/章/节共用）。level 决定缩进：法域 0 / 书 1 / 章 2 / 节 3 */
  function buildTocRow(entry: TocEntry, level: number): HTMLElement {
    const row = el("div", "ge-toc-row")
    row.dataset.level = String(level)
    // ⚠️ data-group 必须取 buildGraphToc 里 groupOfSlug() 算出的组号，
    // 不得用 slug 的字面数字前缀——`10-植物新品种纠纷解释` 实属组 11（品种布图），
    // 字面前缀 10 是排序键、不是组号（教训见 util/graphSections.ts groupOfSlug 注释）。
    // 置灰判据与冒烟步 33-e 的断言都压在这个属性上。
    row.dataset.group = entry.group
    row.dataset.label = entry.title
    row.setAttribute("role", "treeitem")
    const hasKids = entry.children.length > 0
    const caret = el("button", hasKids ? "ge-toc-caret" : "ge-toc-caret ge-toc-caret--leaf")
    caret.type = "button"
    if (hasKids) {
      caret.setAttribute("aria-expanded", "false")
      caret.setAttribute("aria-label", `展开或折叠「${entry.title}」`)
    } else {
      // 叶行的 caret 只作等宽占位（visibility:hidden），不入 Tab 序、不报给读屏
      caret.tabIndex = -1
      caret.setAttribute("aria-hidden", "true")
    }
    // 多选复选框（波C-b）：紧随 caret、排在标题之前，形制与 caret 同宽等高，
    // 使三层缩进下的「三角 → 方框 → 文字」左缘始终对齐。
    // 只有书/章/节行有它——法域行（buildTocFieldBlock）不带 data-group、
    // 一个法域可横跨两组（商标＝组 8＋组 15），勾一个法域等于替用户批量决策，
    // 与「法域行只管折叠展开、不兼做过滤」是同一条纪律。
    const check = el("button", "ge-toc-check")
    check.type = "button"
    check.dataset.slug = entry.slug
    check.setAttribute("aria-pressed", "false")
    check.setAttribute("aria-label", `多选「${entry.title}」`)
    check.title = "加入多选高亮（Cmd/Ctrl 点标题同效；最多 12 个）"
    const link = el("button", "ge-toc-link", entry.title)
    link.type = "button"
    link.dataset.slug = entry.slug
    // 书名普遍二三十字，行内单行省略，全称由 title 承担（置灰时另附说明，见 applyTocDimmed）
    link.title = entry.title
    row.append(caret, check, link)
    if (hasKids) row.setAttribute("aria-expanded", "false")
    tocEntryOf.set(row, entry)
    return row
  }

  /** 一个条目的「行 + 子层容器」。子层容器建而不填，首次展开时才物化 */
  function buildTocBranch(entry: TocEntry, level: number): DocumentFragment {
    const frag = document.createDocumentFragment()
    frag.appendChild(buildTocRow(entry, level))
    if (entry.children.length > 0) {
      const kids = el("div", "ge-toc-children")
      kids.setAttribute("role", "group")
      kids.hidden = true
      kids.dataset.built = "0"
      kids.dataset.level = String(level + 1)
      tocEntryOf.set(kids, entry)
      frag.appendChild(kids)
    }
    return frag
  }

  /** 子层 DOM 物化（幂等）：把 entry.children 一次性铺进已有的空容器 */
  function materializeBranch(kids: HTMLElement) {
    if (kids.dataset.built === "1") return
    const entry = tocEntryOf.get(kids)
    if (entry === undefined) return
    const level = Number(kids.dataset.level ?? "1")
    const frag = document.createDocumentFragment()
    for (const child of entry.children) frag.appendChild(buildTocBranch(child, level))
    kids.appendChild(frag)
    kids.dataset.built = "1"
    // 刚落地的行还带着 buildTocRow 写下的初始态（未灰、未勾），须立刻回写现状——
    // 调用方 toggleTocBranch 收尾也会补一次，此处仍不省：materializeBranch 是
    // 「物化」这件事的唯一出口，把补做钉在出口上，将来多一个调用方也不会漏。
    applyTocRowState()
  }

  /**
   * 法域块：法域行 + 其下书行（书行随法域行一次性物化，定案④默认全展）。
   * 定案①：法域行只管折叠展开，另挂一枚**只读**计数徽标「N 部」，
   * 刻意不兼做过滤——过滤入口唯一是顶部法域标签行，给 hiddenSections 开第二条
   * 写入路径就等于再造一个状态机（图例行与标签行同源那条纪律的延伸）。
   * 法域行**不带 data-group**：一个法域可能横跨两组（商标 = 组 8 + 组 15），
   * 挂单值属性必然失真，置灰也就只作用在书/章/节行上。
   */
  function buildTocFieldBlock(node: TocFieldNode): DocumentFragment {
    const frag = document.createDocumentFragment()
    const row = el("div", "ge-toc-row ge-toc-row--field")
    row.dataset.level = "0"
    row.dataset.field = node.field
    row.setAttribute("role", "treeitem")
    row.setAttribute("aria-expanded", "true")
    const caret = el("button", "ge-toc-caret")
    caret.type = "button"
    caret.setAttribute("aria-expanded", "true")
    caret.setAttribute("aria-label", `展开或折叠「${node.field}」法域`)
    const label = el("span", "ge-toc-link", node.field)
    label.title = `「${node.field}」法域共 ${node.books.length} 部文献`
    const count = el("span", "ge-toc-count", `${node.books.length} 部`)
    row.append(caret, label, count)
    const kids = el("div", "ge-toc-children")
    kids.setAttribute("role", "group")
    kids.dataset.built = "1"
    kids.dataset.level = "1"
    for (const book of node.books) kids.appendChild(buildTocBranch(book, 1))
    frag.append(row, kids)
    return frag
  }

  /**
   * 置灰回写（定案②）：判据 = hiddenSections.has(row.dataset.group)。
   * 置灰行**不置 disabled、仍可点**——点击照常走 selectNode，由其既有拒绝分支
   * 在状态条写「该文档域已隐藏，请先切换顶部标签或在图例中恢复显示」。
   * 目录不自动反写过滤态：目录是导航，不是第二个过滤器。
   */
  function applyTocDimmed() {
    if (tocTreeBox === null) return
    tocDirty = false
    const rows = tocTreeBox.querySelectorAll<HTMLElement>(".ge-toc-row[data-group]")
    for (const row of Array.from(rows)) {
      const group = row.dataset.group
      if (group === undefined) continue
      const dim = hiddenSections.has(group)
      row.classList.toggle("ge-toc-row--dimmed", dim)
      const link = row.querySelector<HTMLElement>(".ge-toc-link")
      if (link === null) continue
      const label = row.dataset.label ?? link.textContent ?? ""
      link.title = dim ? `${label}（所属域组当前已隐藏，点击可查看恢复方式）` : label
    }
  }

  /**
   * 勾选态回写（波C-b）：判据 = selectedAnchors.has(该行 slug 归一后的 SimpleSlug)。
   * 复选框的 data-slug 存的是 FullSlug（与同行 .ge-toc-link 同源，便于点击时
   * 直接交给 selectNode），而锚点集合按 SimpleSlug 记账（图内节点 id 的口径），
   * 故此处逐行归一后比对，不在两侧各存一份 slug。
   */
  function applyTocSelected() {
    if (tocTreeBox === null) return
    const checks = tocTreeBox.querySelectorAll<HTMLElement>(".ge-toc-check[data-slug]")
    for (const check of Array.from(checks)) {
      const slug = check.dataset.slug
      if (slug === undefined || slug.length === 0) continue
      const on = selectedAnchors.has(simplifySlug(slug as FullSlug))
      check.setAttribute("aria-pressed", String(on))
      check.closest<HTMLElement>(".ge-toc-row")?.classList.toggle("ge-toc-row--selected", on)
    }
  }

  /**
   * 行级状态的两项回写成对执行：置灰（域显隐）与勾选（多选锚点）都只作用于
   * **DOM 里现存的行**，而树是惰性增长的——任何一次物化/展开之后两者都得补做，
   * 漏掉其一就会出现「灰了却没勾」或「勾了却没灰」的错位。
   */
  function applyTocRowState() {
    applyTocDimmed()
    applyTocSelected()
  }

  /**
   * 置灰同步的唯一对外接口，由 syncAll() 尾部调用。
   * 刻意**不订阅 GRAPH_FIELD_EVENT**：那个事件由本模块自己派发，在同一闭包内
   * 直连即可，订阅自发事件只是徒增一圈回路（还会与 applyField 的同步顺序纠缠）。
   */
  function syncTocDimmed() {
    if (tocTree === null || !tocOpen) {
      tocDirty = true
      return
    }
    applyTocRowState()
  }

  /** 抽屉头「清空(N)」钮：无选中时整枚撤下，有选中时显示当前锚点数 */
  function syncTocClear() {
    if (tocClearBtn === null) return
    const n = selectedAnchors.size
    tocClearBtn.hidden = n === 0
    tocClearBtn.textContent = `清空(${n})`
  }

  /** 首次点开才建树。返回同一个 Promise，重入不会建第二遍 */
  async function ensureTocBuilt(): Promise<void> {
    if (tocTreeBox === null || tocTree !== null) return
    if (tocBuilding !== null) return tocBuilding
    const box = tocTreeBox
    // await 期间抽屉不该是一片空白（图谱页此刻 __graphIndex 通常已 resolve，
    // 占位只会一闪而过；冷路径下它是唯一的「正在做事」信号）
    box.replaceChildren(el("div", "ge-toc-loading", "目录加载中…"))
    tocBuilding = (async () => {
      try {
        const index = await graphIndex()
        if (disposed) return
        const tree = buildGraphToc(index)
        const frag = document.createDocumentFragment()
        for (const node of tree) frag.appendChild(buildTocFieldBlock(node))
        box.replaceChildren(frag)
        tocTree = tree
        applyTocRowState()
      } catch {
        box.replaceChildren(el("div", "ge-toc-loading", "目录加载失败，可重新点开重试"))
      } finally {
        tocBuilding = null
      }
    })()
    return tocBuilding
  }

  // 钮上的文案与 GraphExplorer.tsx 的 SSR 初值同源（两处都是「常开」）：
  // 波C-c 把这枚钮的语义由「点目录项后不收起」扩为**常开锁**（鼠标移出也不收起），
  // 「钉住」已描述不了它，故文案随语义一并改。localStorage 键不动。
  function syncTocPin() {
    tocPinBtn?.setAttribute("aria-pressed", String(tocPinned))
    if (tocPinBtn !== null) {
      tocPinBtn.title = tocPinned
        ? "常开中：抽屉保持展开，点目录项与移开鼠标都不收起（下次进入本页仍展开）"
        : "常开：抽屉保持展开，鼠标移出也不自动收起（该选择会被记住）"
    }
  }

  /** 开合（定案③：开合本身不持久化，挂载时 open = pinned） */
  function setTocOpen(open: boolean) {
    tocOpen = open
    if (tocDrawer !== null) tocDrawer.hidden = !open
    tocToggle?.setAttribute("aria-expanded", String(open))
    if (tocToggle !== null) {
      tocToggle.title = open
        ? "收起目录导航"
        : "打开目录导航：按「法域 → 书 → 章 → 节」定位到图内节点"
    }
    if (!open) return
    // 不阻塞：抽屉立刻可见（首次是「加载中」占位），树建好后自行补上；
    // 关抽屉期间累积的置灰/勾选变更也在此补做一次
    void ensureTocBuilt().then(() => {
      if (tocDirty) applyTocRowState()
    })
  }

  /** 折叠展开一行（法域行与书/章行共用）：子层未物化则先物化 */
  function toggleTocBranch(row: HTMLElement) {
    const kids = row.nextElementSibling as HTMLElement | null
    if (kids === null || !kids.classList.contains("ge-toc-children")) return
    const willOpen = kids.hidden
    if (willOpen) materializeBranch(kids)
    kids.hidden = !willOpen
    row.setAttribute("aria-expanded", String(willOpen))
    row.querySelector(".ge-toc-caret")?.setAttribute("aria-expanded", String(willOpen))
    // 刚物化出来的章/节行要立刻带上当前的置灰与勾选态，否则会出现
    //「父书灰、子章亮」或「集合里有它、复选框却没勾」的错位
    if (willOpen) applyTocRowState()
  }

  // 树内一切点击走单一委托：树的 DOM 是惰性增长的，逐行绑定既要在物化时补绑、
  // 又要在清理时逐个解绑，委托一处即全覆盖。
  const onTocTreeClick = (ev: Event) => {
    const target = ev.target as HTMLElement | null
    if (target === null) return
    // 复选框分流排在**首位**：它嵌在行内，若让 link 分支先跑，点方框会被
    // closest('.ge-toc-link') 漏判成点标题（两者互不包含，但顺序仍以最具体者优先为准）
    const check = target.closest<HTMLElement>(".ge-toc-check[data-slug]")
    if (check !== null) {
      const slug = check.dataset.slug
      if (slug === undefined || slug.length === 0) return
      // 勾选只改高亮集合：不定位相机、不收起抽屉——用户正在连勾好几个
      toggleAnchor(simplifySlug(slug as FullSlug))
      return
    }
    const link = target.closest<HTMLElement>(".ge-toc-link[data-slug]")
    if (link !== null) {
      const slug = link.dataset.slug
      if (slug === undefined || slug.length === 0) return
      // Cmd/Ctrl + 点标题 ＝ 复选框的第二入口（用户拍板的双入口之一）：
      // 与勾选完全同义，同样不定位、不收起
      const mouse = ev as MouseEvent
      if (mouse.metaKey === true || mouse.ctrlKey === true) {
        toggleAnchor(simplifySlug(slug as FullSlug))
        return
      }
      // 图内定位语义完全复用 selectNode：相机 400ms 居中 + 选中高亮 + 右栏卡片；
      // 目标域组被隐藏时走它既有的拒绝分支写状态条（置灰行仍可点即为此）。
      void selectNode(slug as FullSlug)
      if (!tocPinned) setTocOpen(false)
      return
    }
    const caret = target.closest<HTMLElement>(".ge-toc-caret")
    if (caret !== null && !caret.classList.contains("ge-toc-caret--leaf")) {
      const row = caret.closest<HTMLElement>(".ge-toc-row")
      if (row !== null) toggleTocBranch(row)
      return
    }
    // 法域行整行可点即折叠展开（行内没有可定位的链接，点文字与点 caret 同义）
    const fieldRow = target.closest<HTMLElement>(".ge-toc-row--field")
    if (fieldRow !== null) toggleTocBranch(fieldRow)
  }

  const onTocToggleClick = () => setTocOpen(!tocOpen)
  const onTocCloseClick = () => setTocOpen(false)
  const onTocPinClick = () => {
    tocPinned = !tocPinned
    writeTocPinned(tocPinned)
    syncTocPin()
  }
  /** 「清空(N)」：一次清掉全部锚点（与点画布空白同义，只是不必先找到空白处） */
  const onTocClearClick = () => commitSelection([])

  tocToggle?.addEventListener("click", onTocToggleClick)
  tocCloseBtn?.addEventListener("click", onTocCloseClick)
  tocPinBtn?.addEventListener("click", onTocPinClick)
  tocClearBtn?.addEventListener("click", onTocClearClick)
  tocTreeBox?.addEventListener("click", onTocTreeClick)
  window.addCleanup?.(() => {
    tocToggle?.removeEventListener("click", onTocToggleClick)
    tocCloseBtn?.removeEventListener("click", onTocCloseClick)
    tocPinBtn?.removeEventListener("click", onTocPinClick)
    tocClearBtn?.removeEventListener("click", onTocClearClick)
    tocTreeBox?.removeEventListener("click", onTocTreeClick)
    // 数据树与未决的建树 Promise 一并置空：树体持有 1289 个条目对象，
    // 挂载闭包若因任何一处引用被延寿，置空能让这部分立刻可回收
    tocTree = null
    tocBuilding = null
  })

  syncTocPin()
  // 波C-b：锚点集合每次挂载新建为空（多选刻意不跨 SPA 导航存活——它是「本页这一次
  // 浏览」的临时视角，带过页去只会让人对着一屏高亮想不起为什么），故清空钮初始撤下
  syncTocClear()
  // 定案③：开合不持久化，挂载时 open = pinned——钉住的用户每次进本页即见展开的目录，
  // 未钉住的用户回到「收起态 + 一枚悬浮钮」，两者都无需再点一次
  if (tocPinned) setTocOpen(true)

  syncAll()

  // ---------- 图谱渲染（复用 graph.inline.ts 暴露的入口） ----------
  // termOverride（V5-B BUG-1）：themechange/resize 重建路径传入上一实例的术语层
  // 模式，重建后不回落 data-cfg 默认（hidden）；未传时按 data-cfg 初始值渲染。
  // restoreTransform：resize/themechange 重建路径传入重建前的缩放平移快照，重建后恢复
  //（保持缩放级别与视野中心；focus 高亮不要求保留）。
  // crossfade（J2）：仅 themechange 路径传 true——新画布叠在旧画布上淡入，
  // 旧实例后置到淡入收尾才销毁（先建后毁），消除重建间隙的空白帧与颜色硬切。
  // ---------- 重建并发互斥（阶段5.10 波A-A.2 / R6）----------
  // 改造前 renderCanvas 是「谁调谁自己 await」的裸异步函数，两次调用叠在一起就出事：
  //   ① prev 各自取到不同的 controller，先完成的那轮把后一轮的旧实例引用挤掉，
  //      旧实例失去引用却仍持有 pixi 实例与 rAF 循环（孤儿实例，GPU 纹理一路涨）；
  //   ② 后完成的那轮把先完成的实例覆盖掉，画布上留着已被摘出引用的那张 canvas，
  //      表现为「画布永久空白」；
  //   ③ 重建期间 controller 被置 null 长达 100–700ms，期间任何调度方读到的术语层
  //      是 undefined、相机是 null——术语层静默关闭 + 相机跳回全景。
  // 现在收敛成「请求 + 排水」：同一时刻只有一轮在跑，后到的请求覆盖排队位（中间态
  // 没有渲染价值，堆积只会排出一串必然被下一个顶掉的全量重建），且全程不置空 controller。
  type RenderRequest = {
    slug: FullSlug
    termOverride?: TermLayerMode
    restoreTransform?: SavedTransform | null
    crossfade: boolean
  }
  /** 单调自增的轮次号：await 返回后与当下轮次不一致即为陈旧轮，产物就地销毁 */
  let renderSeq = 0
  /** 排队位（只留最后一个请求，后到覆盖不堆积） */
  let renderQueued: RenderRequest | null = null
  /** 最近一次装机成功的良态值：controller 尚未装上（首帧前）时供调度方回落 */
  let lastTermMode: TermLayerMode | undefined
  let lastTransform: SavedTransform | null = null

  /**
   * 供重建调度方（themechange 等）读取「用户当下所见」的术语层与相机。
   * controller 在重建期间**不再被置空**，且它此刻指向的正是画面上那个旧实例，
   * 其值本身就是良态；仅当 controller 为 null（首帧尚未装上）才回落到记录值。
   */
  const goodTermMode = (): TermLayerMode | undefined => controller?.getTermLayer() ?? lastTermMode
  const goodTransform = (): SavedTransform | null => controller?.getTransform() ?? lastTransform

  function renderCanvas(
    slug: FullSlug,
    termOverride?: TermLayerMode,
    restoreTransform?: SavedTransform | null,
    crossfade = false,
  ): Promise<void> {
    return requestRender({ slug, termOverride, restoreTransform, crossfade })
  }

  /**
   * 当前排水链的「跑完」信号（不会 reject，仅供串行等待；渲染异常仍由发起方承担）。
   * 术语层切换是**另一条**重建路径（controller 内部销毁重建），与本路径共用同一个
   * 容器：两条交叠时，先跑那路的 removeAllChildren 清不到后跑那路刚插入的画布，
   * 容器里就会留下两张 canvas，旧的一张再无人移除（实测复现，见 A.2 验证记录）。
   */
  let renderIdle: Promise<unknown> = Promise.resolve()
  const whenRenderIdle = () => renderIdle
  /**
   * 术语层切换在途信号（同上，不 reject）：互斥必须**双向**，缺一即漏。
   * 实证（A.2 施工中复现）：先点术语钮、后到 themechange，两条路径各自
   * appendChild 一张画布，容器里留下两张、旧的那张再无人移除——单向等待挡不住
   * 这个次序，故 drainRender 每轮开工前同样等它。
   * 无死锁：术语侧在**发起前**捕获 renderIdle，渲染侧在 renderBusy 置位**之后**
   * 才等 termIdle，两边等的都是「对方已经在跑的那一轮」，不构成互等环。
   */
  let termIdle: Promise<unknown> = Promise.resolve()
  const whenTermIdle = () => termIdle

  async function requestRender(req: RenderRequest): Promise<void> {
    if (disposed) return
    // 已有一轮在跑：占住排队位即返回，由那一轮的排水循环接手
    if (renderBusy) {
      renderQueued = req
      return
    }
    const running = drainRender(req)
    renderIdle = running.catch(() => {})
    await running
  }

  /** 排水循环：一轮跑完立刻取排队位上的最后一个请求接着跑，跑空为止 */
  async function drainRender(first: RenderRequest): Promise<void> {
    let req: RenderRequest | null = first
    while (req !== null && !disposed) {
      const seq = ++renderSeq
      renderBusy = true
      try {
        // 反向互斥：术语层那条重建路径若在途，先等它落定再开工（理由见 termIdle）
        await whenTermIdle()
        await runRender(req, seq)
      } finally {
        renderBusy = false
      }
      req = renderQueued
      renderQueued = null
    }
  }

  async function runRender(req: RenderRequest, seq: number): Promise<void> {
    const { slug, termOverride, restoreTransform, crossfade } = req
    const render = window.__graphRender
    if (!render || disposed) return
    centerSlug = slug
    // prev 必须在 await **之前**同步取：await 之后再取，拿到的可能已是别人装上的新实例，
    // 真正该退场的那个就此失去引用（孤儿）
    const prev = controller
    const retire = () => prev?.destroy()
    // 非 crossfade 路径维持原时序：销毁在前，新实例再清空容器重建
    if (!crossfade) retire()
    // ⚠️ 此处**不再置 controller = null**（原 A.2 前的写法）：那会开出一段
    // 100–700ms 的空窗，调度方在窗内读到的术语层是 undefined、相机是 null。
    // 保持指向旧实例即可——它此刻仍在画面上，读它得到的就是用户所见。
    // renderBusy 由 drainRender 统一持有（覆盖整个排水过程，包括两轮之间的空隙）——
    // 若改在本函数内起落，轮与轮之间会露出一帧的窗口，RO 正好挤进来对着在途实例
    // 调 syncSize
    const next = await render(
      canvas!,
      slug,
      termOverride,
      crossfade ? { crossfade: true, retire } : undefined,
    )
    // 陈旧守卫：await 期间若已离开本页（SPA 导航），或本轮已被更新的一轮顶替，
    // 刚建好的实例就地销毁——不销毁则它失去引用却仍跑 rAF 与 pixi（孤儿实例）
    if (disposed || seq !== renderSeq) {
      next.destroy()
      if (disposed) retire()
      return
    }
    controller = next
    if (restoreTransform) controller.applyTransform(restoreTransform)
    // 重建后恢复域隐藏状态（v12：themechange/resize 重建路径不丢图例状态）
    for (const s of hiddenSections) controller.setSectionHidden(s, true)
    // 重建后恢复选中态（v14；波C-b 起重放**整个锚点集合**）。
    // ⚠️ 漏改成单值重放即静默吞集：重建后只剩一个锚点亮着，而目录里 12 个复选框
    // 仍勾着——集合本体在本闭包里没变，看不出任何报错。
    // 只灌渲染器、不碰 UI：目录勾选态与右栏形态在重建前后本就没变过。
    if (selectedAnchors.size > 0) {
      controller.setSelectedMany(Array.from(selectedAnchors), selectedHops)
    }
    // B3：重建后重放法域过滤（术语层过滤 + 可见子集重布局）。
    // 须排在域隐藏与选中态恢复之后——可见子集是「组显隐 × 术语法域过滤」的合取，
    // 组显隐没落定就重布局，收敛出的是错的子集形状。
    // 取舍说明：relayoutVisible 内含整图入框，会盖掉上面 applyTransform 恢复的
    // 缩放平移。法域态下的重建以「子集重新入框」为准——布局既已按子集重算，
    // 守着旧相机反而对不上新形状；未过滤（FIELD_ALL）时本段不执行，
    // J1 的「缩放平移跨重建守恒」原样成立。
    if (activeFieldFilter !== FIELD_ALL) {
      controller.setTermFieldFilter(activeFieldFilter)
      controller.relayoutVisible()
    }
    // 重建后按 controller 实际术语层模式同步三态钮（传 termOverride 时不回落）
    syncTermButtons()
    // 良态记录（A.2）：装机成功后落一份术语层与相机，供 controller 尚为 null 的
    // 首帧前窗口回落使用；controller 装上后 goodTermMode/goodTransform 优先读它
    lastTermMode = controller.getTermLayer()
    lastTransform = controller.getTransform()
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

  /** 相关知识点 chip：点击遵循图内单击规则并刷新面板 */
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
      handleSingleNodeSelection(simplifySlug(target))
    })
    return chip
  }

  /** 容器子节点 chip：已知 SimpleSlug，遵循图内单击规则 */
  function buildSlugChip(label: string, slug: SimpleSlug): HTMLElement {
    const chip = el("button", "ge-chip", label)
    chip.type = "button"
    chip.addEventListener("click", () => handleSingleNodeSelection(slug))
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

  /**
   * `.ge-panel` 显隐的**唯一写入口**（阶段5.10 波A-R4）。
   *
   * 右栏一显一隐就改画布宽度 312–452px，画布尺寸与相机口径必须在同一刻落定，
   * 所以写完 hidden 立刻 syncSize()——**同步重排（约 0.3ms）是刻意为之**：等
   * ResizeObserver 的下一帧回调也能把画布尺寸补上，但那已经晚了一步，中间夹着的
   * focus / setSelected / restoreBaseLayout 全都会读到旧宽度，算出偏右 ΔW/2 的相机。
   * 正确的相机口径优先于省这 0.3ms。
   *
   * 收敛为唯一写入口的意义：hidden 属性此前散落在 showPanelDom / showEmptyState
   * 两处，任何一处漏改都会留下「宽度变了但没人同步」的静默失配。
   */
  function setPanelVisible(visible: boolean) {
    if (panelBox === null) return
    panelBox.hidden = !visible
    controller?.syncSize()
  }

  function showPanelDom(nodes: HTMLElement[]) {
    panelEmpty!.hidden = true
    panelContent!.hidden = false
    panelContent!.replaceChildren(...nodes)
    panelContent!.scrollTop = 0
    // 面板本身是滚动容器，重置滚动位置
    setPanelVisible(true)
    if (panelBox) panelBox.scrollTop = 0
  }

  function showEmptyState() {
    panelContent!.hidden = true
    panelContent!.replaceChildren()
    panelEmpty!.hidden = false
    // v8：未点击节点时右栏整体隐藏
    setPanelVisible(false)
  }

  // 状态条消息自动消失定时器（阶段5.4）：句柄存于本挂载闭包，
  // SPA 清理（addCleanup）时一并撤销，避免导航后回调写到已替换的 DOM 上
  let statusAutoClearTimer: ReturnType<typeof setTimeout> | undefined

  // 状态条单通道写入（阶段5.4 起自动消失）：非空写入先撤销上一条的清空定时器
  // 再重新起算 STATUS_AUTO_CLEAR_MS；setStatus("") 为显式清空，直写并撤销定时器。
  function setStatus(text: string) {
    if (searchStatus === null) return
    clearTimeout(statusAutoClearTimer)
    if (text === "") {
      searchStatus.textContent = ""
      return
    }
    searchStatus.textContent = text
    statusAutoClearTimer = setTimeout(() => {
      searchStatus!.textContent = ""
    }, STATUS_AUTO_CLEAR_MS)
  }

  /** 容器节点降级面板：标题 + 目录级提示 + 子节点 chips（由 contentIndex links 推导） */
  function renderContainerPanel(
    slug: SimpleSlug,
    details: GraphContentDetails | undefined,
    data: Record<string, GraphContentDetails>,
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
    details: GraphContentDetails | undefined,
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
            if (target !== null) handleSingleNodeSelection(simplifySlug(target))
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
    const data = await graphIndex()
    const details = data[toFullSlug(slug)] as GraphContentDetails | undefined

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

  // ---------- 多选锚点集合（阶段5.10 波C-b） ----------

  /**
   * 锚点集合的**唯一写入口**。一切增删——目录勾选、Cmd 点标题、清空钮、chip 移除、
   * 图内单双击、空白清除、组隐藏/法域过滤剔除、重置——统统经此，不得散着写
   * selectedAnchors.add/delete：那三件配套事项（渲染器同步、目录勾选回写、
   * 清空钮计数与右栏形态）漏掉任何一件都是静默失配。
   *
   * @param next  新的锚点全集（替换语义，不是增量）
   * @param opts.panel "keep" 表示右栏由调用方自己负责（单选路径本就紧跟着
   *        showPanel(卡片)，交给这里再渲染一次等于同一张卡片画两遍）；
   *        默认 "auto" 按集合规模自行决定空态/卡片/多选摘要。
   * @param opts.ui "defer" 只同步渲染器、置脏位，UI 回写留给收尾的 syncAll()——
   *        批量剔除路径（法域标签一次切 15 组）专用。
   */
  function commitSelection(
    next: readonly SimpleSlug[],
    opts: { panel?: "auto" | "keep"; ui?: "full" | "defer" } = {},
  ) {
    selectedAnchors.clear()
    for (const slug of next) {
      if (selectedAnchors.size >= MAX_SELECTED_ANCHORS) break
      selectedAnchors.add(slug)
    }
    // 渲染器侧同样是整批替换（空数组即清除，与 setSelected(null) 等价）
    controller?.setSelectedMany(Array.from(selectedAnchors), selectedHops)
    if (opts.ui === "defer") {
      selectionDirty = true
      return
    }
    selectionDirty = false
    applyTocSelected()
    syncTocClear()
    if (opts.panel !== "keep") refreshSelectionPanel()
  }

  /** 延后的 UI 回写补做（脏位门控，见 selectionDirty） */
  function flushSelectionUi() {
    if (!selectionDirty) return
    selectionDirty = false
    applyTocSelected()
    syncTocClear()
    refreshSelectionPanel()
  }

  /**
   * 勾选/取消一个锚点（复选框与 Cmd 点标题共用）。
   * 上限拒绝走状态条而非 alert/静默：静默会让用户以为点击没生效而反复点，
   * 状态条 4s 自动消失且不打断当前操作。
   */
  function toggleAnchor(slug: SimpleSlug) {
    const next = Array.from(selectedAnchors)
    const at = next.indexOf(slug)
    if (at >= 0) {
      next.splice(at, 1)
    } else {
      if (next.length >= MAX_SELECTED_ANCHORS) {
        setStatus(`最多同时选中 ${MAX_SELECTED_ANCHORS} 个节点，请先取消部分勾选`)
        return
      }
      next.push(slug)
    }
    commitSelection(next)
  }

  /** 单选替换：整集换成这一个锚点（图内单双击、目录点行、搜索定位共用） */
  function replaceSelection(slug: SimpleSlug, panel: "auto" | "keep" = "keep") {
    selectedHops = 1
    commitSelection([slug], { panel })
  }

  /**
   * 右栏形态随锚点数分三档：
   *   0   空态（与波C 之前的「清除选中」逐字一致）
   *   1   该节点的内容卡片（与波C 之前的单选逐字一致，零变化）
   *   ≥2  多选摘要（已选 N 个 + chips）
   */
  function refreshSelectionPanel() {
    const anchors = Array.from(selectedAnchors)
    if (anchors.length === 0) {
      showEmptyState()
      return
    }
    if (anchors.length === 1) {
      void showPanel(anchors[0])
      return
    }
    void showSelectionPanel(anchors)
  }

  /**
   * 多选摘要面板（≥2 个锚点）：一句话说明 + 锚点 chips。
   * chip 本体点击＝看该节点的卡片（**不改集合**，看完再勾选/取消即回到摘要）；
   * chip 上的 × ＝把它移出集合。两者共处一枚 chip，故 × 必须 stopPropagation，
   * 否则一次点击会同时触发「看卡片」与「移除」，用户看到的是「点 × 弹出了卡片」。
   */
  async function showSelectionPanel(anchors: SimpleSlug[]) {
    const data = await graphIndex()
    if (disposed) return
    const nodes: HTMLElement[] = []
    nodes.push(el("h3", "ge-title", `已选 ${anchors.length} 个节点`))
    nodes.push(
      el(
        "p",
        "ge-hint",
        "勾选的节点与其直接相关节点在图中常亮。点击下方条目查看该节点卡片，点 × 将其移出；点画布空白处或抽屉里的「清空」可一次清除全部。",
      ),
    )
    const box = el("div", "ge-chips")
    for (const slug of anchors) {
      const details = data[toFullSlug(slug)] as GraphContentDetails | undefined
      const label = details?.title ?? decodeURIComponent(slug)
      box.appendChild(buildAnchorChip(label, slug))
    }
    nodes.push(box)
    showPanelDom(nodes)
  }

  /** 多选摘要里的锚点 chip：本体看卡片、× 移除 */
  function buildAnchorChip(label: string, slug: SimpleSlug): HTMLElement {
    const chip = el("button", "ge-chip ge-chip--anchor")
    chip.type = "button"
    chip.title = `${label}（点击查看卡片）`
    chip.appendChild(el("span", "ge-chip-label", label))
    const remove = el("span", "ge-chip-remove", "×")
    remove.setAttribute("role", "button")
    remove.setAttribute("aria-label", `将「${label}」移出选中集`)
    remove.title = "从选中集移除"
    remove.addEventListener("click", (ev) => {
      // 必须拦住冒泡：外层 chip 的 click 是「看卡片」，不拦即一次点击做两件事
      ev.stopPropagation()
      commitSelection(Array.from(selectedAnchors).filter((s) => s !== slug))
    })
    chip.appendChild(remove)
    chip.addEventListener("click", () => void showPanel(slug))
    return chip
  }

  /** 右侧栏节点按钮与图内单击共享同一选择规则。 */
  function handleSingleNodeSelection(simple: SimpleSlug) {
    const action = resolveSingleClickAction(
      selectedAnchors.size > 0,
      selectedAnchors.size > 0 && controller?.isInSelectedSet(simple) === true,
    )
    if (action === "ignore") return
    if (action === "select") {
      // R4：与 selectNode 同理——右栏即将显现，先把新宽度灌进渲染器再改选中态，
      // 否则这一刻之后的一切相机计算用的都是旧宽度
      setPanelVisible(true)
      replaceSelection(simple)
    }
    void showPanel(simple)
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
    // R4（阶段5.10 波A）：先弹右栏并把新宽度同步进渲染器，再 focus。
    // ⚠️ 只调 DOM 时序不够：focus 用的是渲染器持有的 width（闭包变量），不是 DOM 现值。
    // showPanel 是异步的（取卡片要 await），右栏真正显现落在下一个微任务之后，
    // 而 focus 就在下面这几行同步执行——不先把宽度灌进去，节点会被居中到**旧宽度**
    // 的中点，右栏显现后即偏右 ΔW/2（约 175px），观感就是「定位到一半又被挤走」。
    setPanelVisible(true)
    if (controller !== null) {
      if (controller.focus(simple)) {
        // v14：定位成功 → 图内选中该节点（相关节点亮起闪烁）。
        // 波C-b：点行＝**替换整集**为这一个锚点（与图内双击同义），右栏由上面的
        // showPanel 负责，故传 keep 不让 commitSelection 再画一遍同一张卡片
        replaceSelection(simple)
        return
      }
      if (simple.startsWith("9-")) {
        await controller.setTermLayer("dimmed")
        syncTermButtons()
        setStatus("已临时显示术语层")
        if (controller.focus(simple)) {
          replaceSelection(simple)
          return
        }
      }
      // B3：术语被法域过滤隐掉——重建同样不可见（renderCanvas 的恢复段会重放
      // 过滤器），故直接给可操作提示，不做无谓的全量重建（约 700ms）。
      // 判据可靠：术语层 hidden 的情形已在上一段临时降为 dimmed 并重试过 focus，
      // 走到这里仍不可见且过滤器有效，成因只可能是该术语的出处未触及当前法域。
      if (
        simple.startsWith("9-") &&
        activeFieldFilter !== FIELD_ALL &&
        !controller.isNodeVisible(simple)
      ) {
        setStatus(`「${activeFieldFilter}」法域视图内无此术语，请切回「全部」标签后再定位`)
        return
      }
      // v12：目标节点所在域组被隐藏——focus 必然未命中且重建后仍不可见
      //（renderCanvas 会恢复域隐藏状态），直接提示，不做无意义重建。
      // ⚠️ C-4 修正：原写法把 slug 的目录数字前缀直接当组号比对
      //（`simple.match(/^(\d+)-/)` 取到 "10" 即去查 hiddenSections），正犯
      // graphSections.ts :89-91 记下的教训——目录前缀 10（品种布图，实属组号 "11"）
      // 会被误判成组号 "10"（专利扩展），于是「隐藏专利扩展后定位品种文献」会得到
      // 假的「该文档域已隐藏」而放弃重建兜底。标签行上线后整片法域隐藏成为常态，
      // 该误判从边角case变为高频路径，故归一到 groupOfSlug 后比对。
      const targetGroup = groupOfSlug(simple)
      if (targetGroup !== undefined && controller.getHiddenSections().has(targetGroup)) {
        setStatus("该文档域已隐藏，请先切换顶部标签或在图例中恢复显示")
        return
      }
    }
    // 重建兜底：以目标为中心重渲染，重建后由 runRender 的恢复段重放锚点集合。
    // 此刻 controller 侧的 setSelectedMany 多半被过滤掉（节点正因不在数据集才走到这里），
    // 集合本体仍记着它——这正是「重建后它就在数据集里了」所依赖的
    replaceSelection(simple)
    void renderCanvas(target)
  }

  // ---------- 事件挂载 ----------

  // 图内点击：panel 模式的 graphnodeselect 自 canvas 冒泡至此。
  // v16 语义：无选中时单击即选中该节点（相关节点常亮、其余变暗）；
  // 选中后单击选中集内节点仅刷新右栏；暗色节点单击不响应，双击才切换选中；
  // 空白点击（detail.slug === null）清除选中并隐藏面板
  const onNodeSelect = (ev: Event) => {
    const detail = (ev as CustomEvent<{ slug?: unknown; dbl?: unknown }>).detail
    if (!detail) return
    if (detail.slug === null) {
      // 空白点击清**整批**（用户拍板：点空白＝一次退出多选视角），
      // 右栏随之回到空态由 commitSelection 的 auto 分支承接
      commitSelection([])
      return
    }
    if (typeof detail.slug !== "string") return
    const simple = simplifySlug(detail.slug as FullSlug)
    if (detail.dbl === true) {
      // 双击：把整集替换为该节点（相关节点常亮），右栏显示其信息。
      // 图内点击语义在波C 中一字未改——单击三态门控与双击替换整集都是既有行为，
      // 多选的入口只在目录抽屉那一侧
      replaceSelection(simple)
      void showPanel(simple)
      return
    }
    // 单击（v16）：复用右侧栏节点按钮的统一选择规则。
    handleSingleNodeSelection(simple)
  }
  explorer.addEventListener("graphnodeselect", onNodeSelect)

  // 搜索定位：contentIndex 中 title 前缀匹配优先、包含匹配次之，取第一命中
  async function locateByQuery() {
    const query = (searchInput?.value ?? "").trim()
    if (query.length === 0) return
    const data = await graphIndex()
    const entries = Object.entries(data) as Array<[FullSlug, GraphContentDetails]>
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
    // v14：重置同时清除选中态（恢复默认全景）；波C-b 起清的是整个锚点集合。
    // 右栏已由上一行 showEmptyState 收起，故传 keep 免得再走一遍同样的空态
    selectedHops = 1
    commitSelection([], { panel: "keep" })
    // C-4：重置扩展为「回到全部标签态」——恢复全部非术语组显示，图例项与扩展段控
    // 随 syncAll 一并回到全显。术语层不在此列：其模式由三态钮独管，重置不改动。
    for (const id of NON_TERM_GROUP_IDS) setSectionHiddenRaw(id, false)
    // B2：一并解除图例行的法域过滤，15 项重新列全（与「全部」标签态一致）
    activeFieldFilter = FIELD_ALL
    syncAll()
    // B4：重置＝回到「全部」标签态，左栏目录树的分支过滤须同步解除，
    // 否则会留下「图上全域可见、目录却仍只剩一支」的失配
    notifyFieldChange(FIELD_ALL)
    if (controller !== null) {
      // B3：重置 = 回到「全部」标签态，故与 applyField(FIELD_ALL) 同一套动作——
      // 解除术语法域过滤 + 还原首帧全景基线（内含整图入框，等价于原 resetView 的
      // 「zoomToFit + 清 focus 高亮」，另补上布局本身的还原）
      controller.setTermFieldFilter(null)
      controller.restoreBaseLayout()
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
    if (mode === undefined) return
    // A.2：先等在途的外部重建落定，再走术语层这条重建路径——两条路径共用一个容器，
    // 交叠会在容器里留下第二张 canvas（理由详见 renderIdle 声明处）。
    // controller 判空移到 await 之后：A.2 起重建期间 controller 不再被置空，
    // 此处的 null 只可能是首帧尚未装上，等完再判才不会把用户这一次点击白白吞掉
    await whenRenderIdle()
    if (disposed || controller === null) return
    const switching = controller.setTermLayer(mode)
    // 置在途信号供 drainRender 反向等待（catch 分支只用于串行，异常仍随 await 抛出）
    termIdle = switching.catch(() => {})
    await switching
    syncTermButtons()
  }
  for (const btn of termButtons) {
    btn.addEventListener("click", onTermModeClick)
  }

  // 主题切换：图内颜色为渲染时快照，需重渲染取新主题色；
  // 术语层模式随重建保持（BUG-1），三态钮不回落。
  // J1：缩放平移快照与 resize 路径同策一并传入——布局是确定性的（力导 +
  // phyllotaxis 初值 + 固定节点序 + 同步预热），重建后节点位置本就一致；
  // 此前「切主题内容动了」纯粹是不传 transform 使新实例走 zoomToFit 重新入框，
  // 传入后缩放级别与视野中心跨重建守恒。
  // 120ms trailing 防抖：连点主题卡会连发 themechange，专页是全量图，
  // 不防抖则每次事件都触发一轮全量重建、排队即卡顿（与 graph.inline.ts 同策）
  let themeChangeTimer: ReturnType<typeof setTimeout> | undefined
  const onThemeChange = () => {
    clearTimeout(themeChangeTimer)
    themeChangeTimer = setTimeout(() => {
      // A.2：改读良态取值器。controller 在重建期间不再被置空，故此处恒能拿到
      // 用户当下所见的术语层与相机；首帧前的极早期窗口回落到 lastTermMode/lastTransform，
      // 不会再出现「termOverride=undefined 使术语层静默关闭 + transform=null 使相机跳全景」
      const termMode = goodTermMode()
      const transform = goodTransform()
      void renderCanvas(centerSlug, termMode, transform, true)
    }, THEME_CHANGE_DEBOUNCE_MS)
  }
  document.addEventListener("themechange", onThemeChange)

  // ---------- 尺寸变化一律就地同步（阶段5.10 波A-R2）----------
  // 现状：窗口 resize 与容器 ResizeObserver 两条源都只调 controller.syncSize()——
  // 渲染器就地 resize + zoomBehavior.extent 跟随 + 相机左上锚定补偿，节点坐标、
  // 力导状态、纹理、选中态全部原地不动，画面零位移、零闪烁、零重建。
  //
  // 尺寸重建路径（阶段5.7 波A-A3 的 scheduleRebuild：window resize 250ms/RO 400ms +
  // crossfade）**已退役删除**。它的两项缺陷同时消失：其一，重建后世界原点 +width/2
  // 随宽度漂移，整图跳 ΔW·(1+k)/2≈165–250px；其二，crossfade 实为加性双重曝光
  //（旧层恒 α=1 不淡出、新层 260ms 淡入后硬切），跳变期间叠出残影。附带修掉的还有
  // 「窗口 resize 的 crossfade=false 分支不可达」——两条源共用同一个 resizeTimer，
  // RO 那档后写恒赢，5.7 注释里的「resize 行为零变更」当时已不成立。
  //
  // 整实例重建至此只剩两条合法路径：① themechange（取新主题色，见上方 onThemeChange，
  // 保留 120ms 防抖与 crossfade，那才是它的原始用例：颜色整体换档、不改几何、无位移）；
  // ② 术语层 hidden↔其它（改数据集构成，重建在 graph.inline.ts 内部完成）。
  // 另有两处兜底调用方：selectNode 定位未命中、onReset 在 controller 缺失时回落。
  const onResize = () => controller?.syncSize()
  window.addEventListener("resize", onResize)

  // 容器尺寸观察（阶段5.10 波A-R2 改造）：回调只做一件事——把「容器变了」这一事件
  // 转成一次 controller.syncSize()，由渲染层就地 resize + 相机左上锚定补偿。
  //
  // ⚠️ 量测单点持有：本回调**不再自持任何量测与阈值**。尺寸真值只有一处口径
  //（graph.inline.ts 的 measureCanvasSize），「变没变」也由那边的 dw/dh 双短路判定；
  // 编排层再写一份 offsetWidth 比对，就会出现「这边说变了、那边说没变」的错位，
  // 原先的 lastCanvasW/H + ≥1px 阈值整套因此删除。w===0 与亚像素抖动同样由
  // syncSize 内的短路承接（w===0 直接不动、Δ为 0 即逐字等价于没调用）。
  //
  // 只做 rAF 合并、**不做防抖**：就地 resize 是微秒级操作，没有防抖的必要，而防抖
  // 反而让画布慢半拍跟上。原 400ms 档是为「一次全量重建约 700ms」而设，重建退役后
  // 失去存在理由；.ge-panel 显隐无过渡、法域标签折行也是瞬时布局，合并到下一帧即可。
  // renderBusy 期间短路：重建在途时容器尺寸交由新实例的构造期量测承接（A.2）。
  let roFrame = 0
  let canvasRO: ResizeObserver | undefined
  if (typeof ResizeObserver !== "undefined") {
    canvasRO = new ResizeObserver(() => {
      if (roFrame !== 0) return
      roFrame = requestAnimationFrame(() => {
        roFrame = 0
        if (renderBusy) return
        controller?.syncSize()
      })
    })
    canvasRO.observe(canvas)
  }

  // ---------- 初始渲染 ----------
  await renderCanvas(hostSlug)

  // F8：JS 渲染成功（画布内已出现 canvas 元素）后隐藏生成器预置的降级告警段；
  // 告警段本体保留在产物 HTML 中，脚本未执行/渲染失败时仍然可见，充当兜底。
  // 宿主 slug 取 appPages.GRAPH_SLUG（阶段5.3 批 B4）：此处原为本模块内唯一一处
  // 字面量副本，与 GraphExplorer.tsx 的宿主门控同值，改 slug 时易漏改。
  if (canvas.querySelector("canvas") !== null) {
    const fallbackNote = document.querySelector(
      `body[data-slug="${GRAPH_SLUG}"] article > blockquote`,
    ) as HTMLElement | null
    if (fallbackNote !== null) fallbackNote.hidden = true
  }

  // ---------- SPA 清理（下一次导航前由 spa.inline 统一调用） ----------
  window.addCleanup(() => {
    disposed = true
    // 未决的主题防抖回调必须撤销：导航后触发会重建到已被替换的 DOM 上
    //（原 clearTimeout(resizeTimer) 随尺寸重建路径退役一并删除，替代者是下方的
    //  cancelAnimationFrame(roFrame)）
    clearTimeout(themeChangeTimer)
    // 阶段5.4：未决的状态条自动清空定时器一并撤销，理由同上
    clearTimeout(statusAutoClearTimer)
    explorer.removeEventListener("graphnodeselect", onNodeSelect)
    searchInput?.removeEventListener("keydown", onSearchKey)
    searchBtn?.removeEventListener("click", onSearchClick)
    resetBtn?.removeEventListener("click", onReset)
    for (const btn of termButtons) {
      btn.removeEventListener("click", onTermModeClick)
    }
    document.removeEventListener("themechange", onThemeChange)
    window.removeEventListener("resize", onResize)
    // 容器观察器随挂载闭包一同退场：不断开则旧观察器继续持有已被替换的 DOM 与
    // 本闭包内的 controller，导航后仍会往死掉的容器上排同步（未决的那一帧由
    // 下方 cancelAnimationFrame 撤销，此处断的是继续产生新回调的源头）
    canvasRO?.disconnect()
    if (roFrame !== 0) cancelAnimationFrame(roFrame)
    controller?.destroy()
    controller = null
  })
})
