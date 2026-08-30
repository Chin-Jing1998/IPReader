// 应用页 slug 单一事实源，供排除链路各消费点引用；刻意零依赖
// （构建期 Node 与浏览器 bundle 双端均可安全引入，不得添加任何 import）

/**
 * 图谱总览专页的宿主 slug（生成器 W1 产出的 content/0-图谱总览/index.md）。
 *
 * 消费方（阶段5.3 批 B4 起共八处，一律引用本常量，不得再写字面量）：
 *   · quartz/components/GraphExplorer.tsx —— 宿主门控，非本页返回 null；
 *   · quartz/components/scripts/pageChrome.inline.ts —— 应用页不挂正文影子滚动条；
 *   · quartz/components/scripts/explorer.inline.ts —— 目录联动门控（B4）：
 *     仅本页把目录条目点击改派为图内定位，并接受法域标签的分支过滤事件；
 *   · quartz/components/scripts/graphexplorer.inline.ts —— F8 降级告警段的
 *     `body[data-slug="…"]` 选择器（唯一一处以模板串拼接，非 `===` 比较）；
 *   · quartz/util/docOrder.ts —— 翻页链排除（A12 收口）；
 *   · quartz/components/ReadingAids.tsx —— 回到顶部控件不渲染（A12 收口）；
 *   · quartz/components/Annotate.tsx —— 选区标注壳层不渲染（A12 收口）；
 *   · quartz/components/scripts/pageNav.inline.ts —— 键盘翻页屏蔽（A12 收口）。
 * ⚠️ CSS 侧（custom.scss / graphexplorer.scss 的 `body[data-slug="…"]`）无法引入
 *   TS 常量，仍是字面量，改 slug 时须一并搜改。
 */
export const GRAPH_SLUG = "0-图谱总览/index"
export const SETTINGS_SLUG = "设置/index"
export const GRAPH_EXCLUDE = "0-图谱总览/"
export const SETTINGS_EXCLUDE = "设置/"

// ─────────────────────────────────────────────────────────────────────────────
// 〔已拆除〕GRAPH_HIDDEN_BOOKS —— 图谱隐藏书目表（阶段5.1 批 G-1 引入，
//   阶段5.11 波O 整体拆除，2026-08-30）
//
// 该常量曾登记 5 部政策程序类文献（63 规范性文件制定管理办法 / 79 强国纲要 /
// 87 规章制定程序规定 / 89 十五五规划 / 90 GB 标准清单）：它们已从
// util/graphSections.ts 的 SECTION_GROUPS 摘除，若不同步排出，会以「未登记前缀」
// 的 --gray 灰点形式仍出现在图谱骨架里，与设计目标不符，故另设此表在
// globalGraph 与图谱总览专页两处经 excludeSlugs 排除（页内局部图刻意不排除）。
//
// 拆除理由：波O 的书目下线名单（12 部）**完整覆盖**了这 5 部——它们的内容目录、
// 生成物与语料均已下线归档，图谱数据集中根本不再存在这些节点，「排除一批不存在
// 的 slug」成了纯粹的空转分支。同时该表是「书在库、但图里不给看」这一半态的唯一
// 承载体，半态消失后继续保留只会让四个消费点各自维持一段永不命中的过滤代码，
// 且与「书级色板须覆盖 88 部（83 登记 + 5 寄养）」这类派生口径互相牵制。
//
// 四个消费点已退化为原生形态（各处仅留 GRAPH_EXCLUDE / SETTINGS_EXCLUDE 两项）：
//   · quartz.layout.ts 的 globalGraph.excludeSlugs；
//   · quartz/components/GraphExplorer.tsx 的 explorerGraphConfig.excludeSlugs；
//   · quartz/plugins/emitters/graphLayout.tsx 的 EXCLUDE_SLUGS；
//   · quartz.layout.ts 的 localGraph.excludeSlugs（本就不含，仅注释同步）。
// 关联注释同步点：util/graphToc.ts 头注、util/graphSections.ts 沿革段、
// styles/custom.scss 书级色板节、util/graphSections.test.ts、desktop/smoke.cjs。
//
// 若将来重新出现「书在库但不进图谱」的需求，按上述四个消费点的原形态恢复即可；
// 恢复用的原表内容见本仓 git 历史（波O 之前的本文件）。
// ─────────────────────────────────────────────────────────────────────────────
