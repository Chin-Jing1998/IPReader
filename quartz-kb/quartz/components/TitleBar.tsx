import { JSX } from "preact"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/titlebar.scss"
import { trieFromAllFiles } from "../util/ctx"

/**
 * 自绘标题条（桌面端 macOS `titleBarStyle: 'hiddenInset'`）。
 *
 * 系统标题栏在 hiddenInset 下不再绘制标题文本、页面内容延伸至窗口顶端，
 * 故这条固定条带由页面自绘；颜色随主题走 CSS 变量，这正是系统标题栏做不到的（需求⑥）。
 *
 * **始终 SSR 渲染，显隐全部交给 CSS**：静态构建期无法探知运行平台，
 * 无从在 SSR 阶段决定该不该输出这段 DOM。因此本组件无条件输出，
 * 由 `html[data-desktop]`（Electron + macOS 时于首帧写入，见 settings.inline.ts）
 * 与非移动端断点共同门控 `display`；浏览器打开同一份产物时门控不成立，
 * 标题条保持 `display: none`，对网页版零影响。
 *
 * ── 阶段5.14 施工②：条带内容由应用名改为「正在阅览的正文目录」 ──
 *
 * 条带此前恒显应用名 `IPReader`——那是一条读一次就再无信息增量的常量，占着窗口顶部
 * 最显眼的一行却说不出「现在读到哪里」。现改为渲染当前页在**目录树中的祖先链**：
 *
 *     书名 › 章 › 节 › 当前页标题
 *
 * 取材于 `ctx.trie` 的 `ancestryChain`，与 `Breadcrumbs.tsx`（正文上方那条面包屑）
 * **同一事实源**，两处因而恒不漂移；trie 由 `ctx.trie ??=` 缓存，两个组件共用一棵，
 * 本组件不产生额外构建开销。
 *
 * 三条设计决断：
 *
 *   ① **根节点（Breadcrumbs 中显示为 "Home"）一律摘除**。它对「读到哪一节」零信息量，
 *      却要吃掉 38px 条带里最稀缺的横向空间。摘除后首页的链恰好为空，回落应用名——
 *      即「无正文可指时才报身份」，见下方 `APP_DISPLAY_NAME`。
 *   ② **不保留 `IPReader` 前缀**。链首本就是书名，上下文已经完整；再挂一个应用名只会
 *      在窄窗下把书名挤成省略号。应用身份另有三处稳定出口：macOS 窗口菜单与调度中心
 *      的窗口标题（`desktop/main.cjs` 建窗时钉死为 IPReader 且拦截 page-title-updated）、
 *      程序坞图标、设置页「关于」。
 *   ③ **SPA 导航无需任何脚本**。条带位于 `afterBody`（在 `<body>` 内），micromorph
 *      形变 body 时会连带把它换成新页 SSR 出的那份，跟随因而是结构性的、零 JS、
 *      零闪动；硬跳转与刷新更是天然正确。这也是刻意不做「运行时读 DOM 拼字符串」的
 *      理由——那条路要额外挂 nav 监听，且在 morph 与回调之间存在一帧旧值。
 *
 * 层级过深时的收敛交给 CSS 而非在此截断：`titlebar.scss` 用 flex-shrink 权重让
 * 中间层先塌缩为省略号，书名次之，**当前页标题永远最后才让**——按信息价值排序，
 * 且随窗口宽度连续生效，比写死一个层数阈值更贴合实际。
 *
 * `aria-hidden`：这是窗口 chrome 的视觉补齐件，非页面内容；同一条祖先链已由
 * `Breadcrumbs` 以 `<nav aria-label="breadcrumbs">` 向辅助技术正式暴露，
 * 此处重复朗读只会造成冗余。
 */
// 无祖先链可显示时的回落文本（首页，以及 404、tags 等不在 trie 内的页面）。
// 刻意不取 cfg.pageTitle——显示名统一后二者当前同值，但窗口 chrome 应跟随应用身份
// 而非站点配置：独立常量保证将来 pageTitle 再调整时窗口标题不随动。
const APP_DISPLAY_NAME = "IPReader"

// 层级分隔符。取 U+203A（单右角引号）而非 Breadcrumbs 用的 U+276F（❯）：
// 后者是重笔画的装饰箭头，在 13px 条带上比两侧的汉字还抢眼；203A 笔画轻、
// 宽度窄，正合「分隔而不发声」的职能。
const CRUMB_SEPARATOR = "›"

const TitleBar: QuartzComponent = ({ fileData, allFiles, ctx }: QuartzComponentProps) => {
  const trie = (ctx.trie ??= trieFromAllFiles(allFiles))
  // ancestryChain 对不在 trie 内的页面（404、tags/*）返回 undefined，
  // 与 Breadcrumbs 在同一情形下返回 null 是同一判据，两处行为一致。
  const chain = fileData.slug ? trie.ancestryChain(fileData.slug.split("/")) : undefined
  const crumbs = (chain ?? [])
    .slice(1) // 决断①：摘掉根节点
    .map((node) => node.displayName)
    .filter((name) => name.length > 0)

  if (crumbs.length === 0) {
    return (
      <div class="kb-titlebar" aria-hidden="true">
        <span class="kb-titlebar-text">
          <span class="kb-titlebar-app">{APP_DISPLAY_NAME}</span>
        </span>
      </div>
    )
  }

  // 分隔符作为独立元素而非拼进文本：它需要与两侧的层级各自取不同的收缩权重
  // 与颜色，混在同一个文本节点里就无从分别控制。
  // 用数组而非 Fragment 逐层包裹——Fragment 会多一层 DOM 之外的结构噪声，
  // 且 flex 布局要求分隔符与层级是**同级**兄弟，包起来即失效。
  const parts: JSX.Element[] = []
  crumbs.forEach((name, idx) => {
    if (idx > 0) {
      parts.push(<span class="kb-crumb-sep">{CRUMB_SEPARATOR}</span>)
    }
    // 收缩优先级三档，见 titlebar.scss：leaf（当前页）最后让，root（书名）次之，
    // mid（章、节）先塌缩。单层链（书根页、图谱总览、设置页）只有一个元素，
    // 它既是首也是末，按 leaf 处理——那正是该页唯一的信息。
    const kind =
      idx === crumbs.length - 1 ? "kb-crumb-leaf" : idx === 0 ? "kb-crumb-root" : "kb-crumb-mid"
    parts.push(<span class={`kb-crumb ${kind}`}>{name}</span>)
  })

  return (
    <div class="kb-titlebar" aria-hidden="true">
      <span class="kb-titlebar-text">{parts}</span>
    </div>
  )
}

TitleBar.css = style

export default (() => TitleBar) satisfies QuartzComponentConstructor
