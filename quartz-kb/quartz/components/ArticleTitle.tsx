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
/* v8 三明治滚动：整个标题区（面包屑+标题）固定视口顶部，仅正文滚动。
   sticky 必须挂在 .page-header——其父 .center 高度=整页，sticky 才有滑动空间；
   挂在 .article-title 上时父容器（.popover-hint）高度=元素高度，sticky 失效
   （Electron 实测：滚动 400px 后标题 top=-173px 直接滚走）。 */
.page-header {
  position: sticky;
  top: 0;
  z-index: 50;
  /* sticky 元素必须不透明背景，否则正文从下方透出 */
  background-color: var(--glass-bg-solid, var(--light));
  border-bottom: 1px solid var(--glass-border, var(--lightgray));
}
.article-title {
  margin: 2rem 0 0 0;
  padding: 0.8rem 0 0.6rem;
}
`

export default (() => ArticleTitle) satisfies QuartzComponentConstructor
