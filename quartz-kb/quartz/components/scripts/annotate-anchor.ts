// 标注锚定（v7 需求7）：选区 ↔ 可持久化选择器的双向转换，纯函数、无副作用。
//
// 方案取 W3C Web Annotation 的两类选择器组合：
//   TextPositionSelector —— blockIndex + 块内字符偏移，命中快；
//   TextQuoteSelector    —— exact 与前后文，用于位置漂移后的重新定位。
// 二者互为冗余：静态站每次构建都会重新生成 HTML，位置可能变而文本不变。
//
// 为什么用「块内字符偏移」而不是 DOM 路径：正文段落被术语链接切得很碎
// （一个 p 常含数个 <a>），本轮的行内链接收窄又让这些 <a> 少了一大半——
// DOM 结构大改而块的 textContent 一字未动，块内偏移天然免疫这类变化。

/** 参与锚定的块级元素。正文实测只有 p / h2 / ul>li 三类，其余为前瞻性覆盖 */
export const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th"

/** 前后文取样长度：足以消歧，又不至于让存储膨胀 */
const CONTEXT_LEN = 32

export type TextSelector = {
  blockIndex: number
  blockTag: string
  start: number
  end: number
  exact: string
  prefix: string
  suffix: string
}

// 块列表 memo：rangeFromSelector 每条标注调一次 listBlocks，而列表页块数可达 5271
// （tags/审查指南.html 实测），不缓存则首屏是 O(标注数 × 块数) 次全量查询。
// 标注本身包的是 <mark>（行内元素，不在 BLOCK_SELECTOR 内），不改变块的数量与次序，
// 故包裹/解包无需失效；但 SPA 的 micromorph 是原地改 DOM、article 元素被复用，
// 换页后内容已变而键未变——必须由调用方在 nav 时显式调 invalidateBlocks。
const blockCache = new WeakMap<Element, HTMLElement[]>()

/** 按 DOM 序列出 article 内的全部块，序号即 blockIndex */
export function listBlocks(root: Element): HTMLElement[] {
  const hit = blockCache.get(root)
  if (hit) return hit
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
  blockCache.set(root, blocks)
  return blocks
}

/** 丢弃某个根的块缓存。SPA 换页后 article 内容已换，必须调用。 */
export function invalidateBlocks(root: Element): void {
  blockCache.delete(root)
}

/**
 * 选区所属的块：取「包含该选区、且没有更深的块后代同样包含它」的那一个。
 * 嵌套列表中父 li 也包含子 li 的文本，故必须取最深匹配。
 */
export function findBlock(root: Element, range: Range): HTMLElement | null {
  const blocks = listBlocks(root).filter((b) => b.contains(range.commonAncestorContainer))
  if (blocks.length === 0) {
    return null
  }
  return blocks.reduce((deepest, b) => (deepest.contains(b) ? b : deepest))
}

/** 块内某个 (容器, 偏移) 位置相对块起点的字符数 */
function offsetWithin(block: HTMLElement, container: Node, offset: number): number {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let count = 0
  let node = walker.nextNode()
  while (node !== null) {
    if (node === container) {
      return count + offset
    }
    count += node.textContent?.length ?? 0
    node = walker.nextNode()
  }
  // 容器不是文本节点（选区端点落在元素边界上）时退化为块首
  return count
}

/** 选区 → 选择器；选区跨块或为空时返回 null */
export function selectorFromRange(root: Element, range: Range): TextSelector | null {
  if (range.collapsed) {
    return null
  }
  const block = findBlock(root, range)
  if (block === null) {
    return null
  }
  const text = block.textContent ?? ""
  const start = offsetWithin(block, range.startContainer, range.startOffset)
  const end = offsetWithin(block, range.endContainer, range.endOffset)
  if (end <= start) {
    return null
  }
  const blocks = listBlocks(root)
  return {
    blockIndex: blocks.indexOf(block),
    blockTag: block.tagName,
    start,
    end,
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: text.slice(end, end + CONTEXT_LEN),
  }
}

/** 候选位置打分：前后文吻合越多越好，离原偏移越近越好 */
function score(text: string, at: number, sel: TextSelector): number {
  const before = text.slice(Math.max(0, at - CONTEXT_LEN), at)
  const after = text.slice(at + sel.exact.length, at + sel.exact.length + CONTEXT_LEN)
  let s = 0
  if (sel.prefix && before.endsWith(sel.prefix.slice(-8))) {
    s += 4
  }
  if (sel.suffix && after.startsWith(sel.suffix.slice(0, 8))) {
    s += 4
  }
  return s - Math.abs(at - sel.start) / 1000
}

/** 在一段文本里找 exact 的全部出现位置，按得分取最优 */
function bestIn(text: string, sel: TextSelector): { at: number; s: number } | null {
  let best: { at: number; s: number } | null = null
  let i = text.indexOf(sel.exact)
  while (i !== -1) {
    const s = score(text, i, sel)
    if (best === null || s > best.s) {
      best = { at: i, s }
    }
    i = text.indexOf(sel.exact, i + 1)
  }
  return best
}

/** 把块内字符区间还原成 Range */
function rangeIn(block: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let seen = 0
  let startSet = false
  let node = walker.nextNode()
  while (node !== null) {
    const len = node.textContent?.length ?? 0
    if (!startSet && seen + len >= start) {
      range.setStart(node, start - seen)
      startSet = true
    }
    if (startSet && seen + len >= end) {
      range.setEnd(node, end - seen)
      return range
    }
    seen += len
    node = walker.nextNode()
  }
  return null
}

/**
 * 选择器 → Range，三级降级：
 *   L0 原位精确命中（内容未变时的常态，O(1)）
 *   L1 同块漂移：在原块内按前后文找回
 *   L2 跨块搜索：全文找回，要求最优解明显优于次优解，避免张冠李戴
 * 三级都不中返回 null，调用方据此标为 orphan——不渲染但也绝不删除。
 * 命中 L1/L2 时返回 moved，调用方回写选择器即完成自愈，下次回到 L0。
 */
export function rangeFromSelector(
  root: Element,
  sel: TextSelector,
): { range: Range; moved: Partial<TextSelector> | null } | null {
  const blocks = listBlocks(root)

  const origin = blocks[sel.blockIndex]
  if (origin && origin.tagName === sel.blockTag) {
    const text = origin.textContent ?? ""
    if (text.slice(sel.start, sel.end) === sel.exact) {
      const range = rangeIn(origin, sel.start, sel.end)
      if (range) {
        return { range, moved: null }
      }
    }
    const hit = bestIn(text, sel)
    if (hit) {
      const range = rangeIn(origin, hit.at, hit.at + sel.exact.length)
      if (range) {
        return { range, moved: { start: hit.at, end: hit.at + sel.exact.length } }
      }
    }
  }

  let top: { i: number; at: number; s: number } | null = null
  let runnerUp = -Infinity
  for (let i = 0; i < blocks.length; i++) {
    const hit = bestIn(blocks[i].textContent ?? "", sel)
    if (!hit) {
      continue
    }
    if (top === null || hit.s > top.s) {
      if (top !== null) {
        runnerUp = top.s
      }
      top = { i, at: hit.at, s: hit.s }
    } else if (hit.s > runnerUp) {
      runnerUp = hit.s
    }
  }
  // 唯一性门槛：最优与次优过于接近时宁可判为失配，也不冒险锚到错误位置
  if (top === null || (runnerUp !== -Infinity && top.s - runnerUp < 2)) {
    return null
  }
  const range = rangeIn(blocks[top.i], top.at, top.at + sel.exact.length)
  if (!range) {
    return null
  }
  return {
    range,
    moved: {
      blockIndex: top.i,
      blockTag: blocks[top.i].tagName,
      start: top.at,
      end: top.at + sel.exact.length,
    },
  }
}
