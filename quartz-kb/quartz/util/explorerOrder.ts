// 侧栏目录树「自定义排序」的纯逻辑层（阶段5.8 目录树增强批 S1）。
//
// 独立成模块而非写进 explorer.inline.ts：本表的失效模式是「书目从目录树里失踪」
// ——一个下标算错就有整组书不再出现，而浏览器侧的目录树只有肉眼与冒烟能看见。
// 抽成纯函数后可用夹具级单测把边界逐条钉死（见 explorerOrder.test.ts），
// 做法与 util/graphToc.ts 的先例一致。
//
// 依赖纪律：本模块零依赖（连 util/path 的类型都不取），构建期 Node 与浏览器
// bundle 双端均可安全引入。
//
// 与折叠态表（fileTree-v2 / fileTree-graph）的关系：两张表各管各的，
// 顺序表只记「同级次序」，折叠态只记「展开/收起」，互不读写。
// 「恢复默认排序」只删本键，折叠习惯毫发无损。
//
// 显示序与阅读序的边界（同源注释见 quartz/util/docOrder.ts 与
// explorer.inline.ts 的 sortNodes 文档块）：本表只改目录树的**显示**次序，
// PageNav 的「上一节/下一节」翻页链恒按文档逻辑序（byDocumentOrder），
// 不读本表——拖拽只改「找书的顺序」，不改「读文的顺序」。

/**
 * 顺序表的 localStorage 键。**全站单表**，图谱页与文档站共用：
 * 两者共用同一棵缓存 DOM 树（explorer.inline.ts 的 signature 不含页面差异），
 * 若按页分成两个键，必然出现「在这一侧存了、在那一侧不生效」的幽灵态。
 * 折叠态之所以能双键隔离，是因为它逐导航整树重算；顺序是建树时一次性施加的。
 */
export const EXPLORER_ORDER_STORAGE_KEY = "kb-explorer-order:v1"

/** 表结构版本。与键名里的 v1 同步；版本不符时整表作废（回落默认序），不做迁移。 */
export const EXPLORER_ORDER_VERSION = 1

/**
 * 合成分组节点折叠键的前缀，与 explorer.inline.ts 的 SYNTHETIC_KEY_PREFIX 同一常量
 * （该文件自本模块导入，此处是唯一定义处）。真实目录 slug 不含冒号，故两类键天然不冲突。
 */
export const EXPLORER_SYNTHETIC_PREFIX = "synthetic:"

/**
 * 顺序表：只登记**被拖过**的父节点，其余父节点一律走默认序。
 * 键为父节点的 folderStateKey（合成节点的 `synthetic:…` 稳定键），
 * 值为该父节点子项的期望次序（子项的 folderStateKey 列表）。
 */
export type ExplorerOrderTable = {
  /** 表结构版本，恒为 EXPLORER_ORDER_VERSION */
  v: number
  parents: Record<string, string[]>
}

export function emptyOrderTable(): ExplorerOrderTable {
  return { v: EXPLORER_ORDER_VERSION, parents: {} }
}

/**
 * 宽容解析：**任何异常一律回落空表，绝不抛**。
 * 本函数在每次建树的主路径上被调用，抛出即等于整棵目录树不渲染
 * （与 explorer.inline.ts 里 fileTree-v2 的 try/catch 同一条纪律）。
 *
 * 逐键宽容而非整表作废：单个父节点的记录脏了只丢它自己，其余记录仍生效。
 * 空数组的键在解析阶段即丢弃，与 withParentOrder「空数组删键」保持同一形态。
 */
export function parseOrderTable(raw: string | null | undefined): ExplorerOrderTable {
  const table = emptyOrderTable()
  if (typeof raw !== "string" || raw.length === 0) {
    return table
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return table
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return table
  }
  const candidate = parsed as { v?: unknown; parents?: unknown }
  if (candidate.v !== EXPLORER_ORDER_VERSION) {
    return table
  }
  const parents = candidate.parents
  if (!parents || typeof parents !== "object" || Array.isArray(parents)) {
    return table
  }
  for (const [parentKey, value] of Object.entries(parents as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      continue
    }
    const childKeys = value.filter((key): key is string => typeof key === "string")
    if (childKeys.length === 0) {
      continue
    }
    table.parents[parentKey] = childKeys
  }
  return table
}

export function serializeOrderTable(table: ExplorerOrderTable): string {
  return JSON.stringify(table)
}

/**
 * 该父节点下的同级次序是否可被用户重排。**唯一真相是 `synthetic:` 前缀**：
 * 合成分组层（国家 / 权利类型 / 文件归类）恰好三层，其子项恰是开放重排的三层
 * （法域行 / docType 行 / 书目行）；顶层三巨头的父是根（父键为 null）、
 * 章节层的父是真实目录（slug，不带前缀），两者据此天然锁死。
 * 禁用「按深度判定」的魔数——深度会随分组层的增删而漂移，前缀不会。
 */
export function isOrderableParentKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(EXPLORER_SYNTHETIC_PREFIX)
}

/**
 * 部分排序合并：`desired` 中**已列且当前确实存在**的项按表序排在前，
 * 其余项按 `items` 的原有默认序追加在后。
 *
 * 这条「部分」语义是「新书不失踪」的唯一保证：语料新增一部书时它不在表里，
 * 于是落在后半段按默认序出现，而不是因为不在表内被丢掉。与 explorer.inline.ts
 * 的 orderedKeys（preferred 优先、其余原序追后）同语义。
 *
 * 三条不变式（单测逐条钉死）：
 *   · 项数守恒：输出 length 恒等于输入 length（desired 里的幽灵键被忽略）；
 *   · 不重不漏：输出是输入的一个排列；
 *   · 重复键取首位：同一键在 items 中出现多次时只有首个进入表序段，其余留在默认序段。
 */
export function applyOrderToItems<T>(
  items: readonly T[],
  desired: readonly string[] | undefined,
  keyOf: (item: T) => string,
): T[] {
  if (!desired || desired.length === 0 || items.length === 0) {
    return [...items]
  }
  const firstIndexOf = new Map<string, number>()
  for (let i = 0; i < items.length; i++) {
    const key = keyOf(items[i])
    if (!firstIndexOf.has(key)) {
      firstIndexOf.set(key, i)
    }
  }
  const taken = new Set<number>()
  const head: T[] = []
  for (const key of desired) {
    const index = firstIndexOf.get(key)
    // index 为 undefined：表里登记的键在当前树中已不存在（语料改名/删除）——忽略即可，
    // 绝不能据此往输出里塞占位。taken 命中：desired 内出现重复键，只认首次。
    if (index === undefined || taken.has(index)) {
      continue
    }
    taken.add(index)
    head.push(items[index])
  }
  const tail: T[] = []
  for (let i = 0; i < items.length; i++) {
    if (!taken.has(i)) {
      tail.push(items[i])
    }
  }
  return [...head, ...tail]
}

/**
 * 同级搬移：把 `from` 处的项取出、插到 `to` 处（移除后再插入的口径，
 * 即 `to` 是**移除该项之后**的目标下标）。越界或原地不动一律返回原序副本，
 * 绝不抛、绝不丢项。
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= next.length ||
    to >= next.length ||
    from === to
  ) {
    return next
  }
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * 写入一个父节点的完整子项次序，返回**新表**（输入表不被修改）。
 * `childKeys` 为空数组时删除该键——空记录既无意义，又会让 hasCustomOrder 误判为
 * 「有自定义序」而把「恢复默认排序」按钮永久留在头部。
 */
export function withParentOrder(
  table: ExplorerOrderTable,
  parentKey: string,
  childKeys: readonly string[],
): ExplorerOrderTable {
  const parents: Record<string, string[]> = { ...table.parents }
  if (childKeys.length === 0) {
    delete parents[parentKey]
  } else {
    parents[parentKey] = [...childKeys]
  }
  return { v: EXPLORER_ORDER_VERSION, parents }
}

/** 表内是否有任何自定义次序（「恢复默认排序」入口的显隐判据）。 */
export function hasCustomOrder(table: ExplorerOrderTable): boolean {
  return Object.keys(table.parents).length > 0
}
