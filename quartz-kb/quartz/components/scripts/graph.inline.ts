import type { ContentDetails } from "../../plugins/emitters/contentIndex"
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
import { Text, Graphics, Application, Container, Circle } from "pixi.js"
// ==== patent-kb: 让 PixiJS 不依赖 'unsafe-eval' ====
// PixiJS 8 默认以字符串生成 shader / uniform / UBO / 粒子的同步代码，需要 CSP 放行
// 'unsafe-eval'。官方为此提供了本子模块：副作用导入即执行 selfInstall()，把这些
// 代码路径整体替换为等价的 polyfill 实现，并关掉内部的 unsafeEval 可用性检查。
// 有了它，desktop/server.cjs 下发的 CSP 才能去掉 'unsafe-eval'。
import "pixi.js/unsafe-eval"
// ==== /patent-kb ====
import { Group as TweenGroup, Tween as Tweened } from "@tweenjs/tween.js"
import { registerEscapeHandler, removeAllChildren } from "./util"
import { FullSlug, SimpleSlug, getFullSlug, resolveRelative, simplifySlug } from "../../util/path"
import {
  isGraphBackgroundClick,
  isSelectedAnchorLink,
  selectedLinkStroke,
  shouldShowLabelDuringSelection,
} from "../../util/graphInteraction"
import { D3Config, TermLayerMode } from "../Graph"

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
}

/**
 * 专利知识库定制：按节点 slug 的顶层目录数字前缀映射域色板——**兜底值**。
 * 内容目录形如「1-审查指南/…」…「7-xxx/…」（七部工具书各一色），
 * 「9-关键词索引/…」为术语词条，统一使用靛蓝。
 *
 * 色值真源已迁至 `quartz/styles/custom.scss` 的六套主题覆盖块：每套主题的
 * light/dark 两块各定义 --graph-section-1..9，随主题与明暗切换而变。
 * 本表仅在 CSS 变量缺失时兜底（变量未定义 / getComputedStyle 返回空串，
 * 例如样式表尚未生效、或第三方复用本脚本却未引入主题层），保证图谱不至于失色。
 * 改配色请改 custom.scss；此处九色只作为最后一道保险，勿当作事实源维护。
 */
const SECTION_COLORS_FALLBACK: Record<string, string> = {
  "1": "#d1495b", // 玫红
  "2": "#e07b39", // 橙
  "3": "#b8860b", // 暗金
  "4": "#4c9f70", // 绿
  "5": "#2a9d8f", // 青
  "6": "#4381c1", // 蓝
  "7": "#8e6bbf", // 紫
  "8": "#c26f9e", // 粉紫（预留）
  "9": "#3f51b5", // 靛蓝：关键词索引（术语词条）
}

/** 术语层节点判定：slug 顶层目录为「9-关键词索引」（以 9- 开头） */
function isTermSlug(id: string): boolean {
  return id.startsWith("9-")
}

// 局部图（depth>=1）节点数上限：一跳邻居 p99=73，超限按确定性排序截断
const MAX_LOCAL_NODES = 60
// 术语层 dimmed 模式下节点/边的透明度
const DIMMED_ALPHA = 0.15
// 节点半径上限：一级（书根）与总入口基础半径 + 弱化度数修正后截顶，
// 避免高度数枢纽节点吞掉版面
const MAX_NODE_RADIUS = 13

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
 * 淡入收尾时才移除旧节点并回调 retire——消除「旧画布销毁 → 新画布就绪」之间的
 * 空白帧与颜色硬切。SPA nav、术语层 hidden 重建等既有路径一律不传，行为不变。
 */
export type GraphSwapOptions = {
  /** true：先建后毁 + 新画布淡入；false/不传：保持「先清空容器再建」的原路径 */
  crossfade: boolean
  /**
   * 淡入收尾（transitionend 或硬超时先到者）时调用，由调用方销毁旧渲染实例。
   * 销毁必须后置到此刻：app.destroy() 内部会 loseContext
   *（pixi.js 8 GlContextSystem.destroy），WebGL 画布随即被清空——提前销毁则底图
   * 先行消失，交叉淡入退化成「从空白淡入」，空白帧并未真正消除。
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
  /** 切换某域（slug 顶层数字前缀）节点与相关边的可见性（就地切换，不重建） */
  setSectionHidden(sectionId: string, hidden: boolean): void
  /** 当前隐藏的域集合副本 */
  getHiddenSections(): Set<string>
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
  /** 就地切换某域节点与相关边可见性（不重建、不改变力导布局） */
  setSectionHidden(sectionId: string, hidden: boolean): void
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
 * 并回调 retire 销毁旧渲染实例。收尾由 transitionend（仅 opacity）与硬超时竞争，
 * 先到者执行且只执行一次。
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
  let timer: ReturnType<typeof setTimeout> | undefined
  const onTransitionEnd = (ev: TransitionEvent) => {
    if (ev.propertyName === "opacity") finish()
  }
  const finish = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    canvas.removeEventListener("transitionend", onTransitionEnd)
    if (pendingSwaps.get(graph) === finish) pendingSwaps.delete(graph)
    for (const node of stale) node.remove()
    style.position = ""
    style.inset = ""
    style.opacity = ""
    style.transition = ""
    retire?.()
  }
  canvas.addEventListener("transitionend", onTransitionEnd)
  timer = setTimeout(finish, CROSSFADE_TIMEOUT_MS)
  pendingSwaps.set(graph, finish)

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

  // excludeSlugs 归一化：配置值带不带尾斜杠均可命中
  //（目录 index 页的 simplifySlug 形如「0-图谱总览/」，带尾斜杠）
  const excluded = new Set<string>()
  for (const raw of excludeSlugs ?? []) {
    const base = raw.endsWith("/") ? raw.slice(0, -1) : raw
    excluded.add(base)
    excluded.add(base + "/")
  }

  // 节点准入判定：excludeSlugs 命中的节点始终不进数据集；
  // termLayer:"hidden" 时术语节点（9- 前缀）与其关联边同样不进数据集
  const includeNode = (id: SimpleSlug): boolean =>
    !excluded.has(id) && !(termHidden && isTermSlug(id))

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

  const data: Map<SimpleSlug, ContentDetails> = new Map(
    Object.entries<ContentDetails>(await fetchData).map(([k, v]) => [
      simplifySlug(k as FullSlug),
      v,
    ]),
  )
  const links: SimpleLinkData[] = []
  const tags: SimpleSlug[] = []
  const validLinks = new Set(data.keys())

  const tweens = new Map<string, TweenNode>()
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
  const adjacency = new Map<SimpleSlug, SimpleSlug[]>()
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

  // 局部图 top-60 截断（V4-B1）：depth>=1 且邻居数超上限时按确定性排序保留前 60 个。
  // 排序权重：同书（顶层目录前缀与当前页一致）> 非术语（非 9- 前缀）> 全局度数升序，
  // 末位以 slug 字典序兜底保证确定性。
  let truncatedTotal = 0 // 截断前邻居总数 M
  let truncatedShown = 0 // 截断后显示邻居数 N
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
  const nodeById = new Map<SimpleSlug, NodeData>(nodes.map((n) => [n.id, n]))
  const graphData: { nodes: NodeData[]; links: LinkData[] } = {
    nodes,
    links: links
      .filter((l) => neighbourhood.has(l.source) && neighbourhood.has(l.target))
      .map((l) => ({
        source: nodeById.get(l.source)!,
        target: nodeById.get(l.target)!,
      })),
  }

  // 节点度数预计算：替代原 nodeRadius 内对 graphData.links 的全量扫描
  const nodeDegree = new Map<SimpleSlug, number>()
  for (const l of graphData.links) {
    nodeDegree.set(l.source.id, (nodeDegree.get(l.source.id) ?? 0) + 1)
    nodeDegree.set(l.target.id, (nodeDegree.get(l.target.id) ?? 0) + 1)
  }
  /** 目录层级（slug 段数）→ 基础半径；层级越深越小（v13）。
   * 0 段总入口（图谱总览=专利知识库）12px / 2 段=书根 10px /
   * 3 段=章·节·条款 5.5px / 4 段+（审查指南小节）3.5px；
   * 术语层节点单独下调一档（shown 全量 1000 节点时避免拥挤）；tags 回落 3px。 */
  function levelRadius(id: string): number {
    if (id.startsWith("tags/")) return 3
    const depth = id.split("/").filter(Boolean).length
    if (id.startsWith("0-")) return 12
    if (isTermSlug(id)) return depth >= 3 ? 3.5 : 5.5
    if (depth >= 4) return 3.5
    if (depth === 3) return 5.5
    return 10
  }

  function nodeRadius(d: NodeData) {
    // 层级基础半径 + 弱化度数修正（同层级内 hub 节点略大），仍受 MAX_NODE_RADIUS 封顶。
    // 一级（书根/总入口）不带度数修正——固定尺寸保持一级间视觉梯度，避免全部冲顶
    const base = levelRadius(d.id)
    const boost = base >= 10 ? 0 : 0.3 * Math.sqrt(nodeDegree.get(d.id) ?? 0)
    return Math.min(base + boost, MAX_NODE_RADIUS)
  }

  const width = graph.offsetWidth
  const height = Math.max(graph.offsetHeight, 250)

  // we virtualize the simulation and use pixi to actually render it
  const simulation: Simulation<NodeData, LinkData> = forceSimulation<NodeData>(graphData.nodes)
    .force("charge", forceManyBody().strength(-100 * repelForce))
    .force("center", forceCenter().strength(centerForce))
    .force("link", forceLink(graphData.links).distance(linkDistance))
    .force("collide", forceCollide<NodeData>((n) => nodeRadius(n)).iterations(3))

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
    // 域色板（D1）：九个键必须逐个字面写出——computedStyleMap 的键类型取自
    // 本元组的字面量联合（`Record<(typeof cssVars)[number], string>`），
    // 用循环生成会退化为 string 而丢掉类型约束
    "--graph-section-1",
    "--graph-section-2",
    "--graph-section-3",
    "--graph-section-4",
    "--graph-section-5",
    "--graph-section-6",
    "--graph-section-7",
    "--graph-section-8",
    "--graph-section-9",
  ] as const
  const computedStyleMap = cssVars.reduce(
    (acc, key) => {
      acc[key] = getComputedStyle(document.documentElement).getPropertyValue(key)
      return acc
    },
    {} as Record<(typeof cssVars)[number], string>,
  )

  // 图谱标签字体：优先 --graphFont（主题层定义的黑体栈，中文小字号下更清晰）；
  // 变量未定义时 getComputedStyle 返回空串，回退 --bodyFont，行为与原版一致
  const graphFontFamily = computedStyleMap["--graphFont"].trim() || computedStyleMap["--bodyFont"]

  // 边色 token（V4-B1）：--graphLink / --graphLinkActive 由主题层（custom.scss）定义；
  // 变量为空串时回落原 --lightgray / --gray 行为
  const linkColor = computedStyleMap["--graphLink"].trim() || computedStyleMap["--lightgray"]
  const linkActiveColor = computedStyleMap["--graphLinkActive"].trim() || computedStyleMap["--gray"]

  // 域色取值（D1）：真源是 CSS 变量 --graph-section-1..9（custom.scss 六主题
  // × light/dark 覆盖块），故必须走本实例的 computedStyleMap 快照——这也是本函数
  // 从模块级下沉进 createGraphInstance 的原因（需要闭包持有快照）。
  // 主题切换后由外层重建实例重新取快照，无需在此监听。
  // 两处硬约束：
  //   1) 必须 .trim()——getPropertyValue 返回值常带前导空格，PixiJS 解析色值会失败；
  //   2) 空串（变量未定义）回落 SECTION_COLORS_FALLBACK。
  // 无编号前缀的 slug 返回 undefined，由调用方回落原生配色。
  const sectionColor = (id: string): string | undefined => {
    const section = id.match(/^(\d+)-/)?.[1]
    if (section === undefined) return undefined
    const varName = `--graph-section-${section}` as (typeof cssVars)[number]
    return computedStyleMap[varName]?.trim() || SECTION_COLORS_FALLBACK[section]
  }

  // calculate color
  // 定制：当前节点仍用主题色 --secondary；其余节点优先按顶层目录域色板着色
  // （色值取自主题变量 --graph-section-N，见上方 sectionColor）；
  // 无编号前缀的节点回落到原生规则（已访问/tag 节点用 --tertiary，其它用 --gray）
  const color = (d: NodeData) => {
    const isCurrent = d.id === slug
    if (isCurrent) {
      return computedStyleMap["--secondary"]
    }

    const domainColor = sectionColor(d.id)
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

  // 域隐藏（v12）：图例点击切换某文档域（slug 顶层数字前缀）的节点与相关边可见性。
  // 就地切换——不动数据集、不改力导布局，仅控制 Sprite visible 与边绘制过滤；
  // 与术语层 hidden（重建数据集）互不干扰。
  const hiddenSections = new Set<string>()
  const sectionOf = (id: string): string | undefined => id.match(/^(\d+)-/)?.[1]
  const isSectionHiddenNode = (id: string): boolean =>
    hiddenSections.size > 0 && sectionOf(id) !== undefined && hiddenSections.has(sectionOf(id)!)
  const isSectionHiddenLink = (l: LinkData): boolean =>
    isSectionHiddenNode(l.source.id) || isSectionHiddenNode(l.target.id)

  function setSectionHidden(sectionId: string, hidden: boolean) {
    if (hidden) {
      hiddenSections.add(sectionId)
    } else {
      hiddenSections.delete(sectionId)
    }
    // 节点与标签 Sprite 直接切换 visible（隐藏后不参与命中测试）
    for (const n of nodeRenderData) {
      if (sectionOf(n.simulationData.id) !== sectionId) continue
      n.gfx.visible = !hidden
      n.label.visible = !hidden
    }
    // 被隐藏域内的 focus 高亮环一并清除（drawFocusRing 按帧绘制，避免悬空圆环）
    if (hidden && focusedNodeId !== null && sectionOf(focusedNodeId) === sectionId) {
      focusedNodeId = null
    }
    // hover 邻居信息若引用被隐藏节点，立即清空（避免 active 边引用不可见端点）
    if (hoveredNodeId !== null && isSectionHiddenNode(hoveredNodeId)) {
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

  // dirty-flag 按需渲染（V4-B1）：仅在力导 tick / tween 活跃 / zoom / drag / hover
  // 触发时渲染一帧；力导停机（alpha<alphaMin）后稳态 CPU≈0
  let dirty = true
  const markDirty = () => {
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

  for (const n of graphData.nodes) {
    const nodeId = n.id

    const label = new Text({
      interactive: false,
      eventMode: "none",
      text: n.text,
      alpha: 0,
      anchor: { x: 0.5, y: 1.2 },
      style: {
        fontSize: fontSize * 15,
        fill: computedStyleMap["--dark"],
        fontFamily: graphFontFamily,
      },
      resolution: window.devicePixelRatio * 4,
    })
    label.scale.set(1 / scale)

    let oldLabelOpacity = 0
    const isTagNode = nodeId.startsWith("tags/")
    const r = nodeRadius(n)
    const gfx = new Graphics({
      interactive: true,
      label: nodeId,
      eventMode: "static",
      hitArea: new Circle(0, 0, r),
      cursor: "pointer",
    })
      .circle(0, 0, r)
      .fill({ color: isTagNode ? computedStyleMap["--light"] : color(n) })
      .on("pointerdown", () => {
        // 空白点击判定（v14）：记录节点命中时刻
        lastNodeHitAt = Date.now()
      })
      .on("pointerover", (e) => {
        updateHoverInfo(e.target.label)
        oldLabelOpacity = label.alpha
        if (!dragging) {
          renderPixiFromD3()
        }
        markDirty()
      })
      .on("pointerleave", () => {
        updateHoverInfo(null)
        label.alpha = oldLabelOpacity
        if (!dragging) {
          renderPixiFromD3()
        }
        markDirty()
      })

    if (isTagNode) {
      gfx.stroke({ width: 2, color: computedStyleMap["--tertiary"] })
    }

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
      color: color(n),
      alpha: 1,
      active: false,
      radius: r,
    }

    nodeRenderData.push(nodeRenderDatum)
    nodeRenderDataById.set(nodeId, nodeRenderDatum)
  }

  for (const l of graphData.links) {
    linkRenderData.push({
      simulationData: l,
      active: false,
    })
  }

  let currentTransform = zoomIdentity
  if (enableDrag) {
    select<HTMLCanvasElement, NodeData | undefined>(app.canvas).call(
      drag<HTMLCanvasElement, NodeData | undefined>()
        .container(() => app.canvas)
        // Map 取端点，替代 nodes.find（O(N) 病灶）
        .subject(() =>
          hoveredNodeId !== null ? nodeById.get(hoveredNodeId as SimpleSlug) : undefined,
        )
        .on("start", function dragstarted(event) {
          if (!event.active) simulation.alphaTarget(1).restart()
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
        })
        .on("drag", function dragged(event) {
          const initPos = event.subject.__initialDragPos
          event.subject.fx = initPos.x + (event.x - initPos.x) / currentTransform.k
          event.subject.fy = initPos.y + (event.y - initPos.y) / currentTransform.k
        })
        .on("end", function dragended(event) {
          if (!event.active) simulation.alphaTarget(0)
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
    for (const n of nodeRenderData) {
      // hover 高亮中的标签透明度交给 tween，缩放不覆盖
      if (n.active) continue
      if (
        selectedNodeId !== null &&
        !shouldShowLabelDuringSelection(selectedNodeId, selectedSet, n.simulationData.id)
      ) {
        n.label.alpha = 0
        n.label.scale.set(1 / scale)
        continue
      }
      // 选中节点标签由 renderLabels 拉起（v16），缩放不覆盖
      if (selectedNodeId !== null && n.simulationData.id === selectedNodeId) continue
      n.label.alpha = isDimmedNode(n.simulationData.id) ? 0 : scaleOpacity
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
      .on("zoom", ({ transform }) => {
        currentTransform = transform
        stage.scale.set(transform.k, transform.k)
        stage.position.set(transform.x, transform.y)

        // zoom adjusts opacity of labels too
        updateLabelOpacities()
        markDirty()
      })
    select<HTMLCanvasElement, NodeData>(app.canvas).call(zoomBehavior)
  }

  // ---------- zoomToFit（V4-B1）----------

  /** 按当前节点包围盒计算“整图入框”的 zoom 变换；无有效节点时返回 null */
  function computeFitTransform(): ZoomTransform | null {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of graphData.nodes) {
      if (n.x === undefined || n.y === undefined) continue
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
    if (!isFinite(minX) || !isFinite(minY)) return null
    const PAD = 40
    const bw = maxX - minX + PAD * 2
    const bh = maxY - minY + PAD * 2
    const k = Math.max(
      scaleExtentRange[0],
      Math.min(scaleExtentRange[1], 0.9 * Math.min(width / bw, height / bh)),
    )
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
  if (fitViewEnabled && enableZoom) {
    simulation.stop()
    const prewarmStartedAt = performance.now()
    let prewarmTicks = 0
    while (simulation.alpha() >= PREWARM_TARGET_ALPHA && prewarmTicks < PREWARM_MAX_TICKS) {
      simulation.tick()
      prewarmTicks++
      if (
        prewarmTicks % PREWARM_CHECK_INTERVAL === 0 &&
        performance.now() - prewarmStartedAt > PREWARM_BUDGET_MS
      ) {
        break
      }
    }
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
    // 定时器会再走一次 triggerZoomToFit，以 400ms 动画完成残余修正
    simulation.restart()
  }

  // 力导 tick 驱动 dirty；zoomToFit 在 alpha 首降 <0.3（布局大致成形）时触发
  simulation.on("tick", () => {
    markDirty()
    if (fitViewEnabled && enableZoom && !zoomToFitDone && simulation.alpha() < 0.3) {
      triggerZoomToFit()
    }
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
      if (n.label) {
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
        if (isSectionHiddenLink(d)) continue
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
        if (isSectionHiddenLink(d)) continue
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
      if (isSectionHiddenLink(d)) continue
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
        if (isSectionHiddenLink(d)) continue
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
        if (isSectionHiddenLink(d)) continue
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
    if (tweensActive) dirty = true

    if (dirty) {
      syncPositions()
      drawLinks()
      drawFocusRing()
      app.renderer.render(stage)
      dirty = false
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
    // 域隐藏的节点不可见：定位无效（调用方应提示“该域已隐藏”）
    if (isSectionHiddenNode(target)) return false
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

  function destroyInstance() {
    stopAnimation = true
    clearTimeout(zoomToFitTimer)
    simulation.stop()
    tweens.forEach((t) => t.stop())
    tweens.clear()
    truncationNote?.remove()
    truncationNote = null
    app.destroy()
  }

  return {
    focus: focusNode,
    applyTermMode,
    getTermMode: () => termMode,
    setSectionHidden,
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
  // 域隐藏状态（v12）：controller 级持有，重建（术语层 hidden / 外部重建）后恢复
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

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    instance.destroy()
  }

  const controller: GraphController = Object.assign(destroy, {
    destroy,
    focus: (slug: SimpleSlug) => (destroyed ? false : instance.focus(slug)),
    getTermLayer: () => instance.getTermMode(),
    setSectionHidden: (sectionId: string, hidden: boolean) => {
      if (destroyed) return
      if (hidden) {
        hiddenSections.add(sectionId)
      } else {
        hiddenSections.delete(sectionId)
      }
      instance.setSectionHidden(sectionId, hidden)
    },
    getHiddenSections: () => new Set(hiddenSections),
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
  }
}
window.__graphRender = renderGraph

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
