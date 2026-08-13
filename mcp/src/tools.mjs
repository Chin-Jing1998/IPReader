// tools.mjs —— 七个 MCP 工具的业务实现
//
// 每个函数接收 (ctx, args) 并返回纯数据对象，由 server.mjs 负责包装成 MCP 的
// structuredContent + text 双形态。此处不触碰协议细节，便于单测直接调用。
//
// 返回体积是硬约束：单节点正文最长 15756 字，整部审查指南第二部分逾百万字，
// 任何一处不设上限都足以打爆调用方的上下文。故 search 限条数与摘录长度、
// read 走分页游标、toc 限深度、related 限条数，且默认值一律取保守值。
import { nodeBrief, breadcrumbPath, normalizeTermKey } from './data.mjs';
import { search, excerpt } from './search.mjs';
import { cn2num } from '../../site/scripts/lib/cn-num.mjs';

// 边类型的中文名（与 quartz 侧图例一致），供 related_nodes 分组呈现
const EDGE_LABEL = {
  hierarchy: '层级',
  xref: '交叉引用',
  lawref: '法条依据',
  colaw: '共引同一法条',
  termref: '术语出现',
  termlaw: '术语关联法条',
  termrel: '术语相关',
  termco: '术语共现',
};

const clamp = (v, lo, hi, dflt) => {
  const n = Number.isFinite(v) ? v : dflt;
  return Math.max(lo, Math.min(hi, n));
};

// ============ 1. search_kb ============
export function searchKb(ctx, { query, books, limit, contextChars, includeTerms }) {
  const { kb, index } = ctx;
  const n = clamp(limit, 1, 30, 8);
  const ctxChars = clamp(contextChars, 40, 600, 200);

  const unknown = (books || []).filter((b) => !kb.allowedDomains.has(b));
  const hits = search(kb, index, {
    query,
    books: (books || []).filter((b) => kb.allowedDomains.has(b)),
    limit: n,
    includeTerms: includeTerms !== false,
  });

  const results = hits.map((h) => {
    const b = nodeBrief(kb, h.id);
    const node = kb.byId.get(h.id);
    const body = node.level === 'term'
      ? (kb.termDetails[h.id] || {}).definition || ''
      : (kb.bodies[h.id] || {}).own || node.summary || '';
    // 摘录优先取正文命中处；正文无命中则退回标题的上下文（命中在标题上）
    const ex = excerpt(body, query, ctxChars);
    return {
      id: b.id,
      title: b.title,
      book: b.book,
      level: b.level,
      path: breadcrumbPath(kb, h.id),
      slug: b.slug,
      chars: b.chars,
      excerpt: ex.text,
      matchedIn: h.via,
    };
  });

  return {
    query,
    total: results.length,
    truncated: results.length >= n,
    results,
    notes: unknown.length ? [`以下书目未开放或不存在，已忽略：${unknown.join('、')}`] : [],
  };
}

// ============ 2. read_node ============
export function readNode(ctx, { id, mode, offset, limit }) {
  const { kb } = ctx;
  const node = kb.byId.get(id);
  if (!node) return { error: `节点不存在或所属书目未开放：${id}` };

  const wantFull = mode === 'full';
  const body = kb.bodies[id] || {};
  // full 缺省回落 own（叶子节点二者相同，构建期已去重）；两者皆空时用 summary 兜底
  const raw = (wantFull ? body.full || body.own : body.own) || node.summary || '';
  const total = raw.length;
  const off = clamp(offset, 0, Math.max(0, total), 0);
  const max = clamp(limit, 200, 20000, 4000);
  const text = raw.slice(off, off + max);
  const end = off + text.length;

  const b = nodeBrief(kb, id);
  const detail = kb.docDetails[id] || {};
  const children = (kb.childrenOf.get(id) || []).map((cid) => {
    const c = kb.byId.get(cid);
    return { id: cid, title: c.label, level: c.level };
  });

  return {
    id: b.id,
    title: b.title,
    book: b.book,
    level: b.level,
    path: breadcrumbPath(kb, id),
    slug: b.slug,
    mode: wantFull ? 'full' : 'own',
    brief: detail.brief || node.summary || '',
    lawRefs: detail.lawRefs || [],
    children,
    text,
    offset: off,
    returned: text.length,
    total,
    hasMore: end < total,
    nextOffset: end < total ? end : null,
    empty: total === 0
      ? '该节点无独立正文（其标题即全部内容，或内容分布在子节点中），可用 browse_toc 查看子节点'
      : undefined,
  };
}

// ============ 3. browse_toc ============
export function browseToc(ctx, { root, depth }) {
  const { kb } = ctx;
  const d = clamp(depth, 1, 5, 2);

  // 未指定 root：返回七部书的顶层节点
  if (!root) {
    return {
      root: null,
      depth: d,
      books: kb.books.map((b) => ({
        domain: b.domain,
        title: b.title,
        nodeCount: b.nodeCount,
        chars: b.chars,
        children: buildTree(kb, rootsOfDomain(kb, b.domain), d - 1),
      })),
    };
  }

  // root 是书目域键
  const book = kb.books.find((b) => b.domain === root);
  if (book) {
    return {
      root: { domain: book.domain, title: book.title },
      depth: d,
      children: buildTree(kb, rootsOfDomain(kb, book.domain), d),
    };
  }

  // root 是节点 id
  const node = kb.byId.get(root);
  if (!node) return { error: `未知的书目域或节点：${root}（书目域可用 list_books 查询）` };
  const b = nodeBrief(kb, root);
  return {
    root: { id: b.id, title: b.title, book: b.book, path: breadcrumbPath(kb, root) },
    depth: d,
    children: buildTree(kb, kb.childrenOf.get(root) || [], d),
  };
}

/** 某书的顶层节点：没有父节点的那些 */
function rootsOfDomain(kb, domain) {
  return kb.nodes
    .filter((n) => n.domain === domain && !kb.parentOf.has(n.id))
    .map((n) => n.id)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function buildTree(kb, ids, depth) {
  if (depth <= 0) return [];
  return ids.map((id) => {
    const n = kb.byId.get(id);
    const kids = kb.childrenOf.get(id) || [];
    return {
      id,
      title: n.label,
      level: n.level,
      chars: n.charLen || 0,
      childCount: kids.length,
      children: depth > 1 ? buildTree(kb, kids, depth - 1) : undefined,
    };
  });
}

// ============ 4. lookup_term ============
export function lookupTerm(ctx, { term, includeEvidence }) {
  const { kb } = ctx;
  const key = normalizeTermKey(term);
  const rec = kb.termByName.get(key);

  if (!rec) {
    // 未精确命中时给出可选项，避免调用方在零结果处空转
    const suggestions = [];
    for (const [name, r] of kb.termByName) {
      if (name.includes(key) || key.includes(name)) {
        const n = kb.byId.get(r.id);
        if (n) suggestions.push(n.label);
      }
      if (suggestions.length >= 10) break;
    }
    return {
      error: `未收录术语「${term}」`,
      suggestions: [...new Set(suggestions)],
      hint: '术语共 851 条；也可用 search_kb 做全文检索',
    };
  }

  const node = kb.byId.get(rec.id);
  const d = kb.termDetails[rec.id] || {};
  const occurrences = [];
  for (const [domain, list] of Object.entries(d.occurrences || {})) {
    const book = kb.allBooks.find((b) => b.domain === domain);
    for (const o of list) {
      if (!kb.byId.has(o.nodeId)) continue;
      occurrences.push({
        nodeId: o.nodeId,
        title: o.nodeLabel,
        book: book ? book.short : domain,
        path: [...(o.breadcrumb || []), o.nodeLabel].join(' › '),
        slug: kb.slugs[o.nodeId] || null,
        evidence: includeEvidence ? o.evidence || '' : undefined,
        lawCites: o.fullCites && o.fullCites.length ? o.fullCites : undefined,
      });
    }
  }

  return {
    id: node.id,
    term: node.label,
    matchedVia: rec.canonical ? 'canonical' : 'alias',
    aliases: node.aliases || [],
    topic: node.breadcrumb && node.breadcrumb.length > 1 ? node.breadcrumb[1] : null,
    definition: d.definition || '',
    slug: kb.slugs[node.id] || null,
    laws: d.laws || [],
    relatedTerms: (d.relatedTerms || [])
      .map((t) => {
        const tid = t.id || t;
        const tn = kb.byId.get(tid);
        return tn ? { id: tid, term: tn.label } : null;
      })
      .filter(Boolean),
    occurrenceCount: occurrences.length,
    occurrences: occurrences.slice(0, 40),
    truncated: occurrences.length > 40,
  };
}

// ============ 5. find_law ============
/**
 * 法条入参归一化。接受的写法：
 *   专利法第22条 / 专利法第二十二条 / 法22 / 22（默认专利法）
 *   专利法实施细则第22条 / 实施细则22 / 细则22 / 则22
 *   law-02-01 / rule-02-06（直接给节点 id）
 */
export function normalizeLawKey(kb, input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (kb.byId.has(s)) return { nodeId: s };            // 已是节点 id
  if (kb.lawArticles.has(s)) return { key: s };        // 已是规范键

  const isRule = /实施细则|细则|^则/.test(s);
  const m = s.match(/第?([一二三四五六七八九十百零]+|\d+)条?\s*$/);
  if (!m) return null;
  const num = cn2num(m[1]);
  if (!Number.isFinite(num)) return null;
  const key = `${isRule ? '专利法实施细则' : '专利法'}第${num}条`;
  return kb.lawArticles.has(key) ? { key } : null;
}

export function findLaw(ctx, { article, withCitations, limit }) {
  const { kb } = ctx;
  const hit = normalizeLawKey(kb, article);
  if (!hit) {
    return {
      error: `无法解析法条「${article}」`,
      hint: '可写「专利法第22条」「专利法第二十二条」「细则22」，或直接给条文节点 id（如 law-02-01）',
    };
  }

  const nodeId = hit.nodeId || kb.lawArticles.get(hit.key);
  const node = kb.byId.get(nodeId);
  if (!node) return { error: `条文节点未开放：${nodeId}` };

  // 由节点 id 反查规范键，使「给 id」与「给条号」两条入口的返回一致
  let key = hit.key;
  if (!key) for (const [k, v] of kb.lawArticles) if (v === nodeId) { key = k; break; }

  const body = kb.bodies[nodeId] || {};
  const b = nodeBrief(kb, nodeId);
  const max = clamp(limit, 5, 200, 60);
  const cited = key ? kb.lawCitedBy.get(key) || [] : [];

  return {
    article: key || node.label,
    id: b.id,
    title: b.title,
    book: b.book,
    path: breadcrumbPath(kb, nodeId),
    slug: b.slug,
    text: body.own || node.summary || '',
    citedByCount: cited.length,
    citedBy: withCitations === false ? undefined : cited.slice(0, max).map((cid) => {
      const c = nodeBrief(kb, cid);
      return { id: cid, title: c.title, book: c.book, path: breadcrumbPath(kb, cid), slug: c.slug };
    }),
    truncated: withCitations !== false && cited.length > max,
  };
}

// ============ 6. related_nodes ============
export function relatedNodes(ctx, { id, types, limit }) {
  const { kb } = ctx;
  if (!kb.byId.has(id)) return { error: `节点不存在或所属书目未开放：${id}` };
  const max = clamp(limit, 1, 100, 20);
  const wanted = types && types.length ? new Set(types) : null;

  const groups = new Map();
  for (const nb of kb.neighborsOf.get(id) || []) {
    if (wanted && !wanted.has(nb.type)) continue;
    if (!groups.has(nb.type)) groups.set(nb.type, []);
    groups.get(nb.type).push(nb);
  }

  const out = [];
  for (const [type, list] of groups) {
    out.push({
      type,
      label: EDGE_LABEL[type] || type,
      count: list.length,
      nodes: list.slice(0, max).map((nb) => {
        const b = nodeBrief(kb, nb.id);
        return {
          id: nb.id,
          title: b.title,
          book: b.book,
          level: b.level,
          direction: nb.dir === 'out' ? '指向' : '被指向',
          path: breadcrumbPath(kb, nb.id),
          slug: b.slug,
        };
      }),
      truncated: list.length > max,
    });
  }
  out.sort((a, b) => b.count - a.count);

  const self = nodeBrief(kb, id);
  const detail = kb.docDetails[id] || {};
  return {
    id: self.id,
    title: self.title,
    book: self.book,
    path: breadcrumbPath(kb, id),
    // related 是数据层预解析的人可读关系（上级/下属/法条依据/指南交叉引用等），与图谱边互补
    curated: (detail.related || []).map((r) => ({ id: r.id, title: r.label, reason: r.reason })),
    groups: out,
  };
}

// ============ 7. list_books ============
export function listBooks(ctx) {
  const { kb } = ctx;
  const closed = kb.allBooks.filter((b) => !kb.allowedDomains.has(b.domain));
  return {
    totalNodes: kb.nodes.length,
    termCount: kb.nodes.filter((n) => n.level === 'term').length,
    lawArticleCount: kb.lawArticles.size,
    books: kb.books.map((b) => ({
      domain: b.domain,
      title: b.title,
      short: b.short,
      nodeCount: b.nodeCount,
      chars: b.chars,
    })),
    closedBooks: closed.map((b) => ({ domain: b.domain, title: b.title })),
    note: closed.length
      ? `${closed.length} 部书目已由 PATENTREADER_MCP_DOMAINS 关闭，其内容不参与检索也无法读取`
      : '七部书目全部开放',
  };
}

export { EDGE_LABEL };
