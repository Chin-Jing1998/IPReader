// 图谱域分组：单一事实源，供三处共用——
//   graph.inline.ts         节点着色（sectionColor）与域显隐（setSectionHidden）
//   graphexplorer.inline.ts 图例点击切换与选中态清理
//   GraphExplorer.tsx       图例项 SSR
// 三处必须同键，否则会出现「颜色按法域分组、图例点击按单部文献生效」的错位。
// 组号 id 即 CSS 变量后缀 --graph-section-<id>（custom.scss 六主题 × light/dark 共 12 块）
// 与图例的 data-section 值。
//
// 刻意零依赖（与 appPages.ts 同规约）：构建期 Node 与浏览器 bundle 双端均可安全引入，
// 不得添加任何 import。本模块之所以独立成文件、而非从 graph.inline.ts 导出，是因为
// graphexplorer.inline.ts 对 graph.inline.ts 只做 `import type`——一旦改为值导入，
// esbuild 会把 d3 与 pixi 一并打进 graphexplorer 侧产物（该文件头注释明确要避免）。
//
// 维护规约：新增一部文献（新的顶层数字前缀目录）时，必须在 SECTION_GROUPS 登记其前缀。
// 未登记的前缀 groupOfSlug 返回 undefined，节点回落 --gray——灰点即「未登记」的可见
// 信号，刻意不做静默并组。`0-图谱总览` 亦刻意不登记（已由 appPages.GRAPH_EXCLUDE
// 排出图谱数据集）。前缀 8 与 28 在内容目录中不存在（28 为已裁决剔除的修正案元文档）。
// 新增**组**时另需给出 field（法域标签归属，C-4 标签行据此归并），并同步 FIELD_TABS。
//
// 沿革（阶段5.1 批 G-1）：摘除 id5（机械撰写）/ id6（化学撰写）两整组，并从 id14
// （综合程序）摘除 63、79、87、89、90 五个前缀——上述共 7 部文献同批经 excludeSlugs
// （均引用 appPages.GRAPH_HIDDEN_BOOKS）排出图谱骨架，故本表不再登记其前缀；
// 这 7 部文献的内容目录仍在 content/ 下，仅图谱视图隐藏，与「从未存在」的
// 前缀 8/28 性质不同，勿混淆。原 id8（商标）的前缀 80（商标审查审理指南）
// 未被移除，同批独立成新组 id15，紧邻 id8 排列。
//
// 沿革（阶段5.1 批 G-2）：① 上述排除收窄为**两处**（globalGraph 与图谱总览专页），
// 页内局部图不再排除，理由见 appPages.GRAPH_HIDDEN_BOOKS 的适用范围说明；
// ② 节点着色下沉到书级（见下方 BOOK_COLORS），组级色只余图例点、术语层与回落三用，
// 显隐粒度不变、仍是组级。
//
// 沿革（阶段5.2 批 Q-2）：应用户指令召回 G-1 摘除的 id5（机械撰写）/ id6（化学撰写）
// 两整组，按原定义插回 id4 与 id7 之间——主干由 5 组恢复为 7 组，appPages.
// GRAPH_HIDDEN_BOOKS 同步摘除这两部（现仅剩 63/79/87/89/90 五部政策程序类文献仍隐藏，
// 理由不变）。同批新入库域 91（专利质量评价指南）登记入 id10（专利扩展）组。
// 组数由 13（main5/ext7/term1）增至 15（main7/ext7/term1）；EXT_GROUP_IDS 与其余
// 6 个扩展组的前缀集不受影响。

/** 图例分段：main = 主干七书，ext = 扩展法域组，term = 术语层（由三态钮单独控制） */
export type SectionTier = "main" | "ext" | "term"

/**
 * 法域标签（C-4）：图谱总览页「中国 → 六标签」层级导航的第二级。
 * 与 tier 是两个正交维度——tier 描述图例的呈现分段（主干／扩展／术语），
 * field 描述文献的法域归属；主干七书与「专利扩展」同归 field「专利」，
 * 故一次点击「专利」即得完整专利法域视图（组 1–7 + 10）。
 */
export type FieldTab = "专利" | "商标" | "著作权" | "竞争法" | "品种布图" | "综合程序"

/** 组的 field 取值域：六标签 + 术语（术语层不参与标签导航，由三态钮独管） */
export type SectionField = FieldTab | "术语"

export type SectionGroup = {
  /** 组号：CSS 变量后缀 --graph-section-<id> + 图例 data-section */
  id: string
  /** 图例标签（2–4 字，受工具条单行密度约束） */
  label: string
  /** 归入本组的顶层目录数字前缀 */
  prefixes: number[]
  tier: SectionTier
  /** 法域标签归属（C-4 标签行 data-field 的取值） */
  field: SectionField
}

/**
 * 域组表：数组顺序即图例显示顺序。
 * 主干七书与术语层沿用「组号 = 目录前缀」（历史行为不变）；扩展入库的文献按法域
 * 归为 7 组，组号取 8、10–15——其中 8 复用 custom.scss 十二块早已定义、却从未被
 * 任何目录前缀命中的预留位（原注「粉紫（预留）」）；15（阶段5.1新增，商标审查
 * 指南独立成组）的 --graph-section-15 与图例点规则已于批 G-2 在十二块中补齐
 * （由同块的组 8 派生，落在各主题的商标红系族内）。
 * 归组判据：文献的规范对象是否限于单一法域；跨两个及以上法域、或规范对象为
 * 程序／机关事务／政策者，一律入 §14 综合程序。
 */
export const SECTION_GROUPS: readonly SectionGroup[] = [
  { id: "1", label: "专利法", prefixes: [1], tier: "main", field: "专利" },
  { id: "2", label: "实施细则", prefixes: [2], tier: "main", field: "专利" },
  { id: "3", label: "审查指南", prefixes: [3], tier: "main", field: "专利" },
  { id: "4", label: "侵权判定", prefixes: [4], tier: "main", field: "专利" },
  { id: "5", label: "机械撰写", prefixes: [5], tier: "main", field: "专利" },
  { id: "6", label: "化学撰写", prefixes: [6], tier: "main", field: "专利" },
  { id: "7", label: "答复OA", prefixes: [7], tier: "main", field: "专利" },
  // —— 扩展入库按法域归组（23 + 16 + 1 + 11 + 6 + 6 + 13 = 76）——
  {
    id: "10",
    label: "专利扩展",
    prefixes: [
      11, 17, 20, 26, 37, 44, 56, 57, 60, 61, 62, 64, 65, 68, 72, 73, 74, 75, 78, 81, 82, 85, 91,
    ],
    tier: "ext",
    field: "专利",
  },
  {
    id: "8",
    label: "商标",
    prefixes: [12, 13, 16, 18, 21, 42, 49, 53, 58, 59, 66, 67, 69, 70, 83, 84],
    tier: "ext",
    field: "商标",
  },
  {
    id: "15",
    label: "商标审查指南",
    prefixes: [80],
    tier: "ext",
    field: "商标",
  },
  {
    id: "13",
    label: "著作权",
    prefixes: [14, 38, 39, 40, 41, 45, 51, 52, 55, 76, 77],
    tier: "ext",
    field: "著作权",
  },
  { id: "12", label: "竞争法", prefixes: [25, 30, 32, 46, 48, 71], tier: "ext", field: "竞争法" },
  {
    id: "11",
    label: "品种布图",
    prefixes: [10, 15, 29, 36, 47, 50],
    tier: "ext",
    field: "品种布图",
  },
  {
    id: "14",
    label: "综合程序",
    prefixes: [19, 22, 23, 24, 27, 31, 33, 34, 35, 43, 54, 86, 88],
    tier: "ext",
    field: "综合程序",
  },
  { id: "9", label: "术语", prefixes: [9], tier: "term", field: "术语" },
]

/**
 * 书级色板（阶段5.1 批 G-2；阶段5.2 批 Q-2 更新计数）：目录数字前缀 →
 * { light, dark } 十六进制色值，共 88 键。
 *
 * 真源仍是 CSS —— custom.scss 文末「书级图谱色板」节的 --graph-book-<前缀>
 * （:root 与 :root[saved-theme="dark"] 两个全局块，随明暗自动切换）。本表是
 * graph.inline.ts 读不到该变量时的**兜底**（样式表尚未生效、第三方复用本脚本
 * 却未引入主题层等），与 SECTION_COLORS_FALLBACK 同性质：保证图谱不至于失色，
 * 不当作事实源维护。
 *
 * 两侧色值同出一源：custom.scss 的变量块与本常量都由
 * `node scripts/gen-book-colors.mjs --write` 一次生成，**勿手改**；改配色改脚本
 * 参数后重跑，两处同步更新。
 *
 * 88 = SECTION_GROUPS 登记的 83 部（术语组 9 不计）+ 已摘组但页内局部图仍渲染的
 * 5 部（前缀 63/79/87/89/90，脚本内的寄养表把它们并入邻近法域色系并降饱和）。
 * 前缀 5/6 已于阶段5.2 批 Q-2 随 SECTION_GROUPS 召回为独立 main 组，不再寄养、
 * 恢复各自组锚点色相与正常饱和。前缀 8 与 28 在内容目录中不存在，故不在表内。
 */
// >>> gen-book-colors:ts
export const BOOK_COLORS: Record<string, { light: string; dark: string }> = {
  "1": { light: "#c45868", dark: "#dc6e7d" },
  "2": { light: "#a75f39", dark: "#b97745" },
  "3": { light: "#a6874b", dark: "#bc9d60" },
  "4": { light: "#49906f", dark: "#5fa784" },
  "5": { light: "#458e8d", dark: "#5ba3a3" },
  "6": { light: "#5984b1", dark: "#6e99c8" },
  "7": { light: "#9d7ab9", dark: "#b48fcf" },
  "10": { light: "#6abe5e", dark: "#78cc6c" },
  "11": { light: "#5a481f", dark: "#705e36" },
  "12": { light: "#761d6f", dark: "#8f3787" },
  "13": { light: "#943988", dark: "#ab4f9e" },
  "14": { light: "#642887", dark: "#7b40a0" },
  "15": { light: "#40793e", dark: "#548e51" },
  "16": { light: "#cda6c5", dark: "#dab3d2" },
  "17": { light: "#dab766", dark: "#e6c372" },
  "18": { light: "#88627e", dark: "#9c7591" },
  "19": { light: "#295f98", dark: "#3f74af" },
  "20": { light: "#716238", dark: "#86764c" },
  "21": { light: "#d36fba", dark: "#e47ecb" },
  "22": { light: "#72a1e2", dark: "#80b0f2" },
  "23": { light: "#3e7bd8", dark: "#508eec" },
  "24": { light: "#516387", dark: "#64779d" },
  "25": { light: "#32b3b7", dark: "#46c3c7" },
  "26": { light: "#8e7418", dark: "#a18631" },
  "27": { light: "#a3b4dd", dark: "#afc0ea" },
  "29": { light: "#62a36a", dark: "#72b479" },
  "30": { light: "#256068", dark: "#3c767e" },
  "31": { light: "#5265a8", dark: "#6579be" },
  "32": { light: "#86bfcd", dark: "#92ccda" },
  "33": { light: "#3d4a8b", dark: "#5160a4" },
  "34": { light: "#6571d8", dark: "#7684ec" },
  "35": { light: "#8287b0", dark: "#9398c2" },
  "36": { light: "#84d099", dark: "#90dca5" },
  "37": { light: "#b2a67a", dark: "#c0b587" },
  "38": { light: "#8f50af", dark: "#a363c5" },
  "39": { light: "#bb78da", dark: "#cb88eb" },
  "40": { light: "#673b78", dark: "#7e5190" },
  "41": { light: "#9161a0", dark: "#a473b3" },
  "42": { light: "#603d56", dark: "#78536c" },
  "43": { light: "#8888d2", dark: "#9899e3" },
  "44": { light: "#887e52", dark: "#9a9064" },
  "45": { light: "#cb97d8", dark: "#d9a4e6" },
  "46": { light: "#45788a", dark: "#588c9e" },
  "47": { light: "#4fd188", dark: "#5ede94" },
  "48": { light: "#70a0b8", dark: "#7fb0c8" },
  "49": { light: "#bd76a6", dark: "#cf86b6" },
  "50": { light: "#36614a", dark: "#4b775f" },
  "51": { light: "#7c3189", dark: "#9347a1" },
  "52": { light: "#b766c0", dark: "#c977d2" },
  "53": { light: "#a57c96", dark: "#b78da6" },
  "54": { light: "#47456b", dark: "#5d5b82" },
  "55": { light: "#7b457d", dark: "#925a93" },
  "56": { light: "#b0a04b", dark: "#bfaf5a" },
  "57": { light: "#92852d", dark: "#a49741" },
  "58": { light: "#de91be", dark: "#ec9ecc" },
  "59": { light: "#8d276b", dark: "#a63f81" },
  "60": { light: "#5c582e", dark: "#716e43" },
  "61": { light: "#9c9b6f", dark: "#abab7e" },
  "62": { light: "#b2b35e", dark: "#bfc16c" },
  "63": { light: "#6e6d89", dark: "#80809d" },
  "64": { light: "#707449", dark: "#83875c" },
  "65": { light: "#8f9946", dark: "#9fa957" },
  "66": { light: "#ac4383", dark: "#c25797" },
  "67": { light: "#c497ad", dark: "#d3a5bb" },
  "68": { light: "#b2ba8d", dark: "#bec799" },
  "69": { light: "#7a345a", dark: "#924a70" },
  "70": { light: "#a65a7e", dark: "#ba6d91" },
  "71": { light: "#274f68", dark: "#3d6680" },
  "72": { light: "#6f802e", dark: "#819242" },
  "73": { light: "#b0c676", dark: "#bcd382" },
  "74": { light: "#91ab5d", dark: "#a0ba6b" },
  "75": { light: "#819269", dark: "#91a379" },
  "76": { light: "#a76ba4", dark: "#b97db6" },
  "77": { light: "#af56a8", dark: "#c368bb" },
  "78": { light: "#40512c", dark: "#556841" },
  "79": { light: "#57526e", dark: "#6c6884" },
  "80": { light: "#9a4469", dark: "#b0597d" },
  "81": { light: "#6e9148", dark: "#7fa35a" },
  "82": { light: "#556b47", dark: "#68805a" },
  "83": { light: "#831352", dark: "#9e3068" },
  "84": { light: "#cf5d92", dark: "#e26ea3" },
  "85": { light: "#8ebd78", dark: "#9bcb85" },
  "86": { light: "#604f94", dark: "#7464ab" },
  "87": { light: "#836fb8", dark: "#9581cc" },
  "88": { light: "#83759d", dark: "#9587b0" },
  "89": { light: "#a894c8", dark: "#b7a3d7" },
  "90": { light: "#745e8e", dark: "#8871a3" },
  "91": { light: "#94b08a", dark: "#a1be98" },
}
// <<< gen-book-colors:ts

const PREFIX_TO_GROUP: ReadonlyMap<string, string> = new Map(
  SECTION_GROUPS.flatMap((g) => g.prefixes.map((p) => [String(p), g.id] as const)),
)

/**
 * slug 顶层目录数字前缀 → 域组号。
 * 无数字前缀（如 `tags/…`）、或前缀未在 SECTION_GROUPS 登记时返回 undefined，
 * 由调用方回落原生配色。
 *
 * ⚠️ 组号不是 slug 的字面前缀：判断「某 slug 是否属于某组」必须用本函数比对返回值，
 * 不得写 `slug.startsWith(groupId + "-")`——组号 "10"（专利扩展）会误吞
 * slug "10-植物新品种纠纷解释/…"（该前缀实属组号 "11" 品种布图）。
 */
export function groupOfSlug(id: string): string | undefined {
  const prefix = id.match(/^(\d+)-/)?.[1]
  if (prefix === undefined) return undefined
  return PREFIX_TO_GROUP.get(prefix)
}

/** 某 slug 是否属于指定域组（等价于 groupOfSlug(id) === groupId，供可读性更好的调用点使用） */
export function isSlugInGroup(id: string, groupId: string): boolean {
  return groupOfSlug(id) === groupId
}

/** 全部域组号（含主干与术语），顺序同 SECTION_GROUPS */
export const ALL_GROUP_IDS: readonly string[] = SECTION_GROUPS.map((g) => g.id)

/** 扩展法域组的组号（供图例「扩展」段控一次性切换全部 7 组） */
export const EXT_GROUP_IDS: readonly string[] = SECTION_GROUPS.filter((g) => g.tier === "ext").map(
  (g) => g.id,
)

// ============================================================
// 法域标签导航（C-4）：图谱总览页「中国 → 六标签」两级导航的数据层
// ============================================================

/**
 * 标签行的六个法域标签，数组顺序即标签钮显示顺序。
 * 术语层刻意不入表：其显隐由术语层三态钮独管，标签切换不改动术语层。
 */
export const FIELD_TABS: readonly FieldTab[] = [
  "专利",
  "商标",
  "著作权",
  "竞争法",
  "品种布图",
  "综合程序",
]

/**
 * 「全部」标签钮的哨兵值（SSR 的 data-field 与交互脚本共用同一常量）。
 * 取 "*" 而非空串或中文「全部」：既不可能与任何 FieldTab 取值相撞，
 * 又能被 `[data-field]` 选择器统一枚举到，无需为「全部」另设钩子。
 */
export const FIELD_ALL = "*"

/**
 * 参与标签切换的组号（全部非术语组，共 14 = 主干 7 + 扩展 7）。
 * 标签行的显隐运算一律以本集合为全集：hidden = 本集合 − groupsOfField(field)，
 * 术语组不在其中，故任何标签切换都不会波及术语层三态钮的状态。
 */
export const NON_TERM_GROUP_IDS: readonly string[] = SECTION_GROUPS.filter(
  (g) => g.tier !== "term",
).map((g) => g.id)

/**
 * 法域标签 → 该标签下的组号数组（顺序同 SECTION_GROUPS）。
 * 传入非法标签（含哨兵 FIELD_ALL）时返回空数组，由调用方自行分流。
 *
 * ⚠️ 与 groupOfSlug 同一条纪律：组归属只能经组表比对得出，
 * 不得从 slug 或组号的字面前缀推断（教训见上文 groupOfSlug 注释）。
 */
export function groupsOfField(field: string): string[] {
  return SECTION_GROUPS.filter((g) => g.field === field).map((g) => g.id)
}

/**
 * 多个法域标签 → 组号**并集**（阶段5.11 波J 标签多选化）。
 * 传空集合得空集合，由调用方分流为「全部」——本函数只做并集，不作任何哨兵解释。
 *
 * 返回 Set 而非数组：唯一消费点（graphexplorer.inline.ts 的图例过滤与显隐运算）
 * 全是成员查询；返回数组会让调用方各自再 new 一次，且并集本就需要去重
 *（现有组表下六标签互不重叠，但去重是并集语义的一部分，不该依赖该巧合）。
 *
 * 与 groupsOfField 同一条纪律：组归属只能经组表比对得出，
 * 不得从 slug 或组号的字面前缀推断。
 */
export function groupsOfFields(fields: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const field of fields) {
    for (const id of groupsOfField(field)) out.add(id)
  }
  return out
}
