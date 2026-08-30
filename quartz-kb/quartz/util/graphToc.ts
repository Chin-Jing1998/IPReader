// 图谱总览页「目录导航抽屉」的数据层（阶段5.7 波B-B1）：把图谱四字段索引
// （window.__graphIndex 解析出的 contentIndexGraph.json）折成
// 「法域 → 书 → 章 → 节」三层可渲染树，供 graphexplorer.inline.ts 惰性建 DOM。
//
// 依赖纪律（与 graphSections.ts 同规约）：本模块只依赖 util/path 的类型与
// util/graphSections 的组表，**严禁从 graph.inline.ts 值导入**——后者携带 d3 与
// pixi，一旦值导入，esbuild 会把整包灌进 graphexplorer 侧产物（graphSections.ts
// 文件头已记下同一条教训）。util/path 这一侧也只取 `import type`，运行期零依赖，
// 故本模块在构建期 Node 与浏览器 bundle 双端均可安全引入。
//
// 与图谱数据集同集，零第二份排除表：准入判据是「末段 index + 段数 2–4 +
// groupOfSlug 有登记且非术语组」。三项合起来天然滤掉——
//   · 应用页（`设置/index`、`0-图谱总览/index`）：无数字前缀或前缀未登记；
//   · 术语层（`9-关键词索引/…`）：组 9 的 tier === "term"，由术语层三态钮独管，
//     入目录即是死行（图上默认不可见）。
// 由此本模块不持有任何自己的排除名单，改组表即两侧同步变化。
//
// 沿革（阶段5.11 波O，2026-08-30）：上列第三项「GRAPH_HIDDEN_BOOKS 的 5 部
// （63/79/87/89/90）经 groupOfSlug 返回 undefined 而天然滤掉」已随书目下线失去
// 对象——这 5 部全在波O 的 12 部下线名单内，索引里不再有其条目，
// GRAPH_HIDDEN_BOOKS 机制亦整体拆除（见 util/appPages.ts 尾注）。准入判据一字未改。
//
// 实测规模（2026-08-30 波O 后，语料见 contentIndex）：76 部书；
// 节仅存于 3-专利审查指南与 80-商标审查审理指南两部，其余书只有两层。

import type { FullSlug } from "./path"
import { FIELD_TABS, SECTION_GROUPS, groupOfSlug, type FieldTab } from "./graphSections"

/** 目录条目：书 / 章 / 节同构，层级由 children 表达（节的 children 恒空） */
export type TocEntry = {
  /** 该目录 index 页的 FullSlug，点击目录行即以它调 selectNode */
  slug: FullSlug
  /** 显示名，取索引里的 title；缺失时回落本层目录段的字面名 */
  title: string
  /** 同层排序键：本层目录段的数字前缀；无前缀取 NO_ORDER 沉底 */
  order: number
  /** 域组号（groupOfSlug 算出，非 slug 字面前缀），置灰判据与 data-group 取值 */
  group: string
  children: TocEntry[]
}

/** 法域节点：目录树的最外层，六个法域按 FIELD_TABS 序齐备（无书时 books 为空数组） */
export type TocFieldNode = {
  field: FieldTab
  books: TocEntry[]
}

/**
 * 输入索引的最小结构：只读 title。
 * 刻意写成结构类型而非 import GraphContentIndex——那个类型定义在 index.d.ts 的
 * 全局作用域，而 title 之外的三个字段（slug/links/tags）本模块一概不用；
 * 收窄到最小面既让单测能用几行字面量构造夹具，也杜绝了将来字段增删波及本模块。
 */
export type TocIndexLike = Record<string, { title?: string }>

/** 准入的段数下界（书级 `N-书名/index` 恰 2 段） */
export const TOC_MIN_SEGMENTS = 2
/** 准入的段数上界（节级 `书/章/节/index` 恰 4 段）；5 段及以上不入目录 */
export const TOC_MAX_SEGMENTS = 4

/**
 * 无数字前缀的排序键：沉到同层末尾，再由 title / slug 的 localeCompare 定序。
 * 当前语料下不会命中（76 部书与其全部章节的本层目录段都带数字前缀，实测 0 例），
 * 是给将来新增无前缀目录留的确定性退化路径，而非死代码。
 */
const NO_ORDER = Number.MAX_SAFE_INTEGER

/** 术语组号集合（tier === "term"，当前仅组 9），准入时排除 */
const TERM_GROUP_IDS: ReadonlySet<string> = new Set(
  SECTION_GROUPS.filter((g) => g.tier === "term").map((g) => g.id),
)

/** 组号 → 法域，供书条目归入六个法域桶 */
const GROUP_TO_FIELD: ReadonlyMap<string, string> = new Map(
  SECTION_GROUPS.map((g) => [g.id, g.field] as const),
)

/** 目录段的数字前缀 → 排序键。`10-植物新品种纠纷解释` 得 10，按**数值**比大小 */
function orderOfSegment(segment: string): number {
  const prefix = segment.match(/^(\d+)-/)?.[1]
  return prefix === undefined ? NO_ORDER : Number(prefix)
}

/**
 * 同层定序：数字前缀升序 → title → slug。
 * ⚠️ 必须按数值比，不能按字符串比：字符串序下 "10-" 排在 "2-" **之前**，
 * 目录会呈现 1、10、11、2、3… 的错序（同一坑的另一面见 graphSections.ts
 * groupOfSlug 的注释——字面前缀是排序键，不是组号）。
 * 后两级 tie-break 只为定序稳定：同层同前缀在当前语料下不存在。
 */
function compareEntries(a: TocEntry, b: TocEntry): number {
  if (a.order !== b.order) return a.order - b.order
  const byTitle = a.title.localeCompare(b.title)
  return byTitle !== 0 ? byTitle : a.slug.localeCompare(b.slug)
}

function sortDeep(entries: TocEntry[]): void {
  entries.sort(compareEntries)
  for (const e of entries) {
    if (e.children.length > 0) sortDeep(e.children)
  }
}

/**
 * 索引 → 三层目录树。
 *
 * 层级由 slug 段数判定：2 段 = 书、3 段 = 章、4 段 = 节；父子按目录路径前缀挂接，
 * 父条目缺席时该子条目**丢弃**（不凭空造父节点——目录行点击即 selectNode，
 * 造出的父行没有对应的图内节点，点了只会得到静默失败）。当前语料下孤儿数为 0。
 *
 * 返回按 FIELD_TABS 序的六个法域节点，恒定六个（某法域无书时 books 为空数组），
 * 使渲染侧不必为「某法域整片缺席」另写分支。
 */
export function buildGraphToc(index: TocIndexLike): TocFieldNode[] {
  const byPath = new Map<string, TocEntry>()
  const books: TocEntry[] = []
  const chapters: TocEntry[] = []
  const sections: TocEntry[] = []

  for (const [slug, detail] of Object.entries(index)) {
    const parts = slug.split("/")
    if (parts[parts.length - 1] !== "index") continue
    if (parts.length < TOC_MIN_SEGMENTS || parts.length > TOC_MAX_SEGMENTS) continue
    // 组归属一律经 groupOfSlug 归一：组号不是 slug 的字面数字前缀
    const group = groupOfSlug(slug)
    if (group === undefined || TERM_GROUP_IDS.has(group)) continue

    // 本层目录段 = 去掉末尾 "index" 后的最后一段
    const dirParts = parts.slice(0, parts.length - 1)
    const ownSegment = dirParts[dirParts.length - 1]
    const entry: TocEntry = {
      slug: slug as FullSlug,
      title: detail?.title ?? ownSegment,
      order: orderOfSegment(ownSegment),
      group,
      children: [],
    }
    byPath.set(dirParts.join("/"), entry)
    if (dirParts.length === 1) books.push(entry)
    else if (dirParts.length === 2) chapters.push(entry)
    else sections.push(entry)
  }

  // 先挂章、再挂节：节的父章此刻已全部入表，一趟即可
  for (const list of [chapters, sections]) {
    for (const entry of list) {
      const dirParts = entry.slug.split("/").slice(0, -1)
      const parent = byPath.get(dirParts.slice(0, -1).join("/"))
      parent?.children.push(entry)
    }
  }

  sortDeep(books)

  const byField = new Map<string, TocEntry[]>(FIELD_TABS.map((f) => [f, [] as TocEntry[]]))
  for (const book of books) {
    const field = GROUP_TO_FIELD.get(book.group)
    // 非六标签法域（当前只有「术语」，已在准入处排除）不入桶，防止无声塞进错误法域
    if (field === undefined) continue
    byField.get(field)?.push(book)
  }

  return FIELD_TABS.map((field) => ({ field, books: byField.get(field) ?? [] }))
}

/** 目录树的条目总数（书 + 章 + 节），供渲染侧写计数徽标与冒烟断言取数 */
export function countTocEntries(tree: readonly TocFieldNode[]): {
  books: number
  chapters: number
  sections: number
} {
  let bookCount = 0
  let chapterCount = 0
  let sectionCount = 0
  for (const node of tree) {
    for (const book of node.books) {
      bookCount += 1
      chapterCount += book.children.length
      for (const chapter of book.children) sectionCount += chapter.children.length
    }
  }
  return { books: bookCount, chapters: chapterCount, sections: sectionCount }
}
