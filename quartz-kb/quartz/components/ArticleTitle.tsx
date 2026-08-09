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
.article-title {
  margin: 2rem 0 0 0;
  /* v8 三明治滚动：标题固定视口顶部，仅正文滚动。
     sticky 元素必须不透明背景，否则正文从下方透出。
     注意：内联 CSS 不走 SCSS 编译，注释必须用块注释 */
  position: sticky;
  top: 0;
  z-index: 50;
  padding: 0.8rem 0 0.6rem;
  background-color: var(--glass-bg-solid, var(--light));
  border-bottom: 1px solid var(--glass-border, var(--lightgray));
}
`

export default (() => ArticleTitle) satisfies QuartzComponentConstructor
