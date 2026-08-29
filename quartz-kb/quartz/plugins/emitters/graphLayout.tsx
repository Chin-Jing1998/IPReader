import fs from "fs"
import path from "path"
import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
  forceRadial,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force"
import { FullSlug, SimpleSlug, joinSegments, simplifySlug } from "../../util/path"
import { QuartzEmitterPlugin } from "../types"
import { write } from "./helpers"
import type { GraphContentDetails } from "./contentIndex"
import { GRAPH_EXCLUDE, SETTINGS_EXCLUDE, GRAPH_HIDDEN_BOOKS } from "../../util/appPages"

/**
 * 构建期预计算全景坐标（阶段5.6 波3-3.1）。
 *
 * 目的：图谱总览首次打开时，运行期无需从 d3 的 phyllotaxis 初值起跑同步预热
 * （波2 后实测中位 229ms，占首开耗时的近一半），直接把节点摆到构建期算好的收敛
 * 终态上，首帧即定形。产物 static/graphLayout.json，消费方是
 * components/scripts/graph.inline.ts 的播种回落链第②级。
 *
 * ⚠️ 明确不复用 site/data/layout-baseline.json（阶段5.6 波3 裁决，三条理由）：
 *   1) 键系不通——那份基线以生成器侧的条目 id 为键，本产物以 Quartz 的 SimpleSlug
 *      为键（simplifySlug 归一后的站点路径），两套标识之间没有恒等映射；
 *   2) 覆盖不全——那份基线只覆盖生成器登记过的条目，本图谱的节点集是
 *      contentIndex 全量页面按 excludeSlugs／术语层过滤后的结果，二者出入很大；
 *   3) 算法形态不同——那份基线服务于另一套版面布局，不是本图 d3-force 五力
 *      （charge/center/link/collide/radial）的收敛解，拿来播种等于播一组错坐标。
 *
 * ⚠️ 与运行期的耦合点（改任一侧都必须同改，否则 key 不匹配、产物被静默忽略，
 * 图谱回落到预热路径——功能不坏但收益归零）：
 *   · 数据集构造（下方 buildDataset）逐字复刻 graph.inline.ts 的组装段；
 *   · 力参数（下方 FORCE_*／levelRadius／nodeRadius）逐字复刻 graph.inline.ts；
 *   · 图配置（termLayer/showTags/excludeSlugs）取自 GraphExplorer.tsx 的
 *     explorerGraphConfig，其 excludeSlugs 与本文件同源于 util/appPages.ts。
 */

// ---------- 与 GraphExplorer.tsx 的 explorerGraphConfig 对齐的图配置 ----------

/** 术语层 hidden 档：术语节点（9- 前缀）不进数据集，与专页初始态一致 */
const TERM_HIDDEN = true
/** 专页与 globalGraph 均为 false；为 true 时 tag 节点入图，本产物不覆盖那一档 */
const SHOW_TAGS = false
/** 专页 removeTags: []（showTags 为 false 时不生效，仍入 key 以与运行期同构） */
const REMOVE_TAGS: string[] = []
/** 排除前缀：与 GraphExplorer.tsx 的 excludeSlugs 同源同序（quartz.layout.ts 的 globalGraph 同值） */
const EXCLUDE_SLUGS: string[] = [GRAPH_EXCLUDE, SETTINGS_EXCLUDE, ...GRAPH_HIDDEN_BOOKS]

// ---------- 力参数（逐字复刻 graph.inline.ts:1131-1138）----------

const REPEL_FORCE = 0.6 // explorerGraphConfig.repelForce
const CENTER_FORCE = 0.2 // explorerGraphConfig.centerForce
const LINK_DISTANCE = 30 // explorerGraphConfig.linkDistance
const ENABLE_RADIAL = true // explorerGraphConfig.enableRadial
const COLLIDE_ITERATIONS = 3 // graph.inline.ts: forceCollide(...).iterations(3)
const RADIAL_STRENGTH = 0.2 // graph.inline.ts: forceRadial(radius).strength(0.2)
const RADIAL_RADIUS_FACTOR = 0.8 // graph.inline.ts: (Math.min(width, height) / 2) * 0.8
const MAX_NODE_RADIUS = 13 // graph.inline.ts:204
const LEAF_R = 3.5 // graph.inline.ts:1105

/**
 * 参考画布尺寸：图谱总览专页 .ge-canvas 在 1440×900 主窗口（desktop/main.cjs 的默认
 * 尺寸）下的实测 offsetWidth/offsetHeight —— 2026-08-29 探针实测 1060×646，
 * 首帧与稳定态同值（右侧面板初始即占位，不再二次收窄）。
 *
 * 画布尺寸只经 radial 力的半径影响布局（forceCenter() 不带参数，中心恒为原点
 * (0,0)，与画布无关）。故运行期画布若非此尺寸，按 min(w,h) 之比等比缩放播种即可
 * ——等比缩放保形，且 zoomToFit 会把整图重新入框，尺度差异由相机吸收。
 */
export const REF_WIDTH = 1060
export const REF_HEIGHT = 646

/** d3-force 默认 alphaMin，跑到它之下即认定收敛（默认 alphaDecay 下约 300 tick） */
export const ALPHA_MIN = 0.001
/** tick 上限：只作跑飞兜底，正常在 300 tick 上下收敛；触顶即不产出 */
const MAX_TICKS = 2000

// ---------- 节点/边的最小形态（力学只用 index 与 x/y，text/tags 不参与）----------
//
// buildDataset / makeNodeRadius / makeSimulation / REF_WIDTH / REF_HEIGHT / ALPHA_MIN
// 对外导出，仅为让离线核验脚本（确定性自证：同一数据集跑两遍断言坐标逐位相同；
// 形态回归闸：与运行期自然收敛终态逐节点比对）复用**同一份实现**而非另抄一遍——
// 抄一遍就等于给自己发一张永远对得上的成绩单。emit 之外无生产调用方。

export type LayoutNode = { id: SimpleSlug } & SimulationNodeDatum
export type LayoutLink = {
  source: LayoutNode
  target: LayoutNode
} & SimulationLinkDatum<LayoutNode>

/** 术语层节点判定，逐字复刻 graph.inline.ts:145 */
function isTermSlug(id: string): boolean {
  return id.startsWith("9-")
}

/**
 * 数据集组装：逐字复刻 graph.inline.ts:891-1026 的未命中缓存分支（depth<0 全量图路径）。
 *
 * 顺序即一切——ids 的顺序就是 d3 的 node index 顺序，links 的顺序决定 forceLink 每
 * tick 的累加次序，浮点加法不满足结合律，顺序一变收敛解就是另一组坐标。故三处顺序
 * 必须与运行期同构：contentIndex 的键序 → validLinks（Map 键序）→ [...neighbourhood]。
 */
export function buildDataset(rawIndex: Record<string, GraphContentDetails>) {
  const excluded = new Set<string>()
  const excludedPrefixes: string[] = []
  for (const raw of EXCLUDE_SLUGS) {
    const base = raw.endsWith("/") ? raw : raw + "/"
    excluded.add(base)
    excluded.add(base.slice(0, -1))
    excludedPrefixes.push(base)
  }
  const includeNode = (id: SimpleSlug): boolean =>
    !(excluded.has(id) || excludedPrefixes.some((p) => id.startsWith(p))) &&
    !(TERM_HIDDEN && isTermSlug(id))

  const data: Map<SimpleSlug, GraphContentDetails> = new Map(
    Object.entries<GraphContentDetails>(rawIndex).map(([k, v]) => [simplifySlug(k as FullSlug), v]),
  )
  const rawLinks: Array<{ source: SimpleSlug; target: SimpleSlug }> = []
  const validLinks = new Set(data.keys())

  for (const [source, details] of data.entries()) {
    if (!includeNode(source)) continue
    const outgoing = details.links ?? []
    for (const dest of outgoing) {
      if (validLinks.has(dest) && includeNode(dest)) {
        rawLinks.push({ source: source, target: dest })
      }
    }
    // 运行期在此处还有一段 showTags 分支（tag 节点与其边）。本产物只覆盖
    // SHOW_TAGS=false 一档（专页与 globalGraph 均为 false），故该分支不复刻；
    // SHOW_TAGS 是编译期常量，改为 true 时必须连同本段一并补齐，否则节点集与
    // 运行期不符——届时 key 里的 st= 与 n= 双双变化，运行期会拒绝这份产物。
  }

  const neighbourhood = new Set<SimpleSlug>()
  validLinks.forEach((id) => {
    if (includeNode(id)) neighbourhood.add(id)
  })

  const nodes: LayoutNode[] = [...neighbourhood].map((url) => ({ id: url }))
  const nodeById = new Map<SimpleSlug, LayoutNode>(nodes.map((n) => [n.id, n]))
  const links: LayoutLink[] = rawLinks
    .filter((l) => neighbourhood.has(l.source) && neighbourhood.has(l.target))
    .map((l) => ({ source: nodeById.get(l.source)!, target: nodeById.get(l.target)! }))

  const nodeDegree = new Map<SimpleSlug, number>()
  for (const l of links) {
    nodeDegree.set(l.source.id, (nodeDegree.get(l.source.id) ?? 0) + 1)
    nodeDegree.set(l.target.id, (nodeDegree.get(l.target.id) ?? 0) + 1)
  }

  return { nodes, links, nodeDegree, excluded }
}

/** 层级半径，逐字复刻 graph.inline.ts:1106-1115 */
function levelRadius(id: string): number {
  if (id.startsWith("tags/")) return 3
  if (id.startsWith("0-")) return 12
  if (isTermSlug(id)) return id.endsWith("/") ? 5.5 : LEAF_R
  if (!id.endsWith("/")) return LEAF_R
  const depth = id.split("/").filter(Boolean).length
  if (depth === 1) return 10
  if (depth === 2) return 7
  return 5.5
}

/** 碰撞半径，逐字复刻 graph.inline.ts:1117-1125 */
export function makeNodeRadius(nodeDegree: Map<SimpleSlug, number>) {
  return (d: LayoutNode): number => {
    const base = levelRadius(d.id)
    const boost = base <= LEAF_R || base >= 10 ? 0 : 0.3 * Math.sqrt(nodeDegree.get(d.id) ?? 0)
    return Math.min(base + boost, MAX_NODE_RADIUS)
  }
}

/**
 * 力导构造，逐字复刻 graph.inline.ts:1131-1138。
 * d3-force v3 无外部随机源：初值是确定性的 phyllotaxis 螺旋，唯一的随机调用是
 * 两点完全重合时 1e-6 量级的 jiggle，而它取自 simulation 自带的 LCG
 *（d3-force/src/lcg.js，固定种子 s=1），故整条演化轨迹逐位可复现。
 */
export function makeSimulation(
  nodes: LayoutNode[],
  links: LayoutLink[],
  nodeRadius: (d: LayoutNode) => number,
  width: number,
  height: number,
): Simulation<LayoutNode, LayoutLink> {
  const simulation = forceSimulation<LayoutNode>(nodes)
    .force("charge", forceManyBody<LayoutNode>().strength(-100 * REPEL_FORCE))
    .force("center", forceCenter<LayoutNode>().strength(CENTER_FORCE))
    .force("link", forceLink<LayoutNode, LayoutLink>(links).distance(LINK_DISTANCE))
    .force("collide", forceCollide<LayoutNode>((n) => nodeRadius(n)).iterations(COLLIDE_ITERATIONS))
  const radius = (Math.min(width, height) / 2) * RADIAL_RADIUS_FACTOR
  if (ENABLE_RADIAL) {
    simulation.force("radial", forceRadial<LayoutNode>(radius).strength(RADIAL_STRENGTH))
  }
  return simulation
}

/** 32 位 FNV-1a，输出 8 位 hex（key 只需稳定与低碰撞，不作安全用途） */
function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * 产物指纹：只由「运行期同样算得出」的量构成，运行期据此逐字符比对，不等即忽略产物。
 *
 * ⚠️ d3 版本刻意**不入 key**：graphLayout.json 与消费它的 graph.inline.ts bundle 是
 * 同一次 `npx quartz build` 的产出，二者所用的 d3-force 恒为同一份 node_modules，
 * 运行期也无从独立算出该版本号，写进 key 只会得到一个永远无法校验的字段。版本仍记入
 * meta.d3Force 供排障：升级 d3 后产物随下次构建自动重算，无需人工干预。
 */
function makeFingerprint(input: {
  entryCount: number
  nodeCount: number
  linkCount: number
  excludedSorted: string
}): string {
  return [
    "v1",
    `e=${input.entryCount}`,
    `n=${input.nodeCount}`,
    `l=${input.linkCount}`,
    `th=${TERM_HIDDEN ? 1 : 0}`,
    `st=${SHOW_TAGS ? 1 : 0}`,
    `rt=${REMOVE_TAGS.join(",")}`,
    `ex=${input.excludedSorted}`,
    `rf=${REPEL_FORCE}`,
    `cf=${CENTER_FORCE}`,
    `ld=${LINK_DISTANCE}`,
    `rad=${ENABLE_RADIAL ? 1 : 0}`,
  ].join("|")
}

/** d3-force 版本号（仅供排障；读不到不影响产出） */
function readD3ForceVersion(): string {
  try {
    const pkg = path.join(process.cwd(), "node_modules", "d3-force", "package.json")
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version as string
  } catch {
    return "unknown"
  }
}

export const GraphLayout: QuartzEmitterPlugin = () => {
  return {
    name: "GraphLayout",
    async *emit(ctx, content) {
      const started = Date.now()

      // ---------- 索引派生：与 ContentIndex 同法、同一批 content ----------
      // emitters 由 processors/emit.ts 以 Promise.all **并行**调度，故不能读
      // ContentIndex 刚写出的 static/contentIndexGraph.json（写入是否完成不确定），
      // 只能从同一份 content 自行派生。includeEmptyFiles 恒 true 对应
      // quartz.config.ts 里 ContentIndex 未传该项时的默认值。
      const graphIndex: Record<string, GraphContentDetails> = {}
      for (const [, file] of content) {
        const slug = file.data.slug!
        graphIndex[slug] = {
          slug,
          title: file.data.frontmatter?.title!,
          links: file.data.links ?? [],
          tags: file.data.frontmatter?.tags ?? [],
        }
      }
      const entryCount = Object.keys(graphIndex).length

      // 运行期拿到的是 fetch→JSON.parse 的结果，此处做一次同样的往返，
      // 使键序、数组身份、字段缺省与运行期完全同构（也顺带验证可序列化）
      const roundTripped = JSON.parse(JSON.stringify(graphIndex)) as Record<
        string,
        GraphContentDetails
      >
      const { nodes, links, nodeDegree, excluded } = buildDataset(roundTripped)

      // ---------- 自校验闸①：另一条派生路径的节点集必须逐一相等 ----------
      // 上面走的是「JSON 往返后的对象」，此处走「未经序列化的原始对象」，两条路径
      // 独立跑同一套准入判定。不等即说明序列化环节丢了字段或键序发生位移——
      // 那样的坐标播下去就是错图，宁可不产出、让运行期回落预热路径。
      const check = buildDataset(graphIndex)
      const nodeSetEqual =
        check.nodes.length === nodes.length &&
        nodes.every((n, i) => check.nodes[i].id === n.id) &&
        check.links.length === links.length
      if (!nodeSetEqual) {
        console.warn(
          `[GraphLayout] 节点集自校验未通过（往返 ${nodes.length}/${links.length} vs 直取 ${check.nodes.length}/${check.links.length}），` +
            `不产出 static/graphLayout.json，运行期将回落同步预热路径`,
        )
        return
      }
      if (nodes.length === 0) {
        console.warn(`[GraphLayout] 节点集为空，不产出 static/graphLayout.json`)
        return
      }

      // ---------- 跑至收敛 ----------
      const nodeRadius = makeNodeRadius(nodeDegree)
      const simulation = makeSimulation(nodes, links, nodeRadius, REF_WIDTH, REF_HEIGHT)
      // d3 的 forceSimulation 构造即自启内部 timer，构建期一律手动 tick，先停机
      simulation.stop()
      let ticks = 0
      while (simulation.alpha() >= ALPHA_MIN && ticks < MAX_TICKS) {
        simulation.tick()
        ticks += 1
      }
      const alpha = simulation.alpha()
      if (ticks >= MAX_TICKS) {
        console.warn(
          `[GraphLayout] ${MAX_TICKS} tick 后仍未收敛（alpha=${alpha}），不产出 static/graphLayout.json`,
        )
        return
      }

      // ---------- 自校验闸②：坐标必须逐点有限且覆盖全部节点 ----------
      const pos: Record<string, [number, number]> = {}
      for (const n of nodes) {
        const x = n.x
        const y = n.y
        if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
          console.warn(
            `[GraphLayout] 节点 ${n.id} 坐标非有限值（x=${x}, y=${y}），不产出 static/graphLayout.json`,
          )
          return
        }
        // 两位小数：世界坐标包围盒约 2,700px，0.01px 的精度远细于一个物理像素，
        // 而全量写满双精度会让产物膨胀近一倍
        pos[n.id] = [Math.round(x * 100) / 100, Math.round(y * 100) / 100]
      }
      if (Object.keys(pos).length !== nodes.length) {
        console.warn(`[GraphLayout] 坐标表条目数与节点数不符，不产出 static/graphLayout.json`)
        return
      }

      const fingerprint = makeFingerprint({
        entryCount,
        nodeCount: nodes.length,
        linkCount: links.length,
        excludedSorted: [...excluded].sort().join(","),
      })
      const payload = {
        key: `g1-${fnv1a(fingerprint)}`,
        fingerprint,
        refWidth: REF_WIDTH,
        refHeight: REF_HEIGHT,
        alpha,
        pos,
        meta: {
          ticks,
          nodes: nodes.length,
          links: links.length,
          entryCount,
          buildMs: Date.now() - started,
          d3Force: readD3ForceVersion(),
          radialRadius: (Math.min(REF_WIDTH, REF_HEIGHT) / 2) * RADIAL_RADIUS_FACTOR,
          collideIterations: COLLIDE_ITERATIONS,
          radialStrength: RADIAL_STRENGTH,
          maxNodeRadius: MAX_NODE_RADIUS,
        },
      }

      yield write({
        ctx,
        content: JSON.stringify(payload),
        slug: joinSegments("static", "graphLayout") as FullSlug,
        ext: ".json",
      })
    },
  }
}
