import assert from "node:assert/strict"
import test from "node:test"
import type { SimpleSlug } from "./path"
import {
  GRAPH_FIELD_EVENT,
  dragAlphaTarget,
  dragVelocityDecay,
  isGraphBackgroundClick,
  isSelectedAnchorLink,
  resolveSingleClickAction,
  selectedLinkStroke,
  shouldSettleOnDragEnd,
  shouldShowLabelDuringSelection,
  type GraphFieldDetail,
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
  const anchors = new Set<string>([selected])

  assert.equal(isSelectedAnchorLink(anchors, selected, related), true)
  assert.equal(isSelectedAnchorLink(anchors, related, selected), true)
  assert.equal(isSelectedAnchorLink(anchors, related, otherRelated), false)
  assert.equal(isSelectedAnchorLink(anchors, related, outside), false)
  // 空集＝无选中，逐值等价于波C 之前传 null
  assert.equal(isSelectedAnchorLink(new Set(), selected, related), false)
})

test("选中态直接关联线加粗，其他连线保持原线宽并变暗", () => {
  const selected = slug("book/selected")
  const related = slug("book/related")
  const outside = slug("book/outside")
  const anchors = new Set<string>([selected])

  assert.deepEqual(selectedLinkStroke(anchors, selected, related), { width: 1.6, alpha: 1 })
  assert.deepEqual(selectedLinkStroke(anchors, related, outside), { width: 1, alpha: 0.2 })
})

// 阶段5.10 波C-a：多选锚点。三个判据的语义都从「等于那一个锚点」升为
// 「属于锚点集合」，本用例守的是**并集**语义——任一锚点命中即算命中，
// 而不是「全部锚点都命中才算」，也不是只看集合里的第一个。
test("多选：任一锚点命中即高亮，各锚点的相关边取并集", () => {
  const a = slug("book/anchor-a")
  const b = slug("book/anchor-b")
  const nearA = slug("book/near-a")
  const nearB = slug("book/near-b")
  const outside = slug("book/outside")
  const anchors = new Set<string>([a, b])

  // 两个锚点各自的相关边都算相关（并集，而非交集）
  assert.equal(isSelectedAnchorLink(anchors, a, nearA), true)
  assert.equal(isSelectedAnchorLink(anchors, nearB, b), true)
  // 锚点之间的边天然属于并集
  assert.equal(isSelectedAnchorLink(anchors, a, b), true)
  // 两端都不是锚点：即便端点在某个锚点的邻域内也只是暗边（判据是锚点直连，不是选中集）
  assert.equal(isSelectedAnchorLink(anchors, nearA, nearB), false)
  assert.equal(isSelectedAnchorLink(anchors, nearA, outside), false)

  assert.deepEqual(selectedLinkStroke(anchors, nearB, b), { width: 1.6, alpha: 1 })
  assert.deepEqual(selectedLinkStroke(anchors, nearA, nearB), { width: 1, alpha: 0.2 })
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
  const anchors = new Set<string>([selected])
  const selectedSet = new Set<SimpleSlug>([selected, related])

  assert.equal(shouldShowLabelDuringSelection(anchors, selectedSet, selected), true)
  assert.equal(shouldShowLabelDuringSelection(anchors, selectedSet, related), true)
  assert.equal(shouldShowLabelDuringSelection(anchors, selectedSet, outside), false)
  // 空锚点集＝无选中：全部放行，逐值等价于波C 之前传 null
  assert.equal(shouldShowLabelDuringSelection(new Set(), new Set(), outside), true)
})

// 波C-a：标签判据看的是**并集** selectedSet，不是锚点集本身——
// 漏改成 selectedAnchors.has(nodeId) 会让多选时两个锚点的邻居标签全灭，
// 而那正是「选中集常亮」的主体部分。
test("多选：标签判据取锚点邻域的并集，非锚点集本身", () => {
  const a = slug("book/anchor-a")
  const b = slug("book/anchor-b")
  const nearA = slug("book/near-a")
  const nearB = slug("book/near-b")
  const outside = slug("book/outside")
  const anchors = new Set<string>([a, b])
  // 调用方（computeSelectedSet）算好的并集：两个锚点 + 各自邻居
  const selectedSet = new Set<SimpleSlug>([a, b, nearA, nearB])

  assert.equal(shouldShowLabelDuringSelection(anchors, selectedSet, a), true)
  assert.equal(shouldShowLabelDuringSelection(anchors, selectedSet, nearA), true)
  assert.equal(shouldShowLabelDuringSelection(anchors, selectedSet, nearB), true)
  assert.equal(shouldShowLabelDuringSelection(anchors, selectedSet, outside), false)
  // 锚点非空但并集只含锚点自身（孤立节点）：邻居为空不影响锚点自身显示
  assert.equal(shouldShowLabelDuringSelection(anchors, new Set([a, b]), b), true)
  assert.equal(shouldShowLabelDuringSelection(anchors, new Set([a, b]), nearA), false)
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
  // 拖拽前已收敛 → 松手余震直接归零
  assert.equal(shouldSettleOnDragEnd(false, 0.0001, 0.001), true)
  // 拖拽前远未收敛 → 剩余收敛照常跑完，不提前停机
  assert.equal(shouldSettleOnDragEnd(false, 0.5, 0.001), false)
})

// 阈值取 1.5×alphaMin 而非 alphaMin：局部图预热收尾的 alpha 实测就落在
// 9.8e-4 ~ 1.0e-3，与 alphaMin(0.001) 只差一个舍入量级。判据若卡在边界上，
// 日后预热参数微调即可让它静默转假、余震整体回潮，且不会有任何断言变红。
// 本用例把那点余量钉死，同时守住上界不被继续放宽。
test("松手停机阈值含 1.5 倍余量：略高于 alphaMin 仍判为已收敛，2 倍则不判", () => {
  const alphaMin = 0.001
  // 1.2×alphaMin：落在 [alphaMin, 1.5×alphaMin) 内，正是本次加固要救的那一档
  assert.equal(shouldSettleOnDragEnd(false, 1.2 * alphaMin, alphaMin), true)
  // 2×alphaMin：越过余量上界，按「尚未收敛」处理
  assert.equal(shouldSettleOnDragEnd(false, 2 * alphaMin, alphaMin), false)
  // 余量放宽只作用于局部图，全量图恒不提前停机（红线不受本次加固影响）
  assert.equal(shouldSettleOnDragEnd(true, 1.2 * alphaMin, alphaMin), false)
})

// ============================================================
// kb:graphfield 载荷形状（阶段5.11 波J 多选化）
// ============================================================
// 该事件的 detail 是**跨 bundle 契约**：派发方在 graphexplorer.inline.ts、
// 订阅方在 explorer.inline.ts，两个独立打包闭包之间只靠本模块的类型对齐。
// 形状一旦漂移（例如仍按单值 `{ field }` 派发、按多值 `{ fields }` 订阅）是
// 静默失联——detail.fields 读出 undefined，目录侧直接 return，既不报错也不过滤。
// 故此处把「事件名 + 载荷形状 + 空数组即全部」三项钉成机器可核的断言。
test("kb:graphfield 载荷：{ fields: string[] }，空数组即「全部」", () => {
  assert.equal(GRAPH_FIELD_EVENT, "kb:graphfield")

  // 「全部」态：空数组。订阅方的判据是 fields.size === 0，不再有哨兵 "*"
  const all: GraphFieldDetail = { fields: [] }
  assert.equal(Array.isArray(all.fields), true)
  assert.equal(all.fields.length, 0)

  // 单选与多选是同一种形状，长度不同而已（单选不再退化为字符串）
  const single: GraphFieldDetail = { fields: ["商标"] }
  const multi: GraphFieldDetail = { fields: ["商标", "专利"] }
  assert.deepEqual([...single.fields], ["商标"])
  assert.deepEqual([...multi.fields].sort(), ["专利", "商标"])

  // 订阅方的类型守卫形状：Array.isArray 一次性挡掉 undefined 与旧单值载荷
  const guard = (detail: unknown): string[] | null => {
    const fields = (detail as GraphFieldDetail | undefined)?.fields
    return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : null
  }
  assert.deepEqual(guard(multi), ["商标", "专利"])
  assert.deepEqual(guard(all), [])
  assert.equal(guard(undefined), null)
  assert.equal(guard({}), null)
  // 旧单值载荷（波J 之前的 `{ field: "商标" }`）必须被守卫挡下而非静默半生效
  assert.equal(guard({ field: "商标" }), null)
})
