import assert from "node:assert/strict"
import test from "node:test"
import { getScrollEdgeState } from "./scrollEdge"

test("滚动列表在顶部仅显示底部渐隐", () => {
  assert.deepEqual(getScrollEdgeState({ scrollTop: 0, clientHeight: 248, scrollHeight: 1083 }), {
    top: false,
    bottom: true,
  })
})

test("滚动列表位于中间时同时显示上下渐隐", () => {
  assert.deepEqual(getScrollEdgeState({ scrollTop: 120, clientHeight: 248, scrollHeight: 1083 }), {
    top: true,
    bottom: true,
  })
})

test("滚动列表到底部时仅显示顶部渐隐", () => {
  assert.deepEqual(getScrollEdgeState({ scrollTop: 835, clientHeight: 248, scrollHeight: 1083 }), {
    top: true,
    bottom: false,
  })
})

test("不需要滚动的列表不显示渐隐", () => {
  assert.deepEqual(getScrollEdgeState({ scrollTop: 0, clientHeight: 248, scrollHeight: 248 }), {
    top: false,
    bottom: false,
  })
})
