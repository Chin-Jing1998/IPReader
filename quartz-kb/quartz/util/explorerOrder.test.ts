import assert from "node:assert/strict"
import test from "node:test"
import {
  EXPLORER_ORDER_STORAGE_KEY,
  EXPLORER_ORDER_VERSION,
  applyOrderToItems,
  emptyOrderTable,
  hasCustomOrder,
  isOrderableParentKey,
  moveItem,
  parseOrderTable,
  serializeOrderTable,
  withParentOrder,
  type ExplorerOrderTable,
} from "./explorerOrder"

// ============================================================
// 侧栏目录树自定义排序（阶段5.8 S1）的边界护栏。
// 本模块的失效模式是「书目失踪」——顺序表一旦把某个键漏掉或把项数改小，
// 整组书就从目录树里消失，而浏览器侧只有肉眼与冒烟能发现。故项数守恒、
// 幽灵键忽略、脏表回落三类断言在此逐条钉死。
// 单独重跑：cd quartz-kb && npx tsx --test quartz/util/explorerOrder.test.ts
// ============================================================

/** 测试用条目：键即字面量本身 */
const idOf = (s: string) => s

test("存储键与版本号是约定值（改动即等于让用户既有顺序表整体作废）", () => {
  assert.equal(EXPLORER_ORDER_STORAGE_KEY, "kb-explorer-order:v1")
  assert.equal(EXPLORER_ORDER_VERSION, 1)
})

test("emptyOrderTable 是带版本的空表", () => {
  const table = emptyOrderTable()
  assert.equal(table.v, EXPLORER_ORDER_VERSION)
  assert.deepEqual(table.parents, {})
  assert.equal(hasCustomOrder(table), false)
})

// —— 脏表回落 ——

test("parseOrderTable：脏表五形态一律回落空表且绝不抛", () => {
  // ① 非法 JSON ② 数组 ③ 标量 ④ 版本不符 ⑤ parents 不是对象
  const dirty = [
    "{不是 JSON",
    "[1,2,3]",
    '"字符串"',
    '{"v":99,"parents":{"a":["b"]}}',
    '{"v":1,"parents":[]}',
  ]
  for (const raw of dirty) {
    const table = parseOrderTable(raw)
    assert.deepEqual(table.parents, {}, `脏表未回落：${raw}`)
    assert.equal(table.v, EXPLORER_ORDER_VERSION)
  }
})

test("parseOrderTable：null / undefined / 空串回落空表", () => {
  for (const raw of [null, undefined, ""]) {
    assert.deepEqual(parseOrderTable(raw).parents, {})
  }
})

test("parseOrderTable：逐键宽容——坏键丢弃、好键保留", () => {
  const table = parseOrderTable(
    JSON.stringify({
      v: 1,
      parents: {
        "synthetic:CN": ["synthetic:CN/商标", "synthetic:CN/专利"],
        "synthetic:bad-1": "不是数组",
        "synthetic:bad-2": [],
        "synthetic:mixed": ["a", 42, null, "b"],
      },
    }),
  )
  assert.deepEqual(table.parents["synthetic:CN"], ["synthetic:CN/商标", "synthetic:CN/专利"])
  assert.equal("synthetic:bad-1" in table.parents, false)
  // 空数组键在解析阶段即丢弃，与 withParentOrder 的「空数组删键」同形态
  assert.equal("synthetic:bad-2" in table.parents, false)
  // 非字符串元素被过滤，键本身保留
  assert.deepEqual(table.parents["synthetic:mixed"], ["a", "b"])
})

test("serializeOrderTable / parseOrderTable 往返无损", () => {
  const table = withParentOrder(emptyOrderTable(), "synthetic:CN/专利", ["D5", "D1", "D2"])
  const round = parseOrderTable(serializeOrderTable(table))
  assert.deepEqual(round, table)
})

// —— 部分排序合并 ——

test("applyOrderToItems：部分排序 [c,a] × [a,b,c,d] → [c,a,b,d]", () => {
  const out = applyOrderToItems(["a", "b", "c", "d"], ["c", "a"], idOf)
  assert.deepEqual(out, ["c", "a", "b", "d"])
})

test("applyOrderToItems：失踪防护——desired 含不存在键则忽略，项数恒守恒", () => {
  const items = ["a", "b", "c"]
  const out = applyOrderToItems(items, ["幽灵", "c", "另一个幽灵"], idOf)
  assert.equal(out.length, items.length, "项数必须守恒（少一项即等于一部书从目录树消失）")
  assert.deepEqual(out, ["c", "a", "b"])
  // 输出是输入的一个排列：不重不漏
  assert.deepEqual([...out].sort(), [...items].sort())
})

test("applyOrderToItems：整表全是幽灵键时退化为默认序", () => {
  const items = ["a", "b", "c"]
  const out = applyOrderToItems(items, ["x", "y"], idOf)
  assert.deepEqual(out, items)
})

test("applyOrderToItems：重复键取首位", () => {
  // ① desired 内重复：只认首次出现
  assert.deepEqual(applyOrderToItems(["a", "b", "c"], ["c", "c", "a"], idOf), ["c", "a", "b"])
  // ② items 内重复键（理论上不该发生）：首个进表序段，其余留在默认序段，项数仍守恒
  const dup = [
    { k: "a", n: 1 },
    { k: "b", n: 2 },
    { k: "a", n: 3 },
  ]
  const out = applyOrderToItems(dup, ["a"], (it) => it.k)
  assert.equal(out.length, 3)
  assert.deepEqual(
    out.map((it) => it.n),
    [1, 2, 3],
  )
})

test("applyOrderToItems：desired 缺席 / 为空 / items 为空时原样返回副本", () => {
  const items = ["a", "b"]
  assert.deepEqual(applyOrderToItems(items, undefined, idOf), items)
  assert.deepEqual(applyOrderToItems(items, [], idOf), items)
  assert.deepEqual(applyOrderToItems([], ["a"], idOf), [])
  assert.notEqual(applyOrderToItems(items, undefined, idOf), items, "必须是新数组，不得原地返回")
})

test("applyOrderToItems：全量表即完整重排，且不修改入参", () => {
  const items = ["a", "b", "c"]
  const out = applyOrderToItems(items, ["c", "b", "a"], idOf)
  assert.deepEqual(out, ["c", "b", "a"])
  assert.deepEqual(items, ["a", "b", "c"], "入参不得被原地改动")
})

// —— moveItem 四边界 ——

test("moveItem：四边界（from 越界 / to 越界 / from===to / 负下标）一律原序返回", () => {
  const items = ["a", "b", "c"]
  assert.deepEqual(moveItem(items, 5, 0), items, "from 越界")
  assert.deepEqual(moveItem(items, 0, 5), items, "to 越界")
  assert.deepEqual(moveItem(items, 1, 1), items, "原地不动")
  assert.deepEqual(moveItem(items, -1, 0), items, "负下标")
  assert.deepEqual(moveItem(items, 0, -1), items, "负目标下标")
  assert.deepEqual(moveItem([], 0, 0), [], "空数组")
})

test("moveItem：向前搬、向后搬、搬到首尾", () => {
  const items = ["a", "b", "c", "d"]
  assert.deepEqual(moveItem(items, 2, 0), ["c", "a", "b", "d"], "搬到首位")
  assert.deepEqual(moveItem(items, 0, 3), ["b", "c", "d", "a"], "搬到末位")
  assert.deepEqual(moveItem(items, 1, 2), ["a", "c", "b", "d"], "向后一格")
  assert.deepEqual(moveItem(items, 2, 1), ["a", "c", "b", "d"], "向前一格")
  assert.deepEqual(items, ["a", "b", "c", "d"], "入参不得被原地改动")
})

test("moveItem：非整数下标不抛且原序返回", () => {
  assert.deepEqual(moveItem(["a", "b"], 0.5, 1), ["a", "b"])
  assert.deepEqual(moveItem(["a", "b"], 0, Number.NaN), ["a", "b"])
})

// —— 可重排判据 ——

test("isOrderableParentKey：五用例（三层合成节点可排，根与真实目录锁死）", () => {
  assert.equal(isOrderableParentKey("synthetic:CN"), true, "法域行的父=国家层")
  assert.equal(isOrderableParentKey("synthetic:CN/专利"), true, "docType 行的父=field 层")
  assert.equal(isOrderableParentKey("synthetic:CN/专利/D5"), true, "书目行的父=docType 层")
  assert.equal(isOrderableParentKey("1-专利法"), false, "章节层的父是真实目录，锁死")
  assert.equal(isOrderableParentKey(null), false, "顶层三巨头的父是根，锁死")
  assert.equal(isOrderableParentKey(""), false)
  assert.equal(isOrderableParentKey(undefined), false)
})

// —— 写表与显隐联动 ——

test("withParentOrder：写入返回新表，原表不变", () => {
  const base = emptyOrderTable()
  const next = withParentOrder(base, "synthetic:CN", ["b", "a"])
  assert.deepEqual(base.parents, {}, "原表不得被原地修改")
  assert.deepEqual(next.parents["synthetic:CN"], ["b", "a"])
  assert.equal(next.v, EXPLORER_ORDER_VERSION)
})

test("withParentOrder：空数组删键，并与 hasCustomOrder 联动", () => {
  let table: ExplorerOrderTable = emptyOrderTable()
  assert.equal(hasCustomOrder(table), false)
  table = withParentOrder(table, "synthetic:CN", ["b", "a"])
  assert.equal(hasCustomOrder(table), true)
  table = withParentOrder(table, "synthetic:CN/专利", ["D5", "D1"])
  assert.equal(Object.keys(table.parents).length, 2)
  // 删其一：仍有自定义序
  table = withParentOrder(table, "synthetic:CN", [])
  assert.equal("synthetic:CN" in table.parents, false)
  assert.equal(hasCustomOrder(table), true)
  // 删其二：回到「无自定义序」，恢复默认按钮据此隐藏
  table = withParentOrder(table, "synthetic:CN/专利", [])
  assert.deepEqual(table.parents, {})
  assert.equal(hasCustomOrder(table), false)
})

test("withParentOrder：写入的数组是副本，后续改动调用方数组不影响表", () => {
  const keys = ["a", "b"]
  const table = withParentOrder(emptyOrderTable(), "synthetic:CN", keys)
  keys.push("c")
  assert.deepEqual(table.parents["synthetic:CN"], ["a", "b"])
})

// —— 端到端：写表 → 落盘串 → 读回 → 施加 ——

test("端到端：拖拽写表 → 序列化 → 解析 → 施加，得到拖拽后的次序", () => {
  const defaultOrder = ["专利", "商标", "著作权", "竞争法", "品种布图", "综合程序"]
  // 把「商标」拖到首位后，从 DOM 反读整段次序写表（WYSIWYG）
  const dragged = moveItem(defaultOrder, 1, 0)
  const raw = serializeOrderTable(withParentOrder(emptyOrderTable(), "synthetic:CN", dragged))
  const applied = applyOrderToItems(
    defaultOrder,
    parseOrderTable(raw).parents["synthetic:CN"],
    idOf,
  )
  assert.deepEqual(applied, ["商标", "专利", "著作权", "竞争法", "品种布图", "综合程序"])
  assert.equal(applied.length, defaultOrder.length)
})

test("端到端：表里登记的书被删、又新增一部书时，两侧都不失踪", () => {
  // 表按旧语料写成（含已删除的「旧书」），当前树里多了一部「新书」
  const table = withParentOrder(emptyOrderTable(), "synthetic:CN/专利/D5", ["c", "旧书", "a"])
  const current = ["a", "b", "c", "新书"]
  const applied = applyOrderToItems(current, table.parents["synthetic:CN/专利/D5"], idOf)
  assert.deepEqual(applied, ["c", "a", "b", "新书"])
  assert.equal(applied.length, current.length)
})
