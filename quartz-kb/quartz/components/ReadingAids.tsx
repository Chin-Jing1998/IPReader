import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore
import script from "./scripts/reading.inline"
import style from "./styles/readingAids.scss"
import { classNames } from "../util/lang"

/**
 * 阅读辅助（v6）：回到顶部 FAB ＋ 内嵌阅读进度环（合一控件），
 * 并由同一滚动监听驱动 TOC 当前小节强调（.toc-current，见 reading.inline.ts）。
 * 图谱总览页为画布应用（页面不滚动）、设置页为应用面板，均不渲染。
 */
const ReadingAids: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  if (fileData.slug === "0-图谱总览/index" || fileData.slug === "设置/index") {
    return null
  }
  return (
    <div class={classNames(displayClass, "reading-aids")}>
      <button class="reading-fab" type="button" aria-label="回到顶部" title="回到顶部">
        <svg class="reading-fab-progress" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="reading-fab-track" cx="18" cy="18" r="15.5" />
          <circle class="reading-fab-ring" cx="18" cy="18" r="15.5" />
        </svg>
        <svg
          class="reading-fab-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>
    </div>
  )
}

ReadingAids.css = style
ReadingAids.afterDOMLoaded = script

export default (() => ReadingAids) satisfies QuartzComponentConstructor
