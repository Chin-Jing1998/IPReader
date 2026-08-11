// @ts-ignore
import readerModeScript from "./scripts/readermode.inline"
import styles from "./styles/readermode.scss"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { i18n } from "../i18n"
import { classNames } from "../util/lang"

const ReaderMode: QuartzComponent = ({ displayClass, cfg }: QuartzComponentProps) => {
  return (
    <button class={classNames(displayClass, "readermode")}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="readerIcon"
      >
        <title>{i18n(cfg.locale).components.readerMode.title}</title>
        <path d="M12 7.4v12.8" />
        <path d="M3.2 4.6h4.6c1.9 0 3.5.9 4.2 2.4.7-1.5 2.3-2.4 4.2-2.4h4.6v12.6h-4.6c-1.9 0-3.5.9-4.2 2.4-.7-1.5-2.3-2.4-4.2-2.4H3.2z" />
      </svg>
    </button>
  )
}

ReaderMode.beforeDOMLoaded = readerModeScript
ReaderMode.css = styles

export default (() => ReaderMode) satisfies QuartzComponentConstructor
