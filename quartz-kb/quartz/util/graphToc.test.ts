import assert from "node:assert/strict"
import test from "node:test"
import { FIELD_TABS } from "./graphSections"
import { buildGraphToc, countTocEntries, type TocIndexLike } from "./graphToc"

// ============================================================
// 图谱目录抽屉数据层（阶段5.7 波B-B1）的边界护栏。
// 夹具一律用字面量构造，不读构建产物 static/contentIndexGraph.json——
// 单测不得依赖一次 50s 的站点构建是否跑过（与 graphSections.test.ts 同规约）。
// 单独重跑：cd quartz-kb && npx tsx --test quartz/util/graphToc.test.ts
//
// 真实语料的规模对照（2026-08-29 实测，由冒烟步 33 在浏览器侧守）：
//   76 部书（阶段5.11 波O 下线 12 部后；波O 前为 83 部）；
//   节仅存于 3-专利审查指南与 80-商标审查审理指南。
// ============================================================

/** 造一个索引条目（只有 title 被消费） */
const entry = (title: string) => ({ title })

/** 覆盖三层 + 六法域 + 各类应排除项的基准夹具 */
const FIXTURE: TocIndexLike = {
  // —— 专利：主干书（组 1）三层齐全 ——
  "1-专利法/index": entry("中华人民共和国专利法"),
  "1-专利法/2-授予专利权的条件/index": entry("第二章 授予专利权的条件"),
  "1-专利法/10-附则/index": entry("第十章 附则"),
  "3-专利审查指南/index": entry("专利审查指南"),
  "3-专利审查指南/2-实质审查/index": entry("第二部分 实质审查"),
  "3-专利审查指南/2-实质审查/8-实质审查程序/index": entry("第八章 实质审查程序"),
  "3-专利审查指南/2-实质审查/10-复审/index": entry("第十章 复审"),
  // 叶子页（末段非 index）：目录只收目录页，叶子由图内节点承担
  "3-专利审查指南/2-实质审查/8-实质审查程序/02-08-05-02": entry("五、审查意见通知书"),
  // 5 段目录：防误入的上界，即便末段是 index 也不得进树
  "3-专利审查指南/2-实质审查/8-实质审查程序/9-细目/index": entry("五级目录不入树"),

  // —— 商标（组 8 / 15）、著作权（组 13）、竞争法（组 12）、品种布图（组 11）、综合程序（组 14）——
  "12-商标案件管辖解释/index": entry("商标案件管辖解释"),
  "80-商标审查审理指南/index": entry("商标审查审理指南"),
  "80-商标审查审理指南/3-商标注册申请/index": entry("第三章 商标注册申请"),
  "14-著作权法/index": entry("中华人民共和国著作权法"),
  "25-反不正当竞争法/index": entry("反不正当竞争法"),
  // ⚠️ 目录前缀 10 属组 "11"（品种布图），不是组号 "10"（专利扩展）
  "10-植物新品种纠纷解释/index": entry("植物新品种纠纷解释"),
  "19-北上广知产法院管辖/index": entry("北上广知产法院管辖"),

  // —— 应被排除的三类 ——
  // ① 术语层（组 9，tier=term）：由术语层三态钮独管，入目录即死行
  "9-关键词索引/index": entry("关键词索引"),
  "9-关键词索引/01-新颖性/index": entry("新颖性"),
  // ② 未登记前缀：90 前缀自阶段5.1 起就未登记入 SECTION_GROUPS，
  //    阶段5.11 波O 更随书目整体下线（该书已不在语料与内容目录中）；
  //    夹具是字面量，故此条仍作「未登记前缀不得入树」的护栏保留
  "90-GB国家标准清单/index": entry("GB 国家标准清单"),
  // ③ 无数字前缀的应用页
  "设置/index": entry("设置"),
  "0-图谱总览/index": entry("图谱总览"),
  index: entry("站点首页"),
}

test("三层归属：2/3/4 段分别落为书、章、节，父子按目录路径挂接", () => {
  const tree = buildGraphToc(FIXTURE)
  const patent = tree.find((n) => n.field === "专利")!
  const guideline = patent.books.find((b) => b.slug === "3-专利审查指南/index")!

  assert.equal(guideline.title, "专利审查指南")
  assert.equal(guideline.children.length, 1, "审查指南下恰一章")

  const part2 = guideline.children[0]
  assert.equal(part2.slug, "3-专利审查指南/2-实质审查/index")
  assert.deepEqual(
    part2.children.map((s) => s.slug),
    ["3-专利审查指南/2-实质审查/8-实质审查程序/index", "3-专利审查指南/2-实质审查/10-复审/index"],
    "第三层为节，且同层按数字序",
  )
  assert.deepEqual(
    part2.children.map((s) => s.children.length),
    [0, 0],
    "节是叶层，children 恒空",
  )

  const law = patent.books.find((b) => b.slug === "1-专利法/index")!
  assert.equal(law.children.length, 2)
  assert.equal(law.children[0].children.length, 0, "无第四层时章的 children 为空")

  assert.deepEqual(countTocEntries(tree), { books: 8, chapters: 4, sections: 2 })
})

test("数字序按数值比大小：10- 排在 2- 之后（字符串序会错成 1、10、2）", () => {
  const tree = buildGraphToc(FIXTURE)
  const law = tree.find((n) => n.field === "专利")!.books.find((b) => b.slug === "1-专利法/index")!

  assert.deepEqual(
    law.children.map((c) => c.slug),
    ["1-专利法/2-授予专利权的条件/index", "1-专利法/10-附则/index"],
  )
  assert.deepEqual(
    law.children.map((c) => c.order),
    [2, 10],
    "order 取本层目录段的数字前缀",
  )
  // 书级同理：1- / 3- 在前，10-（品种布图）在其法域桶内亦按数值定序
  const patentBooks = tree.find((n) => n.field === "专利")!.books.map((b) => b.order)
  assert.deepEqual(
    [...patentBooks].sort((a, b) => a - b),
    patentBooks,
    "书级已按 order 升序",
  )
})

test("术语组、未登记前缀、应用页、叶子页与 5 段目录一律不入树", () => {
  const tree = buildGraphToc(FIXTURE)
  const allSlugs: string[] = []
  const walk = (list: readonly { slug: string; children: readonly any[] }[]) => {
    for (const e of list) {
      allSlugs.push(e.slug)
      walk(e.children)
    }
  }
  for (const node of tree) walk(node.books)

  for (const excluded of [
    "9-关键词索引/index", // 术语组（tier=term）
    "9-关键词索引/01-新颖性/index",
    "90-GB国家标准清单/index", // 未登记前缀（该书已于波O 下线，此处仅作护栏）
    "设置/index", // 无数字前缀的应用页
    "0-图谱总览/index", // 前缀 0 未登记
    "index", // 站点首页（单段）
    "3-专利审查指南/2-实质审查/8-实质审查程序/02-08-05-02", // 末段非 index
    "3-专利审查指南/2-实质审查/8-实质审查程序/9-细目/index", // 5 段
  ]) {
    assert.equal(allSlugs.includes(excluded), false, `${excluded} 不应入树`)
  }
  assert.equal(allSlugs.length, 14, "夹具恰产出 8 书 + 4 章 + 2 节")
})

test("六法域齐备且顺序同 FIELD_TABS；书按 groupOfSlug 的组归属分桶", () => {
  const tree = buildGraphToc(FIXTURE)
  assert.deepEqual(
    tree.map((n) => n.field),
    [...FIELD_TABS],
    "法域节点顺序与 FIELD_TABS 逐项一致",
  )

  const bookSlugsOf = (field: string) =>
    tree.find((n) => n.field === field)!.books.map((b) => b.slug)
  assert.deepEqual(bookSlugsOf("专利"), ["1-专利法/index", "3-专利审查指南/index"])
  assert.deepEqual(bookSlugsOf("商标"), ["12-商标案件管辖解释/index", "80-商标审查审理指南/index"])
  assert.deepEqual(bookSlugsOf("著作权"), ["14-著作权法/index"])
  assert.deepEqual(bookSlugsOf("竞争法"), ["25-反不正当竞争法/index"])
  // 高危点：前缀 10 归组 "11"（品种布图），若按字面前缀会被误塞进「专利」桶（组 10）
  assert.deepEqual(bookSlugsOf("品种布图"), ["10-植物新品种纠纷解释/index"])
  assert.deepEqual(bookSlugsOf("综合程序"), ["19-北上广知产法院管辖/index"])

  const varieties = tree.find((n) => n.field === "品种布图")!.books[0]
  assert.equal(varieties.group, "11", "data-group 取 groupOfSlug 的返回值")
  assert.equal(varieties.order, 10, "order 仍是字面数字前缀，与 group 是两个维度")
})

test("空法域仍占位、空索引返回六个空桶，渲染侧无需为整片缺席另写分支", () => {
  const tree = buildGraphToc({})
  assert.equal(tree.length, 6)
  assert.deepEqual(
    tree.map((n) => n.books.length),
    [0, 0, 0, 0, 0, 0],
  )
  assert.deepEqual(countTocEntries(tree), { books: 0, chapters: 0, sections: 0 })

  // 只有商标一部书时，其余五个法域仍在位
  const one = buildGraphToc({ "12-商标案件管辖解释/index": entry("商标案件管辖解释") })
  assert.deepEqual(
    one.map((n) => n.books.length),
    [0, 1, 0, 0, 0, 0],
  )
})

test("父目录缺席时子条目被丢弃，不凭空造出没有图内节点的父行", () => {
  const orphan = buildGraphToc({
    // 书级 index 缺席
    "1-专利法/1-总则/index": entry("第一章 总则"),
    // 章级 index 缺席
    "3-专利审查指南/index": entry("专利审查指南"),
    "3-专利审查指南/2-实质审查/8-实质审查程序/index": entry("第八章 实质审查程序"),
  })
  const patent = orphan.find((n) => n.field === "专利")!
  assert.deepEqual(
    patent.books.map((b) => b.slug),
    ["3-专利审查指南/index"],
    "孤儿章的书不会被凭空补出",
  )
  assert.equal(patent.books[0].children.length, 0, "父章缺席，孤儿节一并丢弃")
  assert.deepEqual(countTocEntries(orphan), { books: 1, chapters: 0, sections: 0 })
})

test("title 缺失回落本层目录段字面名；无数字前缀沉底并按名定序", () => {
  // tie-break 的 title 刻意取拉丁字母：localeCompare 对中日韩字符的次序随运行环境的
  // ICU 排序规则而异（Node 默认 locale 下按码点，「乙」U+4E59 先于「甲」U+7532），
  // 断言若压在中文上就成了环境断言。带数字前缀者在前这一条与 locale 无关，才是本项要守的。
  const tree = buildGraphToc({
    "1-专利法/index": {},
    "1-专利法/2-授予专利权的条件/index": entry("第二章"),
    "1-专利法/附录二/index": entry("Appendix B"),
    "1-专利法/附录一/index": entry("Appendix A"),
  })
  const law = tree.find((n) => n.field === "专利")!.books[0]
  assert.equal(law.title, "1-专利法", "title 缺失时回落目录段名，不显示 undefined")
  assert.deepEqual(
    law.children.map((c) => c.title),
    ["第二章", "Appendix A", "Appendix B"],
    "带前缀者在前；无前缀者沉底后按 title localeCompare",
  )
  assert.equal(law.children[1].order, Number.MAX_SAFE_INTEGER)
})
