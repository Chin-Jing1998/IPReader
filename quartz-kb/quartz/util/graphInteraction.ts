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

/** 选中态下仅允许选中节点及其相关节点显示标签。 */
export function shouldShowLabelDuringSelection(
  selectedNode: SimpleSlug | null,
  selectedSet: ReadonlySet<string>,
  nodeId: SimpleSlug,
): boolean {
  return selectedNode === null || selectedSet.has(nodeId)
}
