import test from "node:test"
import assert from "node:assert"
import { shouldIgnoreSelectionChangeWhileComposing } from "./annotationInteraction"

test("笔记输入框打开时忽略选区变化，保留待保存批注", () => {
  assert.strictEqual(shouldIgnoreSelectionChangeWhileComposing(true), true)
})

test("未打开笔记输入框时不忽略选区变化", () => {
  assert.strictEqual(shouldIgnoreSelectionChangeWhileComposing(false), false)
})
