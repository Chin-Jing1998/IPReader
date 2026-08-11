import test from "node:test"
import assert from "node:assert"
import {
  createPopoverReturnState,
  isPopoverReturnTarget,
  popoverLinkAction,
} from "./popoverInteraction"

test("正文链接单击打开预览，双击才执行详情导航", () => {
  assert.strictEqual(popoverLinkAction(1), "preview")
  assert.strictEqual(popoverLinkAction(2), "navigate")
  assert.strictEqual(popoverLinkAction(3), "navigate")
})

test("仅在进入预览目标详情页时显示返回正文按钮", () => {
  const state = {
    from: "http://127.0.0.1:47822/source/article#关联",
    to: "http://127.0.0.1:47822/9-关键词索引/99-综合/term-0186",
  }
  assert.strictEqual(
    isPopoverReturnTarget("http://127.0.0.1:47822/9-关键词索引/99-综合/term-0186", state),
    true,
  )
  assert.strictEqual(
    isPopoverReturnTarget("http://127.0.0.1:47822/9-关键词索引/99-综合/term-0186#相关法条", state),
    true,
  )
  assert.strictEqual(isPopoverReturnTarget("http://127.0.0.1:47822/1-专利法/01-总则", state), false)
  assert.strictEqual(isPopoverReturnTarget(state.from, state), false)
})

test("正文双击进入关键词详情页时也保留原正文返回状态", () => {
  const from = "http://127.0.0.1:47822/3-专利审查指南/1-初步审查/guide-01-01"
  const to = "http://127.0.0.1:47822/9-关键词索引/99-综合/term-0186"
  const state = createPopoverReturnState(from, to)

  assert.deepStrictEqual(state, { from, to })
  assert.strictEqual(isPopoverReturnTarget(to, state), true)
})
