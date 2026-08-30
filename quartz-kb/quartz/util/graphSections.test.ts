import assert from "node:assert/strict"
import test from "node:test"
import {
  ALL_GROUP_IDS,
  BOOK_COLORS,
  EXT_GROUP_IDS,
  FIELD_ALL,
  FIELD_TABS,
  NON_TERM_GROUP_IDS,
  SECTION_GROUPS,
  groupOfSlug,
  groupsOfField,
  groupsOfFields,
  isSlugInGroup,
} from "./graphSections"

// ============================================================
// 回归护栏：graphexplorer.inline.ts 的「选中节点所在域组被隐藏 → 清除选中态」判定
// 曾写作 `selectedSlug.startsWith(section + "-")`。改为按法域分组后该写法会静默错判，
// 因为组号不再等于 slug 的字面目录前缀。本文件把该边界钉死。
// 单独重跑：cd quartz-kb && npx tsx --test quartz/util/graphSections.test.ts
// ============================================================

test("高危点回归：组号不是 slug 字面前缀，startsWith 会误吞而 groupOfSlug 不会", () => {
  // 组号 "10" = 专利扩展；slug "10-植物新品种纠纷解释/…" 的目录前缀 10 实属组号 "11" 品种布图
  const slug = "10-植物新品种纠纷解释/pv01-01"

  // 旧写法：字面前缀匹配 → 误判为属于组 "10"
  assert.equal(slug.startsWith("10" + "-"), true, "旧写法确实会误吞，护栏前提成立")

  // 新写法：经组表归一 → 正确归入组 "11"
  assert.equal(groupOfSlug(slug), "11")
  assert.equal(isSlugInGroup(slug, "10"), false, "隐藏『专利扩展』不得连带清空品种文献的选中态")
  assert.equal(isSlugInGroup(slug, "11"), true)

  // 另一侧对称：真正属于组 "10" 的 slug 必须命中组 "10"
  assert.equal(groupOfSlug("11-专利纠纷案件规定/pdr-01"), "10")
  assert.equal(groupOfSlug("85-专利纠纷行政裁决和调解办法/padmd-01"), "10")
})

test("高危点回归：多位数前缀精确到目录号边界，不发生 1/1x、8/8x 的前缀吞并", () => {
  // 单位数组号 "1"（专利法）不得吞掉 11-/12-/…/19- 开头的 slug
  assert.equal(groupOfSlug("1-专利法/law-01-01"), "1")
  assert.equal(groupOfSlug("11-专利纠纷案件规定/pdr-01"), "10")
  assert.equal(groupOfSlug("12-商标案件管辖解释/tmjur-01"), "8")
  assert.equal(groupOfSlug("19-北上广知产法院管辖/ipcj-01"), "14")
  // 组号 "8"（商标）不得吞掉 83-/84- 开头的 slug 的判定逻辑——
  // 这两者恰好也属组 8，故另取属组 10 的 82- 做反例；
  // 80 已于 G-2 独立成组 15（商标审查指南），不再属组 8，一并验证精确匹配
  assert.equal(groupOfSlug("82-专利审查指南发布令/egd-01"), "10")
  assert.equal(groupOfSlug("80-商标审查审理指南/tmeg-01"), "15")
  // 组号 "9"（术语）不得吞掉 90- 开头的 slug；90 前缀已于 G-1 从 §14 摘除、不再登记，
  // 故落回 undefined（而非误判为 "9"）
  assert.equal(groupOfSlug("9-关键词索引/99-综合/term-0186"), "9")
  assert.equal(groupOfSlug("90-GB国家标准清单/gbstd-01"), undefined)
})

test("无数字前缀或未登记前缀一律返回 undefined，由调用方回落原生配色", () => {
  assert.equal(groupOfSlug("tags/专利"), undefined)
  assert.equal(groupOfSlug("index"), undefined)
  assert.equal(groupOfSlug("设置/index"), undefined)
  // 0-图谱总览 刻意不登记（已由 appPages.GRAPH_EXCLUDE 排出图谱数据集）
  assert.equal(groupOfSlug("0-图谱总览/index"), undefined)
  // 内容目录中不存在的前缀（8 与 28）不得意外命中
  assert.equal(groupOfSlug("8-不存在/x"), undefined)
  assert.equal(groupOfSlug("28-已剔除/x"), undefined)
})

test("组表自洽：组号唯一、前缀唯一、非术语前缀合计 83 部（主干 7 + 扩展 76）", () => {
  const ids = SECTION_GROUPS.map((g) => g.id)
  assert.equal(new Set(ids).size, ids.length, "组号不得重复")
  assert.equal(ids.length, 15, "共 15 个域组（主干 7 + 扩展 7 + 术语 1）")

  const prefixes = SECTION_GROUPS.flatMap((g) => g.prefixes)
  assert.equal(new Set(prefixes).size, prefixes.length, "同一目录前缀不得登记进两个组")

  const extPrefixes = SECTION_GROUPS.filter((g) => g.tier === "ext").flatMap((g) => g.prefixes)
  assert.equal(extPrefixes.length, 76, "扩展入库文献共 76 部")
  assert.deepEqual([...EXT_GROUP_IDS], ["10", "8", "15", "13", "12", "11", "14"])
  assert.equal(ALL_GROUP_IDS.length, 15)

  // 划分完备性：非术语前缀（主干 + 扩展）应恰好合计 83 部，与术语组互不重叠
  const nonTermPrefixes = SECTION_GROUPS.filter((g) => g.tier !== "term").flatMap((g) => g.prefixes)
  assert.equal(nonTermPrefixes.length, 83, "非术语前缀合计 83 部（主干 7 + 扩展 76）")

  // 主干七书与术语层沿用「组号 = 目录前缀」的历史行为
  for (const g of SECTION_GROUPS) {
    if (g.tier === "main" || g.tier === "term") {
      assert.deepEqual(g.prefixes, [Number(g.id)], `${g.label} 的组号应等于其目录前缀`)
    }
  }

  // 扩展段前缀落在 10–91 且不与主干／术语（1–9）重叠
  for (const p of extPrefixes) {
    assert.ok(p >= 10 && p <= 91, `扩展前缀 ${p} 应在 10–91 之间`)
  }
})

test("组表与 CSS 变量命名对齐：每个组号都有对应的 --graph-section-<id>", () => {
  // custom.scss 十二个主题块各定义 --graph-section-1..15；此处只校验组号取值域，
  // 实际色值一致性由构建后的样式抽验覆盖。
  for (const g of SECTION_GROUPS) {
    const n = Number(g.id)
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 15, `组号 ${g.id} 应为 1–15 的整数`)
  }
})

// ============================================================
// C-4 法域标签导航数据层回归：groupsOfField 六标签映射 / NON_TERM_GROUP_IDS
// 无重叠全覆盖划分 / 标签补集计算 / 高亮反解三态。
// 迁自验证件 /tmp/c4-fieldtabs.test.mts。
// 同批 /tmp/c4-statemachine.test.mts 覆盖的是 graphexplorer.inline.ts 点击标签、
// 图例微调、重置等交互状态机转移表，不属于 graphSections 纯数据层，未迁入本文件；
// 其状态机断言未依赖迁入本处的 activeField 镜像函数，故本次也未随迁 Machine 类，
// 仍留存于 /tmp，留给覆盖 graphexplorer.inline.ts 交互行为的测试落地时处理。
// ============================================================

/**
 * 标签高亮反解——graphexplorer.inline.ts 内 activeFields() 的**同构镜像**
 *（阶段5.11 波J：随标签多选化由返回单值改为返回**高亮集合**）。
 * 镜像而非直接引入：该函数是挂载闭包内的局部函数，无法从模块外调用；
 * 两处逻辑必须逐行对齐，改动其一须同步改另一处。
 *
 * 三态：空隐藏集 → { FIELD_ALL }；若干标签整组全显、其余整组全隐 → 那几枚；
 * 有标签只显了一部分组 → 空集（自定义态）。波J 之前的「返回 null」即现在的空集。
 */
function activeFields(hidden: ReadonlySet<string>): Set<string> {
  const hiddenCount = NON_TERM_GROUP_IDS.filter((id) => hidden.has(id)).length
  if (hiddenCount === 0) return new Set([FIELD_ALL])
  const lit = new Set<string>()
  for (const field of FIELD_TABS) {
    const groups = groupsOfField(field)
    const shownCount = groups.filter((id) => !hidden.has(id)).length
    if (shownCount === 0) continue
    if (shownCount !== groups.length) return new Set()
    lit.add(field)
  }
  return lit
}

/**
 * 单选态的反解便捷式：高亮恰一枚时返回该枚，否则（全部/自定义/多选）返回 null。
 * 供波J 之前那批逐值断言原样沿用——它们描述的正是「恰一枚」这一子集。
 */
function activeFieldOf(hidden: ReadonlySet<string>): string | null {
  const lit = activeFields(hidden)
  if (lit.size !== 1) return null
  const [only] = lit
  return only === FIELD_ALL ? null : only
}

/**
 * applyFields 的隐藏集运算镜像（波J 集合版）：
 * hidden = 非术语全集 − 各标签组集的并集；传空集合即「全部」，得空隐藏集。
 */
function hiddenSetOfFields(fields: Iterable<string>): Set<string> {
  const list = [...fields]
  const shown = new Set(list.length === 0 ? NON_TERM_GROUP_IDS : groupsOfFields(list))
  return new Set(NON_TERM_GROUP_IDS.filter((id) => !shown.has(id)))
}

/** 单标签便捷式：FIELD_ALL 归一为空集合（波J 前的 hiddenSetOfField 逐值等价） */
function hiddenSetOfField(field: string): Set<string> {
  return hiddenSetOfFields(field === FIELD_ALL ? [] : [field])
}

test("FIELD_TABS：六标签、顺序即显示顺序、不含术语", () => {
  assert.deepEqual([...FIELD_TABS], ["专利", "商标", "著作权", "竞争法", "品种布图", "综合程序"])
  assert.equal(FIELD_TABS.includes("术语" as never), false, "术语层不参与标签导航")
  assert.equal(FIELD_ALL, "*")
  // FieldTab 是六字面量的封闭联合，与哨兵 "*" 类型上本无交集——TS 会据此静态判定
  // `f === FIELD_ALL` 恒为 false 而报 TS2367；此处显式加宽为 string 后再比较，
  // 保留运行时校验意图的同时消除误报（C-4 遗留，本次连同断言重算一并修复）。
  assert.equal(
    (FIELD_TABS as readonly string[]).some((f) => f === FIELD_ALL),
    false,
    "「全部」哨兵不得与任何法域标签取值相撞",
  )
})

test("groupsOfField：六标签 → 组集合精确映射（专利含主干七书 + 专利扩展，商标含商标审查指南）", () => {
  assert.deepEqual(groupsOfField("专利"), ["1", "2", "3", "4", "5", "6", "7", "10"])
  assert.deepEqual(groupsOfField("商标"), ["8", "15"])
  assert.deepEqual(groupsOfField("著作权"), ["13"])
  assert.deepEqual(groupsOfField("竞争法"), ["12"])
  assert.deepEqual(groupsOfField("品种布图"), ["11"])
  assert.deepEqual(groupsOfField("综合程序"), ["14"])
  // 术语组虽带 field="术语"，但不在 FIELD_TABS 中，不会被标签行枚举到
  assert.deepEqual(groupsOfField("术语"), ["9"])
  // 未登记标签与哨兵一律空数组，applyField 据此短路、不把整图切空
  assert.deepEqual(groupsOfField("外观设计"), [])
  assert.deepEqual(groupsOfField(FIELD_ALL), [])
})

test("NON_TERM_GROUP_IDS：14 组，排除术语，且六标签构成其无重叠划分", () => {
  assert.equal(NON_TERM_GROUP_IDS.length, 14, "主干 7 + 扩展 7")
  assert.equal(NON_TERM_GROUP_IDS.includes("9"), false, "术语组不参与标签切换")
  assert.equal(ALL_GROUP_IDS.length - NON_TERM_GROUP_IDS.length, 1)
  // 扩展七组全部在内
  for (const id of EXT_GROUP_IDS) {
    assert.ok(NON_TERM_GROUP_IDS.includes(id), `扩展组 ${id} 应在全集内`)
  }

  const union = FIELD_TABS.flatMap((f) => groupsOfField(f))
  assert.equal(new Set(union).size, union.length, "同一组不得归入两个标签")
  assert.deepEqual([...union].sort(), [...NON_TERM_GROUP_IDS].sort(), "六标签恰好覆盖全部非术语组")

  // 每个组都必须声明 field，且取值须落在合法域（六标签 ∪ 术语）内——
  // 防止新增组漏填 field 而静默掉出标签体系，或误填标签体系外的取值
  const validFields = new Set<string>([...FIELD_TABS, "术语"])
  for (const g of SECTION_GROUPS) {
    assert.ok(typeof g.field === "string" && g.field.length > 0, `组 ${g.id} 缺 field`)
    assert.ok(validFields.has(g.field), `组 ${g.id} 的 field 取值「${g.field}」不在合法域内`)
  }
})

test("标签补集：hidden = 非术语全集 − 该标签组集，size 互补", () => {
  assert.deepEqual([...hiddenSetOfField("专利")].sort(), ["11", "12", "13", "14", "15", "8"])
  assert.equal(hiddenSetOfField("专利").size, 6)
  assert.equal(hiddenSetOfField("商标").size, 12)
  assert.equal(hiddenSetOfField("著作权").size, 13)
  assert.equal(hiddenSetOfField(FIELD_ALL).size, 0, "「全部」= 清空非术语组隐藏")
  for (const f of FIELD_TABS) {
    assert.equal(hiddenSetOfField(f).size + groupsOfField(f).length, NON_TERM_GROUP_IDS.length)
    assert.equal(hiddenSetOfField(f).has("9"), false, "任何标签都不得把术语组写进隐藏集")
  }
})

test("高亮反解三态：精确匹配 / 全部 / 自定义", () => {
  // ① 空集 → 全部
  assert.deepEqual([...activeFields(new Set())], [FIELD_ALL])
  // ② 恰为某标签的补集 → 该标签（六标签逐一往返自洽）
  for (const f of FIELD_TABS) {
    assert.equal(activeFieldOf(hiddenSetOfField(f)), f, `${f} 的补集应反解回 ${f}`)
  }
  // ③ 自定义态：图例手动微调后不属任何标签组合的补集 → 无高亮
  assert.equal(activeFields(new Set(["8"])).size, 0, "仅隐藏商标一组 = 自定义态（15 仍显）")
  assert.equal(activeFields(new Set(["1"])).size, 0, "仅隐藏专利法一组 = 自定义态")
  assert.equal(
    activeFields(new Set(["11", "12", "13", "14", "15"])).size,
    0,
    "比「专利」补集少隐一组（8 商标）= 自定义态（商标只显了一半）",
  )
  assert.equal(
    activeFields(new Set([...NON_TERM_GROUP_IDS])).size,
    0,
    "非术语组全隐（无任何法域可见）= 自定义态，不得误判为某标签",
  )
  // ④ 扩展段控全隐（EXT 七组全隐）：其中 10 属专利、8/15 属商标，
  //    专利只显了 7/8 组 ⇒ 落自定义态，不得被多选反解误判为「主干七书那几片法域」
  assert.equal(
    activeFields(new Set(EXT_GROUP_IDS)).size,
    0,
    "扩展段控全隐 = 自定义态（专利组 10 亦被隐，专利只显一半）",
  )
  // ⑤ 术语组混入隐藏集不影响反解（术语层由三态钮独管）
  assert.deepEqual([...activeFields(new Set(["9"]))], [FIELD_ALL], "术语组不计入标签判定")
  assert.equal(activeFieldOf(new Set([...hiddenSetOfField("商标"), "9"])), "商标")
})

// ============================================================
// 标签多选（阶段5.11 波J）：并集补集运算 + 多枚同亮的反解 + 选满塌缩
// ============================================================

test("groupsOfFields：并集去重，空集合得空集合，非法标签被忽略", () => {
  assert.deepEqual([...groupsOfFields([])], [])
  // 单枚与 groupsOfField 逐值同解（顺序无关，比排序后的数组）
  for (const f of FIELD_TABS) {
    assert.deepEqual([...groupsOfFields([f])].sort(), [...groupsOfField(f)].sort(), `${f} 单枚`)
  }
  // 专利（8 组）+ 商标（2 组）= 10 组，main 与 ext 都非空的组合
  assert.deepEqual([...groupsOfFields(["专利", "商标"])].sort(), [
    "1",
    "10",
    "15",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
  ])
  // 重复传入不改结果（并集去重）
  assert.deepEqual([...groupsOfFields(["商标", "商标"])].sort(), ["15", "8"])
  // 非法标签在组表内没有任何组，不产生任何贡献，也不报错
  assert.deepEqual([...groupsOfFields(["外观设计"])], [])
  assert.deepEqual([...groupsOfFields(["商标", "外观设计"])].sort(), ["15", "8"])
  // 六枚全选 = 非术语全集（正是「选满即塌缩为全部」在数据层的依据）
  assert.equal(groupsOfFields(FIELD_TABS).size, NON_TERM_GROUP_IDS.length)
})

test("多选补集：hidden = 非术语全集 − 组并集，且反解回同一组标签", () => {
  // 专利 + 商标：可见 10 组，隐藏 4 组（著作权 13 / 竞争法 12 / 品种布图 11 / 综合程序 14）
  const dual = hiddenSetOfFields(["专利", "商标"])
  assert.deepEqual([...dual].sort(), ["11", "12", "13", "14"])
  assert.deepEqual([...activeFields(dual)].sort(), ["专利", "商标"])

  // 三枚同选同样往返自洽
  const triple = hiddenSetOfFields(["著作权", "竞争法", "品种布图"])
  assert.deepEqual([...triple].sort(), ["1", "10", "14", "15", "2", "3", "4", "5", "6", "7", "8"])
  assert.deepEqual([...activeFields(triple)].sort(), ["品种布图", "竞争法", "著作权"])

  // 任意两枚组合逐对往返：size 互补 + 反解回原组合
  for (const a of FIELD_TABS) {
    for (const b of FIELD_TABS) {
      if (a === b) continue
      const hidden = hiddenSetOfFields([a, b])
      assert.equal(hidden.size + groupsOfFields([a, b]).size, NON_TERM_GROUP_IDS.length)
      assert.equal(hidden.has("9"), false, "任何标签组合都不得把术语组写进隐藏集")
      assert.deepEqual([...activeFields(hidden)].sort(), [a, b].sort(), `${a}+${b} 往返`)
    }
  }
})

test("选满六枚塌缩：隐藏集为空 ⇒ 反解为「全部」而非六枚同亮", () => {
  const full = hiddenSetOfFields(FIELD_TABS)
  assert.equal(full.size, 0, "六枚并选的补集为空，与「全部」在组显隐上同解")
  // 反解只认 hiddenSections，故六枚并选与「全部」不可区分——正因如此，
  // 交互层必须在 nextFieldSet 里把「选满六枚」显式塌缩为空集：
  // 二者在组显隐上同解，但在术语层上不同（六枚并选会滤掉无法域归属的术语）。
  assert.deepEqual([...activeFields(full)], [FIELD_ALL])
  assert.deepEqual([...activeFields(hiddenSetOfFields([]))], [FIELD_ALL])
})

// ============================================================
// 书级色板回归（阶段5.1 批 G-2；阶段5.2 批 Q-2 更新计数）：BOOK_COLORS 键集与色值格式。
// 88 = SECTION_GROUPS 非术语组登记的 83 部前缀 + 已摘组但页内局部图仍渲染的
// 5 部隐藏书前缀（63/79/87/89/90，详见 graphSections.ts 顶部沿革注释）。
// 前缀 5/6 已于阶段5.2 批 Q-2 随 SECTION_GROUPS 召回为独立 main 组，不再属于
// 隐藏书前缀、改由 nonTermPrefixes 覆盖。
// ============================================================

test("BOOK_COLORS：88 键 = 非术语组全部前缀 ∪ 5 部隐藏书前缀，不含术语前缀 9", () => {
  const nonTermPrefixes = SECTION_GROUPS.filter((g) => g.tier !== "term").flatMap((g) =>
    g.prefixes.map(String),
  )
  // 阶段5.1 批 G-1 从 SECTION_GROUPS 摘除、但仍保留书级配色供页内局部图渲染的 5 部
  const hiddenBookPrefixes = ["63", "79", "87", "89", "90"]
  const byNumber = (a: string, b: string) => Number(a) - Number(b)
  const expectedKeys = [...new Set([...nonTermPrefixes, ...hiddenBookPrefixes])].sort(byNumber)

  const actualKeys = Object.keys(BOOK_COLORS)
  assert.equal(new Set(actualKeys).size, actualKeys.length, "BOOK_COLORS 键不得重复")
  assert.equal(actualKeys.length, 88, "BOOK_COLORS 应恰为 88 键")
  assert.deepEqual(
    [...actualKeys].sort(byNumber),
    expectedKeys,
    "键集应等于非术语组前缀并集 5 部隐藏书前缀",
  )
  assert.equal(BOOK_COLORS["9"], undefined, "BOOK_COLORS 不得含术语前缀 9（术语层无书级配色）")
})

test("BOOK_COLORS：每键 light/dark 均为合法十六进制色值，176 色值全局无重复", () => {
  const hexPattern = /^#[0-9a-f]{6}$/
  const allValues: string[] = []
  for (const [prefix, { light, dark }] of Object.entries(BOOK_COLORS)) {
    assert.match(light, hexPattern, `前缀 ${prefix} 的 light 色值格式非法：${light}`)
    assert.match(dark, hexPattern, `前缀 ${prefix} 的 dark 色值格式非法：${dark}`)
    allValues.push(light, dark)
  }
  assert.equal(allValues.length, 176, "88 键 × light/dark 应共 176 个色值")
  assert.equal(new Set(allValues).size, 176, "176 个色值不得有重复")
})
