// 正文行内术语链接化共享库（生成器 D5 阶段）。
// 契约（调用方 build-quartz-md.mjs 与审计工具 build-term-linkaudit-pool.mjs 共同遵守）：
//   1. 必须在 linkLawCites 之后调用——法条链接产生的 [[...]] 是本库的禁区，
//      反向顺序会使 linkLawCites 基于原始偏移的替换全部错位；
//   2. 页级首链去重由调用方跨段落持有 linkedIds（不可变：linkTerms 每次返回新 Set）；
//   3. 词面唯一：同一 surface 映射到多个 id 时整条丢弃（确定性，
//      与 build-quartz-md.mjs 六节 aliasesOf 的重名跳过策略同则）；
//   4. 排除清单（term-link-exclude.json）在 buildTermMatcher 的 exclude 一次性剔除，
//      扫描期零开销。

/**
 * 构建匹配器：首字桶 + 桶内按词面长度降序（保证最长优先）。
 * entries: Array<{surface: string, id: string}>（canonical 与白名单别名各一条，指向同一 id）
 * exclude: Set<id>，被排除术语的全部词面不进入匹配器。
 */
export function buildTermMatcher(entries, { exclude = new Set() } = {}) {
  const owner = new Map(); // surface → id | '__AMBIGUOUS__'
  for (const { surface, id } of entries) {
    const s = String(surface || '').trim();
    if (!s || exclude.has(id)) continue;
    const prev = owner.get(s);
    owner.set(s, prev === undefined || prev === id ? id : '__AMBIGUOUS__');
  }
  const byFirst = new Map();
  let size = 0;
  for (const [surface, id] of owner) {
    if (id === '__AMBIGUOUS__') continue;
    size++;
    const bucket = byFirst.get(surface[0]);
    if (bucket) bucket.push({ surface, id });
    else byFirst.set(surface[0], [{ surface, id }]);
  }
  for (const bucket of byFirst.values()) {
    bucket.sort((a, b) => b.surface.length - a.surface.length || (a.surface < b.surface ? -1 : 1));
  }
  return { byFirst, size };
}

/**
 * 既有链接跨度（禁区），自左向右不重叠：
 *   a. wikilink [[...]]（显示文本不含 ]，linkTo→cleanDisplay 保证）；
 *   b. Markdown 图片 ![alt](path)——路径中的书目录名（如"专利审查指南"）与词面重合，
 *      不设禁区会被误链而破坏图片语法。
 * 单一 alternation 正则自左扫描，两类命中天然不重叠。
 */
export function wikilinkSpans(text) {
  const spans = [];
  const re = /!\[[^\]]*\]\([^)]*\)|\[\[[^\]]*\]\]/g;
  let m;
  while ((m = re.exec(text))) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/**
 * 自左向右收集命中：最长优先、互不重叠、不落入/越入禁区、页级首链（含本次调用内）去重、
 * 排除自链。命中词面若属已链/自身 id，则该位置整体放弃（break 而非回退短词——
 * 该位置的正确归属就是这个更长/自身的词，不应改链到别的词）。
 */
export function collectHits(text, matcher, linkedIds = new Set(), selfId = null) {
  const spans = wikilinkSpans(text);
  const localLinked = new Set(linkedIds);
  const hits = [];
  let spanIdx = 0;
  for (let i = 0; i < text.length; i++) {
    while (spanIdx < spans.length && spans[spanIdx][1] <= i) spanIdx++;
    if (spanIdx < spans.length && i >= spans[spanIdx][0]) {
      i = spans[spanIdx][1] - 1; // 跳到禁区末尾
      continue;
    }
    const bucket = matcher.byFirst.get(text[i]);
    if (!bucket) continue;
    const nextForbidden = spanIdx < spans.length ? spans[spanIdx][0] : Infinity;
    for (const { surface, id } of bucket) {
      if (i + surface.length > nextForbidden) continue; // 越入禁区：试更短词面
      if (!text.startsWith(surface, i)) continue;
      if (id === selfId || localLinked.has(id)) break; // 归属此词但不成链，整位置放弃
      hits.push({ index: i, surface, id });
      localLinked.add(id);
      i = i + surface.length - 1;
      break;
    }
  }
  return hits;
}

/**
 * 对一段文本执行术语链接化。
 * @param {string} text 已完成法条链接化的段落文本
 * @param {{byFirst: Map, size: number}} matcher buildTermMatcher 产物
 * @param {{linkedIds?: Set<string>, selfId?: string|null, linkTo: Function}} opts
 * @returns {{text: string, linkedIds: Set<string>, added: number}} 均为新对象（不可变）
 */
export function linkTerms(text, matcher, { linkedIds = new Set(), selfId = null, linkTo }) {
  if (typeof linkTo !== 'function') throw new TypeError('linkTerms: linkTo 必须为函数');
  const hits = collectHits(text, matcher, linkedIds, selfId);
  if (!hits.length) return { text, linkedIds, added: 0 };
  let out = text;
  for (let i = hits.length - 1; i >= 0; i--) { // 自右向左替换，保左侧偏移
    const h = hits[i];
    out = out.slice(0, h.index) + linkTo(h.id, h.surface) + out.slice(h.index + h.surface.length);
  }
  const nextLinked = new Set(linkedIds);
  for (const h of hits) nextLinked.add(h.id);
  return { text: out, linkedIds: nextLinked, added: hits.length };
}
