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
  /* 随流滚动（移除 sticky：父容器含 meta/标签等，sticky 部分生效会在滚动时
     盖住下方内容造成重叠；固定需求与「不要色块」冲突——透明背景固定时
     正文会从下方透出，故当前采用普通流） */
  padding: 0.8rem 0 0.6rem;
  /* 无背景色块：融入页面底色，仅保留底部细分隔线 */
  border-bottom: 1px solid var(--glass-border, var(--lightgray));
}
`

export default (() => ArticleTitle) satisfies QuartzComponentConstructor
