import type { GraphContentDetails } from "../../plugins/emitters/contentIndex"
import {
  SimulationNodeDatum,
  SimulationLinkDatum,
  Simulation,
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
  forceRadial,
  zoomIdentity,
  select,
  drag,
  zoom,
  type ZoomBehavior,
  type ZoomTransform,
} from "d3"
import {
  Text,
  TextStyle,
  Graphics,
  GraphicsContext,
  Application,
  Container,
  Circle,
  type FederatedPointerEvent,
} from "pixi.js"
// ==== patent-kb: 让 PixiJS 不依赖 'unsafe-eval' ====
// PixiJS 8 默认以字符串生成 shader / uniform / UBO / 粒子的同步代码，需要 CSP 放行
// 'unsafe-eval'。官方为此提供了本子模块：副作用导入即执行 selfInstall()，把这些
// 代码路径整体替换为等价的 polyfill 实现，并关掉内部的 unsafeEval 可用性检查。
// 有了它，desktop/server.cjs 下发的 CSP 才能去掉 'unsafe-eval'。
import "pixi.js/unsafe-eval"
// ==== /patent-kb ====
import { Group as TweenGroup, Tween as Tweened } from "@tweenjs/tween.js"
import { registerEscapeHandler, removeAllChildren } from "./util"
import {
  FullSlug,
  SimpleSlug,
  getFullSlug,
  joinSegments,
  pathToRoot,
  resolveRelative,
  simplifySlug,
} from "../../util/path"
import {
  dragAlphaTarget,
  dragVelocityDecay,
  isGraphBackgroundClick,
  isSelectedAnchorLink,
  selectedLinkStroke,
  shouldSettleOnDragEnd,
  shouldShowLabelDuringSelection,
} from "../../util/graphInteraction"
import { D3Config, TermLayerMode } from "../Graph"
import { BOOK_COLORS, FIELD_ALL, SECTION_GROUPS, groupOfSlug } from "../../util/graphSections"

type NodeData = {
  id: SimpleSlug
  text: string
  tags: string[]
} & SimulationNodeDatum

type SimpleLinkData = {
  source: SimpleSlug
  target: SimpleSlug
}

type LinkData = {
  source: NodeData
  target: NodeData
} & SimulationLinkDatum<NodeData>

// 边渲染数据：V4-B1 性能手术后不再持有独立 Graphics（共享一个批量 Graphics 绘制），
// 仅保留 hover 邻边高亮所需的 active 标记
type LinkRenderData = {
  simulationData: LinkData
  active: boolean
}

type NodeRenderData = {
  simulationData: NodeData
  gfx: Graphics
  label: Text
  color: string
  alpha: number
  active: boolean
  radius: number
  /**
   * 标签「自身要不要显示」（阶段5.6 波1-1.2 标签渲染门控）。
   * 它只表达透明度侧的意愿，最终是否 visible 还要与统一可见性谓词
   * isNodeRenderVisible 合取——合取动作集中在 syncLabelRender 一处，不得另开通路。
   */
  labelWanted: boolean
  /**
   * 标签纹理是否已经光栅化过（阶段5.6 缩放优化 C/A）。
   * PixiJS 8 的 Text 纹理建一次即缓存，此后 visible 反复开合零成本；只有**首次**
   * 转可见那一帧要付 canvas 光栅化（实测每标签 0.11-0.15ms，resolution=8 下）。
   * 该标志把「贵的首次」与「免费的复现」区分开，供缩放手势冻结与逐帧预算判定——
   * 它只是 syncLabelRender 谓词的一个输入项，不构成第二条可见性通路。
   */
  labelReady: boolean
  /**
   * 悬停前的标签透明度，pointerleave 时据此还原（阶段5.6 波1-1.4）。
   * 原先是构造循环里的闭包变量，随事件处理器共享化一并移进本结构。
   */
  oldLabelOpacity: number
  /**
   * 悬停态标签文本（书名 · 标题），首次悬停时才由 withBookName 算出并缓存。
   * undefined ＝ 尚未悬停过本节点，其 label.text 也就从未被换过。
   */
  hoverText?: string
}

/**
 * IPReader 定制：按**域组号**映射域色板——**兜底值**。
 * 组号由 `quartz/util/graphSections.ts` 的 groupOfSlug 从 slug 顶层目录数字前缀解析：
 * 主干五书 1-…4-、7- 各自成组（组号即前缀）、「9-关键词索引/…」为术语层（靛蓝），
 * 扩展入库的文献按法域归为 7 组（组号 8、10–15）。
 * 注意本表的键是**组号**而非目录前缀：主干与术语二者数值恰好相同，扩展则不同
 * （如前缀 12「商标案件管辖解释」属组号 8「商标」）。
 *
 * 组级色的用途自阶段5.1 批 G-2 起收窄：**节点着色已下沉到书级**（见下方 bookColor），
 * 组级色只剩三个消费点——图例色点（graphexplorer.scss）、术语层节点、以及书级色
 * 缺失时的最后回落。
 *
 * 色值真源在 `quartz/styles/custom.scss` 的六套主题覆盖块：每套主题的 light/dark
 * 两块各定义 --graph-section-1..15，随主题与明暗切换而变。本表仅在 CSS 变量缺失时
 * 兜底（变量未定义 / getComputedStyle 返回空串，例如样式表尚未生效、或第三方复用
 * 本脚本却未引入主题层），保证图谱不至于失色。改配色请改
 * `scripts/gen-book-colors.mjs` 后重跑（它同时生成 custom.scss 的组级与书级色值），
 * 此处只作为最后一道保险，勿当作事实源维护。
 * 改分组请改 util/graphSections.ts；着色与图例显隐共用同一取键函数，不得各自实现。
 * 组 5/6 已无前缀命中（G-1 摘除两整组），键保留占位，与 custom.scss 一致。
 */
const SECTION_COLORS_FALLBACK: Record<string, string> = {
  "1": "#d1495b", // 玫红
  "2": "#e07b39", // 橙
  "3": "#b8860b", // 暗金
  "4": "#4c9f70", // 绿
  "5": "#2a9d8f", // 青（空组占位）
  "6": "#4381c1", // 蓝（空组占位）
  "7": "#8e6bbf", // 紫
  "8": "#c26f9e", // 品红：商标
  "9": "#3f51b5", // 靛蓝：关键词索引（术语词条）
  "10": "#76863f", // 秋香：专利扩展
  "11": "#488c40", // 草绿：品种布图
  "12": "#3b7e8f", // 湖青：竞争法
  "13": "#844c92", // 堇紫：著作权
  "14": "#4d43a6", // 青莲：综合程序
  "15": "#9a4469", // 绛红：商标审查指南
}

/** 术语层节点判定：slug 顶层目录为「9-关键词索引」（以 9- 开头） */
function isTermSlug(id: string): boolean {
  return id.startsWith("9-")
}

/**
 * 组号 → 法域（graphSections.ts 的 SectionGroup.field）。
 * 术语法域过滤（阶段5.3 需求6）用它把术语节点的非术语邻居归到法域上。
 * 取键必须先经 groupOfSlug 归组：组号不是 slug 的字面前缀（教训见 graphSections.ts）。
 */
const GROUP_FIELD: ReadonlyMap<string, string> = new Map(SECTION_GROUPS.map((g) => [g.id, g.field]))

/**
 * slug → 法域标签；未登记前缀、tags 节点、以及术语组自身一律 undefined
 * （术语层的 field 取值是「术语」，不是法域，不得作为法域归属贡献给别的术语）。
 */
function fieldOfSlug(id: string): string | undefined {
  const group = groupOfSlug(id)
  if (group === undefined) return undefined
  const field = GROUP_FIELD.get(group)
  return field === undefined || field === "术语" ? undefined : field
}

/** slug 顶层目录的数字前缀（书号）；无前缀返回 undefined */
function bookPrefixOfSlug(id: string): string | undefined {
  return id.match(/^(\d+)-/)?.[1]
}

/**
 * 悬停标签补书名（阶段5.1 批 G-2）：章节节点的标题多为「3.2 申请文件的补正」
 * 「1 引言」这类**脱离书名不可辨**的短标题，悬停时只显示标题等于没说清是哪一部。
 * 本函数把 slug 顶层目录名去掉数字前缀作为书名简称（`3-专利审查指南/…` → 专利审查指南）
 * 拼在标题前。取目录名而非 contentIndex 里的正式全名，是因为后者形如
 * 「最高人民法院关于审理专利纠纷案件适用法律问题的若干规定」，挂在节点上过长。
 *
 * 只作用于**悬停瞬间的标签文本**（见下方 pointerover/pointerleave）：
 * 高倍缩放时自动浮现的常态标签仍是原标题，否则整图会铺满重复书名。
 * 书根节点（slug 只有一段）本身就是书名，不重复添加；tag 节点无书归属，原样返回。
 */
function withBookName(id: string, text: string): string {
  if (id.startsWith("tags/")) return text
  const segments = id.split("/").filter(Boolean)
  if (segments.length < 2) return text
  const book = segments[0].match(/^\d+-(.+)$/)?.[1]
  return book === undefined ? text : `${book} · ${text}`
}

/**
 * 局部图（depth>=1）节点数上限：超限按确定性排序截断（排序规则见下方 isLocalDepth 分支）。
 *
 * 60→120（阶段5.7 波A-A1）。全库一跳邻居实测口径（2026-08-29，7,396 个准入页）：
 * p50=7 / p90=24 / p95=38 / p99=115 / max=1390；超过 60 的有 190 页（2.57%），
 * 超过 120 的仅剩 64 页（0.87%）——本次把其间 126 页从截断态解放为完整显示。
 * 原注释所记「p99=73」是更早语料下的统计，随语料扩充已失效，一并订正。
 *
 * 不取更大值的理由：局部图容器高固定 250px，节点越多包围盒越大、入框缩放越小，
 * 120 是「密度仍可辨认」与「覆盖 p99」之间的取舍点；仍超限的 64 页由既有
 * 「已显示 N/M 个关联」徽标兜底，点击即跳图谱总览看全貌。
 */
const MAX_LOCAL_NODES = 120
// 术语层 dimmed 模式下节点/边的透明度
const DIMMED_ALPHA = 0.15

/**
 * 标签「有效可见」的 alpha 阈值（阶段5.6 波1-1.2）。
 * 取 0.004 ≈ 1/255：8 位通道下低于此值的文字在屏幕上与全透明不可分辨，
 * 拿它当门限既不会漏掉任何肉眼可见的标签，又能把渐隐尾巴上的无效帧挡在光栅化之外。
 */
const LABEL_ALPHA_EPSILON = 0.004
// 节点半径上限：一级（书根）与总入口基础半径 + 弱化度数修正后截顶，
// 避免高度数枢纽节点吞掉版面
const MAX_NODE_RADIUS = 13

// zoomToFit 的视口留白（**屏幕像素**，非世界坐标）。取 12px：略大于
// MAX_NODE_RADIUS 之外的描边与抗锯齿余量，使最外圈节点与卡片边缘明显分离，
// 又不至于在 250px 高的右栏小卡里吃掉可观的画面。见 computeFitTransform。
const FIT_PAD_PX = 12

// ---------- 首帧预热参数（bug#3：图谱打开瞬间节点跳变）----------
// 预热目标 alpha：与下方 tick 回调里 zoomToFit 的触发阈值同值，
// 二者必须一致——预热达标即等价于「tick 回调本会触发入框」，故可直接置完成标志。
const PREWARM_TARGET_ALPHA = 0.3
// tick 上限：d3-force 默认 alphaDecay≈0.0228、alphaTarget=0 时 alpha 按
// 0.9772^n 纯指数衰减，与节点规模无关；alpha<0.3 恒为第 53 tick（0.9772^53≈0.295），
// 60 为其留出余量，同时防止参数被改动后循环失控。
const PREWARM_MAX_TICKS = 60
// 时间预算：预热是同步阻塞计算，超大图（collide iterations=3）单 tick 可达数毫秒，
// 无预算则首帧延迟不可控。达预算即中止，未达标的残余由既有兜底路径平滑修正。
const PREWARM_BUDGET_MS = 200
// 预算检查步长：performance.now() 自身有开销，逐 tick 查不划算，每 8 tick 查一次
const PREWARM_CHECK_INTERVAL = 8

// ---------- 子集重布局参数（阶段5.3 需求4：点法域标签后可见子集就地收拢）----------
// 起始 alpha：0.6 而非 1。重布局的起点是**全景基线**（首帧预热收敛后的快照），
// 子集只需从「全景里被抽稀的形状」收拢成「自成一图的形状」，不必推倒重来；
// 取 1 等于把基线信息抖散，切回「全部」时观感上像换了一张图。
const SUBSET_ALPHA = 0.6
// 衰减：0.05（d3 默认 0.0228 的约 2.2 倍）。alpha 按 0.6·0.95^n 衰减，
// 第 60 tick 落到 0.028（布局肉眼已定），第 120 tick 触及 alphaMin(0.001)。
const SUBSET_DECAY = 0.05
// tick 上限：取 120，即上面算出的「跑到 alphaMin」所需 tick 数，
// 兼作参数被改动后的失控护栏；时间预算沿用 PREWARM_BUDGET_MS（同为同步阻塞计算）。
const SUBSET_TICKS = 120
// 「子集布局已定」阈值：同步预算被超大子集吃满时，剩余收敛交回力导帧循环，
// alpha 首降到此值以下即补一次入框修正。取 0.03 ≈ SUBSET_ALPHA 衰减 60 tick 之值。
const SUBSET_SETTLED_ALPHA = 0.03

const localStorageKey = "graph-visited"
// ==== patent-kb: localStorage 加固 ====
// 上游原实现裸调 JSON.parse 与 setItem。getVisited 位于渲染路径上，值一旦被污染
// （扩展改写、磁盘损坏）就抛出，结果是整张图谱挂不出来而非降级；setItem 在配额
// 写满时抛出，会中断 nav 回调里后续组件的初始化。访问记录是可再生的辅助状态，
// 读写失败退化为「本次没有记录」即可，不该拖垮渲染。
function getVisited(): Set<SimpleSlug> {
  try {
    const raw = JSON.parse(localStorage.getItem(localStorageKey) ?? "[]")
    return new Set(Array.isArray(raw) ? raw : [])
  } catch {
    return new Set()
  }
}

function addToVisited(slug: SimpleSlug) {
  const visited = getVisited()
  visited.add(slug)
  try {
    localStorage.setItem(localStorageKey, JSON.stringify([...visited]))
  } catch {
    // 配额满或隐私模式：丢掉访问记录无妨，不能因此中断图谱渲染
  }
}
// ==== /patent-kb ====

// ---------- 图谱轻量索引取数（阶段5.6 波2-2.1）----------

/**
 * 取图谱专用的四字段索引（static/contentIndexGraph.json，产出见
 * plugins/emitters/contentIndex.tsx）。首个调用方发起 fetch，其余共享同一 Promise
 * ——window.__graphIndex 作为跨脚本、跨实例的去重位：本文件与
 * graphexplorer.inline.ts 是**两个独立打包的产物**，无法共用模块变量，
 * 只能经 window 汇合（同理，这三行在两处各写一份，不是复制粘贴的疏漏）。
 *
 * 路径拼法与 graphexplorer 的 fetchCard 同源：以当前页 slug 反推站点根的**相对**
 * 路径，绝对路径 /static/… 在子路径部署或 file:// 场景下会 404。
 */
const graphIndex = (): Promise<GraphContentIndex> =>
  (window.__graphIndex ??= fetch(
    joinSegments(pathToRoot(getFullSlug(window)), "static/contentIndexGraph.json"),
  ).then((r) => r.json() as Promise<GraphContentIndex>))

// ---------- 构建期预计算坐标取数（阶段5.6 波3-3.1）----------

/**
 * 构建期预计算坐标产物的形状，产出见 plugins/emitters/graphLayout.tsx。
 * pos 的键是 SimpleSlug，值是参考画布尺寸（refWidth×refHeight）下的世界坐标。
 *
 * 两档产物同形：static/graphLayout.json（术语层 hidden 档）与
 * static/graphLayout-terms.json（术语层 shown／dimmed 档），差别只在数据集与 key。
 */
type PrebuiltLayout = {
  /** 数据集与力参数的指纹；运行期复算不等即整份忽略 */
  key: string
  refWidth: number
  refHeight: number
  /** 构建期收敛终态的 alpha（必 < alphaMin） */
  alpha: number
  pos: Record<string, [number, number]>
}

/**
 * 取构建期预计算的全景坐标，按术语层档位选对应产物。与 graphIndex 同风格：
 * window 级去重、每档全站至多一次。
 *
 * ⚠️ 术语档（graphLayout-terms.json，约 800KB／gz 120KB）**惰性拉取**：
 * 本函数只在建实例时按该实例的 termHidden 调用一次，故初始态（hidden）的会话永远
 * 不会碰它，冷启动不多传一个字节；用户首次切到「显示／弱化」时才发起，且此后由
 * window 去重位复用。两档各占一个去重位，互不覆盖。
 *
 * ⚠️ 任何失败一律化为 null，绝不 reject——本产物是纯粹的加速项，取不到就回落
 * 同步预热，图照画。故 fetch 网络错误、非 2xx、JSON 解析失败三条路径全部吞掉。
 */
const graphLayout = (termHidden: boolean): Promise<PrebuiltLayout | null> => {
  const load = (file: string): Promise<PrebuiltLayout | null> =>
    fetch(joinSegments(pathToRoot(getFullSlug(window)), file))
      .then((r) => (r.ok ? (r.json() as Promise<PrebuiltLayout>) : null))
      .catch(() => null)
  return termHidden
    ? (window.__graphLayout ??= load("static/graphLayout.json"))
    : (window.__graphLayoutTerms ??= load("static/graphLayout-terms.json"))
}

/**
 * 32 位 FNV-1a —— 必须与 plugins/emitters/graphLayout.tsx 的同名实现逐位一致，
 * 改一处即两处同改（不一致的后果是产物永远被判为不匹配、收益静默归零）。
 */
function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

// ---------- 模块级组装缓存（阶段5.6 波2-2.2）----------

/**
 * 一次全量图组装的可复用产物。
 *
 * 缓存的是「与中心页、与画布尺寸、与主题都无关」的那一部分——数据集本身及其派生表，
 * 外加一份全景基线坐标。渲染期的东西（颜色、Text/Graphics、命中区）一律不进：它们
 * 依赖主题快照与实例状态，缓存了就是错。
 *
 * ⚠️ ids 的顺序即 d3 的 node index 顺序，必须稳定：linkPairs 存的是 ids 的下标对，
 * positions 虽按 id 索引不受顺序影响，但 forceLink 的 bias/strength 与 forceManyBody
 * 的四叉树遍历次序都随节点数组顺序而定——顺序一变，同一份坐标就不再是同一个收敛态。
 */
type AssemblyCacheEntry = {
  /** 节点 id，顺序即 d3 node index 顺序 */
  ids: SimpleSlug[]
  /** 与 ids 同序的节点显示文本（tag 节点为 "#标签"，其余取索引 title） */
  titles: string[]
  /** 节点 id → tags 数组（只读共享，NodeData.tags 全文无写入点） */
  tagsById: Map<SimpleSlug, string[]>
  /** 边的端点下标对（对应 ids 的下标） */
  linkPairs: Array<[number, number]>
  /** 无向邻接表（只读） */
  adjacency: Map<SimpleSlug, SimpleSlug[]>
  /** 节点度数（只读） */
  nodeDegree: Map<SimpleSlug, number>
  /** 术语 id → 出处法域集合（只读） */
  termFields: Map<string, Set<string>>
  /** 全景基线坐标快照；尚未收敛过即 null（此时不播种，走原预热路径） */
  positions: Map<SimpleSlug, { x: number; y: number }> | null
  /** 取快照那一刻的 alpha，播种后据此决定停机还是重放剩余演化 */
  baseAlpha: number
  /** 快照来源的索引条目数，仅供排障对照（键内已含同一值） */
  entryCount: number
}

/**
 * 条目上限。全量图的键取值面很窄——术语层 hidden/非 hidden 两档 × 现存两处配置
 * （二者 showTags/removeTags/excluded 相同，实际只有两条），4 条留足余量。
 */
const ASSEMBLY_CACHE_MAX = 4

/**
 * 模块级（非实例级）：SPA 软导航不换 JS 上下文，故缓存跨页存活，二次打开图谱即命中。
 * loadURL 硬跳转会新建上下文、缓存随之清空——那是设计如此，不是缺陷。
 */
const assemblyCache = new Map<string, AssemblyCacheEntry>()

// ---------- 常设性能埋点（阶段5.6 波1-1.1）----------

/**
 * 单次 createGraphInstance 的耗时切片与结构量。时间字段一律取 performance.now()
 * 的**绝对值**（相对 timeOrigin），派生量在同一条记录内自减得出，跨记录不可相减。
 *
 * 常设而非临时插桩：图谱打开延迟的每一次归因都要求同口径数字，临时插桩会在下一轮
 * 优化时失传，届时只能重新拍脑袋。默认零输出、零 I/O，开销仅 8 次 performance.now()
 * 与首帧一次 label.visible 计数（6,200 次布尔取值，微秒量级）。
 */
type GraphPerfMark = {
  /** createGraphInstance 入口 */
  t0: number
  /** 图谱轻量索引取数完成、已转成 Map（波2-2.1 前取的是 fetchData 全量索引） */
  dataReady: number
  /** 数据集组装收尾（links/nodes/adjacency/nodeDegree/termFields 全部就绪） */
  assembled: number
  /** await app.init() 返回（WebGL 上下文就绪） */
  appReady: number
  /** 节点 Text/Graphics 构造循环跑完 */
  nodesBuilt: number
  /** 首帧同步预热（runSyncTicks + 落相机）跑完 */
  prewarmed: number
  /** createGraphInstance 返回前 */
  returned: number
  /** animate() 首次 app.renderer.render 完成时刻；首帧尚未出即为 null */
  firstFrame: number | null
  nodeCount: number
  linkCount: number
  /** depth<0 的全量图 */
  fullGraph: boolean
  /** 术语层 hidden（数据集已剔除术语节点） */
  termHidden: boolean
  /** 首帧渲染时 label.visible 为真的标签数——首帧 canvas 光栅化量的直接代理指标 */
  firstFrameVisibleLabels: number | null
  /** 模块级组装缓存是否命中（波2-2.2；局部图不启用缓存，恒 false） */
  assemblyCacheHit: boolean
  /** 坐标是否由现成的全景基线播种（波2-2.2；播种即跳过同步预热） */
  layoutSeeded: boolean
  /**
   * 坐标来源（波3-3.1）：cache=模块级快照（SPA 二次打开）｜
   * prebuilt=构建期预计算产物（首次打开／硬跳转，以及术语层首次切到显示档——
   * 按 termHidden 取 static/graphLayout.json 或 static/graphLayout-terms.json）｜
   * prewarm=无现成坐标，走 d3 默认初值 + 同步预热。
   * layoutSeeded 是它的派生量（前两者为真），保留是为不改动既有探针与 smoke 断言。
   */
  layoutSource: "cache" | "prebuilt" | "prewarm"
  /** 派生：returned - t0，createGraphInstance 全程 */
  total: number
  /** 派生：nodesBuilt - appReady，节点构造段 */
  buildMs: number
  /** 派生：firstFrame - returned，返回到首帧渲染完成 */
  frameMs: number | null
  /**
   * 首次 app.renderer.render(stage) 自身的同步耗时。与 frameMs 的差额即
   * 「返回后、首帧之前」占用主线程的其他工作（目录树重建、SPA 收尾等），
   * 二者分开才谈得上归因——只看 frameMs 会把别人的账记到渲染头上。
   */
  firstRenderMs: number | null
}

/** 保留的记录条数上限：够看清「首开 vs 二次打开」的对照，又不至于常驻内存 */
const GRAPH_PERF_MAX_MARKS = 10

/**
 * 埋点存档，同时挂到 window.__graphPerf 供外部探针（desktop 侧 electron 脚本）读取。
 * localStorage 的 graph-perf 置 "1" 时每条记录 console.table 一行，否则全程静默。
 */
const graphPerf: { marks: GraphPerfMark[] } = { marks: [] }

/** 埋点是否输出到控制台（每次读 localStorage，改开关无需刷新页面） */
function graphPerfVerbose(): boolean {
  try {
    return localStorage.getItem("graph-perf") === "1"
  } catch {
    return false
  }
}

/** 记录入档（超上限丢最旧一条）。返回同一对象，首帧字段由调用方后续就地补写 */
function pushGraphPerfMark(mark: GraphPerfMark): GraphPerfMark {
  graphPerf.marks.push(mark)
  if (graphPerf.marks.length > GRAPH_PERF_MAX_MARKS) graphPerf.marks.shift()
  return mark
}

/** 首帧补写完成后的一次性输出（静默模式下空转） */
function logGraphPerfMark(mark: GraphPerfMark) {
  if (!graphPerfVerbose()) return
  console.table([
    {
      total: Math.round(mark.total),
      dataMs: Math.round(mark.dataReady - mark.t0),
      assembleMs: Math.round(mark.assembled - mark.dataReady),
      initMs: Math.round(mark.appReady - mark.assembled),
      buildMs: Math.round(mark.buildMs),
      prewarmMs: Math.round(mark.prewarmed - mark.nodesBuilt),
      frameMs: mark.frameMs === null ? null : Math.round(mark.frameMs),
      renderMs: mark.firstRenderMs === null ? null : Math.round(mark.firstRenderMs),
      nodes: mark.nodeCount,
      links: mark.linkCount,
      labels1st: mark.firstFrameVisibleLabels,
      full: mark.fullGraph,
      termHidden: mark.termHidden,
      cacheHit: mark.assemblyCacheHit,
      seeded: mark.layoutSeeded,
      layout: mark.layoutSource,
    },
  ])
}

type TweenNode = {
  update: (time: number) => void
  stop: () => void
  /** 组内是否仍有 tween 在播放（tween.js v25 update 不返回状态，用 allStopped 判定） */
  active: () => boolean
}

/**
 * 缩放平移快照（V5-B BUG-1）：graphexplorer 的 resize 重建路径在重建前快照、
 * 重建后恢复。附带快照时的画布尺寸，恢复时按新画布尺寸重算平移锚点，
 * 保持缩放级别与视野中心不变。
 */
export type SavedTransform = {
  k: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * 重建时的画布交换选项（J2）：仅 themechange 路径传入，不传即保持原行为。
 *
 * crossfade=true 时容器内的旧画布**不再先行清空**，新画布绝对定位叠在其上淡入，
 * 淡入收尾时才移除旧节点、并再延约两帧回调 retire——消除「旧画布销毁 → 新画布
 * 就绪」之间的空白帧与颜色硬切。SPA nav、术语层 hidden 重建等既有路径一律不传，
 * 行为不变。
 */
export type GraphSwapOptions = {
  /** true：先建后毁 + 新画布淡入；false/不传：保持「先清空容器再建」的原路径 */
  crossfade: boolean
  /**
   * 淡入收尾（transitionend 或硬超时先到者）再延约两帧后调用，由调用方销毁旧渲染实例。
   * 销毁必须后置到此刻：app.destroy() 内部会 loseContext
   *（pixi.js 8 GlContextSystem.destroy），WebGL 画布随即被清空——提前销毁则底图
   * 先行消失，交叉淡入退化成「从空白淡入」，空白帧并未真正消除。
   * 延帧的原因见 startCrossfade 内 finish 的注释（销毁与 DOM 收尾同帧会闪白）。
   */
  retire?: () => void
}

/**
 * 图渲染控制器（V4-B1）：renderGraph 的返回值，替代原先的 cleanup 函数。
 * 向后兼容：对象本身可调用，直接调用等价于 destroy()——
 * graphexplorer.inline.ts 现存的 `graphCleanup?.()` 写法无需改动即可继续工作。
 */
export interface GraphController {
  /** 向后兼容的调用签名：controller() === controller.destroy() */
  (): void
  /** 高亮描边指定节点并 400ms 平移居中；节点不在当前数据集时返回 false */
  focus(slug: SimpleSlug): boolean
  /** 切换术语层显示模式：hidden↔其它走重建（合法路径）；dimmed↔shown 仅改透明度 */
  setTermLayer(mode: TermLayerMode): Promise<void>
  /** 当前术语层模式 */
  getTermLayer(): TermLayerMode
  /** 切换某域组（util/graphSections.ts 的组号）节点与相关边的可见性（就地切换，不重建） */
  setSectionHidden(groupId: string, hidden: boolean): void
  /** 当前隐藏的域组号集合副本 */
  getHiddenSections(): Set<string>
  /**
   * 术语层法域过滤（需求6）：只保留出处落在该法域的术语节点，其余术语就地隐藏。
   * 传 null 或 FIELD_ALL 即取消过滤。就地切换 Sprite 可见性，**不重建实例**；
   * 与 setSectionHidden 正交（术语组永不进 hiddenSections）。
   */
  setTermFieldFilter(field: string | null): void
  /** 该法域下的术语节点数（供编排层判空域提示）；术语层 hidden 时数据集无术语，恒 0 */
  getTermFieldCount(field: string): number
  /** 节点当前是否可见（在本实例数据集内 且 未被域隐藏/术语法域过滤掉） */
  isNodeVisible(nodeId: SimpleSlug): boolean
  /** 可见子集就地重布局（需求4）：子集内力导收敛后整图入框；子集=全集或空集时等价 restoreBaseLayout */
  relayoutVisible(): void
  /**
   * 全量节点还原到全景基线坐标并整图入框。基线＝最近一次全集布局的收敛终态
   *（首帧预热后先取一版，力导自然跑完时刷新），故还原是逐位复现、往返零漂移。
   */
  restoreBaseLayout(): void
  /** 选中节点（null 清除）：选中集常亮、其余灰度 0.2；hops 2=二跳展开 */
  setSelected(nodeId: SimpleSlug | null, hops?: 1 | 2): void
  /** 当前选中节点（无则 null） */
  getSelected(): SimpleSlug | null
  /** 当前选中跳数（无选中时 1） */
  getSelectedHops(): 1 | 2
  /** 节点是否属于当前选中集（选中节点 + 相关节点；无选中时 false） */
  isInSelectedSet(nodeId: SimpleSlug): boolean
  /** 当前缩放平移快照（含画布尺寸）；未启用 zoom 时返回 null */
  getTransform(): SavedTransform | null
  /** 恢复快照的缩放平移（按新画布尺寸保持视野中心），并停用本实例的自动 zoomToFit */
  applyTransform(saved: SavedTransform): void
  /** 回到 zoomToFit 全景视图并清除 focus 高亮，不销毁实例 */
  resetView(): void
  /** 销毁渲染实例（停帧、停力导、销毁 PixiJS Application） */
  destroy(): void
}

/** 单次渲染实例的内部句柄（setTermLayer 的 hidden 重建路径会替换整个实例） */
type GraphInstance = {
  focus(slug: SimpleSlug): boolean
  /** dimmed↔shown 的纯透明度切换（不重建数据集） */
  applyTermMode(mode: Exclude<TermLayerMode, "hidden">): void
  getTermMode(): TermLayerMode
  /** 就地切换某域组节点与相关边可见性（不重建、不改变力导布局） */
  setSectionHidden(groupId: string, hidden: boolean): void
  /** 术语层法域过滤（需求6）：null / FIELD_ALL 取消过滤；就地切换，不重建 */
  setTermFieldFilter(field: string | null): void
  /** 该法域下的术语节点数（数据集内） */
  getTermFieldCount(field: string): number
  /** 节点当前是否可见（在数据集内 且 未被域隐藏/术语法域过滤掉） */
  isNodeVisible(nodeId: SimpleSlug): boolean
  /** 可见子集就地重布局（需求4） */
  relayoutVisible(): void
  /** 还原全景基线布局（最近一次全集收敛终态）并整图入框 */
  restoreBaseLayout(): void
  /** 选中节点（null 清除）：选中集常亮、其余灰度 0.2；hops 2=二跳展开 */
  setSelected(nodeId: SimpleSlug | null, hops?: 1 | 2): void
  /** 当前选中节点（无则 null） */
  getSelected(): SimpleSlug | null
  /** 节点是否属于当前选中集（选中节点 + 相关节点；无选中时 false） */
  isInSelectedSet(nodeId: SimpleSlug): boolean
  getTransform(): SavedTransform | null
  applyTransform(saved: SavedTransform): void
  resetView(): void
  destroy(): void
}

// ---------- 交叉淡入（J2）：仅 themechange 重建路径启用 ----------

// 淡入硬超时：动效被系统禁用、容器不可见或标签页转入后台时 transitionend 可能
// 不派发，超时兜底保证旧节点必被移除、旧实例必被销毁（不留孤儿实例）
const CROSSFADE_TIMEOUT_MS = 400

// 延迟销毁的兜底（DOM 收尾后）：正常前台走双 rAF（约两帧）即销毁；标签页转入
// 后台时 rAF 挂起，由本超时保证旧实例仍必被销毁。后台无合成输出，同帧销毁无害
const RETIRE_DEFER_FALLBACK_MS = 100

// ---------- GPU 释放延后（J3）：所有销毁路径共用 ----------

/**
 * app.destroy() 释放 GPU 纹理的兜底超时（见 deferPastCommit）。
 *
 * 取 1000ms 而非沿用 RETIRE_DEFER_FALLBACK_MS 的 100ms：本兜底只为「rAF 被挂起
 * （标签页转入后台）时纹理仍必被释放」而设，前台永远由双 rAF 先行完成。若取值
 * 落在主线程阻塞窗口量级内，SPA nav 路径反而会被它抢跑——nav 期间主线程要同步
 * 构建新图（实测约 60–120ms 阻塞），阻塞解除时定时器任务先于 rAF 执行，纹理在
 * 「旧画布已出 DOM」这一步提交之前就被放掉，正是本次要消除的白帧成因。
 */
const DESTROY_DEFER_FALLBACK_MS = 1000

/**
 * 把 fn 推迟到「当前这轮 DOM 变更已被合成器提交」之后执行（幂等，必达）。
 *
 * 用途只有一个：延后 app.destroy() 的 GPU 纹理释放。合成器持有的旧画布图层要等
 * 主线程提交新一帧才会从图层树摘除，而释放纹理是**立即**生效的——两者错序时，
 * 合成器拿着已失效的纹理绘制该图层，整块画布区出一帧纯白（暗色主题下极刺眼）。
 *
 * 双 rAF 的含义：第一帧的 rAF 回调跑在该帧样式/布局/绘制/提交之前，故等到第二帧
 * 的 rAF，前一帧的提交必已完成，旧画布图层此时已不在图层树内，释放纹理无帧可坏。
 */
function deferPastCommit(fn: () => void) {
  let done = false
  const run = () => {
    if (done) return
    done = true
    fn()
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(run)
  })
  setTimeout(run, DESTROY_DEFER_FALLBACK_MS)
}

/**
 * 同一容器上在途的淡入收尾函数（并发闸）。新一轮渲染开工前先冲掉在途那轮，
 * 使「移除旧节点 + 销毁旧实例」按序完成，两轮的旧节点不会互相残留。
 * 取容器粒度而非模块级布尔：一次 themechange 里局部图与全局弹窗图本就并发换画布，
 * 模块级闸会互相误伤。
 */
const pendingSwaps = new WeakMap<HTMLElement, () => void>()

/** 就地收尾指定容器上在途的淡入（无在途则空转） */
function flushPendingSwap(graph: HTMLElement) {
  pendingSwaps.get(graph)?.()
}

/**
 * 新画布叠在旧节点之上淡入；收尾时移除旧节点、清掉内联样式回归常规流，
 * 再延约两帧回调 retire 销毁旧渲染实例。收尾由 transitionend（仅 opacity）与
 * 硬超时竞争，先到者执行且只执行一次；销毁另有 rAF 与超时双兜底，必达。
 */
function startCrossfade(
  graph: HTMLElement,
  canvas: HTMLCanvasElement,
  stale: ChildNode[],
  retire?: () => void,
) {
  const style = canvas.style
  // 绝对定位使新画布脱离常规流并绘制在静态流的旧画布之上（同为定位元素时按
  // DOM 序，新画布后插入即在上），无需 z-index；三类容器（.ge-canvas /
  // .graph-outer / .global-graph-container）均 position:relative|fixed 且无内边距，
  // inset:0 与常规流位置重合，收尾撤样式时不产生位移
  style.position = "absolute"
  style.inset = "0"
  style.opacity = "0"
  style.transition = "opacity var(--duration-theme, 260ms) var(--ease-in-out, ease-in-out)"

  let settled = false
  let retired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let retireTimer: ReturnType<typeof setTimeout> | undefined
  const onTransitionEnd = (ev: TransitionEvent) => {
    if (ev.propertyName === "opacity") finish()
  }
  // 销毁段（幂等）：闸的摘除随销毁走——DOM 已收尾而销毁未达期间，冲闸仍能补上销毁
  const finalize = () => {
    if (retired) return
    retired = true
    clearTimeout(retireTimer)
    if (pendingSwaps.get(graph) === flush) pendingSwaps.delete(graph)
    retire?.()
  }
  const finish = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    canvas.removeEventListener("transitionend", onTransitionEnd)
    for (const node of stale) node.remove()
    style.position = ""
    style.inset = ""
    style.opacity = ""
    style.transition = ""
    // 销毁延约两帧，不与上面的 DOM 收尾同帧：app.destroy() 会 loseContext 并释放
    // GPU 资源，与「移除旧节点 + 撤内联样式」引发的重排重绘落在同一提交窗口时，
    // 合成器偶发拿不到就绪纹理，画布区整块闪一帧白（暗色下刺眼；CDP 帧证据
    // 2026-08-12，Electron 43 复现率约 2/3）。先让 DOM 收尾一帧安全落定（新旧画布
    // 纹理此刻俱在，最坏也只是复用视觉相同的上一帧），再做纯 GPU 释放即无帧可坏。
    // 后台 rAF 挂起时由 RETIRE_DEFER_FALLBACK_MS 超时兜底，销毁必达
    requestAnimationFrame(() => {
      requestAnimationFrame(finalize)
    })
    retireTimer = setTimeout(finalize, RETIRE_DEFER_FALLBACK_MS)
  }
  // 冲闸函数：flushPendingSwap 同步跑完剩余全部步骤（DOM 收尾 + 销毁），
  // 新一轮渲染开工前旧节点必已移除、旧实例必已停机，与拆帧前语义一致。
  // J3 后「停机」与「释放 GPU 纹理」分了家：本处同步完成的是停机（rAF 循环、
  // 力导、补间全停，不留孤儿），纹理释放另由 deferPastCommit 在≤2 帧内必达——
  // 那一步无副作用可言，晚几帧不影响任何调用方语义
  const flush = () => {
    finish()
    finalize()
  }
  canvas.addEventListener("transitionend", onTransitionEnd)
  timer = setTimeout(finish, CROSSFADE_TIMEOUT_MS)
  pendingSwaps.set(graph, flush)

  // 双 rAF：首帧让浏览器把 opacity:0 记入已计算样式，次帧改值才会产生过渡。
  // settled 判定不可省：标签页转入后台时 rAF 挂起而超时照走，收尾清样式在前、
  // rAF 补写 opacity 在后，会把 opacity:1 残留在内联样式上
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (settled) return
      style.opacity = "1"
    })
  })
}

async function createGraphInstance(
  graph: HTMLElement,
  fullSlug: FullSlug,
  termOverride?: TermLayerMode,
  swap?: GraphSwapOptions,
): Promise<GraphInstance> {
  // 埋点（1.1）：入口即取时基。整条记录先以零值占位、逐段就地补写，
  // 避免用 8 个 const 分散声明——animate() 闭包会读它，const 不提升，
  // 声明顺序一旦被后续改动打乱就是运行期 TDZ（本文件已有同类教训，见 basePositions）。
  const perfMark: GraphPerfMark = {
    t0: performance.now(),
    dataReady: 0,
    assembled: 0,
    appReady: 0,
    nodesBuilt: 0,
    prewarmed: 0,
    returned: 0,
    firstFrame: null,
    nodeCount: 0,
    linkCount: 0,
    fullGraph: false,
    termHidden: false,
    firstFrameVisibleLabels: null,
    assemblyCacheHit: false,
    layoutSeeded: false,
    layoutSource: "prewarm",
    total: 0,
    buildMs: 0,
    frameMs: null,
    firstRenderMs: null,
  }
  const slug = simplifySlug(fullSlug)
  const visited = getVisited()
  // 并发闸：同容器上若有在途淡入，先就地收尾再快照本轮旧节点
  flushPendingSwap(graph)
  // 交叉淡入路径（J2）：旧节点留在容器内充当淡入底图，收尾时才移除；
  // 其余路径保持原样——清空在前、`await app.init()` 在后，空白帧即源于此
  const crossfade = swap?.crossfade === true
  const stale: ChildNode[] = crossfade ? Array.from(graph.childNodes) : []
  if (crossfade) {
    // 旧画布先脱离常规流：局部图容器 .graph-container 无显式高度，残留画布若留在
    // 流内会把下方 graph.offsetHeight 量测撑大（行盒下沿留白），每切一次主题再涨一档。
    // 截断 badge 本就 position:absolute，不参与量测，原样留到收尾（与新 badge 同位重叠）
    for (const node of stale) {
      if (node instanceof HTMLCanvasElement) {
        node.style.position = "absolute"
        node.style.left = "0"
        node.style.top = "0"
      }
    }
  } else {
    removeAllChildren(graph)
  }

  let {
    drag: enableDrag,
    zoom: enableZoom,
    depth,
    scale,
    repelForce,
    centerForce,
    linkDistance,
    fontSize,
    opacityScale,
    removeTags,
    showTags,
    focusOnHover,
    enableRadial,
    nodeClickMode,
    termLayer,
    zoomToFit,
    excludeSlugs,
  } = JSON.parse(graph.dataset["cfg"]!) as D3Config

  // 术语层模式：setTermLayer 的重建路径经 termOverride 覆盖 data-cfg 的初始值；
  // 未配置时默认 "shown"，与历史行为一致
  let termMode: TermLayerMode = termOverride ?? termLayer ?? "shown"
  // hidden 模式在建数据集时就把术语节点剔除，实例存续期内不变（切换须重建）
  const termHidden = termMode === "hidden"
  const fitViewEnabled = zoomToFit ?? false
  // 全量图（depth:-1）判定须在 BFS 消耗 depth 前快照
  const fullGraph = depth < 0
  const isLocalDepth = depth >= 1

  // excludeSlugs 归一化：配置值均为容器前缀（目录 index 页，以 / 结尾），带不带尾斜杠
  // 均可命中，且书级排除作用于整棵子树——阶段5.3 修复：此前只把「带/不带尾斜杠」两个
  // 精确键存入 excluded，仅命中书根 index 页本身，其全部子孙页未被排除、留在数据集里
  // 断成孤立分量／小岛，同时以「未登记前缀」的灰点形式残留在图上。尾斜杠是安全前缀
  // 边界——「63-规范性文件制定管理办法/」不会误吞同前缀异名的其他目录。
  const excluded = new Set<string>()
  const excludedPrefixes: string[] = []
  for (const raw of excludeSlugs ?? []) {
    const base = raw.endsWith("/") ? raw : raw + "/"
    excluded.add(base)
    excluded.add(base.slice(0, -1))
    excludedPrefixes.push(base)
  }

  // 节点准入判定：excludeSlugs 命中的节点（含其整棵子树，经 excludedPrefixes 前缀匹配）
  // 始终不进数据集；termLayer:"hidden" 时术语节点（9- 前缀）与其关联边同样不进数据集
  const includeNode = (id: SimpleSlug): boolean =>
    !(excluded.has(id) || excludedPrefixes.some((p) => id.startsWith(p))) &&
    !(termHidden && isTermSlug(id))

  // 节点点击行为分流（W3 参数化）：
  // - navigate（默认，未配置时走此分支）：保持原有行为，SPA 跳转到目标页；
  // - panel：不跳转，从图容器冒泡派发 graphnodeselect 自定义事件，
  //   由图谱总览专页的侧栏脚本（graphexplorer.inline.ts）接管展示。
  // v14：dbl=true 为双击（展开二跳连接），detail 携带 dbl 标志
  const onNodeClick = (targetId: SimpleSlug, dbl = false) => {
    if (nodeClickMode === "panel") {
      graph.dispatchEvent(
        new CustomEvent("graphnodeselect", {
          detail: dbl ? { slug: targetId, dbl: true } : { slug: targetId },
          bubbles: true,
        }),
      )
      return
    }
    const targ = resolveRelative(fullSlug, targetId)
    window.spaNavigate(new URL(targ, window.location.toString()))
  }

  // 构建期坐标与轻量索引**并行**发起（波3-3.1）：两份产物互不依赖，串行等待等于
  // 白白多付一个 RTT。局部图（depth>=1）的邻域随中心页而变，产物覆盖不到，故不发起。
  // 真正 await 的位置在数据集组装之后（那时才知道节点数、算得出指纹），此处只起跑。
  //
  // 档位按本实例的 termHidden 选：hidden 实例取 graphLayout.json，shown／dimmed 实例
  // 取 graphLayout-terms.json。术语层 hidden↔shown 的切换走整实例重建（setTermLayer
  // 的重建路径），新实例在此处自然发起对应档的取数——所以术语档的字节只有真的切过去
  // 才会下载，无需另设惰性开关。
  const prebuiltPromise = fullGraph ? graphLayout(termHidden) : null

  const rawIndex = await graphIndex()
  perfMark.dataReady = performance.now()

  // ---------- 模块级组装缓存的查表（阶段5.6 波2-2.2）----------
  //
  // 键 = 决定组装结果的全部输入：索引条目数（内容变了就换一份产物，构建期一变即失效）
  // ｜术语层是否 hidden（决定术语节点进不进数据集）｜showTags 与 removeTags（决定 tag
  // 节点与其边）｜excluded（排除前缀集，排序后拼接以消除书写顺序差异）。
  //
  // ⚠️ 键**刻意不含 slug**：全量图的组装结果与「当前在哪一页」无关——slug 的唯一影响
  // 是 color() 里 d.id === slug 那一支高亮色，那是渲染期判定，不进缓存。把 slug 塞进键
  // 等于每换一页就多一份缓存，命中率归零。
  //
  // ⚠️ 只对 depth<0 的全量图启用：局部图（depth>=1）的邻域随中心页而变，缓存必然打空，
  // 徒增内存与失效面。
  //
  // ⚠️ 力参数（repelForce/centerForce/linkDistance/enableRadial）同样不在键内：现存两处
  // 全量图配置（GraphExplorer.tsx 的专页与 quartz.layout.ts 的 globalGraph）这四项逐字
  // 相同，已核。新增第三处全量图配置且力参数不同时，本键须同步扩展——否则两者会共享
  // 同一份坐标快照（positions），播种出的是另一套力参数的收敛态。
  const assemblyKey = fullGraph
    ? [
        Object.keys(rawIndex).length,
        termHidden,
        showTags,
        removeTags.join(","),
        [...excluded].sort().join(","),
      ].join("|")
    : null
  const cachedAssembly = assemblyKey === null ? undefined : assemblyCache.get(assemblyKey)
  perfMark.assemblyCacheHit = cachedAssembly !== undefined

  const tweens = new Map<string, TweenNode>()

  // 组装产物：命中即从缓存条目重建，未命中走下方原路径并在收尾写入缓存。
  // 一律 let（原为 const）——两条路径各自赋值，其余引用点一字未动。
  let adjacency: Map<SimpleSlug, SimpleSlug[]>
  let nodeDegree: Map<SimpleSlug, number>
  let termFields: Map<string, Set<string>>
  let nodeById: Map<SimpleSlug, NodeData>
  let graphData: { nodes: NodeData[]; links: LinkData[] }
  // 局部图截断 badge 的两个计数（全量图恒 0，故缓存命中路径无须重算）
  let truncatedTotal = 0 // 截断前邻居总数 M
  let truncatedShown = 0 // 截断后显示邻居数 N

  if (cachedAssembly !== undefined) {
    // ⚠️ NodeData 对象**必须每次新建**：d3-force 会往节点上写 x/y/vx/vy/index，
    // 而专页全量图与 Ctrl+G 弹窗全量图可以并存（同键、同一条缓存），共用节点对象
    // 会让两个 simulation 互相踩坐标——表现为一边拖拽另一边跟着抖。
    // 文本与标签数组是只读值，可安全共享。
    const nodes: NodeData[] = cachedAssembly.ids.map((id, i) => ({
      id,
      text: cachedAssembly.titles[i],
      tags: cachedAssembly.tagsById.get(id) ?? [],
    }))
    nodeById = new Map<SimpleSlug, NodeData>(nodes.map((n) => [n.id, n]))
    graphData = {
      nodes,
      // linkPairs 存的是 ids 数组的下标对，故 ids 的顺序即 d3 的 node index 顺序，
      // 写入与重建两侧必须同序（写入侧用 graphData.nodes 的顺序建表，见下方写入块）
      links: cachedAssembly.linkPairs.map(([si, ti]) => ({
        source: nodes[si],
        target: nodes[ti],
      })),
    }
    // ⚠️ 以下三张表直接引用缓存条目，**只读，任何路径禁写**：它们被同键的所有实例共享，
    // 就地改一处即污染此后每一次命中。现有消费点均为只读（adjacency→computeSelectedSet、
    // nodeDegree→nodeRadius、termFields→isTermFieldHidden/getTermFieldCount），新增消费点
    // 若需要改写，必须先复制一份再改。
    adjacency = cachedAssembly.adjacency
    nodeDegree = cachedAssembly.nodeDegree
    termFields = cachedAssembly.termFields
  } else {
    // 换源（波2-2.1）：由全站共用的 fetchData（13.45MB 全量索引）改取图谱专用的
    // 四字段索引。图谱只用 slug/title/links/tags，且由此不再与 search.inline.ts 的
    // flexsearch 全文索引在同一份 Promise 上排队。fetchData 本身语义一字未动，
    // 其余消费方（explorer/search）照旧。
    const data: Map<SimpleSlug, GraphContentDetails> = new Map(
      Object.entries<GraphContentDetails>(rawIndex).map(([k, v]) => [
        simplifySlug(k as FullSlug),
        v,
      ]),
    )
    const links: SimpleLinkData[] = []
    const tags: SimpleSlug[] = []
    const validLinks = new Set(data.keys())

    for (const [source, details] of data.entries()) {
      // 术语层过滤 + excludeSlugs：被剔除节点的出边整体跳过
      if (!includeNode(source)) continue
      const outgoing = details.links ?? []

      for (const dest of outgoing) {
        if (validLinks.has(dest) && includeNode(dest)) {
          links.push({ source: source, target: dest })
        }
      }

      if (showTags) {
        const localTags = details.tags
          .filter((tag) => !removeTags.includes(tag))
          .map((tag) => simplifySlug(("tags/" + tag) as FullSlug))

        tags.push(...localTags.filter((tag) => !tags.includes(tag)))

        for (const tag of localTags) {
          links.push({ source: source, target: tag })
        }
      }
    }

    // 邻接表：一次 O(E) 构建，替代原 BFS 中对全量 links 的逐节点 filter（O(N·E) 病灶）
    adjacency = new Map<SimpleSlug, SimpleSlug[]>()
    const addAdjacency = (a: SimpleSlug, b: SimpleSlug) => {
      const list = adjacency.get(a)
      if (list !== undefined) {
        list.push(b)
      } else {
        adjacency.set(a, [b])
      }
    }
    for (const l of links) {
      addAdjacency(l.source, l.target)
      addAdjacency(l.target, l.source)
    }

    const neighbourhood = new Set<SimpleSlug>()
    if (depth >= 0) {
      // links 已按 includeNode 预过滤，邻接表内只会出现准入节点；仅 BFS 种子需单独判定
      const wl: (SimpleSlug | "__SENTINEL")[] = includeNode(slug) ? [slug, "__SENTINEL"] : []
      while (depth >= 0 && wl.length > 0) {
        // compute neighbours
        const cur = wl.shift()!
        if (cur === "__SENTINEL") {
          depth--
          wl.push("__SENTINEL")
        } else if (!neighbourhood.has(cur)) {
          neighbourhood.add(cur)
          wl.push(...(adjacency.get(cur) ?? []))
        }
      }
    } else {
      validLinks.forEach((id) => {
        if (includeNode(id)) neighbourhood.add(id)
      })
      if (showTags) tags.forEach((tag) => neighbourhood.add(tag))
    }

    // 局部图 top-120 截断（V4-B1；上限 60→120 见阶段5.7 波A-A1，MAX_LOCAL_NODES 注释）：
    // depth>=1 且邻居数超上限时按确定性排序保留前 120 个。
    // 排序权重：同书（顶层目录前缀与当前页一致）> 非术语（非 9- 前缀）> 全局度数升序，
    // 末位以 slug 字典序兜底保证确定性。
    if (isLocalDepth) {
      const neighbours = [...neighbourhood].filter((id) => id !== slug)
      if (neighbours.length > MAX_LOCAL_NODES) {
        const globalDegree = new Map<SimpleSlug, number>()
        for (const l of links) {
          globalDegree.set(l.source, (globalDegree.get(l.source) ?? 0) + 1)
          globalDegree.set(l.target, (globalDegree.get(l.target) ?? 0) + 1)
        }
        const curBook = slug.split("/")[0]
        neighbours.sort((a, b) => {
          const bookA = a.split("/")[0] === curBook ? 0 : 1
          const bookB = b.split("/")[0] === curBook ? 0 : 1
          if (bookA !== bookB) return bookA - bookB
          const termA = isTermSlug(a) ? 1 : 0
          const termB = isTermSlug(b) ? 1 : 0
          if (termA !== termB) return termA - termB
          const degA = globalDegree.get(a) ?? 0
          const degB = globalDegree.get(b) ?? 0
          if (degA !== degB) return degA - degB
          return a < b ? -1 : a > b ? 1 : 0
        })
        const hadCenter = neighbourhood.has(slug)
        const kept = neighbours.slice(0, MAX_LOCAL_NODES)
        truncatedTotal = neighbours.length
        truncatedShown = kept.length
        neighbourhood.clear()
        if (hadCenter) neighbourhood.add(slug)
        for (const id of kept) neighbourhood.add(id)
      }
    }

    const nodes = [...neighbourhood].map((url) => {
      const text = url.startsWith("tags/") ? "#" + url.substring(5) : (data.get(url)?.title ?? url)
      return {
        id: url,
        text,
        tags: data.get(url)?.tags ?? [],
      }
    })
    // 端点解析用 Map：替代原 links.map 内的 nodes.find（O(N·E) 病灶）
    nodeById = new Map<SimpleSlug, NodeData>(nodes.map((n) => [n.id, n]))
    graphData = {
      nodes,
      links: links
        .filter((l) => neighbourhood.has(l.source) && neighbourhood.has(l.target))
        .map((l) => ({
          source: nodeById.get(l.source)!,
          target: nodeById.get(l.target)!,
        })),
    }

    // 节点度数预计算：替代原 nodeRadius 内对 graphData.links 的全量扫描
    nodeDegree = new Map<SimpleSlug, number>()
    for (const l of graphData.links) {
      nodeDegree.set(l.source.id, (nodeDegree.get(l.source.id) ?? 0) + 1)
      nodeDegree.set(l.target.id, (nodeDegree.get(l.target.id) ?? 0) + 1)
    }

    // 术语法域表（阶段5.3 需求6）：随波2-2.2 由下方「术语层法域过滤」区块上移至此，
    // 与其余组装趟归拢在同一条缓存分支内（消费点 isTermFieldHidden / getTermFieldCount
    // 仍在原处，逻辑一字未动）。
    /**
     * 术语节点 → 其出处所覆盖的法域集合。构建口径：**只算术语节点的出边**
     *（contentIndex 中术语页自身 links 指向的章节，即术语卡「出处」区块）。
     *
     * ⚠️ 方向策略已裁决，勿「优化」成双向（20260825 裁决，理由三条）：
     *   1) 语义：术语的「所属法域」由**出处索引**定义——该词条从哪些文献抽取而来，
     *      是策展事实；入边（各书正文页自动注入的术语链接）语义是「被提及」而非
     *      「所属」，审查指南正文提到某词不改变该词条的抽取来源。
     *   2) 区分度：实测双向口径下 28% 的术语跨两域及以上，过滤形同虚设；
     *      仅出边 2.5% 跨域，过滤有效。
     *   3) 事实自洽：仅出边口径下「术语抽取现仅覆盖专利/商标两域」为真陈述
     *      （实测专利 852 / 商标 209 / 跨两域 26 / 其余四域 0 / 1035 术语全覆盖），
     *      编排层的空域提示据此成立；双向口径下该提示永不触发且与事实冲突。
     *
     * 一次 O(E) 扫描建表，与 nodeDegree 同一纪律（不在渲染路径上重复扫全量边）。
     * 术语容器节点（词条分类目录，如「9-关键词索引/01-新颖性/」）出边只指向同层
     * 术语，集合恒空——法域过滤生效时随之隐藏，符合「该法域视图内不列术语目录」。
     */
    termFields = new Map<string, Set<string>>()
    for (const l of graphData.links) {
      // 只取「术语 → 非术语」这一向；术语↔术语、非术语→术语均不贡献法域
      if (!isTermSlug(l.source.id) || isTermSlug(l.target.id)) continue
      const field = fieldOfSlug(l.target.id)
      if (field === undefined) continue
      const set = termFields.get(l.source.id)
      if (set === undefined) {
        termFields.set(l.source.id, new Set([field]))
      } else {
        set.add(field)
      }
    }

    // 组装收尾：把可复用的产物写入模块级缓存（波2-2.2）。
    // positions/baseAlpha 此刻还没有——坐标要等力导收敛，由 saveAssemblySnapshot
    // 在 simulation "end" 与 destroyInstance 两处回填。
    if (assemblyKey !== null) {
      const idxById = new Map<SimpleSlug, number>()
      graphData.nodes.forEach((n, i) => idxById.set(n.id, i))
      // 超上限即整体清空，不做 LRU：全量图的键取值极少（术语层两档 × 少数配置），
      // 4 条足以覆盖一次会话内的来回切换；真超了说明键的取值面判断有误，
      // 与其半吊子淘汰不如整体重建，逻辑简单且不会留下过期条目。
      if (assemblyCache.size >= ASSEMBLY_CACHE_MAX) assemblyCache.clear()
      assemblyCache.set(assemblyKey, {
        ids: graphData.nodes.map((n) => n.id),
        titles: graphData.nodes.map((n) => n.text),
        tagsById: new Map(graphData.nodes.map((n) => [n.id, n.tags])),
        linkPairs: graphData.links.map((l) => [
          idxById.get(l.source.id)!,
          idxById.get(l.target.id)!,
        ]),
        adjacency,
        nodeDegree,
        termFields,
        positions: null,
        baseAlpha: 0,
        entryCount: Object.keys(rawIndex).length,
      })
    }
  }

  /**
   * 本次实例对应的缓存条目（局部图恒 null）。命中与未命中两条路径拿到的是**同一个
   * 对象**：未命中那条刚在上面写入，此处取回，坐标快照后续就回填到它身上。
   */
  const assemblyEntry: AssemblyCacheEntry | null =
    assemblyKey === null ? null : (assemblyCache.get(assemblyKey) ?? null)

  // ---------- 构建期坐标的取回与校验（阶段5.6 波3-3.1）----------
  //
  // 落点选在此处而非播种点，是因为这里还没有 simulation：forceSimulation 一构造就自启
  // 内部 timer，此后再插 await 便可能让出到事件循环、白跑几个 tick。数据集此刻已就绪，
  // 指纹（含节点数/边数）算得出来，条件齐备。
  //
  // 模块级快照（第①级）已有坐标时不等这份 Promise：它更新、更贴近用户离开时的样子，
  // 且无需缩放。fetch 仍在后台跑完并留在 window 上，下次需要时即取即用。
  const prebuiltExpectedKey =
    assemblyKey === null
      ? null
      : `g1-${fnv1a(
          [
            "v1",
            `e=${Object.keys(rawIndex).length}`,
            `n=${graphData.nodes.length}`,
            `l=${graphData.links.length}`,
            `th=${termHidden ? 1 : 0}`,
            `st=${showTags ? 1 : 0}`,
            `rt=${removeTags.join(",")}`,
            `ex=${[...excluded].sort().join(",")}`,
            `rf=${repelForce}`,
            `cf=${centerForce}`,
            `ld=${linkDistance}`,
            `rad=${enableRadial ? 1 : 0}`,
          ].join("|"),
        )}`
  const prebuiltRaw =
    prebuiltPromise === null || assemblyEntry?.positions != null ? null : await prebuiltPromise
  /**
   * 通过全部校验、可直接播种的构建期坐标；任一条不过即 null，静默回落同步预热。
   * 校验三关，缺一不可：
   *   1) key 逐字符相等——数据集规模或力参数一变，这份坐标就是另一套解；
   *   2) refWidth/refHeight 为正——缩放系数的分母，为 0 会把整图坐标算成 NaN/Infinity；
   *   3) 覆盖全部当前节点——少一个节点就会留在 phyllotaxis 初值上飞在图外，
   *      比整体回落预热更难看，故宁可整份弃用。
   */
  const prebuiltLayout: PrebuiltLayout | null = (() => {
    if (prebuiltRaw === null || prebuiltExpectedKey === null) return null
    if (prebuiltRaw.key !== prebuiltExpectedKey) return null
    if (!(prebuiltRaw.refWidth > 0) || !(prebuiltRaw.refHeight > 0)) return null
    for (const n of graphData.nodes) {
      if (prebuiltRaw.pos[n.id] === undefined) return null
    }
    return prebuiltRaw
  })()

  /** 容器/叶子半径分级（v14，阶段5.3 需求3 重构）：Quartz 的 simplifySlug 使目录页 slug
   * 恒以「/」结尾、文件页恒不以「/」结尾——`id.endsWith("/")` 即容器/叶子的充要判据。
   * 原实现按 slug 段数定级（4 段 3.5 / 3 段 5.5 / 1-2 段 10），导致同为叶子的审查指南
   * 小节（4 段）与其他书条文（3 段）半径不同、全库叶子大小不一；现改按该判据分级：
   * 全库叶子统一 LEAF_R=3.5px（以原审查指南叶子为基准）；容器按深度单调递减——
   * 12（0- 总入口）＞10（书根，1 段容器）＞7（编/部或书的章目录，2 段容器）＞
   * 5.5（更深容器）；术语层容器（词条分类目录）5.5、术语叶沿用 LEAF_R；tags 回落 3px。 */
  const LEAF_R = 3.5 // 全库叶子统一半径（原审查指南叶子基准）
  function levelRadius(id: string): number {
    if (id.startsWith("tags/")) return 3
    if (id.startsWith("0-")) return 12
    if (isTermSlug(id)) return id.endsWith("/") ? 5.5 : LEAF_R
    if (!id.endsWith("/")) return LEAF_R
    const depth = id.split("/").filter(Boolean).length
    if (depth === 1) return 10 // 书根
    if (depth === 2) return 7 // 编/部（审查指南类）或通用书的章目录
    return 5.5 // 更深容器
  }

  function nodeRadius(d: NodeData) {
    // 层级基础半径 + 弱化度数修正，仍受 MAX_NODE_RADIUS 封顶。
    // 叶子（base<=LEAF_R）与一级容器（书根/总入口，base>=10）不带度数修正——
    // 叶子零 boost 保证全库叶子严格等大；书根/总入口固定尺寸维持一级间视觉梯度，
    // 避免全部冲顶。度数修正只保留给中层容器（书根之下、叶子之上，如「编/部」）。
    const base = levelRadius(d.id)
    const boost = base <= LEAF_R || base >= 10 ? 0 : 0.3 * Math.sqrt(nodeDegree.get(d.id) ?? 0)
    return Math.min(base + boost, MAX_NODE_RADIUS)
  }

  // 画布尺寸（阶段5.10 波A-R2）：由 const 改 let——容器尺寸变化改走 syncSize 的
  // renderer 就地 resize，本对变量随之改写，下游 15 处读取里除两处快照语义外
  //（见下方 radial 半径与 seedScale 的注释）全是**每次现读**，故自动跟随新尺寸，
  // 无须逐处改动。改造前这里是一次性快照 + 整实例重建，重建即残影跳变。
  let width = graph.offsetWidth
  let height = Math.max(graph.offsetHeight, 250)

  // we virtualize the simulation and use pixi to actually render it
  const simulation: Simulation<NodeData, LinkData> = forceSimulation<NodeData>(graphData.nodes)
    .force("charge", forceManyBody().strength(-100 * repelForce))
    .force("center", forceCenter().strength(centerForce))
    .force("link", forceLink(graphData.links).distance(linkDistance))
    .force("collide", forceCollide<NodeData>((n) => nodeRadius(n)).iterations(3))

  // 局部图专属阻尼（阶段5.10 波B-1）：**独立语句、不并入上方链式表达式**，
  // 使全量图的力配置文本一眼可辨未动。dragVelocityDecay 返回 null 即「不调用
  // velocityDecay」，全量图恒走这一路、沿用 d3 默认 0.4。
  // ⚠️ 红线：fullGraph 必须写在下面这一行、不得先折成布尔中间变量再判——
  // graphLayout.json 的指纹不含 velocityDecay，全量图误改无任何断言会红（详见
  // quartz/util/graphInteraction.ts 顶部说明）。
  const localVelocityDecay = dragVelocityDecay(fullGraph)
  if (localVelocityDecay !== null) simulation.velocityDecay(localVelocityDecay)

  // ⚠️ 快照语义之一（阶段5.10 波A-R2）：radial 半径是**布局参数**，不是每帧现读的
  // 渲染量，此处取的是构造期的 min(w,h)。resize 后由 syncSize 在 **min(w,h) 真的变了**
  // 时重装同名力（forceRadial 半径同公式重算），min 未变则一字不动——右栏显隐纯改宽度、
  // min 恒为高度，因此「开右栏不触碰 simulation」有结构性保证，全量图力参数不变。
  const radius = (Math.min(width, height) / 2) * 0.8
  if (enableRadial) simulation.force("radial", forceRadial(radius).strength(0.2))

  // precompute style prop strings as pixi doesn't support css variables
  const cssVars = [
    "--secondary",
    "--tertiary",
    "--gray",
    "--light",
    "--lightgray",
    "--dark",
    "--darkgray",
    "--bodyFont",
    "--graphFont",
    "--graphLink",
    "--graphLinkActive",
    // 域色板（D1）：十五个键必须逐个字面写出——computedStyleMap 的键类型取自
    // 本元组的字面量联合（`Record<(typeof cssVars)[number], string>`），
    // 用循环生成会退化为 string 而丢掉类型约束。
    // 1–4/7 主干五书、9 术语层、8+10–15 扩展入库按法域归的七组
    //（组表见 quartz/util/graphSections.ts；新增组号时此处必须同步补字面量，
    //  否则 custom.scss 补了变量脚本也读不到）
    // 书级色 --graph-book-* 不进本元组：87 个键逐字写出既臃肿又与类型约束无关，
    // 改由下方 bookColorMap 一次性快照（键集来自 BOOK_COLORS，同样是有限枚举）。
    "--graph-section-1",
    "--graph-section-2",
    "--graph-section-3",
    "--graph-section-4",
    "--graph-section-5",
    "--graph-section-6",
    "--graph-section-7",
    "--graph-section-8",
    "--graph-section-9",
    "--graph-section-10",
    "--graph-section-11",
    "--graph-section-12",
    "--graph-section-13",
    "--graph-section-14",
    "--graph-section-15",
  ] as const
  const computedStyleMap = cssVars.reduce(
    (acc, key) => {
      acc[key] = getComputedStyle(document.documentElement).getPropertyValue(key)
      return acc
    },
    {} as Record<(typeof cssVars)[number], string>,
  )

  // 书级色快照（阶段5.1 批 G-2）：与上方 computedStyleMap 同一纪律——PixiJS 不认
  // CSS 变量，必须在实例创建时取一次快照；主题/明暗切换由外层重建实例重新取快照。
  // 键集取自 BOOK_COLORS（88 部文献的目录数字前缀），CSS 变量缺失时逐键回落到
  // 该表对应明暗档；两者色值同出一源（scripts/gen-book-colors.mjs 一次生成）。
  const isDarkTheme = document.documentElement.getAttribute("saved-theme") === "dark"
  const rootStyle = getComputedStyle(document.documentElement)
  const bookColorMap: Record<string, string> = {}
  for (const prefix of Object.keys(BOOK_COLORS)) {
    const fromCss = rootStyle.getPropertyValue(`--graph-book-${prefix}`).trim()
    bookColorMap[prefix] = fromCss || BOOK_COLORS[prefix][isDarkTheme ? "dark" : "light"]
  }

  // 图谱标签字体：优先 --graphFont（主题层定义的黑体栈，中文小字号下更清晰）；
  // 变量未定义时 getComputedStyle 返回空串，回退 --bodyFont，行为与原版一致
  const graphFontFamily = computedStyleMap["--graphFont"].trim() || computedStyleMap["--bodyFont"]

  // 边色 token（V4-B1）：--graphLink / --graphLinkActive 由主题层（custom.scss）定义；
  // 变量为空串时回落原 --lightgray / --gray 行为
  const linkColor = computedStyleMap["--graphLink"].trim() || computedStyleMap["--lightgray"]
  const linkActiveColor = computedStyleMap["--graphLinkActive"].trim() || computedStyleMap["--gray"]

  // 域色取值（D1）：真源是 CSS 变量 --graph-section-1..14（custom.scss 六主题
  // × light/dark 覆盖块），故必须走本实例的 computedStyleMap 快照——这也是本函数
  // 从模块级下沉进 createGraphInstance 的原因（需要闭包持有快照）。
  // 主题切换后由外层重建实例重新取快照，无需在此监听。
  // 三处硬约束：
  //   1) 必须 .trim()——getPropertyValue 返回值常带前导空格，PixiJS 解析色值会失败；
  //   2) 空串（变量未定义）回落 SECTION_COLORS_FALLBACK；
  //   3) 取键必须走 groupOfSlug（util/graphSections.ts），与下方域显隐同源——
  //      两处各写一份正则会在分组语义下产生「颜色按法域分组、图例点击按单部生效」的错位。
  // 无编号前缀、或前缀未在 SECTION_GROUPS 登记的 slug 返回 undefined，
  // 由调用方回落原生配色（灰点即「未登记」信号）。
  const sectionColor = (id: string): string | undefined => {
    const group = groupOfSlug(id)
    if (group === undefined) return undefined
    const varName = `--graph-section-${group}` as (typeof cssVars)[number]
    return computedStyleMap[varName]?.trim() || SECTION_COLORS_FALLBACK[group]
  }

  /**
   * 书级取色（阶段5.1 批 G-2）：着色粒度由「组」细到「单部文献」。
   * 取键是 slug 顶层目录的**数字前缀**（不是组号），与 sectionColor 的取键不同
   * ——后者要先经 groupOfSlug 归组，本函数直接用前缀查 87 键的书级表。
   * 三级回落：--graph-book-<前缀> → BOOK_COLORS[前缀] → undefined（交回组级）。
   * 前两级已在 bookColorMap 快照里合并，故此处只判「前缀是否在表内」。
   *
   * 术语层刻意返回 undefined：约千个术语节点共用一色是既定设计（靛蓝、
   * 由三态钮整体控制），拆成书级毫无意义，故让它回落到组级 --graph-section-9。
   * 未登记前缀同样返回 undefined，再经 sectionColor 落到 --gray——「灰点 = 未登记」
   * 这一可见信号在书级化之后依旧成立（新增目录若两处都没登记，仍是灰点）。
   */
  const bookColor = (id: string): string | undefined => {
    if (isTermSlug(id)) return undefined
    const prefix = bookPrefixOfSlug(id)
    return prefix === undefined ? undefined : bookColorMap[prefix]
  }

  // calculate color
  // 定制：当前节点仍用主题色 --secondary；其余节点先按**书级**色板着色，
  // 书级缺失（术语层、未登记前缀）再回落组级域色板；
  // 两者都取不到时回落原生规则（已访问/tag 节点用 --tertiary，其它用 --gray）
  const color = (d: NodeData) => {
    const isCurrent = d.id === slug
    if (isCurrent) {
      return computedStyleMap["--secondary"]
    }

    const domainColor = bookColor(d.id) ?? sectionColor(d.id)
    if (domainColor !== undefined) {
      return domainColor
    }

    if (visited.has(d.id) || d.id.startsWith("tags/")) {
      return computedStyleMap["--tertiary"]
    }

    return computedStyleMap["--gray"]
  }

  // dimmed 模式下的术语节点判定（termMode 可经 applyTermMode 在 dimmed↔shown 间切换）
  const isDimmedNode = (id: string): boolean => termMode === "dimmed" && isTermSlug(id)
  const isDimmedLink = (l: LinkData): boolean =>
    termMode === "dimmed" && (isTermSlug(l.source.id) || isTermSlug(l.target.id))

  // 域隐藏（v12 / v17）：图例点击切换某**域组**（groupOfSlug 解析出的组号）的节点与
  // 相关边可见性。取键与上方 sectionColor 同源（同为 groupOfSlug），保证「同色即同批显隐」；
  // 本处不得另写 /^(\d+)-/ 正则——组号与目录前缀在扩展段并不相等。
  // 就地切换——不动数据集、不改力导布局，仅控制 Sprite visible 与边绘制过滤；
  // 与术语层 hidden（重建数据集）互不干扰。
  const hiddenSections = new Set<string>()
  const isSectionHiddenNode = (id: string): boolean => {
    if (hiddenSections.size === 0) return false
    const group = groupOfSlug(id)
    return group !== undefined && hiddenSections.has(group)
  }

  // 埋点（1.1）：数据集组装收尾——此前是取数之后的全部 O(V+E) 趟。
  // 口径不变（波2-2.2 只把 termFields 的构建挪进上方缓存分支，落点仍在本行之前）：
  // assembleMs 依旧含 simulation 构造与 computedStyleMap 快照，与波1 数字可比。
  perfMark.assembled = performance.now()
  perfMark.nodeCount = graphData.nodes.length
  perfMark.linkCount = graphData.links.length
  perfMark.fullGraph = fullGraph
  perfMark.termHidden = termHidden

  // ---------- 术语层法域过滤（阶段5.3 需求6）----------
  // 表本身（termFields）在上方组装分支内构建，本区块只留过滤器状态与两个谓词。

  /** 当前法域过滤器：null = 不过滤（FIELD_ALL 在入口即归一为 null） */
  let termFieldFilter: string | null = null

  /** 术语节点因法域过滤而隐藏：过滤器有效 且 是术语 且 出处未触及该法域 */
  const isTermFieldHidden = (id: string): boolean =>
    termFieldFilter !== null && isTermSlug(id) && !termFields.get(id)?.has(termFieldFilter)

  /**
   * 统一可见性谓词（需求4/6）：域组显隐与术语法域过滤两层的合取。
   * 全文一切「这个节点还画不画」的判定都必须走它——两层各自为政时，
   * 后写的一层会用 `gfx.visible = !hidden` 覆盖掉前一层的判定结果。
   */
  const isNodeRenderVisible = (id: string): boolean =>
    !isSectionHiddenNode(id) && !isTermFieldHidden(id)

  /** 边可见 ⇔ 两端点皆可见（端点不可见时连线必须一并撤掉，否则出现悬空线） */
  const isLinkRenderVisible = (l: LinkData): boolean =>
    isNodeRenderVisible(l.source.id) && isNodeRenderVisible(l.target.id)

  /**
   * 标签视口裁剪（阶段5.6 波1-1.2b）的世界坐标边界。初值放到无穷大＝不裁剪，
   * 首帧 refreshLabelViewport 之后才生效。
   *
   * 为什么必须加这一层：1.2 只把光栅化从「打开时一次性 6,202 个」推迟到
   * 「缩放越过 k>1 的那一帧一次性 6,202 个」，实测那一帧长达 1018ms（本轮采数），
   * 卡顿只是换了个地方发生。按视口裁剪后，任一时刻只对屏幕内（含边距）的标签
   * 付光栅化成本，且 PixiJS 的文字纹理建一次即缓存，来回平移不重复付费。
   * 屏幕外的标签本就一像素都不着，裁掉零语义变更——与 alpha=0 等同 visible=false
   * 是同一条理由。
   */
  const labelViewport = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }

  /**
   * ---------- 标签光栅化调度（阶段5.6 缩放卡顿根治）----------
   *
   * 诊断实测（2026-08-29，逐帧成本分解探针）：连续缩放的每帧成本本就只有
   * 5-12ms（render 4.7-9.2、drawLinks 0.4-3.5、O(V) 两趟合计 <1），唯一超标项是
   * **越过 k>1 标签浮现档位的那一帧**——该帧一次性把视口内 636 个标签（1348×852 画布；
   * 更大画布或更密区域可达 1500+）全部首次光栅化，render 96.9ms、整帧 99.7ms
   * （波1 记录的 205.6ms 即同一现象在更大标签批下的量）。
   *
   * 对策两条，都只作为 syncLabelRender 谓词的输入项，不另开可见性通路：
   * ① 手势冻结：滚轮缩放（及程序化变换动画）进行中不新建标签纹理，已建的照常开合——
   *    已可见标签靠 stage transform 跟随，纯 GPU，零 CPU 成本；
   * ② 逐帧预算：任一帧新建纹理数受 LABEL_RASTER_BUDGET_MS 的时间预算约束，
   *    未获配额的标签留待下一帧（labelRasterPending 会把帧循环续上），
   *    把「一帧集中光栅化」摊成数帧快速渐显。
   * 二者都不改变**稳态**的可见集：预算耗尽即置 pending 续帧，直至无人被拒，
   * 收敛后的 visible 集合与门控原实现逐个相同。
   */
  const LABEL_RASTER_BUDGET_MS = 10
  const LABEL_RASTER_MIN_BATCH = 16
  const LABEL_RASTER_MAX_BATCH = 512
  /** 单标签光栅化耗时估计（ms），初值取实测均值，运行期按 render 实际增量自校正 */
  let labelRasterCostMs = 0.15
  /** 无新增光栅化时的 render 基线（ms），用于从 render 总耗时中剥离光栅化增量 */
  let renderBaseMs = 6
  /** 本帧剩余的新建纹理配额（animate 每帧重置） */
  let labelRasterBudget = 0
  /** 本帧有标签因配额耗尽被拒 ⇒ 下一帧必须续跑，否则可见集停在半途 */
  let labelRasterPending = false
  /** 本帧实际新建的纹理数（用于成本自校正） */
  let labelRasterThisFrame = 0
  /** 缩放手势进行中且该手势属于「滚轮/程序化变换」⇒ 冻结新建纹理 */
  let zoomFreezeLabels = false
  /** 缩放事件已改动相机 ⇒ 本帧需重算一次标签透明度（合并同一帧内的多个滚轮事件） */
  let labelOpacityDirty = false
  /** 冻结兜底定时器：d3 的 end 事件万一没来也能解冻（正常路径由 end 提前清掉） */
  let zoomFreezeTimer: ReturnType<typeof setTimeout> | undefined
  // 取 400ms：d3-zoom 滚轮空闲判定为 150ms，程序化变换动画为 400ms，
  // 取二者上界即可保证正常路径永远轮不到兜底触发
  const ZOOM_FREEZE_WATCHDOG_MS = 400

  /** 解冻并唤醒一帧补齐（手势 end 与兜底定时器共用） */
  function releaseZoomFreeze() {
    clearTimeout(zoomFreezeTimer)
    if (!zoomFreezeLabels) return
    zoomFreezeLabels = false
    // 手势期间被拒的标签在这一帧起按预算分批补齐（labelRasterPending 负责续帧）
    markViewDirty()
  }

  /**
   * 是否允许为该节点新建标签纹理。
   * hover / 选中 / 定位目标三类是**优先项**：它们要求标签即时在位（hover 即时、
   * 定位直达标签立即在位是已验收语义），不受冻结与预算约束——三者至多各一个节点，
   * 破例不构成成本。
   */
  const canRasterizeLabel = (id: string): boolean => {
    if (id === hoveredNodeId || id === selectedNodeId || id === focusedNodeId) return true
    if (zoomFreezeLabels) return false
    return labelRasterBudget > 0
  }

  /**
   * 视口外扩边距，单位是**世界坐标**而非屏幕像素——这是本实现的关键：
   * 标签是 stage 的子节点，其世界宽度恒为 文本宽度 / scale，与缩放级别 k 无关，
   * 故用世界边距一劳永逸覆盖「节点已出屏、标签还露半截」的情形，无需随 k 调整。
   * 取 220：全库最长标题约 26 个中文字符 × 10.5px ≈ 273px，除以 scale 后半宽约 130，
   * 留足余量。
   */
  const LABEL_VIEWPORT_MARGIN = 220

  /**
   * 按当前缩放平移重算标签视口（屏幕矩形 → 世界矩形的逆变换）。
   * 节点渲染坐标 = 力导坐标 + 画布半宽/半高，故解出的是力导坐标系下的边界。
   * ⚠️ 只能在 currentTransform 初始化之后调用（本函数声明会提升、那个 let 不会）。
   */
  function refreshLabelViewport() {
    const k = currentTransform.k
    if (!(k > 0)) {
      labelViewport.minX = -Infinity
      labelViewport.minY = -Infinity
      labelViewport.maxX = Infinity
      labelViewport.maxY = Infinity
      return
    }
    labelViewport.minX = -currentTransform.x / k - width / 2 - LABEL_VIEWPORT_MARGIN
    labelViewport.maxX = (width - currentTransform.x) / k - width / 2 + LABEL_VIEWPORT_MARGIN
    labelViewport.minY = -currentTransform.y / k - height / 2 - LABEL_VIEWPORT_MARGIN
    labelViewport.maxY = (height - currentTransform.y) / k - height / 2 + LABEL_VIEWPORT_MARGIN
  }

  /** 节点是否落在标签视口内（坐标未初始化的节点按「不在」处理，下一帧自会补上） */
  const inLabelViewport = (d: NodeData): boolean => {
    const { x, y } = d
    if (x === undefined || y === undefined) return false
    return (
      x >= labelViewport.minX &&
      x <= labelViewport.maxX &&
      y >= labelViewport.minY &&
      y <= labelViewport.maxY
    )
  }

  /**
   * 标签门控（阶段5.6 波1-1.2）：把 label.visible 同步到
   * 「labelWanted（透明度侧的意愿）∧ isNodeRenderVisible（域显隐/法域过滤）
   *   ∧ inLabelViewport（视口裁剪，1.2b）」。
   *
   * 全文一切对 label.visible 的写入只此一处——与 isNodeRenderVisible 是「唯一可见性
   * 谓词」同一条纪律；开第二条通路必然出现后写的一方覆盖前一方判定的老病。
   *
   * 为什么必须门控 visible 而不能只靠 alpha=0：PixiJS 8 的文字是**懒光栅化**的，
   * 渲染收集只看 visible/renderable/culled，不看 alpha——alpha:0 的 Text 一样会被
   * 收集、一样要在 canvas 上把字画出来生成纹理。全量图 6,202 个标签在首帧被一次性
   * 光栅化，实测首次 render 耗时 2.0s（埋点 firstRenderMs，2026-08-29 基线）。
   * visible=false 与 alpha=0 在画面上完全等同（两者都不着一像素），故门控零语义变更，
   * 拿掉的纯粹是看不见的那部分光栅化开销。
   */
  const syncLabelRender = (n: NodeRenderData) => {
    const id = n.simulationData.id
    // 前三项＝波1 的门控合取（意愿 ∧ 域显隐/法域过滤 ∧ 视口裁剪）；
    // 第四项＝纹理调度（阶段5.6）：纹理已建者恒放行，未建者须拿到新建许可。
    // 「隐藏」方向永不受调度约束——撤下标签是零成本操作，画面正确性优先。
    let want = n.labelWanted && isNodeRenderVisible(id) && inLabelViewport(n.simulationData)
    if (want && !n.labelReady) {
      if (canRasterizeLabel(id)) {
        n.labelReady = true
        labelRasterBudget--
        labelRasterThisFrame++
      } else {
        want = false
        // 被拒者留待下一帧补齐（冻结期不置：手势结束时由 zoom end 统一唤醒，
        // 免得整个手势期间每帧空转重排）
        if (!zoomFreezeLabels) labelRasterPending = true
      }
    }
    if (n.label.visible === want) return
    n.label.visible = want
    if (want) {
      // 隐藏期间 syncPositions 不再更新其坐标（见该函数），转可见的瞬间必须补一次，
      // 否则本帧会把标签画在上一次可见时的旧位置上
      const { x, y } = n.simulationData
      if (x && y) n.label.position.set(x + width / 2, y + height / 2)
    }
  }

  /** 把某节点的 Sprite 与标签同步到统一谓词的判定结果 */
  const syncNodeVisibility = (n: NodeRenderData) => {
    const visible = isNodeRenderVisible(n.simulationData.id)
    n.gfx.visible = visible
    // 标签走门控合取：域显隐/法域过滤放行之后，还要它自己想显示才画
    syncLabelRender(n)
  }

  /**
   * 切换术语法域过滤（就地，不重建实例——重建代价约 700ms，法域切换绝不走这条路）。
   * dimmed / shown 两态下生效；hidden 态数据集本就无术语节点，谓词自然空转。
   */
  function setTermFieldFilter(field: string | null) {
    const next = field === null || field === FIELD_ALL ? null : field
    if (next === termFieldFilter) return
    termFieldFilter = next
    for (const n of nodeRenderData) {
      if (!isTermSlug(n.simulationData.id)) continue
      syncNodeVisibility(n)
    }
    // 与 setSectionHidden 同策：焦点环与 hover 邻居信息若落在已不可见的节点上，就地清除
    if (focusedNodeId !== null && !isNodeRenderVisible(focusedNodeId)) {
      focusedNodeId = null
    }
    if (hoveredNodeId !== null && !isNodeRenderVisible(hoveredNodeId)) {
      updateHoverInfo(null)
      renderPixiFromD3()
    }
    markDirty()
  }

  /** 该法域下的术语节点数（本实例数据集内）；传 FIELD_ALL 得「有法域归属的术语」总数 */
  function getTermFieldCount(field: string): number {
    if (field === FIELD_ALL) return termFields.size
    let n = 0
    for (const fields of termFields.values()) {
      if (fields.has(field)) n++
    }
    return n
  }

  function setSectionHidden(groupId: string, hidden: boolean) {
    if (hidden) {
      hiddenSections.add(groupId)
    } else {
      hiddenSections.delete(groupId)
    }
    // 节点与标签 Sprite 切换 visible（隐藏后不参与命中测试）。
    // 走统一谓词而非 `= !hidden`：本组恰是术语组（"9"）时，`!hidden` 会把法域过滤
    // 已隐掉的术语一并显出来，两层过滤互相覆盖。
    for (const n of nodeRenderData) {
      if (groupOfSlug(n.simulationData.id) !== groupId) continue
      syncNodeVisibility(n)
    }
    // 被隐藏域内的 focus 高亮环一并清除（drawFocusRing 按帧绘制，避免悬空圆环）
    if (hidden && focusedNodeId !== null && groupOfSlug(focusedNodeId) === groupId) {
      focusedNodeId = null
    }
    // hover 邻居信息若引用不可见节点，立即清空（避免 active 边引用不可见端点）
    if (hoveredNodeId !== null && !isNodeRenderVisible(hoveredNodeId)) {
      updateHoverInfo(null)
      renderPixiFromD3()
    }
    markDirty()
  }

  // ---------- 选中态（v14）：选中节点 → 相关节点常亮、其余变暗 ----------
  // v16：常亮不闪烁；单击语义见 graphexplorer（无选中单击即选中、选中集内仅刷右栏、
  // 暗色单击不响应、双击切换）
  let selectedNodeId: SimpleSlug | null = null
  let selectedHops: 1 | 2 = 1
  let selectedSet: Set<string> = new Set()

  function computeSelectedSet(): Set<string> {
    const set = new Set<string>()
    if (selectedNodeId === null) return set
    set.add(selectedNodeId)
    let frontier = new Set<SimpleSlug>([selectedNodeId])
    for (let hop = 0; hop < selectedHops; hop++) {
      const next = new Set<SimpleSlug>()
      for (const id of frontier) {
        for (const nb of adjacency.get(id) ?? []) {
          if (!set.has(nb)) {
            next.add(nb)
            set.add(nb)
          }
        }
      }
      frontier = next
    }
    return set
  }

  function setSelected(nodeId: SimpleSlug | null, hops: 1 | 2 = 1) {
    // 节点不在当前数据集（如术语层 hidden 剔除/域隐藏）：忽略
    if (nodeId !== null && nodeRenderDataById.get(nodeId) === undefined) return
    selectedNodeId = nodeId
    selectedHops = hops
    selectedSet = computeSelectedSet()
    // 选中态与 focus 高亮环 / hover 高亮互斥：两者都清除，避免叠加
    focusedNodeId = null
    if (hoveredNodeId !== null) {
      updateHoverInfo(null)
    }
    if (selectedNodeId !== null) {
      // 选中：立即按选中态重绘边与节点分级（相关边加亮、其余淡化；
      // 选中集常亮、其余灰度 0.2），随后的闪烁帧只动节点 alpha
      drawLinks()
      renderNodes()
      renderLabels()
      updateLabelOpacities()
    } else {
      // 清除：完整恢复一帧（节点 alpha 经 tween 过渡回默认、边恢复默认、hover 恢复）
      renderPixiFromD3()
      // 选中节点标签回落为缩放透明度（v16）
      updateLabelOpacities()
    }
    markDirty()
  }

  function getSelected(): SimpleSlug | null {
    return selectedNodeId
  }

  let hoveredNodeId: string | null = null
  let hoveredNeighbours: Set<string> = new Set()
  const linkRenderData: LinkRenderData[] = []
  const nodeRenderData: NodeRenderData[] = []
  const nodeRenderDataById = new Map<SimpleSlug, NodeRenderData>()
  // focus() 高亮的节点 id（描边圆环随帧绘制）
  let focusedNodeId: SimpleSlug | null = null

  /**
   * 标签意愿判据（阶段5.6 波1-1.2）：唯一一处从 alpha / hover / 选中态推出
   * labelWanted 的地方。是否真的画由 syncLabelRender 与可见性谓词合取后决定。
   * hover 与选中目标额外置真，是因为 renderLabels 把它们的 alpha 交给 100ms tween——
   * tween 起步那一帧 alpha 仍接近 0，只看 alpha 会让标签晚一帧才浮现。
   * dimmed 术语节点恒假：该态下「术语无标签」是既定语义（updateLabelOpacities 与
   * renderLabels 都不给它拉 alpha），此处短路顺带保证 hover 也不会把它拉出来。
   *
   * ⚠️ 声明位置卡在两处之间，勿上下挪：须排在 hoveredNodeId / selectedNodeId 两个
   * let 之后（const 不提升，排前即运行期 TDZ，本文件 basePositions 有同款教训），
   * 又须排在节点构造循环之前（循环内的 pointerover/pointerleave 闭包引用它）。
   */
  const wantsLabel = (n: NodeRenderData): boolean => {
    const id = n.simulationData.id
    if (isDimmedNode(id)) return false
    return n.label.alpha > LABEL_ALPHA_EPSILON || id === hoveredNodeId || id === selectedNodeId
  }

  // dirty-flag 按需渲染（V4-B1）：仅在力导 tick / tween 活跃 / zoom / drag / hover
  // 触发时渲染一帧；力导停机（alpha<alphaMin）后稳态 CPU≈0
  let dirty = true
  /**
   * 几何脏标（阶段5.6 缩放优化 E）：节点/边/焦点环的坐标与批次是否需要重建。
   *
   * 依据现场坐标系设计：节点、标签、边全部画在 **stage 的世界坐标**里，缩放平移只改
   * stage.scale / stage.position（见 zoom 回调）——即相机变了、几何一点没变。故只有相机
   * 变化的那一类帧无需重跑 syncPositions（O(V) 次 Transform 写入）与 drawLinks
   * （clear + 29,010 条边重建路径批次），render 直接拿上一帧的几何画即可。
   *
   * markDirty 保守地同时置两个标（既有调用点语义一字不变），只有**明确只动相机**的
   * 路径才走 markViewDirty。
   */
  let geometryDirty = true
  const markDirty = () => {
    dirty = true
    geometryDirty = true
  }
  /** 只有相机变换变化（缩放/平移）：需要重绘一帧，但几何无须重建 */
  const markViewDirty = () => {
    dirty = true
  }

  function updateHoverInfo(newHoveredId: string | null) {
    hoveredNodeId = newHoveredId

    if (newHoveredId === null) {
      hoveredNeighbours = new Set()
      for (const n of nodeRenderData) {
        n.active = false
      }

      for (const l of linkRenderData) {
        l.active = false
      }
    } else {
      hoveredNeighbours = new Set()
      for (const l of linkRenderData) {
        const linkData = l.simulationData
        if (linkData.source.id === newHoveredId || linkData.target.id === newHoveredId) {
          hoveredNeighbours.add(linkData.source.id)
          hoveredNeighbours.add(linkData.target.id)
        }

        l.active = linkData.source.id === newHoveredId || linkData.target.id === newHoveredId
      }

      for (const n of nodeRenderData) {
        n.active = hoveredNeighbours.has(n.simulationData.id)
      }
    }
  }

  let dragStartTime = 0
  let dragging = false
  /**
   * 本次拖拽按下那一刻的 simulation.alpha()（阶段5.10 波B-4）。
   * 松手时据它判定「拖拽前布局是否已收敛」——已收敛则松手后的运动全是本次拖拽
   * 注入的余震，可直接停机（见 shouldSettleOnDragEnd）。
   */
  let dragStartAlpha = 0
  /**
   * 本次按下之后是否真的产生过位移（阶段5.10 波B-5）。
   * 力导加热改由**首个 drag 事件**触发而非 start：单击（<500ms 且从不触发 drag）
   * 从此完全不加热，点一下不再抖 3-4 秒。
   */
  let dragHeated = false
  // 双击判定（v14）：两次单击间隔 <350ms 视为双击（展开二跳连接）
  let lastClickAt = 0
  // 空白点击判定（v14）：节点命中（pointerdown）时间戳，canvas 原生 click
  // 距此 <300ms 视为节点点击（忽略），否则为空白点击（清除选中+隐藏右栏）
  let lastNodeHitAt = 0
  // 连线命中同样不应被 canvas 原生 click 当作空白点击
  let lastLinkHitAt = 0

  // 边高亮 tween 状态（V4-B1）：原每边独立 alpha tween 改为驱动两个整体量——
  // fade：普通边批次的整体透明度（hover 时降到 0.2，保持“非邻边变淡”语义）；
  // overlay：active 邻边覆盖层批次的整体透明度（hover 时升到 1）
  const linkTweenState = { fade: 1, overlay: 0 }

  function renderLinks() {
    tweens.get("link")?.stop()
    const tweenGroup = new TweenGroup()

    const target = hoveredNodeId !== null ? { fade: 0.2, overlay: 1 } : { fade: 1, overlay: 0 }
    tweenGroup.add(new Tweened(linkTweenState).to(target, 200))

    tweenGroup.getAll().forEach((tw) => tw.start())
    tweens.set("link", {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop())
      },
      active: () => !tweenGroup.allStopped(),
    })
  }

  function renderLabels() {
    tweens.get("label")?.stop()
    const tweenGroup = new TweenGroup()

    const defaultScale = 1 / scale
    const activeScale = defaultScale * 1.1
    for (const n of nodeRenderData) {
      const nodeId = n.simulationData.id

      if (
        selectedNodeId !== null &&
        !shouldShowLabelDuringSelection(selectedNodeId, selectedSet, nodeId)
      ) {
        tweenGroup.add(
          new Tweened<Text>(n.label).to(
            {
              alpha: 0,
              scale: { x: defaultScale, y: defaultScale },
            },
            100,
          ),
        )
        continue
      }

      // dimmed 术语节点无标签：悬停也不拉起标签透明度；
      // v16：选中节点标签同样拉起（节点+连线+标签常亮的显示效果）
      if ((hoveredNodeId === nodeId || selectedNodeId === nodeId) && !isDimmedNode(nodeId)) {
        tweenGroup.add(
          new Tweened<Text>(n.label).to(
            {
              alpha: 1,
              scale: { x: activeScale, y: activeScale },
            },
            100,
          ),
        )
      } else {
        tweenGroup.add(
          new Tweened<Text>(n.label).to(
            {
              alpha: n.label.alpha,
              scale: { x: defaultScale, y: defaultScale },
            },
            100,
          ),
        )
      }
    }

    tweenGroup.getAll().forEach((tw) => tw.start())
    tweens.set("label", {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop())
      },
      active: () => !tweenGroup.allStopped(),
    })
  }

  function renderNodes() {
    tweens.get("hover")?.stop()

    const tweenGroup = new TweenGroup()
    for (const n of nodeRenderData) {
      let alpha = 1

      if (selectedNodeId !== null) {
        // 选中态（v16）：选中集节点常亮（alpha 1）、其余变暗 0.2——
        // 与鼠标悬浮时的非邻节点状态一致；hover 高亮让位（移开鼠标选中态保持）
        alpha = selectedSet.has(n.simulationData.id) ? 1 : 0.2
      } else if (hoveredNodeId !== null && focusOnHover) {
        // if we are hovering over a node, we want to highlight the immediate neighbours
        alpha = n.active ? 1 : 0.2
      }

      // dimmed 术语节点始终压到 DIMMED_ALPHA 上限
      if (isDimmedNode(n.simulationData.id)) {
        alpha = Math.min(alpha, DIMMED_ALPHA)
      }

      tweenGroup.add(new Tweened<Graphics>(n.gfx, tweenGroup).to({ alpha }, 200))
    }

    tweenGroup.getAll().forEach((tw) => tw.start())
    tweens.set("hover", {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop())
      },
      active: () => !tweenGroup.allStopped(),
    })
  }

  function renderPixiFromD3() {
    renderNodes()
    renderLinks()
    renderLabels()
  }

  tweens.forEach((tween) => tween.stop())
  tweens.clear()

  const app = new Application()
  await app.init({
    width,
    height,
    antialias: true,
    autoStart: false,
    autoDensity: true,
    backgroundAlpha: 0,
    // WebGPU 渲染器在 Electron 桌面端（Chromium WebGPU 实现）下创建上下文成功但
    // 画布输出空白，仅浏览器环境正常；WebGL 在两类环境均稳定，故显式选用。
    // （2026-08-09 排查：Electron 43 图谱总览页画布空白）
    preference: "webgl",
    resolution: window.devicePixelRatio,
    eventMode: "static",
  })
  // 埋点（1.1）：WebGL 上下文就绪（本函数唯一的第二个 await 点）
  perfMark.appReady = performance.now()
  graph.appendChild(app.canvas)
  // 此处**不**起手交叉淡入：本函数在 appendChild 之后还有一大段同步构建
  //（逐节点建 Text/Graphics、力导预热），全量图实测约 700ms 阻塞主线程——
  // 在此起手则淡入的 260ms 与 400ms 兜底全被这段阻塞吃掉，收尾在解除阻塞的
  // 第一刻就触发，画面退回硬切。故推迟到构建收尾（见文件下方 animate 注册处）。
  // 期间新画布留在常规流内且尚无内容，绘制在绝对定位的旧画布**之下**，
  // `await app.init()` 的让出窗口里也不会露出。

  // 空白点击（v14）：canvas 原生 click 且距最近节点命中 >300ms → 派发
  // graphnodeselect {slug: null}，由图谱总览脚本清除选中并隐藏右栏。
  // 拖拽平移画布同样会触发 click，但期间无节点命中、且本事件仅清除选中态，
  // 不产生跳转副作用，符合"点击空白恢复"语义。
  app.canvas.addEventListener("click", () => {
    if (!isGraphBackgroundClick(lastNodeHitAt, lastLinkHitAt, Date.now())) return
    graph.dispatchEvent(
      new CustomEvent("graphnodeselect", { detail: { slug: null }, bubbles: true }),
    )
  })

  const stage = app.stage
  stage.interactive = false

  const labelsContainer = new Container<Text>({ zIndex: 3, isRenderGroup: true })
  const nodesContainer = new Container<Graphics>({ zIndex: 2, isRenderGroup: true })
  const linkContainer = new Container<Graphics>({ zIndex: 1, isRenderGroup: true })
  // focus 高亮圆环层：置于最上（zIndex 最高且最后 addChild）
  const focusContainer = new Container<Graphics>({ zIndex: 4, isRenderGroup: true })
  stage.addChild(nodesContainer, labelsContainer, linkContainer, focusContainer)

  // 单个共享 Graphics 批量绘制全部边（V4-B1）：替代原“每边一个 Graphics、每帧逐个
  // clear/stroke”的写法；每帧一次 clear 后按批次累积路径、分批 stroke
  const linkGfx = new Graphics({ interactive: true, eventMode: "static" }).on("pointerdown", () => {
    lastLinkHitAt = Date.now()
  })
  linkContainer.addChild(linkGfx)
  const focusGfx = new Graphics({ interactive: false, eventMode: "none" })
  focusContainer.addChild(focusGfx)

  // ---------- 构造循环的共享化（阶段5.6 波1-1.4）----------
  // 病灶：每节点各建一份 TextStyle、各自绘制一份圆形几何、各挂三个事件闭包，
  // 全量图即 6,202 份样式 + 6,202 份几何 + 18,600 个闭包。以下三项分别对治。

  /**
   * 全图共用的标签样式（1.4）：6,202 次 new TextStyle 变一次。
   *
   * ⚠️ 禁止对任何单个 `label.style` 赋值或改其属性——所有标签共用这一个实例，
   * 改一处即改全图，且 PixiJS 会把挂在该样式上的全部 Text 一起标脏重排。
   * 需要「只改一个标签」时改的是 `label.text`（现有 hover 补书名即如此），不是 style。
   */
  const labelStyle = new TextStyle({
    fontSize: fontSize * 15,
    fill: computedStyleMap["--dark"],
    fontFamily: graphFontFamily,
  })

  /**
   * 节点圆形几何池（1.4）：键＝半径|填充色|有无描边。全库半径只有 6 档
   *（3/3.5/5.5/7/10/12 加度数修正）、颜色不过百余种，实际去重率极高。
   *
   * ⚠️ 构造之后禁止对任何节点 gfx 调 clear()/circle()/fill()/stroke()——几何是共享的，
   * 动一个节点等于动同组全部节点。逐实例的差异只准走这三条：
   * hitArea（命中区）、alpha（hover 变暗、dimmed 压暗）、position。
   */
  const ctxPool = new Map<string, GraphicsContext>()
  const contextFor = (r: number, fill: string, ring: boolean): GraphicsContext => {
    const key = `${r.toFixed(2)}|${fill}|${ring ? 1 : 0}`
    const hit = ctxPool.get(key)
    if (hit !== undefined) return hit
    const ctx = new GraphicsContext().circle(0, 0, r).fill({ color: fill })
    if (ring) ctx.stroke({ width: 2, color: computedStyleMap["--tertiary"] })
    ctxPool.set(key, ctx)
    return ctx
  }

  // 三个共享事件处理器（1.4）：替代每节点各一份闭包（18,600 个）。
  // 上下文改由 e.target.label（即节点 slug）反查 nodeRenderDataById 取得——
  // 该 label 正是下方建 Graphics 时写入的 nodeId，与命中对象一一对应。
  // 取 currentTarget 而非 target：pixi 的 pointerleave 是沿祖先链逐级派发的，
  // 派发过程中 event.target 会被就地改写成上一级父容器（EventBoundary.js 的
  // `leaveEvent.target = leaveEvent.target.parent`），只有 currentTarget 恒等于
  // 「此刻正在执行其监听器的那个对象」。target 作兜底，二者在本处的首帧取值一致。
  const nodeOf = (e: FederatedPointerEvent): NodeRenderData | undefined => {
    const el = (e.currentTarget ?? e.target) as Container | null
    const id = el?.label
    return typeof id === "string" ? nodeRenderDataById.get(id as SimpleSlug) : undefined
  }
  const onNodePointerDown = () => {
    // 空白点击判定（v14）：记录节点命中时刻
    lastNodeHitAt = Date.now()
  }
  const onNodePointerOver = (e: FederatedPointerEvent) => {
    const n = nodeOf(e)
    if (n === undefined) return
    const nodeId = n.simulationData.id
    updateHoverInfo(nodeId)
    n.oldLabelOpacity = n.label.alpha
    // 悬停态标签文本（G-2）改懒算（1.4）：withBookName 只在首次悬停该节点时算一次，
    // 此后缓存在 NodeRenderData 上；构造期 6,202 次字符串切分与拼接就此免除
    const hoverText = (n.hoverText ??= withBookName(nodeId, n.simulationData.text))
    if (hoverText !== n.simulationData.text) n.label.text = hoverText
    // 门控（1.2）：hover 目标先置真再触发渲染——renderLabels 把它的 alpha 交给
    // 100ms tween，只等 alpha 越阈值会让标签晚一帧才浮现
    n.labelWanted = wantsLabel(n)
    syncLabelRender(n)
    if (!dragging) {
      renderPixiFromD3()
    }
    markDirty()
  }
  const onNodePointerLeave = (e: FederatedPointerEvent) => {
    const n = nodeOf(e)
    if (n === undefined) return
    updateHoverInfo(null)
    n.label.alpha = n.oldLabelOpacity
    // hoverText 为 undefined 说明从未悬停过本节点，文本也就从未被换过，无需还原
    if (n.hoverText !== undefined && n.hoverText !== n.simulationData.text) {
      n.label.text = n.simulationData.text
    }
    // 门控（1.2）：alpha 已还原，就地重算意愿（通常落回隐藏），不等下一帧
    n.labelWanted = wantsLabel(n)
    syncLabelRender(n)
    if (!dragging) {
      renderPixiFromD3()
    }
    markDirty()
  }

  for (const n of graphData.nodes) {
    const nodeId = n.id

    const label = new Text({
      interactive: false,
      eventMode: "none",
      text: n.text,
      alpha: 0,
      // 门控（1.2）：建出来就是隐藏的。首帧 k≈0.05–0.2 使 scaleOpacity 恒为 0，
      // 本就没有一个标签该显示；不显式关掉 visible，PixiJS 仍会把 6,202 个
      // alpha:0 的 Text 全部收集并光栅化（实测首次 render 2.0s）。
      // 此后由 syncLabelRender 统一按「labelWanted ∧ isNodeRenderVisible」开合。
      visible: false,
      anchor: { x: 0.5, y: 1.2 },
      // 共享样式单例（1.4）——切勿改成每节点新建，亦不可就地改它的属性
      style: labelStyle,
      // 标签纹理分辨率上限（阶段5.6 波1-1.3）：dpr×4 是为高倍缩放留的清晰度余量，
      // 但它是**平方**吃显存的——单张标签纹理按 po2 对齐后可达 MB 级，6,202 张叠起来
      // 就是 GB 量级。夹到 8 的依据：图内标签最大有效放大倍率 = 缩放上限 k=4 ×
      // label.scale(1/scale≈1) ≈ 4，再乘屏幕 dpr(2) 恰为 8，已覆盖最清晰的呈现需求。
      // 落地影响面：dpr≤2 的机器（含本机与绝大多数 Retina）算出的 4/8 本就不超上限，
      // 一像素不变；只有 dpr=3 的机器由 12 夹到 8，而 8 仍高于其实际所需。
      resolution: Math.min(window.devicePixelRatio * 4, 8),
    })
    label.scale.set(1 / scale)

    const isTagNode = nodeId.startsWith("tags/")
    const r = nodeRadius(n)
    // 每节点只算一次颜色（1.4）：原实现在 fill 与 NodeRenderData.color 两处各算一遍。
    // 注意 tag 节点的**填充**是 --light、而 NodeRenderData.color 记的仍是 color(n)，
    // 二者本就不同名同物，合并时须分开保留，不得图省事写成同一个值
    const nodeColor = color(n)
    const fill = isTagNode ? computedStyleMap["--light"] : nodeColor
    const gfx = new Graphics({
      // 共享几何（1.4）：同「半径|色|描边」的节点共用一份 GraphicsContext。
      // hitArea 与 alpha 仍逐实例，命中判定与 hover 变暗语义因此一字未变
      context: contextFor(r, fill, isTagNode),
      interactive: true,
      label: nodeId,
      eventMode: "static",
      hitArea: new Circle(0, 0, r),
      cursor: "pointer",
    })
      .on("pointerdown", onNodePointerDown)
      .on("pointerover", onNodePointerOver)
      .on("pointerleave", onNodePointerLeave)

    // dimmed 术语节点初始即压暗
    if (isDimmedNode(nodeId)) {
      gfx.alpha = DIMMED_ALPHA
    }

    nodesContainer.addChild(gfx)
    labelsContainer.addChild(label)

    const nodeRenderDatum: NodeRenderData = {
      simulationData: n,
      gfx,
      label,
      color: nodeColor,
      alpha: 1,
      active: false,
      radius: r,
      // 门控（1.2）：初始无标签（首帧 scaleOpacity=0），随缩放/hover/选中态再开
      labelWanted: false,
      // 纹理未建：首次转可见时才付光栅化，届时由 syncLabelRender 置真
      labelReady: false,
      // 共享事件处理器所需的逐节点上下文（1.4）：原为循环内的闭包变量
      oldLabelOpacity: 0,
      hoverText: undefined,
    }

    nodeRenderData.push(nodeRenderDatum)
    nodeRenderDataById.set(nodeId, nodeRenderDatum)
  }
  // 埋点（1.1）：节点构造循环收尾（buildMs = 本刻 - appReady）
  perfMark.nodesBuilt = performance.now()

  for (const l of graphData.links) {
    linkRenderData.push({
      simulationData: l,
      active: false,
    })
  }

  let currentTransform = zoomIdentity
  // 拖拽期的力导增益地板（阶段5.10 波B-3）。
  // ⚠️ 红线同 velocityDecay：fullGraph 就写在本行，不折成布尔中间变量。
  // 全量图恒 1（上游 Quartz 原值，行为逐字不变）；局部图 0.2，只够邻接节点让位，
  // 不足以把整张迷你图的残余收敛全速重放。
  const DRAG_ALPHA_TARGET = dragAlphaTarget(fullGraph)
  if (enableDrag) {
    select<HTMLCanvasElement, NodeData | undefined>(app.canvas).call(
      drag<HTMLCanvasElement, NodeData | undefined>()
        .container(() => app.canvas)
        // Map 取端点，替代 nodes.find（O(N) 病灶）
        .subject(() =>
          hoveredNodeId !== null ? nodeById.get(hoveredNodeId as SimpleSlug) : undefined,
        )
        .on("start", function dragstarted(event) {
          // 阶段5.10 波B-4：**此处不再加热**（原为 alphaTarget(1).restart()）。
          // 加热推迟到首个 drag 事件（见下方 dragged），单击因而彻底不动力导。
          event.subject.fx = event.subject.x
          event.subject.fy = event.subject.y
          event.subject.__initialDragPos = {
            x: event.subject.x,
            y: event.subject.y,
            fx: event.subject.fx,
            fy: event.subject.fy,
          }
          dragStartTime = Date.now()
          dragging = true
          dragStartAlpha = simulation.alpha()
          dragHeated = false
        })
        .on("drag", function dragged(event) {
          // 阶段5.10 波B-5：首个 drag 事件才升温，且只升到 DRAG_ALPHA_TARGET。
          // ⚠️ 判据是 `event.active <= 1` 而**不是** start 处的 `!event.active`：
          // d3-drag 的 active 是并发手势计数，dispatch 时 start 取 `n = active++`
          //（首个手势得 0）、drag 取 `n = active`（同一手势期间恒 ≥1）、end 先 `--active`
          // 再取（末个手势得 0）。把 start 的写法照搬到 drag 里，条件恒假、力导永不升温——
          // 收敛态下没有 tick，被拖的节点连位置都不会刷新（fx→x 只在 tick 内生效），
          // 拖拽整体失效。<=1 才等价于 start 处「没有其他手势在跑」的原意。
          if (!dragHeated) {
            dragHeated = true
            if (event.active <= 1) simulation.alphaTarget(DRAG_ALPHA_TARGET).restart()
          }
          const initPos = event.subject.__initialDragPos
          event.subject.fx = initPos.x + (event.x - initPos.x) / currentTransform.k
          event.subject.fy = initPos.y + (event.y - initPos.y) / currentTransform.k
        })
        .on("end", function dragended(event) {
          if (!event.active) simulation.alphaTarget(0)
          // 阶段5.10 波B-6：局部图「拖拽即整理、放下不回弹」——拖拽前布局已收敛
          // （alpha < alphaMin）时，松手后的一切运动都是本次拖拽注入的余震，直接归零
          // 停机（现状约 290 tick、4.8s 才自行停下）。纯单击 dragHeated=false，不碰 alpha。
          // 与下方「播种自收敛终态不 restart」的既有契约同源：停机态由拖拽经
          // alphaTarget().restart() 唤醒，唤醒之后仍由本行负责收场。
          if (
            dragHeated &&
            shouldSettleOnDragEnd(fullGraph, dragStartAlpha, simulation.alphaMin())
          ) {
            simulation.alpha(0)
          }
          event.subject.fx = null
          event.subject.fy = null
          dragging = false

          // if the time between mousedown and mouseup is short, we consider it a click
          if (Date.now() - dragStartTime < 500) {
            const now = Date.now()
            const isDbl = now - lastClickAt < 350
            // 双击后重置计时，避免三连击把第三次也当双击
            lastClickAt = isDbl ? 0 : now
            onNodeClick((event.subject as NodeData).id, isDbl)
          }
        }),
    )
  } else {
    for (const node of nodeRenderData) {
      node.gfx.on("click", () => {
        onNodeClick(node.simulationData.id)
      })
    }
  }

  // 标签透明度随缩放更新（拆出为函数，zoom 事件与术语层切换共用）
  function updateLabelOpacities() {
    const scaleFactor = currentTransform.k * opacityScale
    const scaleOpacity = Math.max((scaleFactor - 1) / 3.75, 0)
    // 视口裁剪（1.2b）：本函数由 zoom 事件驱动，变换刚变，边界须先跟上再逐节点同步
    refreshLabelViewport()
    for (const n of nodeRenderData) {
      // hover 高亮中的标签透明度交给 tween，缩放不覆盖
      if (n.active) continue
      if (
        selectedNodeId !== null &&
        !shouldShowLabelDuringSelection(selectedNodeId, selectedSet, n.simulationData.id)
      ) {
        n.label.alpha = 0
        n.label.scale.set(1 / scale)
        // 门控（1.2）：写完 alpha 就地重算意愿并同步，别等下一帧
        n.labelWanted = wantsLabel(n)
        syncLabelRender(n)
        continue
      }
      // 选中节点标签由 renderLabels 拉起（v16），缩放不覆盖
      if (selectedNodeId !== null && n.simulationData.id === selectedNodeId) continue
      n.label.alpha = isDimmedNode(n.simulationData.id) ? 0 : scaleOpacity
      n.labelWanted = wantsLabel(n)
      syncLabelRender(n)
    }
  }

  // zoomToFit / focus / resetView 都要经 zoomBehavior.transform 应用变换，
  // 保持 d3 内部缩放状态与舞台同步，故保留 behavior 引用
  let zoomBehavior: ZoomBehavior<HTMLCanvasElement, NodeData> | null = null
  // depth:-1 全量图放宽最小缩放，zoomToFit 大图时才能整图入框
  const scaleExtentRange: [number, number] = fullGraph ? [0.05, 4] : [0.25, 4]

  if (enableZoom) {
    zoomBehavior = zoom<HTMLCanvasElement, NodeData>()
      .extent([
        [0, 0],
        [width, height],
      ])
      .scaleExtent(scaleExtentRange)
      .on("zoom", ({ transform, sourceEvent }) => {
        currentTransform = transform
        stage.scale.set(transform.k, transform.k)
        stage.position.set(transform.x, transform.y)

        // 手势性质判定（阶段5.6 C）：滚轮缩放（含触控板捏合，Chromium 一律派发 wheel）
        // 与程序化变换动画（sourceEvent 为空：zoomToFit / focusNode / resetView）冻结
        // 新建标签纹理；鼠标拖拽平移不冻结——平移每帧新进视口的标签本就只有个位数，
        // 有逐帧预算兜底即可，冻结它反而让「拖到哪、标签才到哪」变成松手才出。
        const src = sourceEvent?.type
        zoomFreezeLabels = src === undefined || src === "wheel"
        // 冻结兜底：万一 d3 的 end 事件没来（gesture 被打断），到点强制解冻并补齐
        clearTimeout(zoomFreezeTimer)
        zoomFreezeTimer = setTimeout(releaseZoomFreeze, ZOOM_FREEZE_WATCHDOG_MS)

        // zoom adjusts opacity of labels too：改为**推迟到本帧的 animate 里做一次**。
        // 滚轮事件流一帧可来数个，逐个跑 O(V) 的透明度重算纯属重复劳动；而两者之间
        // 不存在任何渲染，合并到帧内做与逐事件做的画面结果逐像素相同。
        labelOpacityDirty = true
        // 缩放只动相机：几何（节点位置/边批次）在世界坐标里一点没变，无须重建
        markViewDirty()
      })
      // 手势收尾（阶段5.6 C）：滚轮停后 d3 的 150ms wheelDelay 到点即派发 end，
      // 正是「手势停止 debounce」——无须自建防抖，直接借 d3 既有节奏
      .on("end", releaseZoomFreeze)
    select<HTMLCanvasElement, NodeData>(app.canvas).call(zoomBehavior)
  }

  // ---------- zoomToFit（V4-B1）----------

  /**
   * 按当前节点包围盒计算“整图入框”的 zoom 变换；无有效节点时返回 null。
   *
   * 只算**可见**节点（阶段5.3 需求4 成因②）：域隐藏与术语法域过滤都是就地切换
   * Sprite 可见性、节点仍留在 graphData.nodes 里占位，若一并计入包围盒，切到某法域
   * 后相机仍按全图尺度取景——可见子集缩在角落，观感即「点了标签什么也没发生」。
   * 全部不可见（极端：整图被隐尽）时回落全集重算，避免包围盒为空而返回 null、
   * 让视图僵在上一档。
   */
  function computeFitTransform(): ZoomTransform | null {
    return computeBoundsTransform(true) ?? computeBoundsTransform(false)
  }

  function computeBoundsTransform(visibleOnly: boolean): ZoomTransform | null {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of graphData.nodes) {
      if (n.x === undefined || n.y === undefined) continue
      if (visibleOnly && !isNodeRenderVisible(n.id)) continue
      // 包围盒取「节点外缘」而非圆心（v14 修）：圆心入框不等于圆入框。半径由
      // nodeRadius 按层级 + 度数算出，最大可达 MAX_NODE_RADIUS(13)，旧实现每侧
      // 因此少留整整一个节点的量，表现为贴边节点只露半个圆——本轮缺陷本体。
      const r = nodeRadius(n)
      if (n.x - r < minX) minX = n.x - r
      if (n.x + r > maxX) maxX = n.x + r
      if (n.y - r < minY) minY = n.y - r
      if (n.y + r > maxY) maxY = n.y + r
    }
    if (!isFinite(minX) || !isFinite(minY)) return null
    const bw = Math.max(maxX - minX, 1)
    const bh = Math.max(maxY - minY, 1)
    // 留白改屏幕像素语义（v14 修）：旧实现把 PAD=40 加在**世界坐标**的包围盒上，
    // 屏幕上的实际留白是 PAD*k——k 小时几近于零，等于没有边距。现改为先在屏幕侧
    // 扣掉两侧留白、再解 k，任何缩放下留白恒为 FIT_PAD_PX 像素。
    const availW = Math.max(width - FIT_PAD_PX * 2, 1)
    const availH = Math.max(height - FIT_PAD_PX * 2, 1)
    // 上界（v14 增）：非全量图不放大过 1。局部图只有一跳邻居，三五个节点的小图
    // 若按可用区放大，节点会胀满整卡、与相邻页面的图观感失衡；夹在 1 即维持
    // 「小图保持原尺寸、只在装不下时才缩」。全量图节点以千计，k 恒远小于 1，
    // 该夹紧对其不产生任何影响（图谱总览专页与全局弹窗的观感因此不变）。
    const maxFit = fullGraph ? scaleExtentRange[1] : Math.min(scaleExtentRange[1], 1)
    // 旧实现的 0.9 安全系数在此删除：它原本是唯一有效的边距来源，现由
    // FIT_PAD_PX 精确承担，再乘 0.9 会额外缩掉一成、白白浪费卡面。
    const k = Math.max(scaleExtentRange[0], Math.min(maxFit, Math.min(availW / bw, availH / bh)))
    // 节点渲染坐标 = 力导坐标 + 画布半宽/半高偏移，包围盒中心按同一偏移换算
    const cx = (minX + maxX) / 2 + width / 2
    const cy = (minY + maxY) / 2 + height / 2
    return zoomIdentity.translate(width / 2 - k * cx, height / 2 - k * cy).scale(k)
  }

  /** 应用整图入框变换（经 zoomBehavior.transform，保持 d3 内部状态同步） */
  function applyFitView(animated: boolean) {
    if (zoomBehavior === null) return
    const t = computeFitTransform()
    if (t === null) return
    const sel = select<HTMLCanvasElement, NodeData>(app.canvas)
    if (animated) {
      sel.transition().duration(400).call(zoomBehavior.transform, t)
    } else {
      sel.call(zoomBehavior.transform, t)
    }
    markDirty()
  }

  let zoomToFitDone = false
  let zoomToFitTimer: ReturnType<typeof setTimeout> | undefined
  const triggerZoomToFit = () => {
    if (zoomToFitDone) return
    zoomToFitDone = true
    clearTimeout(zoomToFitTimer)
    // 走到这里说明预热未把布局推到达标（超大图预算耗尽）：画面上已是预热后的
    // 近似入框视图，此处只做残余修正，故用 400ms 过渡而非瞬跳（bug#3）
    applyFitView(true)
  }
  if (fitViewEnabled && enableZoom) {
    // 兜底：力导 alpha 迟迟不降（节点极少或被拖拽）时 800ms 后强制入框
    zoomToFitTimer = setTimeout(triggerZoomToFit, 800)
  }

  // ---------- 首帧预热（修 bug#3：图谱打开时节点跳一下）----------
  // 病灶：相机初值恒为 zoomIdentity，首次入框要等 alpha 首降 <0.3（或 800ms 兜底）
  // 才发生且无过渡——用户先看到原点附近的散乱布局，随后画面被瞬间拽走。
  // 对策：在首帧呈现之前同步跑完力导的前若干 tick 把布局推到大致成形，再无过渡地
  // 落相机，使用户看到的第一帧即整图入框的稳定画面，跳变无从发生。
  //
  // d3 契约：simulation.tick() 只推进内部状态，不派发 "tick" 事件（该事件仅由内部
  // timer 驱动的 step() 派发）。因此预热期间既不会 markDirty，也不会误触发下方 tick
  // 回调中的 triggerZoomToFit——即便本块已在 tick 注册之前执行，该性质同样成立。
  //
  // 门控与 zoomToFit 机制同条件：局部图（zoomToFit:false）零成本，
  // 不给每次 SPA 导航都渲染的右栏小图增加任何同步开销。
  /**
   * 同步预热助手：阻塞跑力导 tick，直到 alpha 降至 minAlpha 以下、跑满 maxTicks、
   * 或耗尽 PREWARM_BUDGET_MS 时间预算（三者先到者为准），返回实际跑过的 tick 数。
   * 首帧预热与子集重布局（relayoutVisible）共用同一套预算与检查步长。
   */
  function runSyncTicks(maxTicks: number, minAlpha: number): number {
    const startedAt = performance.now()
    let ticks = 0
    while (simulation.alpha() >= minAlpha && ticks < maxTicks) {
      simulation.tick()
      ticks++
      if (
        ticks % PREWARM_CHECK_INTERVAL === 0 &&
        performance.now() - startedAt > PREWARM_BUDGET_MS
      ) {
        break
      }
    }
    return ticks
  }

  // 子集重布局区的状态声明（函数体见下方「子集重布局」区块）。
  // ⚠️ 必须留在这里、勿并回下方区块：紧接其后的首帧预热块同步调用 captureBaseLayout()，
  // 该函数读 basePositions、写 baseAlpha。函数声明会提升，这四个 const/let 却不会——
  // 声明一旦排到预热块之后，那一句立即抛
  // `ReferenceError: Cannot access 'basePositions' before initialization`，
  // createGraphInstance 随之 reject、controller 恒 null（三态钮/法域标签/focus 全失效）。
  // tsc 的流分析不跨函数追这类 use-before-declare，编译期抓不到，只在运行期现形。
  // 另一时序约束：baseAlphaDecay 取 simulation.alphaDecay() 的实时值，落点须在
  // simulation 构建语句之后。
  /** 全景基线坐标：全集布局的快照，一切重布局的确定性起点 */
  const basePositions = new Map<SimpleSlug, { x: number; y: number }>()
  /**
   * 取基线那一刻的 alpha。还原全景时按它重放当时的剩余演化：
   * ≥alphaMin（基线取自尚未跑完的预热态）→ 恢复坐标后让力导沿原轨迹继续跑完；
   * <alphaMin（基线取自自然收敛终态）→ 直接停机，还原即逐位复现、零漂移。
   */
  let baseAlpha = 0
  /** 子集重布局的同步预算被吃满、残余收敛交回帧循环时，待补的那次入框修正 */
  let pendingRelayoutFit = false
  /** 力导默认衰减（子集重布局会临时调快，还原全景时改回，使拖拽手感跨切换一致） */
  const baseAlphaDecay = simulation.alphaDecay()

  // ---------- 坐标播种（阶段5.6 波2-2.2，波3-3.1 扩为三级回落链）----------
  // 有现成坐标就不必从 phyllotaxis 初值起跑，同步预热（实测中位 229ms，占波1 后
  // SPA 打开耗时的 47%）随之整段省掉。三级依次尝试，先命中者胜：
  //   ① 模块级快照 assemblyEntry.positions（波2）——最贴近用户离开时的样子，
  //      同一画布尺寸下取得，无需缩放；SPA 二次打开走这一级；
  //   ② 构建期预计算产物（波3-3.1，按 termHidden 取 static/graphLayout.json 或
  //      static/graphLayout-terms.json）——首次打开／硬跳转（新 JS 上下文，模块缓存空）、
  //      以及术语层首次切到显示档（新数据集，模块缓存里没有它）走这一级，
  //      按画布尺寸等比缩放后落座；
  //   ③ 都没有则回落原路径：d3 默认初值 + runSyncTicks 同步预热。
  //
  // 落点必须在 simulation 构造之后：forceSimulation(nodes) 会给每个节点写一遍
  // phyllotaxis 初值，排在其前会被覆盖。而 forceLink/forceManyBody 的 initialize 只读
  // 节点数组与 index、不读坐标，故此刻改坐标对它们无影响。
  //
  // vx/vy 清零与 restoreBaseLayout 同策：快照只存位置不存速度，留着上一实例的残余速度
  // 会让画面在首帧之后自己漂一段。
  let layoutSeeded = false
  /** 播种源对应的 alpha：决定播种后是就此停机还是把剩余演化跑完（见下方分流） */
  let seedAlpha = 0
  const seedPositions = assemblyEntry?.positions ?? null
  if (seedPositions !== null) {
    for (const n of graphData.nodes) {
      const p = seedPositions.get(n.id)
      if (p === undefined) continue
      n.x = p.x
      n.y = p.y
      n.vx = 0
      n.vy = 0
    }
    layoutSeeded = true
    seedAlpha = assemblyEntry?.baseAlpha ?? 0
    perfMark.layoutSource = "cache"
  } else if (prebuiltLayout !== null) {
    // 等比缩放：构建期坐标算在 refWidth×refHeight 的参考画布上，而画布尺寸只经
    // radial 力的半径参与布局（forceCenter() 不带参数，中心恒为原点），故按
    // min(w,h) 之比整体缩放即可保形；尺度差异随后由 zoomToFit 的相机吸收。
    // 尺寸相同时系数恰为 1（浮点上也是精确的 1），坐标逐位等于产物值。
    // ⚠️ 快照语义之二（阶段5.10 波A-R2）：seedScale 系**构造期一次性播种读取**，
    // 禁止随 resize 重算。重算 = 每开一次右栏就把全部 6202 个节点的坐标整体平移缩放
    // 一遍（等于把 resize 变成一次全图重排），且破坏「往返零漂移」——基线坐标与
    // 产物值的逐位等同关系一旦按新尺寸再缩放就不可逆。尺度差异本就由相机（zoomToFit
    // 与 syncSize 的左上锚定补偿）吸收，布局侧无须跟随。
    const seedScale =
      Math.min(width, height) / Math.min(prebuiltLayout.refWidth, prebuiltLayout.refHeight)
    for (const n of graphData.nodes) {
      const p = prebuiltLayout.pos[n.id]
      // 覆盖完整性已在取回处逐节点校验过，此处的守卫只是不信任兜底
      if (p === undefined) continue
      n.x = p[0] * seedScale
      n.y = p[1] * seedScale
      n.vx = 0
      n.vy = 0
    }
    layoutSeeded = true
    seedAlpha = prebuiltLayout.alpha
    perfMark.layoutSource = "prebuilt"
  }
  perfMark.layoutSeeded = layoutSeeded

  if (fitViewEnabled && enableZoom) {
    simulation.stop()
    if (layoutSeeded) {
      // 播种路径：布局已是现成的收敛态，只需把 alpha 摆到播种源当时那一档——
      // <alphaMin 即坐标取自自然收敛终态（模块快照的收敛版本、或构建期产物），
      // 置 0 表示无剩余演化可跑；否则按该 alpha 让力导接着把剩下的路走完
      //（与 restoreBaseLayout 的分流同一条判据）
      simulation.alpha(seedAlpha < simulation.alphaMin() ? 0 : seedAlpha)
    } else {
      runSyncTicks(PREWARM_MAX_TICKS, PREWARM_TARGET_ALPHA)
    }
    // 全景基线快照（需求4）：预热收敛之后、落相机之前取，作为此后一切重布局的
    // 确定性起点。取在此处而非 tick 回调里，是因为这一刻的坐标唯一且可复现——
    // 同一数据集、同一力参数、同一 tick 数必得同一组坐标（d3-force 无随机源，
    // 唯一例外是两点坐标完全重合时 1e-6 量级的 jiggle，已收敛布局不触发）。
    captureBaseLayout()
    // 首帧尚未呈现（pixi autoStart:false，animate 循环在下方才启动），
    // 此处无过渡落相机不产生可见跳变
    applyFitView(false)
    if (simulation.alpha() < PREWARM_TARGET_ALPHA) {
      // 布局已达标：自动入框任务就此完成，撤掉 800ms 兜底定时器；
      // 同时使下方 tick 回调的 alpha 分支因 zoomToFitDone 短路，不再重复入框
      zoomToFitDone = true
      clearTimeout(zoomToFitTimer)
    }
    // 未达标（预算耗尽的超大图）则保留兜底：后续真实 tick 的 alpha 首降或 800ms
    // 定时器会再走一次 triggerZoomToFit，以 400ms 动画完成残余修正。
    //
    // 播种自收敛终态（alpha 已在 alphaMin 之下）的那一路**不 restart**，与
    // relayoutVisible 收敛后的处置同策——模块快照的收敛版本与构建期产物
    //（emitter 跑到 alpha<alphaMin 才产出，恒属此列）都走这一支：
    // d3 的 step 会先无条件跑一次完整 tick 再判停，
    // 而 forceCollide 不乘 alpha——那一 tick 足以把逐位复现的坐标推开零点几像素，
    // 「往返零漂移」随即不成立。拖拽仍能经 alphaTarget(1).restart() 正常唤醒力导。
    if (!(layoutSeeded && simulation.alpha() < simulation.alphaMin())) {
      simulation.restart()
    }
  }
  // 埋点（1.1）：首帧同步预热收尾（局部图 zoomToFit:false 时本段零成本，
  // 该刻与 nodesBuilt 相差无几，属预期）
  perfMark.prewarmed = performance.now()

  // ---------- 子集重布局（阶段5.3 需求4：点法域标签后可见子集就地收拢）----------
  // 病灶：法域切换只改 Sprite 可见性，剩下的一成节点仍钉在全景布局的原位——
  // 满屏空白里散着几簇孤点，既不成图也读不出结构（成因①）；相机又按全集取景，
  // 于是「点了标签什么也没发生」（成因②，已由 computeFitTransform 修）。
  // 对策：可见子集从全景基线出发、只受子集内边约束地再收敛一轮，随后整图入框。
  // 全程不重建实例（重建约 700ms），只换 simulation 的节点集与 link 力。
  // 本区状态（basePositions / baseAlpha / pendingRelayoutFit / baseAlphaDecay）声明在
  // 上方首帧预热块之前，原因见该处注释（预热块同步调用 captureBaseLayout，const 不提升）。

  function captureBaseLayout() {
    basePositions.clear()
    for (const n of graphData.nodes) {
      basePositions.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 })
    }
    baseAlpha = simulation.alpha()
  }

  /**
   * 把全景基线写回模块级缓存（阶段5.6 波2-2.2），供下一次同键实例播种。
   *
   * ⚠️ 写的只能是 basePositions（全景基线）与其 baseAlpha，**严禁**改写成读
   * n.x/n.y 的现值：法域过滤/域隐藏之后 simulation 跑的是可见子集，节点现值是那个
   * 子集的收敛态，一旦当作全景存进缓存，下一次打开就是「上一次筛选后的形状」。
   * basePositions 只由 captureBaseLayout 更新，而后者仅在预热收尾与「end 且跑的是
   * 全集」两处被调，天然是全景，这是本函数敢直接取用它的前提。
   *
   * new Map 是必须的浅拷贝：basePositions 会被 captureBaseLayout 就地 clear，
   * 直接存引用等于把缓存交给一个随时被清空的容器（值对象每次新建，不会被就地改写，
   * 故浅拷贝足够）。
   */
  const saveAssemblySnapshot = () => {
    if (assemblyEntry === null || basePositions.size === 0) return
    assemblyEntry.positions = new Map(basePositions)
    assemblyEntry.baseAlpha = baseAlpha
  }

  /**
   * 把节点拉回基线起点并清零速度。
   * fx/fy 刻意不动：拖拽期间只有 dragend 会置 null，而重布局由标签点击触发、
   * 与拖拽手势不可能同帧并发；越权清空反而会打断「拖住某点不放」的既有语义。
   */
  function resetToBaseLayout() {
    for (const n of graphData.nodes) {
      const p = basePositions.get(n.id)
      if (p === undefined) continue
      n.x = p.x
      n.y = p.y
      n.vx = 0
      n.vy = 0
    }
  }

  /**
   * 可见子集就地重布局：子集内力导收敛 → 整图入框。
   * 子集恒等于全集（无任何过滤）或为空集（全隐尽）时转 restoreBaseLayout——
   * 前者重布局无意义且会把全景抖成另一副样子，后者子集为空无从收敛。
   */
  function relayoutVisible() {
    if (basePositions.size === 0) captureBaseLayout()
    const visible = graphData.nodes.filter((n) => isNodeRenderVisible(n.id))
    if (visible.length === 0 || visible.length === graphData.nodes.length) {
      restoreBaseLayout()
      return
    }
    const visibleIds = new Set(visible.map((n) => n.id))
    const subLinks = graphData.links.filter(
      (l) => visibleIds.has(l.source.id) && visibleIds.has(l.target.id),
    )
    // 全量还原起点：不可见节点也一并归位，保证此后任何一次 restoreBaseLayout
    // 都能逐位复现首帧，跨标签往返零漂移
    resetToBaseLayout()
    simulation.stop()
    simulation.nodes(visible)
    // link 力必须整个换掉（d3 的 forceLink 在 initialize 时按传入的边集算 strength /
    // bias，就地改 links 不会重算）；charge/center/collide/radial 沿用——
    // 前三者只依赖 simulation.nodes()，nodes() 已在上一行换过；collide 的半径读
    // nodeRadius 闭包，与节点集无关，均无需重建
    simulation.force("link", forceLink<NodeData, LinkData>(subLinks).distance(linkDistance))
    simulation.alpha(SUBSET_ALPHA).alphaDecay(SUBSET_DECAY)
    runSyncTicks(SUBSET_TICKS, simulation.alphaMin())
    // 先按当前（可能只跑到一半的）布局落一次相机，保证点击即有响应
    applyFitView(true)
    if (simulation.alpha() >= SUBSET_SETTLED_ALPHA) {
      // 同步预算（PREWARM_BUDGET_MS，与首帧预热同一档）被超大子集吃满而未收敛：
      // 剩余部分交回力导自身的帧循环继续跑（与预热的兜底同策），用户看到的是子集
      // 逐帧收拢的动画而非半截静止的散点；alpha 落定后由 tick 回调补一次入框修正。
      // 终态不受分工影响：总 tick 数由 alpha 从 SUBSET_ALPHA 衰减到 alphaMin 唯一
      // 决定，同步跑几 tick、异步跑几 tick 只改变分界，确定性照旧。
      pendingRelayoutFit = true
      simulation.restart()
    } else {
      // 已收敛则停机不 restart：alpha 已触及 alphaMin，restart 只会多派一次 tick
      // 后立刻停；拖拽仍能经 alphaTarget(1).restart() 正常唤醒力导
      pendingRelayoutFit = false
    }
    markDirty()
  }

  /**
   * 还原全景基线：全量节点回到基线坐标、力导恢复全集，随后整图入框。
   * 「全部」标签与重置视图钮因此恒等于同一张全景，与中途切过几轮法域无关。
   *
   * 停机与否按 baseAlpha 分流（见其声明处）：
   *   · 基线已是自然收敛终态（baseAlpha<alphaMin，全图跑完后由 end 回调刷新）→
   *     直接停机。还原逐位复现基线，往返零漂移，这是稳态下的常规路径。
   *   · 基线还停在预热态（用户在全图跑完之前就点了标签）→ 按当时的 alpha 与默认
   *     衰减让力导把剩余演化跑完，随后 end 回调把基线换成这一终态，此后即进入
   *     上一条的稳态。不这么做的话，全景会被 alpha(0) 永久冻结在预热快照上——
   *     实测预热快照与自然收敛终态相差均值 95px / 最大 393px（世界坐标，全图包围盒
   *     约 2750px），肉眼可见地比用户点标签之前更松散。
   *     注意重放并非原轨迹的逐位复刻：起点速度被清零（原轨迹在该点带着速度），
   *     故终态与「一直不点标签」所得相差均值 2.91px / 最大 29.9px（同一量纲，
   *     入框后约 1px / 13px 屏幕像素）——同样收敛、观感无别，但不是同一组坐标。
   */
  function restoreBaseLayout() {
    if (basePositions.size === 0) captureBaseLayout()
    // 焦点环随之清除：本函数是「回到初始全景」的落地动作（重置视图钮与「全部」
    // 标签共用），与 resetView 同语义，故沿用其清 focus 高亮的行为。
    // relayoutVisible 刻意不清——定位到的节点若在子集内仍可见，保留标记更有用；
    // 若已被过滤掉，setTermFieldFilter/setSectionHidden 那一步早已清掉。
    focusedNodeId = null
    // 回基线即作废在途的子集收尾入框（否则残余 tick 会把相机再拽回子集取景）
    pendingRelayoutFit = false
    resetToBaseLayout()
    simulation.stop()
    simulation.nodes(graphData.nodes)
    simulation.force("link", forceLink<NodeData, LinkData>(graphData.links).distance(linkDistance))
    simulation.alphaDecay(baseAlphaDecay)
    if (baseAlpha >= simulation.alphaMin()) {
      simulation.alpha(baseAlpha).restart()
    } else {
      simulation.alpha(0)
    }
    applyFitView(true)
    markDirty()
  }

  // 力导 tick 驱动 dirty；zoomToFit 在 alpha 首降 <0.3（布局大致成形）时触发
  simulation.on("tick", () => {
    markDirty()
    // 子集重布局的收尾入框（同步预算未跑完时才有）：alpha 落定即补一次 400ms 修正
    if (pendingRelayoutFit && simulation.alpha() < SUBSET_SETTLED_ALPHA) {
      pendingRelayoutFit = false
      applyFitView(true)
    }
    if (fitViewEnabled && enableZoom && !zoomToFitDone && simulation.alpha() < 0.3) {
      triggerZoomToFit()
    }
  })

  // 全景基线刷新（需求4）：力导自然收敛（alpha<alphaMin 派发 end）且当前跑的是**全集**
  // 时，把基线更新为这一收敛终态——此后「全部」还原就是逐位复现用户离开时的那张全景。
  // 判节点数不可省：子集重布局跑完同样派 end，若不区分就会把子集坐标写成全景基线，
  // 基线从此被污染（切回「全部」得到的是上一次子集的形状）。
  simulation.on("end", () => {
    if (simulation.nodes().length !== graphData.nodes.length) return
    captureBaseLayout()
    // 写回模块级缓存（波2-2.2）：此刻的基线是自然收敛终态，是最值得播种的一版——
    // 下一次同键打开据它落座，首帧即终态、零预热
    saveAssemblySnapshot()
  })

  // ---------- 局部图截断 badge（V4-B1）----------
  let truncationNote: HTMLButtonElement | null = null
  if (truncatedTotal > truncatedShown) {
    truncationNote = document.createElement("button")
    truncationNote.type = "button"
    truncationNote.className = "graph-truncation-note"
    truncationNote.textContent = `已显示 ${truncatedShown}/${truncatedTotal} 个关联`
    truncationNote.title = "关联节点已按相关度截断，点击前往图谱总览查看全部"
    truncationNote.addEventListener("click", (e) => {
      e.stopPropagation()
      const targ = resolveRelative(fullSlug, "0-图谱总览/" as SimpleSlug)
      window.spaNavigate(new URL(targ, window.location.toString()))
    })
    graph.appendChild(truncationNote)
  }

  // ---------- 帧循环：dirty 时才同步位置、批量画边并 render ----------

  function syncPositions() {
    for (const n of nodeRenderData) {
      const { x, y } = n.simulationData
      if (!x || !y) continue
      n.gfx.position.set(x + width / 2, y + height / 2)
      // 门控（1.2）：隐藏的标签不必逐帧搬位置——力导跑动期间这是每帧 6,200 次
      // 无意义的 Transform 写入与脏标记。转可见的那一刻由 syncLabelRender 补一次坐标，
      // 且本函数在 animate 里排在标签同步之后，同帧内必被重新定位
      if (n.label.visible) {
        n.label.position.set(x + width / 2, y + height / 2)
      }
    }
  }

  function drawLinks() {
    linkGfx.clear()
    const ox = width / 2
    const oy = height / 2

    // 选中态：仅当前锚点与直接相关节点之间的边提亮，其他边只降低透明度；
    // 直接相关边加粗，暗边保持原线宽。闪烁帧不重绘此处（见 animate）
    if (selectedNodeId !== null) {
      let hasRelated = false
      let relatedStroke: ReturnType<typeof selectedLinkStroke> | null = null
      for (const l of linkRenderData) {
        const d = l.simulationData
        if (d.source.x === undefined || d.source.y === undefined) continue
        if (d.target.x === undefined || d.target.y === undefined) continue
        if (!isLinkRenderVisible(d)) continue
        const related = isSelectedAnchorLink(selectedNodeId, d.source.id, d.target.id)
        if (!related) continue
        relatedStroke = selectedLinkStroke(selectedNodeId, d.source.id, d.target.id)
        linkGfx.moveTo(d.source.x + ox, d.source.y + oy)
        linkGfx.lineTo(d.target.x + ox, d.target.y + oy)
        hasRelated = true
      }
      if (hasRelated) {
        const stroke = relatedStroke ?? { width: 1.6, alpha: 1 }
        linkGfx.stroke({ width: stroke.width, color: linkActiveColor, alpha: stroke.alpha })
      }

      let hasOther = false
      let otherStroke: ReturnType<typeof selectedLinkStroke> | null = null
      for (const l of linkRenderData) {
        const d = l.simulationData
        if (d.source.x === undefined || d.source.y === undefined) continue
        if (d.target.x === undefined || d.target.y === undefined) continue
        if (!isLinkRenderVisible(d)) continue
        if (isSelectedAnchorLink(selectedNodeId, d.source.id, d.target.id)) continue
        otherStroke = selectedLinkStroke(selectedNodeId, d.source.id, d.target.id)
        linkGfx.moveTo(d.source.x + ox, d.source.y + oy)
        linkGfx.lineTo(d.target.x + ox, d.target.y + oy)
        hasOther = true
      }
      if (hasOther) {
        const stroke = otherStroke ?? { width: 1, alpha: 0.2 }
        linkGfx.stroke({ width: stroke.width, color: linkColor, alpha: stroke.alpha })
      }
      return
    }

    // 批 1：普通边（dimmed 模式下术语边另批），整批一次 stroke
    let hasNormal = false
    for (const l of linkRenderData) {
      if (l.active) continue
      const d = l.simulationData
      if (d.source.x === undefined || d.source.y === undefined) continue
      if (d.target.x === undefined || d.target.y === undefined) continue
      if (isDimmedLink(d)) continue
      if (!isLinkRenderVisible(d)) continue
      linkGfx.moveTo(d.source.x + ox, d.source.y + oy)
      linkGfx.lineTo(d.target.x + ox, d.target.y + oy)
      hasNormal = true
    }
    if (hasNormal) {
      linkGfx.stroke({ width: 1, color: linkColor, alpha: linkTweenState.fade })
    }

    // 批 1b：dimmed 模式下的术语关联边，恒压 DIMMED_ALPHA 上限
    if (termMode === "dimmed") {
      let hasDimmed = false
      for (const l of linkRenderData) {
        if (l.active) continue
        const d = l.simulationData
        if (d.source.x === undefined || d.source.y === undefined) continue
        if (d.target.x === undefined || d.target.y === undefined) continue
        if (!isDimmedLink(d)) continue
        if (!isLinkRenderVisible(d)) continue
        linkGfx.moveTo(d.source.x + ox, d.source.y + oy)
        linkGfx.lineTo(d.target.x + ox, d.target.y + oy)
        hasDimmed = true
      }
      if (hasDimmed) {
        linkGfx.stroke({
          width: 1,
          color: linkColor,
          alpha: Math.min(DIMMED_ALPHA, linkTweenState.fade),
        })
      }
    }

    // 批 2：hover 邻边覆盖层——active 边加宽、用 --graphLinkActive 色，
    // 整层透明度由 linkTweenState.overlay 驱动（替代原每边独立 alpha tween）
    if (linkTweenState.overlay > 0.01) {
      let hasActive = false
      for (const l of linkRenderData) {
        if (!l.active) continue
        const d = l.simulationData
        if (d.source.x === undefined || d.source.y === undefined) continue
        if (d.target.x === undefined || d.target.y === undefined) continue
        if (!isLinkRenderVisible(d)) continue
        linkGfx.moveTo(d.source.x + ox, d.source.y + oy)
        linkGfx.lineTo(d.target.x + ox, d.target.y + oy)
        hasActive = true
      }
      if (hasActive) {
        linkGfx.stroke({ width: 1.6, color: linkActiveColor, alpha: linkTweenState.overlay })
      }
    }
  }

  function drawFocusRing() {
    focusGfx.clear()
    if (focusedNodeId === null) return
    const n = nodeRenderDataById.get(focusedNodeId)
    if (n === undefined) return
    const { x, y } = n.simulationData
    if (x === undefined || y === undefined) return
    focusGfx
      .circle(x + width / 2, y + height / 2, n.radius + 3)
      .stroke({ width: 2, color: computedStyleMap["--secondary"], alpha: 0.9 })
  }

  let stopAnimation = false
  function animate(time: number) {
    if (stopAnimation) return

    let tweensActive = false
    tweens.forEach((t) => {
      t.update(time)
      if (t.active()) tweensActive = true
    })
    // tween 活跃走 markDirty 而非只置 dirty：边的整层透明度（linkTweenState.fade/overlay）
    // 是**烘进** drawLinks 的批次里的，tween 每帧改它就必须重建边批次，
    // 只置 dirty 会让边的渐变卡在上一帧的透明度上
    if (tweensActive) markDirty()

    if (dirty) {
      // 本帧的新建纹理配额（阶段5.6 A）：按实测单标签成本折算成条数，
      // 使集中光栅化摊成每帧约 LABEL_RASTER_BUDGET_MS 的快速渐显而非一帧长卡。
      labelRasterBudget = Math.max(
        LABEL_RASTER_MIN_BATCH,
        Math.min(LABEL_RASTER_MAX_BATCH, Math.round(LABEL_RASTER_BUDGET_MS / labelRasterCostMs)),
      )
      labelRasterPending = false
      labelRasterThisFrame = 0
      // 缩放事件推迟到帧内合并处理（见 zoom 回调）：一帧多个滚轮事件只重算一次透明度
      if (labelOpacityDirty) {
        labelOpacityDirty = false
        updateLabelOpacities()
      }
      // 门控（1.2）：tween 每帧都在改 label.alpha（hover/选中/渐隐），labelWanted 必须
      // 跟着重算，否则会出现「alpha 已拉起、visible 还是 false」的该出不出。
      // 放在 syncPositions 之前：本帧转可见的标签随即被 syncPositions 定位。
      // 纯比较 + 偶发赋值，无分配，稳态下这一趟对 6,202 个节点约几十微秒。
      // 视口边界也在此刷新：力导跑动、拖拽、缩放动画都会改坐标或变换
      refreshLabelViewport()
      for (const n of nodeRenderData) {
        const want = wantsLabel(n)
        if (n.labelWanted !== want) n.labelWanted = want
        syncLabelRender(n)
      }
      // 几何重建只在几何真的变了时才做（阶段5.6 E）：缩放帧走 markViewDirty，
      // 节点坐标与边批次在世界坐标里未变，跳过这三趟纯属白拿
      if (geometryDirty) {
        syncPositions()
        drawLinks()
        drawFocusRing()
      }
      // 逐帧给 render 计时（阶段5.6 A）：两次 performance.now() 约 0.05µs，相对 5-10ms
      // 的帧成本可忽略，换来的是光栅化成本的**在线自校正**——单标签成本随机型、dpr、
      // 标题长度浮动，写死常数必然在某类机器上要么卡顿要么渐显过慢。
      // 埋点（1.1）：首帧的记录仍只做一次。可见标签数在 render 之后统计：本轮渲染收集
      // 已结束，二者之间无可见性写入，计数即这一帧真正被光栅化的标签量
      const renderStart = performance.now()
      app.renderer.render(stage)
      const renderEnd = performance.now()
      const renderMs = renderEnd - renderStart
      if (perfMark.firstFrame === null) {
        perfMark.firstFrame = renderEnd
        perfMark.firstRenderMs = renderMs
        perfMark.frameMs = perfMark.returned > 0 ? perfMark.firstFrame - perfMark.returned : null
        let visibleLabels = 0
        for (const n of nodeRenderData) {
          if (n.label.visible) visibleLabels++
        }
        perfMark.firstFrameVisibleLabels = visibleLabels
        logGraphPerfMark(perfMark)
      }
      // 成本自校正：有新建纹理的帧，其超出基线的部分即光栅化开销；无新建的帧刷新基线。
      // 夹紧上下界防止个别异常帧（GC、窗口切换）把估计打飞
      if (labelRasterThisFrame > 0) {
        const extra = renderMs - renderBaseMs
        if (extra > 0) {
          const sample = extra / labelRasterThisFrame
          labelRasterCostMs = Math.min(1, Math.max(0.02, labelRasterCostMs * 0.7 + sample * 0.3))
        }
      } else {
        renderBaseMs = renderBaseMs * 0.9 + renderMs * 0.1
      }
      dirty = false
      geometryDirty = false
      // 本帧被配额挡下的标签，下一帧接着补——不续帧就会停在半途，
      // 收敛后的可见集必须与门控原实现逐个相同。几何未变，只需重绘
      if (labelRasterPending) markViewDirty()
    }
    requestAnimationFrame(animate)
  }

  requestAnimationFrame(animate)

  // 交叉淡入起手（J2）：同步构建到此为止，新画布下一帧即可画出内容——
  // animate 先于本处的 rAF 注册，故第一帧先渲染内容、第二帧才拉起 opacity，
  // 淡入全程有画面。有旧节点才淡入；容器本就空（首次渲染）时无底图可交叉，
  // 直接回调 retire，避免调用方的旧实例无人接管而成为孤儿。
  // 调用方在本函数返回后的同一微任务链里 applyTransform（恢复缩放平移），
  // 早于下一帧 rAF，故淡入首帧呈现的已是恢复后的视野
  if (crossfade) {
    if (stale.length > 0) {
      startCrossfade(graph, app.canvas, stale, swap?.retire)
    } else {
      swap?.retire?.()
    }
  }

  // ---------- 实例控制方法（GraphController 经此代理）----------

  function focusNode(target: SimpleSlug): boolean {
    const n = nodeRenderDataById.get(target)
    if (n === undefined) return false
    // 不可见节点（域隐藏 / 术语法域过滤）定位无效：调用方据此给出对应提示
    if (!isNodeRenderVisible(target)) return false
    // BUG-2（V5-B）：定位一旦发生，本实例的自动 zoomToFit 作废——
    // 置完成标志并清 800ms 兜底定时器；力导 tick 的 alpha 首降触发分支
    // 同受 zoomToFitDone 约束，不会再把 focus 居中拉回全景
    zoomToFitDone = true
    clearTimeout(zoomToFitTimer)
    focusedNodeId = target
    markDirty()
    const { x, y } = n.simulationData
    if (zoomBehavior !== null && x !== undefined && y !== undefined) {
      // 保持当前缩放级别，仅 400ms 平移把目标节点带到画布中心
      const k = currentTransform.k
      const t = zoomIdentity
        .translate(width / 2 - k * (x + width / 2), height / 2 - k * (y + height / 2))
        .scale(k)
      select<HTMLCanvasElement, NodeData>(app.canvas)
        .transition()
        .duration(400)
        .call(zoomBehavior.transform, t)
    }
    return true
  }

  function applyTermMode(mode: Exclude<TermLayerMode, "hidden">) {
    if (termMode === mode) return
    termMode = mode
    // 仅透明度切换：节点 alpha 走既有 tween 管线，标签立即重算，边按帧重绘自然生效
    updateLabelOpacities()
    renderPixiFromD3()
    markDirty()
  }

  function getTransform(): SavedTransform | null {
    if (zoomBehavior === null) return null
    return { k: currentTransform.k, x: currentTransform.x, y: currentTransform.y, width, height }
  }

  function applyTransform(saved: SavedTransform): void {
    if (zoomBehavior === null) return
    // 外部恢复变换视为用户视角已确定：本实例自动 zoomToFit 作废（与 focus 同语义）
    zoomToFitDone = true
    clearTimeout(zoomToFitTimer)
    // 以旧画布中心对应的世界坐标为锚点，按新画布尺寸重算平移：
    // 缩放级别 k 原样保留，视野中心在 resize 前后指向同一世界坐标
    const cx = (saved.width / 2 - saved.x) / saved.k
    const cy = (saved.height / 2 - saved.y) / saved.k
    const t = zoomIdentity
      .translate(width / 2 - saved.k * cx, height / 2 - saved.k * cy)
      .scale(saved.k)
    select<HTMLCanvasElement, NodeData>(app.canvas).call(zoomBehavior.transform, t)
    markDirty()
  }

  function resetView() {
    focusedNodeId = null
    markDirty()
    applyFitView(true)
  }

  // 本实例是否已停机（destroyInstance 幂等所需）：GPU 释放被推迟后，
  // 「已下令销毁但纹理尚未释放」存在一段窗口，期间重复调用不得再排一次释放
  let instanceDisposed = false

  function destroyInstance() {
    if (instanceDisposed) return
    instanceDisposed = true
    // 写回坐标快照（波2-2.2）：力导常常还没跑到 end 用户就离开了（SPA 导航、
    // 术语层重建、themechange），此处补一次，使「打开→离开→再打开」也能播种。
    // 写的仍是全景基线而非节点现值，理由见 saveAssemblySnapshot
    saveAssemblySnapshot()
    // 停机部分立即执行：rAF 循环、力导、补间、截断 badge 一律就地了断，
    // 不留孤儿——延后的只有 app.destroy() 这一步纯 GPU 资源释放
    stopAnimation = true
    clearTimeout(zoomToFitTimer)
    clearTimeout(zoomFreezeTimer)
    simulation.stop()
    tweens.forEach((t) => t.stop())
    tweens.clear()
    truncationNote?.remove()
    truncationNote = null
    // J3：GPU 释放延后到「旧画布已出图层树」的提交之后。
    // 根因（CDP 帧证据 2026-08-12，Electron 43，玄夜暗下 SPA 导航 8/10 复现）：
    // SPA nav 的时序是「prenav 清理里同步 app.destroy() → micromorph 摘掉旧画布
    // → nav 处理器同步构建新图，主线程阻塞约 60–120ms」。纹理在第一步就被释放，
    // 而摘除旧画布要等主线程让出后才提交，中间这段窗口合成器仍按旧图层树出帧，
    // 拿不到纹理即把整块画布区绘成纯白——白帧稳定落在点击后 +18~+39ms。
    // 延后后，该窗口内合成器复用的是仍然有效的旧图层（视觉上即旧图多留几十毫秒，
    // 与不闪白的那两成用例本就同一观感），提交完成后再释放，无帧可坏。
    // 交叉淡入（themechange）路径同受益且零回归：本延后只会让释放更晚，
    // e44efa9 的「DOM 收尾后再延两帧」时序原样保留，绝不提前。
    deferPastCommit(() => {
      app.destroy()
      // 共享几何池的释放（1.4）：以 `new Graphics({ context })` 传入的 context 不归
      // Graphics 所有，Graphics.destroy 与 app.destroy 都不会连带释放它
      //（pixi 8 只在 _ownedContext 非空时销毁）。不显式销毁，每建一次实例就漏一批
      // GPU 几何缓冲——图谱页来回进出十几次即可观。
      for (const ctx of ctxPool.values()) ctx.destroy()
      ctxPool.clear()
    })
  }

  // 埋点（1.1）：返回前收口并入档。firstFrame/frameMs/firstFrameVisibleLabels 三项
  // 由 animate 首帧就地补写到**同一对象**上（marks 里存的是引用），故外部探针可以
  // 先读到记录、再轮询等首帧字段落定
  perfMark.returned = performance.now()
  perfMark.total = perfMark.returned - perfMark.t0
  perfMark.buildMs = perfMark.nodesBuilt - perfMark.appReady
  pushGraphPerfMark(perfMark)

  return {
    focus: focusNode,
    applyTermMode,
    getTermMode: () => termMode,
    setSectionHidden,
    setTermFieldFilter,
    getTermFieldCount,
    isNodeVisible: (nodeId: SimpleSlug) =>
      nodeRenderDataById.has(nodeId) && isNodeRenderVisible(nodeId),
    relayoutVisible,
    restoreBaseLayout,
    setSelected,
    getSelected,
    isInSelectedSet: (nodeId: SimpleSlug) => selectedNodeId !== null && selectedSet.has(nodeId),
    getTransform,
    applyTransform,
    resetView,
    destroy: destroyInstance,
  }
}

/**
 * 渲染入口：返回 GraphController（V4-B1，替代原 cleanup 函数返回值）。
 * controller 本身可调用（等价 destroy()），graphexplorer.inline.ts 的旧签名
 * `graphCleanup?.()` 无需改动即可继续工作。
 * V5-B BUG-1：新增可选第三参 termOverride——外部全量重建（themechange/resize）
 * 时传入上一实例的术语层模式，覆盖 data-cfg 初始值，避免重建后回落默认。
 * J2：新增可选第四参 swap——themechange 路径传 {crossfade:true, retire}，
 * 新画布叠加淡入、淡入完成后经 retire 销毁旧实例（先建后毁）；不传即原行为。
 */
async function renderGraph(
  graph: HTMLElement,
  fullSlug: FullSlug,
  termOverride?: TermLayerMode,
  swap?: GraphSwapOptions,
): Promise<GraphController> {
  let instance = await createGraphInstance(graph, fullSlug, termOverride, swap)
  let destroyed = false
  // 术语层 hidden↔其它的重建是串行的：切换期间的并发调用按顺序排队
  let switching: Promise<void> = Promise.resolve()
  // 域隐藏状态（v12 / v17）：controller 级持有域**组号**，重建（术语层 hidden /
  // 外部重建）后恢复
  const hiddenSections = new Set<string>()
  const applyHiddenTo = (inst: GraphInstance) => {
    for (const s of hiddenSections) inst.setSectionHidden(s, true)
  }
  applyHiddenTo(instance)
  // 选中态（v14）：controller 级持有，重建后恢复（renderCanvas 重建路径由调用方恢复）。
  // 用 const 对象包装规避 TS 对闭包捕获 let 变量的流分析收窄
  const selectedBox: { nodeId: SimpleSlug | null; hops: 1 | 2 } = { nodeId: null, hops: 1 }
  const applySelectedTo = (inst: GraphInstance) => {
    if (selectedBox.nodeId !== null) inst.setSelected(selectedBox.nodeId, selectedBox.hops)
  }
  applySelectedTo(instance)
  // 术语法域过滤态（阶段5.3 需求6）：controller 级持有，术语层 hidden↔其它的重建
  // 后重放。重放必须**排在** hiddenSections 与选中态恢复之后——可见子集由两层过滤
  // 合取而成，域显隐没落定就 relayout，收敛出的是错的子集形状。
  // null = 不过滤（FIELD_ALL 在入口归一）
  const fieldBox: { field: string | null } = { field: null }
  const applyFieldTo = (inst: GraphInstance) => {
    if (fieldBox.field === null) return
    inst.setTermFieldFilter(fieldBox.field)
    // 重建后节点回到新实例的首帧全景布局，须重跑一次子集收拢才与重建前同形
    inst.relayoutVisible()
  }
  applyFieldTo(instance)

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    instance.destroy()
  }

  const controller: GraphController = Object.assign(destroy, {
    destroy,
    focus: (slug: SimpleSlug) => (destroyed ? false : instance.focus(slug)),
    getTermLayer: () => instance.getTermMode(),
    setSectionHidden: (groupId: string, hidden: boolean) => {
      if (destroyed) return
      if (hidden) {
        hiddenSections.add(groupId)
      } else {
        hiddenSections.delete(groupId)
      }
      instance.setSectionHidden(groupId, hidden)
    },
    getHiddenSections: () => new Set(hiddenSections),
    setTermFieldFilter: (field: string | null) => {
      if (destroyed) return
      fieldBox.field = field === null || field === FIELD_ALL ? null : field
      instance.setTermFieldFilter(field)
    },
    getTermFieldCount: (field: string) => (destroyed ? 0 : instance.getTermFieldCount(field)),
    isNodeVisible: (nodeId: SimpleSlug) => !destroyed && instance.isNodeVisible(nodeId),
    relayoutVisible: () => {
      if (!destroyed) instance.relayoutVisible()
    },
    restoreBaseLayout: () => {
      if (!destroyed) instance.restoreBaseLayout()
    },
    setSelected: (nodeId: SimpleSlug | null, hops: 1 | 2 = 1) => {
      if (destroyed) return
      selectedBox.nodeId = nodeId
      selectedBox.hops = hops
      instance.setSelected(nodeId, hops)
    },
    getSelected: () => instance.getSelected(),
    getSelectedHops: () => (instance.getSelected() === null ? 1 : selectedBox.hops),
    isInSelectedSet: (nodeId: SimpleSlug) => instance.isInSelectedSet(nodeId),
    setTermLayer: (mode: TermLayerMode): Promise<void> => {
      switching = switching.then(async () => {
        if (destroyed) return
        const current = instance.getTermMode()
        if (mode === current) return
        if (mode === "hidden" || current === "hidden") {
          // 重建路径（合法路径）：hidden 影响数据集构成，须销毁后按新模式重渲
          instance.destroy()
          const next = await createGraphInstance(graph, fullSlug, mode)
          // 排队语义保持（V5-B）：重建等待期间若外部已 destroy（如 renderCanvas
          // 全量重建路径），丢弃刚建好的实例，避免两条重建路径产生孤儿渲染实例
          if (destroyed) {
            next.destroy()
            return
          }
          instance = next
          // 重建后恢复域隐藏状态（v12）
          applyHiddenTo(instance)
          // 重建后恢复选中态（v14）
          applySelectedTo(instance)
          // 重建后恢复术语法域过滤 + 子集重布局（阶段5.3 需求4/6，须排在上面两项之后）
          applyFieldTo(instance)
        } else {
          // dimmed↔shown：仅透明度切换，不重建
          instance.applyTermMode(mode as Exclude<TermLayerMode, "hidden">)
        }
      })
      return switching
    },
    getTransform: () => (destroyed ? null : instance.getTransform()),
    applyTransform: (saved: SavedTransform) => {
      if (!destroyed) instance.applyTransform(saved)
    },
    resetView: () => {
      if (!destroyed) instance.resetView()
    },
  })

  return controller
}

// 把渲染入口暴露到 window，供图谱总览专页脚本（graphexplorer.inline.ts）复用同一渲染管线。
// 各 inline 脚本会被分别独立打包，若 explorer 直接 import 本文件将重复打包 d3 与 pixi.js
// 并重复注册本文件的 nav 监听，故以全局函数方式共享。
// V4-B1 契约变更：返回值由 cleanup 函数升级为 GraphController（本身仍可调用=destroy，
// 旧调用方直接 `cleanup()` 依旧成立；新能力经 focus/setTermLayer/resetView 暴露）。
// V5-B 契约扩展：新增可选第三参 termOverride（TermLayerMode）——外部重建时传入
// 上一实例的术语层模式以覆盖 data-cfg 初始值；controller 另暴露
// getTransform/applyTransform 供 resize 重建路径快照/恢复缩放平移。
declare global {
  interface Window {
    __graphRender?: typeof renderGraph
    /** 常设性能埋点存档（阶段5.6 波1-1.1）：最近 10 次 createGraphInstance 的耗时切片 */
    __graphPerf?: { marks: GraphPerfMark[] }
    /**
     * 构建期预计算坐标的取数 Promise（阶段5.6 波3-3.1），首个调用方发起、其余共享。
     * 与 __graphIndex 不同，本项只有本文件消费（graphexplorer.inline.ts 不读坐标），
     * 故类型声明留在本文件的 declare global 内，不进 index.d.ts。
     *
     * 术语层 hidden 档（static/graphLayout.json）。
     */
    __graphLayout?: Promise<PrebuiltLayout | null>
    /**
     * 术语层 shown／dimmed 档（static/graphLayout-terms.json）的取数 Promise。
     * 与上一项分开存放，使两档各自去重、互不覆盖；本位在用户首次切到显示档之前
     * 恒为 undefined——那一档的字节因此不进初始态的下载账。
     */
    __graphLayoutTerms?: Promise<PrebuiltLayout | null>
  }
}
window.__graphRender = renderGraph
window.__graphPerf = graphPerf

// themechange 重建防抖窗口：主题卡连点时只重建最后一次
const THEME_CHANGE_DEBOUNCE_MS = 120

let localGraphControllers: GraphController[] = []
let globalGraphControllers: GraphController[] = []

function cleanupLocalGraphs() {
  for (const controller of localGraphControllers) {
    controller.destroy()
  }
  localGraphControllers = []
}

function cleanupGlobalGraphs() {
  for (const controller of globalGraphControllers) {
    controller.destroy()
  }
  globalGraphControllers = []
}

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const slug = e.detail.url
  addToVisited(simplifySlug(slug))

  // crossfade（J2）：仅 themechange 路径传 true——旧实例撑到新画布淡入完成才销毁
  //（app.destroy 会 loseContext 令旧画布立即变空，销毁必须后置），
  // SPA nav 路径保持销毁在前（跨页交叉淡入无意义且会串页）
  async function renderLocalGraph(crossfade = false) {
    const stale = localGraphControllers
    localGraphControllers = []
    const retire = () => {
      for (const controller of stale) controller.destroy()
    }
    if (!crossfade) retire()
    const localGraphContainers = document.getElementsByClassName("graph-container")
    let rendered = 0
    for (const container of localGraphContainers) {
      localGraphControllers.push(
        await renderGraph(
          container as HTMLElement,
          slug,
          undefined,
          crossfade ? { crossfade: true, retire } : undefined,
        ),
      )
      rendered++
    }
    // 一个容器都没渲染（页面无局部图）时旧实例无人接管，就地销毁
    if (rendered === 0) retire()
  }

  await renderLocalGraph()

  const containers = [...document.getElementsByClassName("global-graph-outer")] as HTMLElement[]
  async function renderGlobalGraph(crossfade = false) {
    // 先销毁既有全局图实例：图标连点 / 主题重建路径都会重复调用本函数，
    // 不先 cleanup 则旧 controller 失去引用却仍持有 pixi 实例与 rAF 循环（孤儿实例）。
    // crossfade 路径（themechange）例外：销毁后置到淡入收尾，见 renderLocalGraph 注释
    const stale = globalGraphControllers
    globalGraphControllers = []
    const retire = () => {
      for (const controller of stale) controller.destroy()
    }
    if (!crossfade) retire()
    const slug = getFullSlug(window)
    let rendered = 0
    for (const container of containers) {
      container.classList.add("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) {
        sidebar.style.zIndex = "1"
      }

      const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
      registerEscapeHandler(container, hideGlobalGraph)
      if (graphContainer) {
        globalGraphControllers.push(
          await renderGraph(
            graphContainer,
            slug,
            undefined,
            crossfade ? { crossfade: true, retire } : undefined,
          ),
        )
        rendered++
      }
    }
    if (rendered === 0) retire()
  }

  function hideGlobalGraph() {
    cleanupGlobalGraphs()
    for (const container of containers) {
      container.classList.remove("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) {
        sidebar.style.zIndex = ""
      }
    }
  }

  // 主题切换重渲染：图内颜色是创建期的 getComputedStyle 快照，必须重建实例才换色。
  // 注册位置在 containers 声明之后（此前挂在其上方，靠函数声明提升才成立，
  // 是 const 的 TDZ 阅读陷阱）。
  // 修 bug#4(b)：此前只重建局部图，全局图弹窗打开期间切主题不换色；
  // 现检测 .active 容器并重建弹窗（renderGlobalGraph 开头已自带旧实例接管，
  // 无需在此重复销毁）。
  // 120ms trailing 防抖：设置页连点主题卡会连发 themechange，
  // 不防抖则每次都触发一轮全量重建（局部图 + 弹窗），重建排队即卡顿。
  // J2：本路径（且仅本路径）走交叉淡入——新画布叠加淡入、旧实例后置销毁，
  // 消除重建间隙的空白帧与颜色硬切。
  let themeChangeTimer: ReturnType<typeof setTimeout> | undefined
  const handleThemeChange = () => {
    clearTimeout(themeChangeTimer)
    themeChangeTimer = setTimeout(() => {
      void renderLocalGraph(true)
      if (containers.some((container) => container.classList.contains("active"))) {
        void renderGlobalGraph(true)
      }
    }, THEME_CHANGE_DEBOUNCE_MS)
  }

  document.addEventListener("themechange", handleThemeChange)
  window.addCleanup(() => {
    // 未决的防抖回调必须撤销：导航后触发会按旧 slug 重建到已被替换的 DOM 上
    clearTimeout(themeChangeTimer)
    document.removeEventListener("themechange", handleThemeChange)
  })

  async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
    if (e.key === "g" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      const anyGlobalGraphOpen = containers.some((container) =>
        container.classList.contains("active"),
      )
      anyGlobalGraphOpen ? hideGlobalGraph() : renderGlobalGraph()
    }
  }

  // 包一层再挂监听：renderGlobalGraph 现有首参 crossfade，直接作监听器会把
  // MouseEvent 当成 crossfade（真值）传入，误开图标点击路径的交叉淡入
  const onGlobalGraphIconClick = () => {
    void renderGlobalGraph()
  }
  const containerIcons = document.getElementsByClassName("global-graph-icon")
  Array.from(containerIcons).forEach((icon) => {
    icon.addEventListener("click", onGlobalGraphIconClick)
    window.addCleanup(() => icon.removeEventListener("click", onGlobalGraphIconClick))
  })

  document.addEventListener("keydown", shortcutHandler)
  window.addCleanup(() => {
    document.removeEventListener("keydown", shortcutHandler)
    cleanupLocalGraphs()
    cleanupGlobalGraphs()
  })
})
