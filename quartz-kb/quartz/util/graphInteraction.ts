import type { SimpleSlug } from "./path"

export type SingleClickAction = "select" | "show" | "ignore"

// ============================================================
// 图谱总览页「图谱 ⇄ 左栏目录」联动的自定义事件（阶段5.3 批 B4 建立；阶段5.4 反转后仅存一条）
// ============================================================
// 事件名与 detail 形状放在本共享模块、不在两侧各写字面量：收发双方分处
// explorer.inline.ts 与 graphexplorer.inline.ts 两个独立挂载闭包，字面量一旦拼错
// 是静默失联（既不报错也不触发），TS 常量则在编译期就能挡住。
//
// 链路一律以 `getFullSlug(window) === appPages.GRAPH_SLUG` 门控，
// 非图谱页（含首页、内容页）不绑定、不派发，目录树行为与 DOM 一字不变。

// 阶段5.4：kb:graphlocate 随目录行为反转撤销（原目录⇒图谱定位契约），kb:graphfield 保留。

/**
 * 法域标签 → 目录分支过滤（方向：graphexplorer.inline.ts ⇒ document ⇒ explorer.inline.ts）。
 *
 * 派发时机：applyField() 收尾（含标签行点击与图例批量路径），以及「重置视图」
 * 回到全部态时。接收方对 field 层合成节点（`data-folderpath` 形如
 * `synthetic:CN/<field>`）的外层 `li` 切 `hidden` **属性**——只增删属性，
 * 不增删节点、不写折叠态存储。
 */
export const GRAPH_FIELD_EVENT = "kb:graphfield"

/** `kb:graphfield` 的 detail：当前法域标签，取 FIELD_TABS 之一或哨兵 FIELD_ALL（"*"）。 */
export type GraphFieldDetail = { field: string }

export type GraphLinkStroke = {
  width: number
  alpha: number
}

/** 决定图内节点和右侧栏节点按钮的单击行为。 */
export function resolveSingleClickAction(
  hasSelection: boolean,
  targetInSelectedSet: boolean,
): SingleClickAction {
  if (!hasSelection) return "select"
  return targetInSelectedSet ? "show" : "ignore"
}

/** 选中态只高亮当前锚点节点与其直接相连的边。 */
export function isSelectedAnchorLink(
  selectedNode: SimpleSlug | null,
  source: SimpleSlug,
  target: SimpleSlug,
): boolean {
  return selectedNode !== null && (source === selectedNode || target === selectedNode)
}

/** 选中态的直接关联边加粗，暗边仅降低透明度。 */
export function selectedLinkStroke(
  selectedNode: SimpleSlug | null,
  source: SimpleSlug,
  target: SimpleSlug,
): GraphLinkStroke {
  return isSelectedAnchorLink(selectedNode, source, target)
    ? { width: 1.6, alpha: 1 }
    : { width: 1, alpha: 0.2 }
}

/** 记录命中节点或连线后，短时间内的画布 click 不应被当作空白点击。 */
export function isGraphBackgroundClick(
  lastNodeHitAt: number,
  lastLinkHitAt: number,
  now: number,
  threshold = 300,
): boolean {
  return now - lastNodeHitAt >= threshold && now - lastLinkHitAt >= threshold
}

// ============================================================
// 拖拽手感参数（阶段5.10 波B）
// ============================================================
// 三个取值全部以 fullGraph 分流，且**只有局部图（迷你图）那一路改动**：全量图
// 一路必须逐值维持上游 Quartz 的原样。提纯到本模块而不写在 graph.inline.ts 里，
// 是因为 static/graphLayout.json 的指纹只覆盖节点集与 charge/link/collide 等力参数，
// **不含 velocityDecay 与 alphaTarget**——全量图这两项一旦被误改，既有断言
// （含 smoke 步 30 的坐标播种校验）不会变红，只会让构建期预计算坐标与运行期力导
// 参数静默错配、总览图布局逐次漂移。故把红线交给下方 graphInteraction.test.ts
// 的逐值断言机器化守卫，调用处则一律把 fullGraph 写在同一行、不经布尔中间变量绕层。

/**
 * 拖拽期间的 alphaTarget（力导增益的地板值）。
 *
 * 全量图 1：上游 Quartz 原值，拖拽即把整张图重新加热到满增益。
 * 局部图 0.2：迷你图只有几十到一百余个节点、且多为单中心星形，满增益会把
 * 「冻结在半途的残余收敛」全速重放——实测拖拽期间 98% 的位移来自这一重加热而非鼠标，
 * 表现为「拖一个点、满屏乱跳」。0.2 只够让邻接节点跟随让位，不足以重启全局收敛。
 */
export function dragAlphaTarget(fullGraph: boolean): number {
  return fullGraph ? 1 : 0.2
}

/**
 * velocityDecay（速度阻尼）覆盖值；返回 null 表示**不调用** velocityDecay、
 * 沿用 d3 默认 0.4——全量图恒走这一路，其力导配置文本因此一字未动。
 *
 * 局部图 0.55：阻尼加大即单 tick 保留的速度更少，跟随位移更快衰减，
 * 消除松手后的余震拖尾。取 0.55 而非更高，是为保住「拖动时邻接点仍会让位」的手感。
 */
export function dragVelocityDecay(fullGraph: boolean): number | null {
  return fullGraph ? null : 0.55
}

/**
 * 松手（dragend）时是否直接把 alpha 归零、令力导立即停机。
 *
 * 仅局部图、且**拖拽开始前布局已自然收敛**（alphaAtDragStart < alphaMin）时为真：
 * 那种局面下松手后的一切运动都是本次拖拽注入的能量，属余震而非未完成的收敛，
 * 直接停机即「拖拽即整理，放下不回弹」。拖拽开始时布局尚未收敛（alpha ≥ alphaMin）
 * 则返回假，剩余收敛照常跑完。全量图恒返回假，行为与改前逐字一致。
 */
export function shouldSettleOnDragEnd(
  fullGraph: boolean,
  alphaAtDragStart: number,
  alphaMin: number,
): boolean {
  return !fullGraph && alphaAtDragStart < alphaMin
}

/** 选中态下仅允许选中节点及其相关节点显示标签。 */
export function shouldShowLabelDuringSelection(
  selectedNode: SimpleSlug | null,
  selectedSet: ReadonlySet<string>,
  nodeId: SimpleSlug,
): boolean {
  return selectedNode === null || selectedSet.has(nodeId)
}
