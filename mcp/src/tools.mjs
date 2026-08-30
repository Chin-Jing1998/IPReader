// tools.mjs —— 七个 MCP 工具的业务实现
//
// 每个函数接收 (ctx, args) 并返回纯数据对象，由 server.mjs 负责包装成 MCP 的
// structuredContent + text 双形态。此处不触碰协议细节，便于单测直接调用。
//
// 返回体积是硬约束：单节点正文最长 15756 字，整部审查指南第二部分逾百万字，
// 任何一处不设上限都足以打爆调用方的上下文。故 search 限条数与摘录长度、
// read 走分页游标、toc 限深度、related 限条数，且默认值一律取保守值。
import { nodeBrief, breadcrumbPath, normalizeTermKey } from './data.mjs';
import {
  search, excerpt, parseArticleQuery, articleCandidates,
  matchLawAlias, lawNameLike, splitArticleTail, lawRegistry,
} from './search.mjs';

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

// ============ 文献分类词表（阶段5 波C 新增） ============
// 76 部书按国家（country）/ 六标签法域（field）/ D1–D6 文献类型（docType）分类，
// 单一事实源为 site/scripts/lib/domains.mjs 的同名常量——此处存一份逐字同步的副本，
// 与 site 侧同步维护，此文件内不 import 该文件：mcp/ 是独立离线分发包，不依赖 site/
// 侧的构建期文件，沿用 BOOKS 常量「双档各自维护、由脚本校验一致性」的既有惯例
// （如 mcp/scripts/build-data.mjs 与 site/scripts/build-quartz-md.mjs 的 BOOKS 双文件、
// mcp/scripts/check-taxonomy.mjs 对 domains.mjs 的一致性校验）。domains.mjs 若调整
// 这两个常量的取值，须手工同步改这里。
const DOC_TYPES = {
  D1: '法律', D2: '行政法规', D3: '部门规章与规范性文件',
  D4: '司法解释与裁判规则', D5: '审查与实务指引', D6: '政策文件与标准索引',
};
const FIELDS = ['专利', '商标', '著作权', '竞争法', '品种布图', '综合程序'];

/**
 * country → field → docType 三级分桶：list_books 的 groups 摘要与 browse_toc 的
 * grouped 视图共用此步骤，避免两处重复「跳过缺字段书目 + 三层 Map.get-or-set」逻辑。
 * books 中任一项缺 country/field/docType 三字段之一即跳过——现网 dist 数据包
 * （阶段5 波C 数据重建前）三字段皆缺，此时返回空 Map，两个消费方各自据此得到空数组，
 * 这正是分组功能的向后兼容分支。
 */
function groupByTaxonomy(books) {
  const byCountry = new Map();
  for (const b of books) {
    if (!b.country || !b.field || !b.docType) continue;
    if (!byCountry.has(b.country)) byCountry.set(b.country, new Map());
    const byField = byCountry.get(b.country);
    if (!byField.has(b.field)) byField.set(b.field, new Map());
    const byDocType = byField.get(b.field);
    if (!byDocType.has(b.docType)) byDocType.set(b.docType, []);
    byDocType.get(b.docType).push(b);
  }
  return byCountry;
}

const byBookOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

/**
 * list_books 的 groups 摘要用：fields 按 FIELDS 声明顺序排列，docTypes 按 D1..D6 排列，
 * 同一 docType 内的 domains 按书目 order 字段升序排列，逐层附计数——纯统计摘要，
 * domains 只给域键，明细仍查同一返回体里的 books[] 平铺。
 */
function buildBookGroups(books) {
  const byCountry = groupByTaxonomy(books);
  const groups = [];
  for (const [country, byField] of byCountry) {
    const fields = [];
    for (const field of FIELDS) {
      const byDocType = byField.get(field);
      if (!byDocType) continue;
      let count = 0;
      const docTypes = [];
      for (const docType of Object.keys(DOC_TYPES)) {
        const list = byDocType.get(docType);
        if (!list) continue;
        const sorted = [...list].sort(byBookOrder);
        count += sorted.length;
        docTypes.push({
          docType,
          docTypeName: DOC_TYPES[docType],
          count: sorted.length,
          domains: sorted.map((b) => b.domain),
        });
      }
      fields.push({ field, count, docTypes });
    }
    groups.push({ country, fields });
  }
  return groups;
}

/**
 * browse_toc（groupBy='taxonomy'）的 grouped 视图用：分组与排序规则与 buildBookGroups
 * 一致，但叶层换成可直接展示/续查的 {domain,title,nodeCount}而非纯域键，且不附计数——
 * 该视图定位是「按分类浏览书目」而非统计摘要，字段取舍与 list_books 的 groups 各自独立。
 */
function buildTaxonomyTree(books) {
  const byCountry = groupByTaxonomy(books);
  const grouped = [];
  for (const [country, byField] of byCountry) {
    const fields = [];
    for (const field of FIELDS) {
      const byDocType = byField.get(field);
      if (!byDocType) continue;
      const docTypes = [];
      for (const docType of Object.keys(DOC_TYPES)) {
        const list = byDocType.get(docType);
        if (!list) continue;
        const sorted = [...list].sort(byBookOrder);
        docTypes.push({
          docType,
          docTypeName: DOC_TYPES[docType],
          books: sorted.map((b) => ({ domain: b.domain, title: b.title, nodeCount: b.nodeCount })),
        });
      }
      fields.push({ field, docTypes });
    }
    grouped.push({ country, fields });
  }
  return grouped;
}

/**
 * 容器节点的入口子节点：首个自身带正文的后代。
 *
 * 4453 个文档节点中约 447 个无 own（其中 438 个有子节点），它们的 summary 实为子节点
 * 摘要——检索命中这类节点时，调用方拿到的是「本节无独立正文」而无从续读。
 * 命中容器多为「找章入口」的合法诉求（如查「专利登记簿」命中「第九章 专利登记和专利公报」），
 * 故不在打分层降权，改为随结果附出这个可直接续读的实体子节点。
 *
 * 深度取 3：423 个容器的首层子节点即有正文，余 15 个需下探第二层，三层足够覆盖。
 * 按 childrenOf 的既有 id 序遍历（构建期已排序），故「首个」在文档顺序上确定。
 */
function entryChildOf(kb, id, depth = 3) {
  const kids = kb.childrenOf.get(id) || [];
  for (const cid of kids) {
    if ((kb.bodies[cid] || {}).own) return cid;
  }
  if (depth <= 1) return null;
  for (const cid of kids) {
    const deep = entryChildOf(kb, cid, depth - 1);
    if (deep) return deep;
  }
  return null;
}

// ============ 1. search_kb ============
export function searchKb(ctx, { query, books, limit, contextChars, includeTerms }) {
  const { kb, index } = ctx;
  const n = clamp(limit, 1, 30, 8);
  const ctxChars = clamp(contextChars, 40, 600, 200);

  const requested = books || [];
  const valid = requested.filter((b) => kb.allowedDomains.has(b));
  const unknown = requested.filter((b) => !kb.allowedDomains.has(b));

  // 指定了书目却无一有效时，不得把空数组交给 search——search 会把空数组判为「未限定」
  // 而回落全库检索，调用方以为限定了范围、实际拿到全库结果，属静默错误。
  // 此处直接返回空结果并说明原因，使范围失效在调用侧可见。
  if (requested.length && !valid.length) {
    return {
      query,
      total: 0,
      truncated: false,
      results: [],
      error: `指定的书目均未开放或不存在：${unknown.join('、')}（可用 list_books 查看已开放书目的域键）`,
      notes: [],
    };
  }

  const hits = search(kb, index, {
    query,
    books: valid,
    limit: n,
    includeTerms: includeTerms !== false,
  });

  const results = hits.map((h) => {
    const b = nodeBrief(kb, h.id);
    const node = kb.byId.get(h.id);
    const body = node.level === 'term'
      ? (kb.termDetails[h.id] || {}).definition || ''
      : (kb.bodies[h.id] || {}).own || node.summary || '';
    // 容器节点（本节无独立正文）附首个实体子节点，并改以该子节点正文取摘录——
    // 容器自身的 body 槽回落的是 summary（子节点摘要），拿它作摘录等于给出二手转述。
    const isContainer = node.level !== 'term' && !(kb.bodies[h.id] || {}).own;
    const entryId = isContainer ? entryChildOf(kb, h.id) : null;
    const exBody = entryId ? (kb.bodies[entryId] || {}).own || '' : body;
    // 摘录优先取正文命中处；正文无命中则退回标题的上下文（命中在标题上）
    const ex = excerpt(exBody, query, ctxChars);
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
      isContainer: isContainer || undefined,
      entry: entryId
        ? { id: entryId, title: kb.byId.get(entryId).label, chars: (kb.bodies[entryId] || {}).own.length }
        : undefined,
    };
  });

  const notes = [];
  if (unknown.length) notes.push(`以下书目未开放或不存在，已忽略：${unknown.join('、')}`);
  // 裸条号（未写明法名）的法域推定提示。检索侧沿用「专利法优先」的既有口径不变，
  // 但须把歧义讲明：「第26条」在 45 部规范中都有对应条文，静默按专利法排序而不作声，
  // 等于替用户下了一个多半不对的判断。find_law 侧的对策是返回候选清单（见 normalizeLawKey
  // 第 3 级）——检索工具不宜照搬，45 条候选会把 Top8 占满且无一是用户想要的。
  const art = parseArticleQuery(kb, query);
  if (art && !art.explicit) {
    const cands = articleCandidates(kb, art.num);
    if (cands.length > 1) {
      // 举例取一部非专利法系、且法名最短的规范：既真正示范「写明法名」的作用，
      // 又避开 39 字的司法解释全称与「著作权」这类与他法互为子串的简称
      const other = cands
        .filter((c) => c.domain !== 'patent-law' && c.domain !== 'implementation-rules')
        .sort((a, b) => a.lawName.length - b.lawName.length)[0] || cands[cands.length - 1];
      notes.push(`「第${art.num}条」未写明法名，已按专利法推定；该条号在 ${cands.length} 部规范中均有对应条文，`
        + `写明法名（如「${other.lawName}第${art.num}条」）可直达，或用 find_law 取完整候选清单`);
    }
  }

  return {
    query,
    total: results.length,
    truncated: results.length >= n,
    results,
    notes,
  };
}

// ============ 2. read_node ============
const LAW_CITES_LIMIT = 50;

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

  // 本节正文引用的法条清单：count 降序，同 count 按 lawKey 中文排序；仅在非空时输出，
  // 避免给全库中无引用记录的多数节点徒增一个空字段（省略优于空数组，减轻调用方判空负担）。
  const citesRaw = (kb.lawCitesByNode && kb.lawCitesByNode.get(id)) || [];
  const citesSorted = citesRaw.length
    ? [...citesRaw].sort((x, y) => y.count - x.count || x.lawKey.localeCompare(y.lawKey, 'zh'))
    : [];

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
    lawCites: citesSorted.length ? citesSorted.slice(0, LAW_CITES_LIMIT) : undefined,
    truncated: citesSorted.length ? citesSorted.length > LAW_CITES_LIMIT : undefined,
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
export function browseToc(ctx, { root, depth, groupBy }) {
  const { kb } = ctx;
  // 上限由 5 提至 8（阶段5.3 批次 W9）：商标审查审理指南（tmeg）经 W1/W2 深层解析后为 8 层树
  // （书根下 7 级 id 段），上限 5 时无法从书根一次展开到叶节点，须分次续查，体验不佳。
  const d = clamp(depth, 1, 8, 2);

  // 未指定 root：返回七部书的顶层节点（books 平铺形态逐字不变，向后兼容）
  if (!root) {
    const flat = {
      root: null,
      depth: d,
      books: kb.books.map((b) => ({
        domain: b.domain,
        title: b.title,
        nodeCount: b.nodeCount,
        chars: b.chars,
        // 效力四字段（阶段5.3 批次 W9 新增），与 list_books 的书目条目同构透出；
        // 数据包未升级时为 undefined，序列化自动省略，向后兼容。
        effectiveDate: b.effectiveDate,
        adoptedDate: b.adoptedDate,
        documentNo: b.documentNo,
        status: b.status,
        children: buildTree(kb, rootsOfDomain(kb, b.domain), d - 1),
      })),
    };
    // groupBy='taxonomy'：在 flat 之外另附层级视图 grouped，不改动/替换上面的 books
    // 平铺——旧消费者只读 books 字段，对新增字段零感知。数据包缺三字段时
    // buildTaxonomyTree 回落空数组，此即向后兼容分支。
    return groupBy === 'taxonomy' ? { ...flat, grouped: buildTaxonomyTree(kb.books) } : flat;
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
      // 条数由运行时数据实算，不写死——术语层在后续入库阶段会扩容
      hint: `术语共 ${kb.nodes.filter((n) => n.level === 'term').length} 条；也可用 search_kb 做全文检索`,
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
const FIND_LAW_HINT = '可写「专利法第22条」「专利法第二十二条」「细则22」「商标法第八条」'
  + '「侵权解释二第22条」，或直接给条文节点 id（如 law-02-01）';

/**
 * 法条入参归一化。接受的写法：
 *   专利法第22条 / 专利法第二十二条 / 法22 / 22（裸条号，见第 3 级）
 *   专利法实施细则第22条 / 实施细则22 / 细则22 / 则22
 *   商标法第八条 /《商标法》第8条 / 侵权解释（二）第22条 / 布图细则第43条（阶段 3 起）
 *   law-02-01 / rule-02-06（直接给节点 id）
 *
 * 三级回退（阶段 3）：
 *   1. 精确法名——条号左侧命中注册表别名（最长优先），直达该法域的键；
 *      该法无此条号时返回 no-such-article，而非改判他法；
 *   2. 有法名但不认识——返回 unknown-law。这是勘误一的根治点：阶段 3 前本函数
 *      只锚定查询结尾的条号、完全不看法名，「商标法第8条」静默返回专利法第8条，
 *      且返回体 article 字段写着「专利法第8条」，调用方无从察觉自己问错了；
 *   3. 真裸条号——返回全部候选（专利法系置首）。「第26条」有 45 部候选，
 *      静默单选等于替用户下了一个多半不对的判断。
 *
 * @returns {{nodeId}|{key,domain?}|{candidates,num}|{error:'unknown-law'|'no-such-article',...}|null}
 */
export function normalizeLawKey(kb, input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (kb.byId.has(s)) return { nodeId: s };            // 已是节点 id
  if (kb.lawArticles.has(s)) return { key: s };        // 已是规范键

  const tail = splitArticleTail(s);
  if (!tail) return null;
  const { left, num } = tail;

  // 第 1 级 · 精确法名（includeFindOnly：「法22」这类 find_law 历史写法只在此路径生效）
  const named = matchLawAlias(kb, left, { includeFindOnly: true });
  if (named) {
    const key = `${named.lawName}第${num}条`;
    return kb.lawArticles.has(key)
      ? { key, domain: named.domain }
      : { error: 'no-such-article', lawName: named.lawName, num };
  }

  // 第 2 级 · 有法名但不认识：绝不回落专利法
  if (lawNameLike(left)) return { error: 'unknown-law', text: left.trim(), num };

  // 第 3 级 · 裸条号：候选唯一则直达，多义则交还调用方择一
  const cands = articleCandidates(kb, num);
  if (!cands.length) return null;
  if (cands.length === 1) return { key: cands[0].key, domain: cands[0].domain };
  return { candidates: cands, num };
}

const CAND_LIMIT = 20;

export function findLaw(ctx, { article, withCitations, limit }) {
  const { kb } = ctx;
  const hit = normalizeLawKey(kb, article);
  if (!hit) return { error: `无法解析法条「${article}」`, hint: FIND_LAW_HINT };

  if (hit.error === 'unknown-law') {
    // 左侧残留不含中文（多为节点 id 笔误，如 rule-99-99）时，说「未收录法律」反而误导
    if (!/[一-龥]/.test(hit.text)) return { error: `无法解析法条「${article}」`, hint: FIND_LAW_HINT };
    return {
      error: `未收录法律「${hit.text}」，故无法定位其第${hit.num}条`,
      hint: `可用 list_books 查看已开放的 ${lawRegistry(kb).lawNameByDomain.size} 部有条文规范；`
        + `若要查专利法请写明「专利法第${hit.num}条」`,
    };
  }
  if (hit.error === 'no-such-article') {
    return { error: `《${hit.lawName}》无第${hit.num}条`, hint: '请核对条号' };
  }
  if (hit.candidates) {
    // 裸条号跨法域多候选：列出全部，不代用户择一
    const shown = hit.candidates.slice(0, CAND_LIMIT);
    const note = `「第${hit.num}条」在 ${hit.candidates.length} 部规范中均有对应条文，`
      + `请写明法名（如「${hit.candidates[0].lawName}第${hit.num}条」）以直达`;
    const candidates = shown.map((c) => {
      const b = nodeBrief(kb, kb.lawArticles.get(c.key));
      return { article: c.key, lawName: c.lawName, short: c.short, id: b.id, title: b.title, slug: b.slug };
    });
    return {
      ambiguous: true,
      query: article,
      note,
      candidates,
      truncated: hit.candidates.length > CAND_LIMIT,
      // 以下四项供 server.mjs 的可读文本渲染取用（该文件为本批红线，不可改其渲染分支）：
      // 不设 error 字段，故本返回不被标记为 isError——多义是正常结果，不是失败。
      article: `第${hit.num}条`,
      title: `跨法域多义 · ${hit.candidates.length} 部规范均有该条`,
      id: '（请择一后重查）',
      text: [note, ...candidates.map((c) => `  · ${c.article}　${c.title}（${c.id}）`)].join('\n')
        + (hit.candidates.length > CAND_LIMIT ? `\n  …… 另有 ${hit.candidates.length - CAND_LIMIT} 部未列出` : ''),
      citedByCount: 0,
      citedBy: [],
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
      // 阶段5 波C 新增：数据包（波C 数据重建前）无此三字段时 b.xxx 为 undefined，
      // 序列化时自动省略——旧调用方读不到陌生字段，即向后兼容分支。
      country: b.country,
      field: b.field,
      docType: b.docType,
      docTypeName: DOC_TYPES[b.docType],
      // 效力四字段（阶段5.3 批次 W9 新增）：build-data.mjs 侧空串照传而非省略，
      // 故此处直接透出即可、无需按 country/field/docType 的存在性兜底写法；
      // 数据包未升级到 W9 定版时 b.xxx 为 undefined，序列化时自动省略，仍是向后兼容分支。
      effectiveDate: b.effectiveDate,
      adoptedDate: b.adoptedDate,
      documentNo: b.documentNo,
      status: b.status,
    })),
    closedBooks: closed.map((b) => ({ domain: b.domain, title: b.title })),
    note: closed.length
      ? `${closed.length} 部书目已由 IPREADER_MCP_DOMAINS 关闭，其内容不参与检索也无法读取`
      : `全部 ${kb.books.length} 部书目均已开放`,
    // 摘要分组：country→field→docType 三级聚合，供快速概览 76 部书目的分布，不必
    // 自行遍历 books[] 重新分组。groups 字段本身恒存在（结构性新增，非条件性出现），
    // 但数据包未完成波C 重建时三字段皆缺，buildBookGroups 回落空数组，即向后兼容分支。
    groups: buildBookGroups(kb.books),
  };
}

export { EDGE_LABEL };
