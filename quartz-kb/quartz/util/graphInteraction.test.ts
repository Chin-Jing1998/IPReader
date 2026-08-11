import assert from "node:assert/strict"
import test from "node:test"
import type { SimpleSlug } from "./path"
import {
  isGraphBackgroundClick,
  isSelectedAnchorLink,
  resolveSingleClickAction,
  selectedLinkStroke,
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
