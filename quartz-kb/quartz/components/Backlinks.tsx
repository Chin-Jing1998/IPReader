import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/backlinks.scss"
import { resolveRelative, simplifySlug } from "../util/path"
import { i18n } from "../i18n"
import { classNames } from "../util/lang"
import OverflowListFactory from "./OverflowList"

interface BacklinksOptions {
  hideWhenEmpty: boolean
}

const defaultOptions: BacklinksOptions = {
  hideWhenEmpty: true,
}

export default ((opts?: Partial<BacklinksOptions>) => {
  const options: BacklinksOptions = { ...defaultOptions, ...opts }
  const { OverflowList, overflowListAfterDOMLoaded } = OverflowListFactory()

  const Backlinks: QuartzComponent = ({
    fileData,
    allFiles,
    displayClass,
    cfg,
  }: QuartzComponentProps) => {
    const slug = simplifySlug(fileData.slug!)
    const backlinkFiles = allFiles.filter((file) => file.links?.includes(slug))
    if (options.hideWhenEmpty && backlinkFiles.length == 0) {
      return null
    }
    // 跨书歧义消解：仅当列表内 title 重名（如多部书各有「引言」）时，
    // 为重名条目追加书名括注——取 slug 顶层段并去掉数字前缀（"3-专利审查指南2025" → "专利审查指南2025"）；
    // 不重名的条目保持原样，避免全列表噪音。
    const titleCounts = new Map<string, number>()
    for (const f of backlinkFiles) {
      const t = f.frontmatter?.title ?? ""
      titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1)
    }
    const displayNameOf = (f: (typeof backlinkFiles)[number]): string => {
      const t = f.frontmatter?.title ?? ""
      if ((titleCounts.get(t) ?? 0) <= 1) {
        return t
      }
      const book = (f.slug ?? "").split("/")[0].replace(/^\d+-/, "")
      return book ? `${t}（${book}）` : t
    }
    return (
      <div class={classNames(displayClass, "backlinks")}>
        <h3>{i18n(cfg.locale).components.backlinks.title}</h3>
        <OverflowList>
          {backlinkFiles.length > 0 ? (
            backlinkFiles.map((f) => (
              <li>
                <a href={resolveRelative(fileData.slug!, f.slug!)} class="internal">
                  {displayNameOf(f)}
                </a>
              </li>
            ))
          ) : (
            <li>{i18n(cfg.locale).components.backlinks.noBacklinksFound}</li>
          )}
        </OverflowList>
      </div>
    )
  }

  Backlinks.css = style
  Backlinks.afterDOMLoaded = overflowListAfterDOMLoaded

  return Backlinks
}) satisfies QuartzComponentConstructor
