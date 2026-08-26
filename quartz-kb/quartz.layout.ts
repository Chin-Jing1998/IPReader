import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
import { GRAPH_HIDDEN_BOOKS } from "./quartz/util/appPages"

/**
 * Explorer 共用配置（内容页与列表页保持一致）。
 *
 * 注意：sortFn / filterFn / mapFn 会被 toString() 序列化后送入浏览器执行，
 * 必须是纯函数——不得引用函数体外的任何变量、导入或类型运行时值。
 */
const explorerConfig = {
  title: "知识库目录",
  // 注意：函数体内不得定义具名内部函数（const fn = …），否则 esbuild 的 keep-names
  // 转换会注入 __name() 包装，序列化到浏览器后 __name 未定义导致排序失效
  // 排序规则已内联到 explorer.inline.ts 的 sortNodes——原先经 toString() 传给
  // 浏览器再 eval，迫使 CSP 放行 'unsafe-eval'。此处不再配置，避免两份真相。
  // 默认展开到第一层目录（Explorer.tsx Options.openLevels，F5 已实现）
  openLevels: 1,
}

/**
 * Graph 关系图参数调优：
 * - 局部图 depth 取 1（v3 W3）：详情页右侧只显示与当前页直接关联的一跳邻居，
 *   两跳邻居在中等章节页会引入上百个节点、喧宾夺主；全量探索交给图谱总览专页；
 * - 全局图节点规模约 83 部书章节 + 1035 术语，初始缩放调小、开启径向布局与悬停聚焦；
 * - 中文标签字号略放大；关闭 tag 节点避免术语页标签造成视觉噪声。
 */
const graphConfig = {
  localGraph: {
    depth: 1,
    scale: 1.05,
    repelForce: 0.6,
    centerForce: 0.3,
    linkDistance: 32,
    fontSize: 0.7,
    opacityScale: 1,
    showTags: false,
    focusOnHover: true,
    // v14：局部图此前漏配本项，落回 Graph.tsx 默认的 false——相机恒为 zoomIdentity，
    // 节点按「力导坐标 + 画布半宽/半高」直接下笔，一跳邻居一多就铺出 250px 的卡外，
    // 右/下缘节点被 .graph-outer 的 overflow:hidden 裁成半个圆。开启后走与全局图
    // 同一条路径：先同步预热力导（首帧即成形，无跳变），再无过渡地落入框相机。
    zoomToFit: true,
    // V4-B1：排除链接全站的宿主页节点（目录 index 页的 simplifySlug 带尾斜杠）
    // 刻意**不**排除 GRAPH_HIDDEN_BOOKS：局部图是「当前页的一跳邻居」视图，
    // 排掉那 5 部会让它们自己的页面局部图整块空白、并使他页丢失跨书邻居。
    // 隐藏只在全局迷你图与图谱总览两处生效（见 appPages.GRAPH_HIDDEN_BOOKS 注释）。
    excludeSlugs: ["0-图谱总览/", "设置/"],
  },
  globalGraph: {
    depth: -1,
    scale: 0.7,
    repelForce: 0.6,
    centerForce: 0.2,
    linkDistance: 30,
    fontSize: 0.55,
    opacityScale: 1,
    showTags: false,
    focusOnHover: true,
    enableRadial: true,
    // V4-B1：全局图默认隐藏术语层（1015 节点/9728 边），骨架约 1203 节点/7042 边；
    // 布局成形后自动整图入框；除宿主页节点外，另排除 GRAPH_HIDDEN_BOOKS 那 5 部
    termLayer: "hidden" as const,
    zoomToFit: true,
    excludeSlugs: ["0-图谱总览/", "设置/", ...GRAPH_HIDDEN_BOOKS],
  },
}

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  // 图谱总览专页（W3）：同一模式，仅 0-图谱总览/index 页渲染全幅图谱 + 玻璃侧栏
  // PageNav（v6）：书籍式上一节/下一节翻页，链外页面（首页/图谱页）自行返回 null
  // ReadingAids（v6）：回顶进度环 FAB + TOC 当前节强调（图谱页自行返回 null）
  // Annotate（v7）：选中文本的复制/高亮/划线/笔记（图谱页自行返回 null）
  // SettingsPage（v9）：独立设置页正文，仅 设置/index 页渲染（同 GraphExplorer 模式）。
  // v8 的居中模态已整体废弃——设置不再是浮层，故原「遮罩挂 document.body 规避
  // left 栏层叠上下文」的机制连同 z-850 层位一并不复存在；左栏只留
  // SettingsButton（齿轮 <a> 跳本页；v14 已删除同排的明暗快捷钮，
  // 明暗模式改由设置页抽屉内的分段控件独占入口）
  afterBody: [
    // TitleBar 置于首位：桌面自绘标题条（fixed 定位、CSS 门控 html[data-desktop]），
    // DOM 序首位便于排查层叠顺序问题
    Component.TitleBar(),
    // 正文影子滚动条（零渲染脚本宿主，样式在 custom.scss 第十五节）
    Component.PageChrome(),
    Component.GraphExplorer(),
    Component.SettingsPage(),
    Component.PageNav(),
    Component.ReadingAids(),
    Component.Annotate(),
  ],
  // 离线化：清空页脚外链（GitHub/Discord 在离线环境为死链）
  footer: Component.Footer({
    links: {},
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.SettingsButton() },
        { Component: Component.ReaderMode() },
      ],
      // 间距单一事实源：custom.scss 的 --kb-quick-gap（默认回落 0.4rem）
      gap: "var(--kb-quick-gap, 0.4rem)",
    }),
    Component.Explorer(explorerConfig),
  ],
  right: [
    Component.Graph(graphConfig),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
}

// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.SettingsButton() },
        // 图谱总览等目录页与内容页左栏保持一致（v10）：阅读模式按钮同排
        { Component: Component.ReaderMode() },
      ],
      // 间距单一事实源：custom.scss 的 --kb-quick-gap（默认回落 0.4rem）
      gap: "var(--kb-quick-gap, 0.4rem)",
    }),
    Component.Explorer(explorerConfig),
  ],
  right: [],
}
