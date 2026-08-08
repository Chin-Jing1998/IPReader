import type { QuartzPluginData } from "../plugins/vfile"

/**
 * 「文档序」比较器——全库单一事实源（v6 自 quartz.config.ts 迁出，逻辑零改动）。
 * 三处共用，保证目录页条目序 / Explorer 树序（语义同源，见 quartz.layout.ts）/
 * 翻页链序完全一致：
 *   1. FolderPage / TagPage 列表排序（quartz.config.ts 传入）；
 *   2. PageNav 翻页链（getReadingChain）。
 *
 * 规则：
 *   1. 逐段比较 slug，先剥去 index 尾段——目录页因此紧排在自己的子条目之前；
 *   2. 每段先比数字前缀（parseInt），使未补零的中文目录名按数值序（9-… < 10-费用）；
 *   3. 数字前缀并列时用 zh-CN 排序器（numeric）比整段（01-01-04-07 < 01-01-05）；
 *   4. 一方是另一方前缀时短者在前（01-01-03 < 01-01-03-01，父节点先于子节点）。
 *
 * 本模块只在构建期（Node）执行，不会被 toString() 序列化送浏览器，
 * 因此不受 quartz.layout.ts explorerConfig 那条「不得含具名内部函数」的限制。
 */
const docOrderCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" })

function docOrderSegments(slug: string | undefined): string[] {
  const segments = String(slug ?? "").split("/")
  // 目录页 slug 形如 <目录>/index：剥去尾段使其落在自身子条目之前（站根 "index" 不剥）
  if (segments.length > 1 && segments[segments.length - 1] === "index") {
    segments.pop()
  }
  return segments
}

function compareDocOrderSegment(a: string, b: string): number {
  const aMatch = a.match(/^(\d+)/)
  const bMatch = b.match(/^(\d+)/)
  const na = aMatch ? parseInt(aMatch[1], 10) : Number.MAX_SAFE_INTEGER
  const nb = bMatch ? parseInt(bMatch[1], 10) : Number.MAX_SAFE_INTEGER
  if (na !== nb) {
    return na - nb
  }
  return docOrderCollator.compare(a, b)
}

export function byDocumentOrder(f1: QuartzPluginData, f2: QuartzPluginData): number {
  const a = docOrderSegments(f1.slug)
  const b = docOrderSegments(f2.slug)
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const cmp = compareDocOrderSegment(a[i], b[i])
    if (cmp !== 0) {
      return cmp
    }
  }
  return a.length - b.length
}

/**
 * 不参与翻页链的页面：站根首页（无数字前缀会被排到全库末尾，语义错乱）、
 * 图谱总览应用页（非阅读页）、tags 合成页（防御性排除，本不在 allFiles 内）。
 */
export function isOutsideReadingChain(slug: string): boolean {
  return slug === "index" || slug === "0-图谱总览/index" || slug.startsWith("tags/")
}

export type ReadingChain = { order: QuartzPluginData[]; index: Map<string, number> }

/**
 * 全库阅读链：文档序全序 + slug→位置索引。
 * 性能关键：ContentPage / FolderPage / TagPage 的 allFiles 数组各在其页循环之外
 * 创建一次（quartz/plugins/emitters/contentPage.tsx 等），故以数组对象身份作
 * WeakMap 键缓存——全构建仅排序 3 次（每次约 2200 项）；若误按页排序将是
 * 五千万次比较的分钟级代价。filter 先行返回新数组，sort 不污染调用方 allFiles。
 */
const chainCache = new WeakMap<QuartzPluginData[], ReadingChain>()

export function getReadingChain(allFiles: QuartzPluginData[]): ReadingChain {
  const hit = chainCache.get(allFiles)
  if (hit) {
    return hit
  }
  const order = allFiles
    .filter((f) => f.slug && !isOutsideReadingChain(f.slug))
    .sort(byDocumentOrder)
  const index = new Map<string, number>()
  for (let i = 0; i < order.length; i++) {
    index.set(order[i].slug as string, i)
  }
  const chain: ReadingChain = { order, index }
  chainCache.set(allFiles, chain)
  return chain
}
