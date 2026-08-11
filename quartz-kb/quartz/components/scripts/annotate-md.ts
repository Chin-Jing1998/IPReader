// 批注 → Markdown 文件（v8 需求）：纯函数，不碰 DOM 副作用，便于独立验证。
//
// 文件划分规则（用户确认）：
//   · 标记所在块向上取最近标题元素（h1–h4）；
//   · 该标题为 h3/h4 时，此 h3/h4 及其以下全部内容的批注合并进一个文件（多脚注）；
//   · 最近标题仅 h1/h2 或无标题时，用该标题/页面标题作文件主题（兜底）。
// 路径：<书>/<章节标题>.md（书 = slug 首段去数字前缀）。
// 内容：每条批注一个「> 整段引用块」按文档序排列；
//       高亮 ==…==（Obsidian 兼容）、下划线 <u>…</u>；
//       有笔记的批注在标记文本尾部追加 [^n]，脚注定义紧跟对应引用块下方。
// 定位失败（orphan）的批注不导出——保留在 localStorage，用户可手动处理。

import type { Annotation } from "./annotate-store"
import { findBlock, rangeFromSelector } from "./annotate-anchor"

export type MdFile = { relativePath: string; content: string }

const TITLE_SELECTOR = "h1, h2, h3, h4"

/** 文件名清洗：剔除文件系统非法字符，防跨目录注入 */
function sanitize(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned || "未命名章节"
}

/** 书目录名：slug 首段去数字前缀 */
function bookOf(slug: string): string {
  const first = slug.split("/")[0] ?? ""
  return sanitize(first.replace(/^\d+-/, "")) || "未命名"
}

/**
 * 块所属章节标题：Quartz 渲染后标题与正文是兄弟节点（h1–h4 并列于 article 下），
 * 故取「文档序中该块之前的最近标题」；块自身是标题（标记落在标题文本上）时取自身。
 */
function sectionOf(
  article: HTMLElement,
  block: HTMLElement,
): { tag: string; title: string } | null {
  if (block.matches(TITLE_SELECTOR)) {
    return { tag: block.tagName, title: (block.textContent ?? "").trim() }
  }
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_ELEMENT)
  let last: Element | null = null
  let node = walker.nextNode()
  while (node !== null) {
    if (node === block) {
      break
    }
    if ((node as Element).matches(TITLE_SELECTOR)) {
      last = node as Element
    }
    node = walker.nextNode()
  }
  if (last) {
    return { tag: last.tagName, title: (last.textContent ?? "").trim() }
  }
  return null
}

/**
 * 单块渲染：块内多条批注按 start 升序切段拼接，标记文本按 kind 包格式，
 * 有笔记的追加脚注引用 [^n]。
 */
function renderBlock(
  block: HTMLElement,
  entries: { anno: Annotation; start: number; end: number }[],
  refOf: (annoId: string) => string | null,
): string {
  const text = block.textContent ?? ""
  const sorted = entries.slice().sort((a, b) => a.start - b.start)
  let out = ""
  let cursor = 0
  for (const m of sorted) {
    if (m.start < cursor) {
      continue // 防御：重叠区间不应发生，跳过即可
    }
    out += text.slice(cursor, m.start)
    const piece = text.slice(m.start, m.end)
    const wrapped = m.anno.kind === "underline" ? `<u>${piece}</u>` : `==${piece}==`
    const ref = refOf(m.anno.id)
    out += ref ? wrapped + ref : wrapped
    cursor = m.end
  }
  out += text.slice(cursor)
  return out
}

/** 渲染一个章节文件：多批注按块聚合，各自独立脚注 */
function renderFile(
  title: string,
  entries: { anno: Annotation; block: HTMLElement; start: number; end: number }[],
): string {
  const refs = new Map<string, string>() // annoId -> [^n]
  let n = 0
  for (const e of entries) {
    if (e.anno.note) {
      n++
      refs.set(e.anno.id, `[^${n}]`)
    }
  }
  const lines: string[] = [`# ${title}`, ""]
  // 按块聚合，块间按文档序
  const byBlock = new Map<HTMLElement, typeof entries>()
  for (const e of entries) {
    const list = byBlock.get(e.block) ?? []
    list.push(e)
    byBlock.set(e.block, list)
  }
  const blocks = Array.from(byBlock.keys()).sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  )
  for (const block of blocks) {
    const list = byBlock.get(block) ?? []
    lines.push(`> ${renderBlock(block, list, (id) => refs.get(id) ?? null)}`, "")
    for (const e of list) {
      if (e.anno.note) {
        const note = e.anno.note.replace(/\r?\n/g, " ")
        lines.push(`${refs.get(e.anno.id)}: 📝 ${note}`, "")
      }
    }
  }
  return lines.join("\n")
}

/**
 * 页面批注 → md 文件清单。
 * @param article 正文容器（.center article）
 * @param pageTitle 页面标题（frontmatter title，无标题时兜底）
 * @param annos 该页全部批注
 */
export function buildMarkdownFiles(
  article: HTMLElement,
  pageTitle: string,
  annos: Annotation[],
): MdFile[] {
  const book = bookOf(annos[0]?.slug ?? "")
  const groups = new Map<
    string,
    {
      title: string
      entries: { anno: Annotation; block: HTMLElement; start: number; end: number }[]
    }
  >()
  for (const anno of annos) {
    const hit = rangeFromSelector(article, anno.selector)
    if (hit === null) {
      continue
    }
    const block = findBlock(article, hit.range)
    if (block === null) {
      continue
    }
    const start = hit.moved?.start ?? anno.selector.start
    const end = hit.moved?.end ?? anno.selector.end
    const section = sectionOf(article, block)
    const title = sanitize(section?.title ?? pageTitle)
    let g = groups.get(title)
    if (!g) {
      g = { title, entries: [] }
      groups.set(title, g)
    }
    g.entries.push({ anno, block, start, end })
  }
  const files: MdFile[] = []
  for (const g of groups.values()) {
    files.push({
      relativePath: `${book}/${g.title}.md`,
      content: renderFile(g.title, g.entries),
    })
  }
  return files
}
