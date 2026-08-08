import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore
import script from "./scripts/pageNav.inline"
import style from "./styles/pageNav.scss"
import { FullSlug, resolveRelative } from "../util/path"
import { classNames } from "../util/lang"
import { getReadingChain, isOutsideReadingChain } from "../util/docOrder"
import { QuartzPluginData } from "../plugins/vfile"

/**
 * 书籍式翻页导航（v6）：每篇文档底部「上一节 / 下一节」，按全库文档序
 * 跨目录连续翻阅（与目录树 / 列表页同一 byDocumentOrder 事实源）。
 * 中文文案硬编码于 Options（不动 quartz/i18n，先例：GraphExplorer、知识库目录）。
 */
interface PageNavOptions {
  prevLabel: string
  nextLabel: string
  keyboardHint: string
  enableKeyboard: boolean
  /** all=全库跨书连续翻阅；book=链条截断在顶层书目录内 */
  scope: "all" | "book"
}

const defaultOptions: PageNavOptions = {
  prevLabel: "上一节",
  nextLabel: "下一节",
  keyboardHint: "← → 或 [ ] 翻页",
  enableKeyboard: true,
  scope: "all",
}

// 顶层书目录名（去数字前缀），跨书翻页时作 wayfinding 标记（同 Backlinks 括注法）
const bookOf = (slug: string): string => slug.split("/")[0].replace(/^\d+-/, "")

// 页面标题：frontmatter.title 兜底 slug 尾段（目录页取剥去 index 后的目录段）
const titleOf = (f: QuartzPluginData): string => {
  if (f.frontmatter?.title) {
    return f.frontmatter.title
  }
  const parts = (f.slug as string).split("/")
  const tail =
    parts[parts.length - 1] === "index" ? parts[parts.length - 2] : parts[parts.length - 1]
  return tail ?? (f.slug as string)
}

const chevronLeft = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
)

const chevronRight = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

export default ((userOpts?: Partial<PageNavOptions>) => {
  const opts: PageNavOptions = { ...defaultOptions, ...userOpts }

  const PageNav: QuartzComponent = ({ fileData, allFiles, displayClass }: QuartzComponentProps) => {
    const slug = fileData.slug
    if (!slug || isOutsideReadingChain(slug)) {
      return null
    }

    const { order, index } = getReadingChain(allFiles)
    const i = index.get(slug)
    if (i === undefined) {
      return null
    }

    const topDir = slug.split("/")[0]
    const pick = (j: number): QuartzPluginData | undefined => {
      const f = order[j]
      if (!f?.slug) {
        return undefined
      }
      if (opts.scope === "book" && f.slug.split("/")[0] !== topDir) {
        return undefined
      }
      return f
    }
    const prev = pick(i - 1)
    const next = pick(i + 1)
    if (!prev && !next) {
      return null
    }

    const renderItem = (f: QuartzPluginData | undefined, dir: "prev" | "next", label: string) => {
      if (!f) {
        // 单侧缺失渲染空占位，保持两栏网格不塌陷（链条首页/末页）
        return <span class={`page-nav-item is-empty ${dir}`} aria-hidden="true" />
      }
      const cross = (f.slug as string).split("/")[0] !== topDir
      return (
        <a
          class={`page-nav-item ${dir}`}
          href={resolveRelative(slug, f.slug as FullSlug)}
          rel={dir}
        >
          <span class="page-nav-dir">
            {dir === "prev" ? chevronLeft : chevronRight}
            {label}
          </span>
          <span class="page-nav-title">{titleOf(f)}</span>
          {cross && <span class="page-nav-book">《{bookOf(f.slug as string)}》</span>}
        </a>
      )
    }

    return (
      <div class={classNames(displayClass, "page-nav-wrapper")}>
        <nav
          class="page-nav"
          aria-label="文档翻页"
          data-prev={prev ? resolveRelative(slug, prev.slug as FullSlug) : ""}
          data-next={next ? resolveRelative(slug, next.slug as FullSlug) : ""}
        >
          {renderItem(prev, "prev", opts.prevLabel)}
          {renderItem(next, "next", opts.nextLabel)}
        </nav>
        {opts.enableKeyboard && <p class="page-nav-hint">{opts.keyboardHint}</p>}
      </div>
    )
  }

  PageNav.css = style
  if (opts.enableKeyboard) {
    PageNav.afterDOMLoaded = script
  }

  return PageNav
}) satisfies QuartzComponentConstructor
