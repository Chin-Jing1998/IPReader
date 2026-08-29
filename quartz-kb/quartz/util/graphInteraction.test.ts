import assert from "node:assert/strict"
import test from "node:test"
import type { SimpleSlug } from "./path"
import {
  dragAlphaTarget,
  dragVelocityDecay,
  isGraphBackgroundClick,
  isSelectedAnchorLink,
  resolveSingleClickAction,
  selectedLinkStroke,
  shouldSettleOnDragEnd,
  shouldShowLabelDuringSelection,
} from "./graphInteraction"

const slug = (value: string) => value as SimpleSlug

test("单击决策区分首次选中、选中集内刷新和暗节点忽略", () => {
  assert.equal(resolveSingleClickAction(false, false), "select")
  assert.equal(resolveSingleClickAction(true, true), "show")
  assert.equal(resolveSingleClickAction(true, false), "ignore")
})

test("选中态只高亮当前节点与直接相关节点之间的连线", () => {
  const selected = slug("book/selected")
  const related = slug("book/related")
  const otherRelated = slug("book/other-related")
  const outside = slug("book/outside")

  assert.equal(isSelectedAnchorLink(selected, selected, related), true)
  assert.equal(isSelectedAnchorLink(selected, related, selected), true)
  assert.equal(isSelectedAnchorLink(selected, related, otherRelated), false)
  assert.equal(isSelectedAnchorLink(selected, related, outside), false)
  assert.equal(isSelectedAnchorLink(null, selected, related), false)
})

test("选中态直接关联线加粗，其他连线保持原线宽并变暗", () => {
  const selected = slug("book/selected")
  const related = slug("book/related")
  const outside = slug("book/outside")

  assert.deepEqual(selectedLinkStroke(selected, selected, related), { width: 1.6, alpha: 1 })
  assert.deepEqual(selectedLinkStroke(selected, related, outside), { width: 1, alpha: 0.2 })
})

test("点击连线不被判定为空白点击", () => {
  const now = 1_000
  assert.equal(isGraphBackgroundClick(0, 0, now), true)
  assert.equal(isGraphBackgroundClick(now - 100, 0, now), false)
  assert.equal(isGraphBackgroundClick(0, now - 100, now), false)
})

test("选中状态下暗节点不显示标签", () => {
  const selected = slug("book/selected")
  const related = slug("book/related")
  const outside = slug("book/outside")
  const selectedSet = new Set<SimpleSlug>([selected, related])

  assert.equal(shouldShowLabelDuringSelection(selected, selectedSet, selected), true)
  assert.equal(shouldShowLabelDuringSelection(selected, selectedSet, related), true)
  assert.equal(shouldShowLabelDuringSelection(selected, selectedSet, outside), false)
  assert.equal(shouldShowLabelDuringSelection(null, new Set(), outside), true)
})

// 阶段5.10 波B 红线：全量图（depth<0）的拖拽三参数必须逐值维持改前取值。
// graphLayout.json 的指纹不含 velocityDecay 与 alphaTarget，全量图一旦被误改，
// 既有 smoke 断言不会变红、只会静默漂移布局，故此处逐值钉死。
test("全量图拖拽参数逐值不变（红线：改动只许落在局部图分支）", () => {
  assert.equal(dragAlphaTarget(true), 1)
  // null＝不调用 velocityDecay，沿用 d3 默认 0.4
  assert.equal(dragVelocityDecay(true), null)
  // 全量图恒不提前停机：即便拖拽前 alpha 已在 alphaMin 之下也返回 false
  assert.equal(shouldSettleOnDragEnd(true, 0.0001, 0.001), false)
})

test("局部图拖拽参数：低增益加热、加大阻尼、收敛态松手即停", () => {
  assert.equal(dragAlphaTarget(false), 0.2)
  assert.equal(dragVelocityDecay(false), 0.55)
  // 拖拽前已收敛（alpha < alphaMin）→ 松手余震直接归零
  assert.equal(shouldSettleOnDragEnd(false, 0.0001, 0.001), true)
  // 拖拽前尚未收敛（alpha ≥ alphaMin）→ 剩余收敛照常跑完，不提前停机
  assert.equal(shouldSettleOnDragEnd(false, 0.5, 0.001), false)
})
