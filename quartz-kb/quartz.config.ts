import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"
import * as Component from "./quartz/components"
import { byDocumentOrder } from "./quartz/util/docOrder"

/**
 * Quartz 4 配置 —— IPReader（纯离线定制版）
 *
 * 离线化要点：
 * 1. analytics 置 null，不注入任何统计脚本；
 * 2. baseUrl 设为 localhost，产物仅在 Electron 本地 http 托管，不产生外部链接；
 * 3. fontOrigin 设为 "local" 且 typography 使用系统字体栈，构建期与运行期均不请求任何字体文件；
 * 4. 移除 Latex 插件（KaTeX 依赖 jsdelivr CDN）与 CustomOgImages（构建期请求 Google Fonts）。
 *
 * 列表页「文档序」排序（FolderPage / TagPage 正文条目列表）：
 * 背景：全库 frontmatter 无 date，PageList 默认按修改日期排序在工具书语义下
 * 无意义且导致目录页条目跳号。规则详见 quartz/util/docOrder.ts（v6 迁出为
 * 全库单一事实源——列表序 / Explorer 树序 / PageNav 翻页链序三者同源）。
 */

const config: QuartzConfig = {
  configuration: {
    pageTitle: "IPReader",
    pageTitleSuffix: "",
    enableSPA: true,
    enablePopovers: true,
    // 离线运行，禁用一切统计分析
    analytics: null,
    locale: "zh-CN",
    // 纯离线场景：baseUrl 仅用于生成 sitemap/RSS/og 等 meta 值，设为 localhost 不产外链
    baseUrl: "localhost",
    ignorePatterns: ["private", "templates", ".obsidian"],
    defaultDateType: "modified",
    theme: {
      // 本地字体：不下载、不引用任何字体文件，完全依赖系统字体栈
      fontOrigin: "local",
      cdnCaching: false,
      typography: {
        // 中文系统字体栈（含逗号的完整栈会被 joinStyles 原样输出，见 quartz/util/theme.ts）
        // 字体栈的事实源是 quartz/styles/custom.scss 的 $fontHei/$fontSong/$fontPing/
        // $fontKai/$fontFang 五个常量；此处 header/body 是「宣纸」主题那一份的副本
        // （B1 双写），用于兜住无 JS / 首帧尚未落 data-style 的极早期窗口。
        // 改动时两处必须同改，否则 Electron 首帧与稳定态字体不一致。
        header:
          '"Heiti SC", "STHeiti", "SimHei", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif',
        body: '"Songti SC", "SimSun", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", serif',
        code: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace',
      },
      // 基础九色同为「宣纸」主题的副本（B1 双写，理由同上）。六套主题的完整
      // 定义在 custom.scss 的 [data-style] 覆盖块；joinStyles 把本处的值拼在
      // index.css 末尾的 :root / :root[saved-theme="dark"]，特异性 (0,1,0)/(0,2,0)
      // 低于覆盖块，稳定态一律由覆盖块接管。
      colors: {
        lightMode: {
          light: "#feefe5",
          lightgray: "#e1d6cf",
          gray: "#948781",
          darkgray: "#6e6059",
          dark: "#3a3226",
          secondary: "#8c5a3c",
          tertiary: "#a3775d",
          highlight: "rgba(140, 90, 60, 0.13)",
          textHighlight: "#fecbaeaa",
        },
        darkMode: {
          light: "#201c16",
          lightgray: "#342d28",
          gray: "#70675f",
          darkgray: "#a2968d",
          dark: "#d8cfc0",
          secondary: "#c8956c",
          tertiary: "#a47855",
          highlight: "rgba(200, 149, 108, 0.16)",
          textHighlight: "#653d19aa",
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        priority: ["frontmatter", "git", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: {
          light: "github-light",
          dark: "github-dark",
        },
        keepBackground: false,
      }),
      // 离线化：关闭 mermaid（其内联脚本包含 cdnjs 动态 import，本知识库不使用图表代码块）
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false, mermaid: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      // 离线化：移除 Plugin.Latex（其 KaTeX 样式与脚本走 jsdelivr CDN，内容不含公式）
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      // 目录页条目列表由生成器直出为正文的「## 子节点」，故关闭组件侧的
      // page-listing（同批内容的第二份呈现，见 FolderContent.tsx 注释块）。
      // TagPage 不传该项——标签页没有生成器直出的列表，仍需 page-listing。
      Plugin.FolderPage({
        sort: byDocumentOrder,
        pageBody: Component.FolderContent({ sort: byDocumentOrder, showPageList: false }),
      }),
      Plugin.TagPage({ sort: byDocumentOrder }),
      Plugin.ContentIndex({
        enableSiteMap: true,
        enableRSS: true,
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.Favicon(),
      Plugin.NotFoundPage(),
      // 离线化：移除 Plugin.CustomOgImages（构建期会请求 fonts.googleapis.com 下载字体）
    ],
  },
}

export default config
