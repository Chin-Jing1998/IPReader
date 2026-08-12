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

// —— 末尾空占位项（OverflowList.tsx 的 li.overflow-end，base.scss 固定 8px）——
// 三例的量度全部取自 Electron 43 实测（1440×812 / 1440×780 的右栏反链卡），
// 不是构造值：占位项计入 scrollHeight，不扣除即为一条空占位亮起底部渐隐。

test("仅末尾占位项溢出时不显示底部渐隐", () => {
  // Arrange：clientHeight 307 / scrollHeight 315，8px 全是占位，末条链接完整可见
  const metrics = { scrollTop: 0, clientHeight: 307, scrollHeight: 315, spacerHeight: 8 }

  // Act & Assert
  assert.deepEqual(getScrollEdgeState(metrics), { top: false, bottom: false })
  // 对照：不扣占位（旧口径）时同一量度会误判为「下方还有内容」
  assert.equal(getScrollEdgeState({ ...metrics, spacerHeight: 0 }).bottom, true)
})

test("扣除占位后仍有真实内容在下方时照常显示底部渐隐", () => {
  assert.deepEqual(
    getScrollEdgeState({ scrollTop: 0, clientHeight: 275, scrollHeight: 315, spacerHeight: 8 }),
    { top: false, bottom: true },
  )
})

test("滚到底时占位项不再拖着底部渐隐不放", () => {
  // scrollTop 取最大值 315−275=40：真实内容已见底，只余占位在滚动区内
  assert.deepEqual(
    getScrollEdgeState({ scrollTop: 40, clientHeight: 275, scrollHeight: 315, spacerHeight: 8 }),
    { top: true, bottom: false },
  )
})
