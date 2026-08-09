import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

const ArticleTitle: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const title = fileData.frontmatter?.title
  if (title) {
    return <h1 class={classNames(displayClass, "article-title")}>{title}</h1>
  } else {
    return null
  }
}

ArticleTitle.css = `
/* v8 三明治滚动：整个标题区（面包屑+标题）滚动时固定，只稍微上移（距顶 0.75rem 留缝）。
   sticky 必须挂在 .page-header——其父 .center 高度=整页，sticky 才有滑动空间；
   挂在 .article-title 上时父容器（.popover-hint）高度=元素高度，sticky 失效
   （Electron 实测：滚动 400px 后标题 top=-173px 直接滚走）。
   Apple 毛玻璃：半透明背景 + blur；-webkit- 必须写在无前缀之前
   （lightningcss 对「无前缀在前」的双写会吞掉无前缀版，现代 Chromium 只认无前缀）。 */
.page-header {
  position: sticky;
  top: 0.75rem;
  z-index: 50;
  background-color: var(--glass-bg, rgba(250, 248, 248, 0.72));
  -webkit-backdrop-filter: blur(18px) saturate(1.6);
  backdrop-filter: blur(18px) saturate(1.6);
  border: 1px solid var(--glass-border, var(--lightgray));
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
}
.article-title {
  margin: 2rem 0 0 0;
  padding: 0.8rem 0 0.6rem;
}
`

export default (() => ArticleTitle) satisfies QuartzComponentConstructor
