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
 * 专利知识库定制：按节点 slug 的顶层目录数字前缀映射域色板。
 * 内容目录形如「1-审查指南/…」…「7-xxx/…」（七部工具书各一色），
 * 「9-关键词索引/…」为术语词条，统一使用靛蓝。
 * 色板取中等明度，浅色（#faf8f8）与深色（#161618）背景下均可辨识。
 */
const SECTION_COLORS: Record<string, string> = {
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

/** 取 slug 顶层目录的数字前缀对应的域色；无编号前缀返回 undefined，回落到原生配色 */
function sectionColor(id: string): string | undefined {
  const match = id.match(/^(\d+)-/)
  return match ? SECTION_COLORS[match[1]] : undefined
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
  getTransform(): SavedTransform | null
  applyTransform(saved: SavedTransform): void
  resetView(): void
  destroy(): void
}

async function createGraphInstance(
  graph: HTMLElement,
  fullSlug: FullSlug,
  termOverride?: TermLayerMode,
): Promise<GraphInstance> {
  const slug = simplifySlug(fullSlug)
  const visited = getVisited()
  removeAllChildren(graph)

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
  const onNodeClick = (targetId: SimpleSlug) => {
    if (nodeClickMode === "panel") {
      graph.dispatchEvent(
        new CustomEvent("graphnodeselect", {
          detail: { slug: targetId },
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

  // calculate color
  // 定制：当前节点仍用主题色 --secondary；其余节点优先按顶层目录域色板着色；
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

      // dimmed 术语节点无标签：悬停也不拉起标签透明度
      if (hoveredNodeId === nodeId && !isDimmedNode(nodeId)) {
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

      // if we are hovering over a node, we want to highlight the immediate neighbours
      if (hoveredNodeId !== null && focusOnHover) {
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
  const linkGfx = new Graphics({ interactive: false, eventMode: "none" })
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
            onNodeClick((event.subject as NodeData).id)
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
    applyFitView(false)
  }
  if (fitViewEnabled && enableZoom) {
    // 兜底：力导 alpha 迟迟不降（节点极少或被拖拽）时 800ms 后强制入框
    zoomToFitTimer = setTimeout(triggerZoomToFit, 800)
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
 */
async function renderGraph(
  graph: HTMLElement,
  fullSlug: FullSlug,
  termOverride?: TermLayerMode,
): Promise<GraphController> {
  let instance = await createGraphInstance(graph, fullSlug, termOverride)
  let destroyed = false
  // 术语层 hidden↔其它的重建是串行的：切换期间的并发调用按顺序排队
  let switching: Promise<void> = Promise.resolve()
  // 域隐藏状态（v12）：controller 级持有，重建（术语层 hidden / 外部重建）后恢复
  const hiddenSections = new Set<string>()
  const applyHiddenTo = (inst: GraphInstance) => {
    for (const s of hiddenSections) inst.setSectionHidden(s, true)
  }
  applyHiddenTo(instance)

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

  async function renderLocalGraph() {
    cleanupLocalGraphs()
    const localGraphContainers = document.getElementsByClassName("graph-container")
    for (const container of localGraphContainers) {
      localGraphControllers.push(await renderGraph(container as HTMLElement, slug))
    }
  }

  await renderLocalGraph()
  const handleThemeChange = () => {
    void renderLocalGraph()
  }

  document.addEventListener("themechange", handleThemeChange)
  window.addCleanup(() => {
    document.removeEventListener("themechange", handleThemeChange)
  })

  const containers = [...document.getElementsByClassName("global-graph-outer")] as HTMLElement[]
  async function renderGlobalGraph() {
    const slug = getFullSlug(window)
    for (const container of containers) {
      container.classList.add("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) {
        sidebar.style.zIndex = "1"
      }

      const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
      registerEscapeHandler(container, hideGlobalGraph)
      if (graphContainer) {
        globalGraphControllers.push(await renderGraph(graphContainer, slug))
      }
    }
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

  async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
    if (e.key === "g" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      const anyGlobalGraphOpen = containers.some((container) =>
        container.classList.contains("active"),
      )
      anyGlobalGraphOpen ? hideGlobalGraph() : renderGlobalGraph()
    }
  }

  const containerIcons = document.getElementsByClassName("global-graph-icon")
  Array.from(containerIcons).forEach((icon) => {
    icon.addEventListener("click", renderGlobalGraph)
    window.addCleanup(() => icon.removeEventListener("click", renderGlobalGraph))
  })

  document.addEventListener("keydown", shortcutHandler)
  window.addCleanup(() => {
    document.removeEventListener("keydown", shortcutHandler)
    cleanupLocalGraphs()
    cleanupGlobalGraphs()
  })
})
