import type { SimpleSlug } from "./path"

export type SingleClickAction = "select" | "show" | "ignore"

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
