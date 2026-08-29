import { Root } from "hast"
import { GlobalConfiguration } from "../../cfg"
import { getDate } from "../../components/Date"
import { escapeHTML } from "../../util/escape"
import { FilePath, FullSlug, SimpleSlug, joinSegments, simplifySlug } from "../../util/path"
import { QuartzEmitterPlugin } from "../types"
import { toHtml } from "hast-util-to-html"
import { write } from "./helpers"
import { i18n } from "../../i18n"

export type ContentIndexMap = Map<FullSlug, ContentDetails>
export type ContentDetails = {
  slug: FullSlug
  filePath: FilePath
  title: string
  links: SimpleSlug[]
  tags: string[]
  content: string
  richContent?: string
  date?: Date
  description?: string
}

/**
 * 图谱链路专用的四字段投影（阶段5.6 波2-2.1）。
 *
 * 图谱（graph.inline.ts）与图谱总览专页（graphexplorer.inline.ts）对索引的全部用途
 * 只有四项：slug（节点身份）、title（节点文本与搜索定位）、links（边与子节点 chips）、
 * tags（tag 节点，showTags 为真时才用）。content 字段占全量索引的 40.7%，
 * 图谱一字不读却要随之解析——故另出一份瘦身产物，见下方 emit 的 contentIndexGraph。
 */
export type GraphContentDetails = Pick<ContentDetails, "slug" | "title" | "links" | "tags">

interface Options {
  enableSiteMap: boolean
  enableRSS: boolean
  rssLimit?: number
  rssFullHtml: boolean
  rssSlug: string
  includeEmptyFiles: boolean
}

const defaultOptions: Options = {
  enableSiteMap: true,
  enableRSS: true,
  rssLimit: 10,
  rssFullHtml: false,
  rssSlug: "index",
  includeEmptyFiles: true,
}

function generateSiteMap(cfg: GlobalConfiguration, idx: ContentIndexMap): string {
  const base = cfg.baseUrl ?? ""
  const createURLEntry = (slug: SimpleSlug, content: ContentDetails): string => `<url>
    <loc>https://${joinSegments(base, encodeURI(slug))}</loc>
    ${content.date && `<lastmod>${content.date.toISOString()}</lastmod>`}
  </url>`
  const urls = Array.from(idx)
    .map(([slug, content]) => createURLEntry(simplifySlug(slug), content))
    .join("")
  return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`
}

function generateRSSFeed(cfg: GlobalConfiguration, idx: ContentIndexMap, limit?: number): string {
  const base = cfg.baseUrl ?? ""

  const createURLEntry = (slug: SimpleSlug, content: ContentDetails): string => `<item>
    <title>${escapeHTML(content.title)}</title>
    <link>https://${joinSegments(base, encodeURI(slug))}</link>
    <guid>https://${joinSegments(base, encodeURI(slug))}</guid>
    <description><![CDATA[ ${content.richContent ?? content.description} ]]></description>
    <pubDate>${content.date?.toUTCString()}</pubDate>
  </item>`

  const items = Array.from(idx)
    .sort(([_, f1], [__, f2]) => {
      if (f1.date && f2.date) {
        return f2.date.getTime() - f1.date.getTime()
      } else if (f1.date && !f2.date) {
        return -1
      } else if (!f1.date && f2.date) {
        return 1
      }

      return f1.title.localeCompare(f2.title)
    })
    .map(([slug, content]) => createURLEntry(simplifySlug(slug), content))
    .slice(0, limit ?? idx.size)
    .join("")

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
    <channel>
      <title>${escapeHTML(cfg.pageTitle)}</title>
      <link>https://${base}</link>
      <description>${!!limit ? i18n(cfg.locale).pages.rss.lastFewNotes({ count: limit }) : i18n(cfg.locale).pages.rss.recentNotes} on ${escapeHTML(
        cfg.pageTitle,
      )}</description>
      <generator>Quartz -- quartz.jzhao.xyz</generator>
      ${items}
    </channel>
  </rss>`
}

export const ContentIndex: QuartzEmitterPlugin<Partial<Options>> = (opts) => {
  opts = { ...defaultOptions, ...opts }
  return {
    name: "ContentIndex",
    async *emit(ctx, content) {
      const cfg = ctx.cfg.configuration
      const linkIndex: ContentIndexMap = new Map()
      for (const [tree, file] of content) {
        const slug = file.data.slug!
        const date = getDate(ctx.cfg.configuration, file.data) ?? new Date()
        if (opts?.includeEmptyFiles || (file.data.text && file.data.text !== "")) {
          linkIndex.set(slug, {
            slug,
            filePath: file.data.relativePath!,
            title: file.data.frontmatter?.title!,
            links: file.data.links ?? [],
            tags: file.data.frontmatter?.tags ?? [],
            content: file.data.text ?? "",
            richContent: opts?.rssFullHtml
              ? escapeHTML(toHtml(tree as Root, { allowDangerousHtml: true }))
              : undefined,
            date: date,
            description: file.data.description ?? "",
          })
        }
      }

      if (opts?.enableSiteMap) {
        yield write({
          ctx,
          content: generateSiteMap(cfg, linkIndex),
          slug: "sitemap" as FullSlug,
          ext: ".xml",
        })
      }

      if (opts?.enableRSS) {
        yield write({
          ctx,
          content: generateRSSFeed(cfg, linkIndex, opts.rssLimit),
          slug: (opts?.rssSlug ?? "index") as FullSlug,
          ext: ".xml",
        })
      }

      const fp = joinSegments("static", "contentIndex") as FullSlug
      const simplifiedIndex = Object.fromEntries(
        Array.from(linkIndex).map(([slug, content]) => {
          // remove description and from content index as nothing downstream
          // actually uses it. we only keep it in the index as we need it
          // for the RSS feed
          delete content.description
          delete content.date
          return [slug, content]
        }),
      )

      yield write({
        ctx,
        content: JSON.stringify(simplifiedIndex),
        slug: fp,
        ext: ".json",
      })

      // ---------- 图谱专用轻量索引（阶段5.6 波2-2.1）----------
      // 产物 static/contentIndexGraph.json：四字段投影（约 5.7MB，gz 392KB），
      // 全量 contentIndex.json 为 13.45MB（content 字段占 40.7%，图谱一字不读）。
      // 收益不止于体量——图谱链路由此脱离 fetchData 的排队：contentIndex 的那份
      // Promise 还要供 search.inline.ts 的 flexsearch 全文索引消费，二者在同一次
      // resolve 后争抢主线程，冷启动尤甚。
      //
      // ⚠️ 硬约束：两份索引必须**同一次构建、从同一个 linkIndex 派生**。
      // 它们描述的是同一批页面，图谱按 slug 取节点、搜索与目录按 slug 取详情，
      // 一旦分头生成（例如挪进独立 emitter、或改从别处取 links），两者的节点集与
      // 边集就可能错位，表现为「图上点得到、面板查无此页」这类难查的幽灵缺陷。
      // 故本块紧随上面的 contentIndex 写出、共用同一 linkIndex，不得拆分。
      //
      // 位置刻意排在 simplifiedIndex 之后：上面那段用 delete 就地改的是 linkIndex 里
      // 的同一批对象（description/date），本块若排在其前，读到的字段集合取决于两段的
      // 书写顺序——四字段投影虽不含这两项、结果一样，但那是巧合而非保证。
      const graphFp = joinSegments("static", "contentIndexGraph") as FullSlug

      // ---------- 悬空内链护栏（阶段5.7 波A-A2）----------
      // 只作用于图谱专用投影：links 中指向「本批不存在的页面」的目标一律滤除
      //（判据＝目标在本批全部 slug 的 simplifySlug 全集内；两侧同用 simplifySlug
      //  归一，links 本身即以 SimpleSlug 形态由 transformLinks 写入）。
      //
      // ⚠️ 定性：本过滤对图谱渲染是**恒等变换**，是护栏与告警，不是缺陷修复。
      // 运行期 graph.inline.ts 建边时已有 `validLinks.has(dest)` 门控、构建期
      // graphLayout.tsx 同样先算 validLinks 再建边，悬空目标在两侧本就进不了边集；
      // 因此节点集、边集、坐标产物与其 key 指纹、模块级组装缓存键全部逐位不变。
      // 本项的价值只有两条：
      //   ① 索引自洽——产物里不再留「查无此页」的边，任何新增消费方拿到即为干净
      //      数据，无须各自再写一遍同样的过滤，也就无从写漏；
      //   ② 构建期告警——语料再引入新的悬空链时构建当场报数并给样例，不必等到
      //      有人察觉图上少了一条边才回头追查。
      // 全量 contentIndex.json 的 links 明确**不动**：其消费方（fileTrie 只看类型、
      // explorer 的 tree.links 是 DOM 锚点、Backlinks 走构建期 allFiles）与图谱边集
      // 无关，改它属于扩大改动面。
      const graphSlugs = new Set<SimpleSlug>(
        Array.from(linkIndex.keys()).map((slug) => simplifySlug(slug)),
      )
      const danglingSamples: string[] = []
      let danglingCount = 0
      const graphIndex: Record<FullSlug, GraphContentDetails> = Object.fromEntries(
        Array.from(linkIndex).map(([slug, content]) => {
          const source = simplifySlug(slug)
          const keptLinks = content.links.filter((dest) => {
            if (graphSlugs.has(dest)) return true
            danglingCount += 1
            if (danglingSamples.length < 10) danglingSamples.push(`${source} -> ${dest}`)
            return false
          })
          return [
            slug,
            {
              slug: content.slug,
              title: content.title,
              links: keptLinks,
              tags: content.tags,
            } satisfies GraphContentDetails,
          ]
        }),
      )

      yield write({
        ctx,
        content: JSON.stringify(graphIndex),
        slug: graphFp,
        ext: ".json",
      })

      if (danglingCount > 0) {
        console.warn(
          `[ContentIndex] 检测到 ${danglingCount} 条悬空内链，已从 contentIndexGraph.json 滤除。\n` +
            `  滤除只作用于图谱索引产物：页面正文中的对应链接仍指向不存在的路径，` +
            `点击即 404，须在语料侧修正。\n` +
            `  前 ${danglingSamples.length} 条样例（源页 -> 失效目标）：\n` +
            danglingSamples.map((s) => `    ${s}`).join("\n"),
        )
      }
    },
    externalResources: (ctx) => {
      if (opts?.enableRSS) {
        return {
          additionalHead: [
            <link
              rel="alternate"
              type="application/rss+xml"
              title="RSS Feed"
              href={`https://${ctx.cfg.configuration.baseUrl}/index.xml`}
            />,
          ],
        }
      }
    },
  }
}
