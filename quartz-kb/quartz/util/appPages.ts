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

/**
 * 图谱隐藏书目单一事实源（阶段5.1 批 G-1 新增）：这 5 部文献已从
 * util/graphSections.ts 的 SECTION_GROUPS 摘除（不再登记任何前缀，理由见该文件
 * 头注沿革说明），若不同步排出，会以「未登记前缀」的 --gray 灰点形式仍出现在
 * 图谱中——与「不进图谱骨架」的设计目标不符。
 *
 * ⚠️ 适用范围（阶段5.1 批 G-2 裁决，仅两处，不是三处）：
 *   · quartz.layout.ts 的 **globalGraph**（右栏全局迷你图）—— 排除；
 *   · GraphExplorer.tsx 的图谱总览专页全量图 —— 排除；
 *   · quartz.layout.ts 的 **localGraph**（页内局部图）—— **不排除**。
 * 局部图是「当前页的一跳邻居」视图，排掉这 5 部会让它们自身页面的局部图整块
 * 空白，并让引用过它们的其他页丢失跨书邻居；隐藏的本意是不让它们进入全局骨架
 * 与图例导航，不是把它们从阅读页的上下文里抹掉。也正因局部图仍会渲染这 5 部，
 * 书级色板（custom.scss 的 --graph-book-*）必须覆盖全部 88 部、一部不缺。
 *
 * 目录名均取自 content/ 实测全名（非拼接推断），含尾斜杠以匹配 excludeSlugs
 * 既有的 simplifySlug 容器前缀写法（同 GRAPH_EXCLUDE/SETTINGS_EXCLUDE 惯例）。
 *
 * 沿革（阶段5.2 批 Q-2）：机械撰写规范（5）、化学撰写规范（6）已随 SECTION_GROUPS
 * 召回为独立 main 组，从本表摘除、恢复在图谱中正常显示；本表现仅剩 5 部政策
 * 程序类文献。
 */
export const GRAPH_HIDDEN_BOOKS: readonly string[] = [
  "63-规范性文件制定管理办法/",
  "79-知识产权强国建设纲要/",
  "87-国家知识产权局规章制定程序规定/",
  "89-知识产权保护和运用十五五规划/",
  "90-GB国家标准清单/",
]
