// tools.mjs —— 十三个 MCP 工具的业务实现
//
// 每个函数接收 (ctx, args) 并返回纯数据对象，由 server.mjs 负责包装成 MCP 的
// structuredContent + text 双形态。此处不触碰协议细节，便于单测直接调用。
//
// ============ 输出体量是本文件的第一约束 ============
//
// 阶段5.13b 取证（Claude Code v2.1.247 可执行文件 + 实调验证）确立了三条事实，
// 本文件的全部限流参数由它们推导，改动前须先读懂：
//
//   1. 宿主只消费 structuredContent，不消费 content[0].text。
//      宿主侧 MCP 结果规范化函数的分支顺序是「toolResult → structuredContent → content[]」：
//      structuredContent 存在时，直接取 JSON.stringify(structuredContent) 交给模型，
//      content[] 中的 text 块被整体丢弃（仅图片等非 text 块会被保留并与该 JSON 拼接）。
//      实调佐证：browse_toc 缺省档被截断时，宿主回报「result (109,739 characters)」，
//      与本地实测的 structuredContent JSON 字符数逐字相等，且截断提示写明
//      「Format: JSON with schema: {root: null, depth: number, books: [{...}]}」。
//      推论：探查报告「双轨把体量放大约 1.5 倍」的假设不成立——text 不进模型上下文，
//      治理目标是且仅是 JSON.stringify(structuredContent) 的体量。
//
//   2. 硬上限 25 000 token（MAX_MCP_OUTPUT_TOKENS，可由环境变量覆盖）。
//      超限后整个返回体被转存文件、不进模型上下文，模型只拿到一句「已转存」的错误提示，
//      随即换参重试——用户观感即「调用了很久没有结果」。这正是本批要根治的体感问题。
//
//   3. 免检快速路径的边界是上限的一半，即 12 500 估算 token。
//      宿主先用本地估算做快速判断：估算值 ≤ 上限×0.5 时直接放行；超过则发起一次
//      真实 token 计数再判定——那是一次额外往返，即便最终没超限也已经付了延迟。
//
// 由此定安全阈值 SAFE_OUTPUT_TOKENS = 12 000（按下方 estimateTokens 的 CJK 保守口径）。
// 论证：CJK 保守口径（中文一字一 token、其余四字符一 token）恒不小于宿主所用的
// 「字符数 ÷ 4」口径，故本口径 ≤ 12 000 可保证宿主口径 ≤ 12 000 < 12 500——
// 既不被截断，也不触发宿主侧的真实 token 计数往返。
//
// 落实手段有两层：工具内按语义边界的增量预算（本文件，主力），
// 与 server.mjs 的 reply() 兜底保险丝（异常形态的最后一道，正常不触发）。
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

// ============ 输出体量自律 ============

/** 安全阈值缺省值，推导见文件头注第 3 条 */
const DEFAULT_SAFE_TOKENS = 12000;
/**
 * 信封预留额度上限：主清单之外的元字段（root、criteria、facets、hint、计数与游标等）不走
 * 增量预算，须先扣下来。取 1000 是实测校准值——治理后各工具的信封实测在 200–650 tok 之间，
 * 留四成余量以吸收 hint 文案后续加长。
 *
 * 实际预留取「该上限」与「阈值的一成」中的较小者：调用方把 IPREADER_MAX_OUTPUT_TOKENS
 * 设得很低时（如 2000），固定扣 1000 会吃掉一半预算，主清单反而装不下几条。
 */
const ENVELOPE_RESERVE = 1000;
const envelopeFor = (cap) => Math.min(ENVELOPE_RESERVE, Math.round(cap * 0.1));
/**
 * 每项的结构开销：数组元素之间的逗号、嵌套对象的花括号与缩进不在单项序列化里，
 * 逐项估算会系统性低估。实测 depth=3 的数千项累计低估约 600 tok，故每项另计 2 tok。
 */
const ITEM_OVERHEAD = 2;

/**
 * 本次运行的输出安全阈值。
 * 环境变量 IPREADER_MAX_OUTPUT_TOKENS 可覆盖——宿主侧上限并非各家一律 25 000，
 * 给用户留一个不改代码即可适配的旋钮；取值夹在 1000–100000 之间以防误设为 0 或天文数字。
 */
export function safeOutputTokens() {
  const raw = Number(process.env.IPREADER_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SAFE_TOKENS;
  return Math.max(1000, Math.min(100000, Math.floor(raw)));
}

/**
 * 保守 token 估算：CJK 与全角区一字算一 token，其余按四字符一 token。
 *
 * 口径与阶段5.13 探查报告、宿主实测对照表逐字一致，故本文件的断言数字可与报告直接比对。
 * 之所以取「保守」而非「精确」：估高不会导致超限，估低会——限流器宁可少给也不能给爆。
 * 传对象时按其 JSON 序列化计——那正是宿主实际计量的那一份。
 */
export function estimateTokens(v) {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  return Math.round(cjk + (s.length - cjk) / 4);
}

/**
 * 增量预算。工具逐项累加、超额即停，切分点因此落在语义边界（一条命中、一个节点、一层子树）
 * 上，而不是像宿主截断那样从字符串中间一刀切断。
 * @param {number} [limit] 预算上限，缺省取安全阈值减去信封预留
 */
export function makeBudget(limit) {
  const safe = safeOutputTokens();
  const cap = Number.isFinite(limit) ? limit : safe - envelopeFor(safe);
  let used = 0;
  return {
    get used() { return used; },
    get cap() { return cap; },
    get left() { return Math.max(0, cap - used); },
    /**
     * 试加一项：装得下则计入并返 true，装不下则不计入并返 false。
     * `used > 0` 的例外是为单项即超预算的极端情形留一条出路——宁可给一条超额结果，
     * 也不返回空数组让调用方以为「查无此物」。
     */
    tryAdd(item) {
      const cost = estimateTokens(item) + ITEM_OVERHEAD;
      if (used > 0 && used + cost > cap) return false;
      used += cost;
      return true;
    },
    /** 无条件计入（用于信封字段等必出内容） */
    charge(item) { used += estimateTokens(item); },
  };
}

/** 分页/截断的统一提示句，供各工具拼进返回体的 hint 字段 */
const budgetHint = (what, how) => `结果已按输出体量上限截断（仅返回${what}）；${how}`;

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
 * 5963 个文档节点中 756 个无 own（其中 723 个有子节点），它们的 summary 实为子节点
 * 摘要——检索命中这类节点时，调用方拿到的是「本节无独立正文」而无从续读。
 * 命中容器多为「找章入口」的合法诉求（如查「专利登记簿」命中「第九章 专利登记和专利公报」），
 * 故不在打分层降权，改为随结果附出这个可直接续读的实体子节点。
 *
 * 深度取 3（阶段5.13b 复测：本行原写「4453 个节点／447 个无 own／438 有子节点／
 * 423 个首层命中」，系阶段5.2 之前的数值，已随多轮入库失效）：723 个容器中 686 个的
 * 首层子节点即有正文，33 个需下探第二层、3 个需第三层，1 个整棵子树皆无正文，
 * 故三层仍足够覆盖。按 childrenOf 的既有 id 序遍历（构建期已排序），
 * 故「首个」在文档顺序上确定。
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

  // 预算守卫：limit=30 与 contextChars=600 的组合下，高频词（实测最坏「说明书」）
  // 可达 16 146 tok，超出安全阈值。逐条计费、装不下即停，比事后整体裁剪更省算力。
  const budget = makeBudget();
  let budgetHit = false;

  const results = [];
  for (const h of hits) {
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
    const item = {
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
    if (!budget.tryAdd(item)) { budgetHit = true; break; }
    results.push(item);
  }

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

  if (budgetHit) {
    notes.push(`命中 ${hits.length} 条，因输出体量上限只返回前 ${results.length} 条；`
      + '需要更多结果请调小 contextChars，或用 books 限定书目范围后重查');
  }

  return {
    query,
    total: results.length,
    // truncated 兼顾两种截断成因：命中数触到 limit（既有语义），或体量触到预算（本批新增）
    truncated: results.length >= n || budgetHit,
    budgetTruncated: budgetHit || undefined,
    results,
    notes,
  };
}

// ============ 2. read_node ============
const LAW_CITES_LIMIT = 50;
// 单次返回字数上限。阶段5.13b 由 20000 降至 8000：中文正文近似「一字一 token」，
// limit=20000 的最坏形态实测 19 593 tok，已逼近宿主 25 000 硬上限、远超 12 500 的
// 免检门槛；8000 字对应约 8 000 tok，留足信封与 lawCites 的余量。分页游标（nextOffset）
// 本就存在，降上限只是多翻一页，不损任何可达性。
const READ_LIMIT_MAX = 8000;

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
  const max = clamp(limit, 200, READ_LIMIT_MAX, 4000);
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
//
// 阶段5.13b 输出治理的主战场。治理前三种常用形态（缺省 40 199 tok、groupBy=taxonomy
// 43 603 tok、depth=3 125 267 tok）全部超出宿主 25 000 token 硬上限，必被截断——
// 这就是用户体感「调用不及时」的直接成因（模型拿不到结果，只能换参重试）。
//
// 治理分两处：
//   一、缺省档（不传 root）改为「书目级摘要」，不展开任何子树。76 部书各出域键、短名、
//       节点数、字数与顶层节点数，够调用方判断「往哪部书里钻」，实测降至约 3 300 tok。
//       要展开须显式传 depth——把「代价大的形态」从缺省变成明示请求，是限流的第一原则。
//   二、一切展开路径（无 root 传 depth、给书目域键、给节点 id）统一走预算内建树：
//       逐节点计费，装不下即停止展开并标 truncated，附 hint 指明如何续取。
export function browseToc(ctx, { root, depth, groupBy }) {
  const { kb } = ctx;
  const budget = makeBudget();

  // 未指定 root
  if (!root) {
    // 缺省 depth=0：仅书目摘要。显式传 depth≥1 才展开子树（上限仍为 8，见下方说明）。
    const d = clamp(depth, 0, 8, 0);
    const grouped = groupBy === 'taxonomy' ? buildTaxonomyTree(kb.books) : undefined;
    if (grouped) budget.charge(grouped);

    const books = kb.books.map((b) => ({
      domain: b.domain,
      // 摘要档出 short（如「审查指南」）而非 title（如「专利审查指南（2025年发布）」）：
      // 76 部书的全称合计约 1 900 tok，而短名足以支撑「往哪钻」的判断；
      // 需要全称、文号、施行日期等完整著录信息时走 list_books 的 detail='full'。
      short: b.short,
      nodeCount: b.nodeCount,
      chars: b.chars,
      topCount: (kb.rootsByDomain.get(b.domain) || []).length,
    }));
    budget.charge(books);

    if (d === 0) {
      return {
        root: null,
        depth: 0,
        mode: 'summary',
        books,
        ...(grouped ? { grouped } : {}),
        estimatedTokens: budget.used,
        hint: '当前为书目级摘要（不含子树）。展开某部书用 root=<域键>（如 root="examination-guideline"）；'
          + '需要跨全部书目的顶层结构可加 depth=1，层数越深返回越大，超出输出体量上限的部分会被截断。',
      };
    }

    // 显式展开：逐部书按预算建树，装不下的书只留摘要（children 省略）
    let truncatedAt = null;
    for (const b of books) {
      if (truncatedAt) { b.childrenOmitted = true; continue; }
      const tree = buildTree(kb, kb.rootsByDomain.get(b.domain) || [], d - 1, budget);
      if (tree.truncated && !tree.nodes.length) { truncatedAt = b.domain; b.childrenOmitted = true; continue; }
      b.children = tree.nodes;
      if (tree.truncated) { b.childrenTruncated = true; truncatedAt = b.domain; }
    }
    return {
      root: null,
      depth: d,
      mode: 'expanded',
      books,
      ...(grouped ? { grouped } : {}),
      truncated: Boolean(truncatedAt),
      estimatedTokens: budget.used,
      hint: truncatedAt
        ? budgetHint(`前若干部书的子树（自「${truncatedAt}」起未展开）`,
          '按部展开请改用 root=<域键> 单独调用，或调小 depth')
        : undefined,
    };
  }

  // root 是书目域键
  const book = kb.books.find((b) => b.domain === root);
  // 上限 8（阶段5.3 批次 W9 由 5 提至 8）：商标审查审理指南（tmeg）经 W1/W2 深层解析后为
  // 8 层树（书根下 7 级 id 段），上限 5 时无法从书根一次展开到叶节点，须分次续查，体验不佳。
  // 阶段5.13b 保留该上限不变，改由预算在体量维度兜底——深度是语义诉求，体量才是硬约束。
  const d = clamp(depth, 1, 8, 2);
  if (book) {
    const tree = buildTree(kb, kb.rootsByDomain.get(book.domain) || [], d, budget);
    return {
      root: { domain: book.domain, title: book.title },
      depth: d,
      children: tree.nodes,
      truncated: tree.truncated,
      estimatedTokens: budget.used,
      hint: tree.truncated
        ? budgetHint('可容纳的前若干个节点', '请调小 depth，或改以某个子节点 id 作 root 分段展开')
        : undefined,
    };
  }

  // root 是节点 id
  const node = kb.byId.get(root);
  if (!node) return { error: `未知的书目域或节点：${root}（书目域可用 list_books 查询）` };
  const b = nodeBrief(kb, root);
  const tree = buildTree(kb, kb.childrenOf.get(root) || [], d, budget);
  return {
    root: { id: b.id, title: b.title, book: b.book, path: breadcrumbPath(kb, root) },
    depth: d,
    children: tree.nodes,
    truncated: tree.truncated,
    estimatedTokens: budget.used,
    hint: tree.truncated
      ? budgetHint('可容纳的前若干个节点', '请调小 depth，或改以某个子节点 id 作 root 分段展开')
      : undefined,
  };
}

/**
 * 预算内建树：深度优先逐节点计费，任一节点装不下即整棵停止（返回 truncated）。
 *
 * 停在「已展开的节点」边界上而非字符中间，故返回体始终是合法且自洽的子树；
 * 调用方据 truncated 与 hint 决定是缩小 depth 还是换个 root 分段取。
 * @returns {{ nodes: object[], truncated: boolean }}
 */
function buildTree(kb, ids, depth, budget) {
  if (depth <= 0) return { nodes: [], truncated: false };
  const out = [];
  for (const id of ids) {
    const n = kb.byId.get(id);
    if (!n) continue;
    const kids = kb.childrenOf.get(id) || [];
    const item = {
      id,
      title: n.label,
      level: n.level,
      chars: n.charLen || 0,
      childCount: kids.length,
    };
    if (!budget.tryAdd(item)) return { nodes: out, truncated: true };
    out.push(item);
    if (depth > 1 && kids.length) {
      const sub = buildTree(kb, kids, depth - 1, budget);
      if (sub.nodes.length) item.children = sub.nodes;
      if (sub.truncated) return { nodes: out, truncated: true };
    }
  }
  return { nodes: out, truncated: false };
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
      hint: `术语共 ${kb.termCount} 条；也可用 search_kb 做全文检索`,
    };
  }

  const node = kb.byId.get(rec.id);
  const d = kb.termDetails[rec.id] || {};
  const allOccurrences = [];
  for (const [domain, list] of Object.entries(d.occurrences || {})) {
    const book = kb.allBooks.find((b) => b.domain === domain);
    for (const o of list) {
      if (!kb.byId.has(o.nodeId)) continue;
      allOccurrences.push({
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

  // 出处条数上限 40 是既有口径，保持不变；本批在其上叠加预算守卫——
  // includeEvidence=true 时每条出处夹带原文摘录，实测最坏（「近似商标」）达 8 687 tok，
  // 术语层后续扩容后可能触阈，故按条计费、装不下即停。
  const budget = makeBudget();
  const occurrences = [];
  let budgetHit = false;
  for (const o of allOccurrences.slice(0, 40)) {
    if (!budget.tryAdd(o)) { budgetHit = true; break; }
    occurrences.push(o);
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
    occurrenceCount: allOccurrences.length,
    occurrences,
    truncated: allOccurrences.length > occurrences.length,
    budgetTruncated: budgetHit || undefined,
    hint: budgetHit
      ? budgetHint(`前 ${occurrences.length} 处出处`, '逐处原文请用 read_node 按 nodeId 读取，或去掉 includeEvidence')
      : undefined,
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
  const text = body.own || node.summary || '';

  // 预算守卫：条文正文先入账（它是本工具的主体，不可被引用清单挤掉），
  // 余额再分给 citedBy。实测最坏（专利法第25条，limit=200）7 428 tok 尚在阈内，
  // 但被引数上限 70、条文最长者与之组合仍可能触阈，故按条计费。
  const budget = makeBudget();
  budget.charge(text);
  let citedBy;
  let budgetHit = false;
  if (withCitations !== false) {
    citedBy = [];
    for (const cid of cited.slice(0, max)) {
      const c = nodeBrief(kb, cid);
      const item = { id: cid, title: c.title, book: c.book, path: breadcrumbPath(kb, cid), slug: c.slug };
      if (!budget.tryAdd(item)) { budgetHit = true; break; }
      citedBy.push(item);
    }
  }

  return {
    article: key || node.label,
    id: b.id,
    title: b.title,
    book: b.book,
    path: breadcrumbPath(kb, nodeId),
    slug: b.slug,
    // 效力著录：消除「同一条号在不同版本下是不同规范」的歧义，说明见 effectivityOf
    ...effectivityOf(kb, node.domain),
    text,
    citedByCount: cited.length,
    citedBy,
    truncated: withCitations !== false && cited.length > (citedBy ? citedBy.length : 0),
    budgetTruncated: budgetHit || undefined,
    hint: budgetHit
      ? budgetHint(`前 ${citedBy.length} 处引用章节`, '完整反查请用 find_citing_sections 分页取')
      : undefined,
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

  // 预算守卫：limit=100 的最坏形态实测 13 836 tok（law-02-04，被八类边同时命中），
  // 已越过安全阈值。按边分组顺序逐条计费——分组已按 count 降序排过，先满足信息量大的组。
  const budget = makeBudget();
  let budgetHit = false;
  const ordered = [...groups].sort((a, b) => b[1].length - a[1].length);

  const out = [];
  for (const [type, list] of ordered) {
    if (budgetHit) break;
    const nodes = [];
    for (const nb of list.slice(0, max)) {
      const b = nodeBrief(kb, nb.id);
      const item = {
        id: nb.id,
        title: b.title,
        book: b.book,
        level: b.level,
        direction: nb.dir === 'out' ? '指向' : '被指向',
        path: breadcrumbPath(kb, nb.id),
        slug: b.slug,
      };
      if (!budget.tryAdd(item)) { budgetHit = true; break; }
      nodes.push(item);
    }
    out.push({
      type,
      label: EDGE_LABEL[type] || type,
      count: list.length,
      nodes,
      truncated: list.length > nodes.length,
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
    budgetTruncated: budgetHit || undefined,
    hint: budgetHit
      ? budgetHint('可容纳的前若干条关联', '请调小 limit，或用 types 限定边类型分次取')
      : undefined,
  };
}

// ============ 7. list_books ============

/** 书目条目的精简形态：决策「往哪部书里查」所需的最小字段集 */
const briefBook = (b) => ({
  domain: b.domain,
  short: b.short,
  nodeCount: b.nodeCount,
  chars: b.chars,
  field: b.field,
  docType: b.docType,
  statusCode: b.statusCode,
});

/** 书目条目的完整形态：含全称、分类词表与效力著录五字段 */
const fullBook = (b) => ({
  ...briefBook(b),
  title: b.title,
  // 阶段5 波C 新增：数据包（波C 数据重建前）无此二字段时 b.xxx 为 undefined，
  // 序列化时自动省略——旧调用方读不到陌生字段，即向后兼容分支。
  country: b.country,
  docTypeName: DOC_TYPES[b.docType],
  // 效力字段（阶段5.3 批次 W9 建立四项，阶段5.13b 增 statusCode/statusNote 两项）：
  // build-data.mjs 侧空串照传而非省略，故此处直接透出即可、无需按 country/docType 的
  // 存在性兜底写法；数据包未升级时 b.xxx 为 undefined，序列化时自动省略，仍是兼容分支。
  effectiveDate: b.effectiveDate,
  adoptedDate: b.adoptedDate,
  documentNo: b.documentNo,
  status: b.status,
  statusNote: b.statusNote,
  lawName: b.lawName,
});

/**
 * 内容清单。
 *
 * 阶段5.13b 输出治理：原实现无参、恒返回 76 部书的全字段（实测 10 239 tok，占宿主
 * 25 000 token 配额的 41%——单次调用就吃掉四成上下文，且离触发宿主真实 token 计数
 * 往返的 12 500 门槛只差两千）。现分 brief/full 两档，缺省 brief 只出决策所需字段，
 * 长书名、文号、通过日期等著录信息移到 full 档按需取。
 */
export function listBooks(ctx, { detail, offset, limit } = {}) {
  const { kb } = ctx;
  const wantFull = detail === 'full';
  const closed = kb.allBooks.filter((b) => !kb.allowedDomains.has(b.domain));
  const total = kb.books.length;
  const off = clamp(offset, 0, Math.max(0, total), 0);
  // 分档缺省页长：brief 档单部约 48 tok，76 部合计约 3 700 tok，一次给全，
  // 「列出当前开放的书目」这一承诺由缺省档完整兑现；full 档单部约 146 tok，
  // 76 部要 11 100 tok 已顶到预算，故缺省只给 40 部、其余按 nextOffset 续取。
  const max = clamp(limit, 1, total || 1, wantFull ? 40 : total || 1);

  const shape = wantFull ? fullBook : briefBook;
  const budget = makeBudget();
  const books = [];
  let budgetHit = false;
  for (const b of kb.books.slice(off, off + max)) {
    const item = shape(b);
    if (!budget.tryAdd(item)) { budgetHit = true; break; }
    books.push(item);
  }
  const end = off + books.length;
  const hasMore = end < total;

  return {
    totalNodes: kb.nodes.length,
    termCount: kb.termCount,
    lawArticleCount: kb.lawArticles.size,
    detail: wantFull ? 'full' : 'brief',
    bookCount: total,
    offset: off,
    returned: books.length,
    books,
    hasMore,
    nextOffset: hasMore ? end : null,
    closedBooks: closed.map((b) => ({ domain: b.domain, title: b.title })),
    note: closed.length
      ? `${closed.length} 部书目已由 IPREADER_MCP_DOMAINS 关闭，其内容不参与检索也无法读取`
      : `全部 ${total} 部书目均已开放`,
    // 摘要分组：country→field→docType 三级聚合，供快速概览 76 部书目的分布，不必
    // 自行遍历 books[] 重新分组。groups 恒覆盖全部开放书目、不受上面的分页影响
    //（分页的是明细，不是总览）。数据包未完成波C 重建时三字段皆缺，
    // buildBookGroups 回落空数组，即向后兼容分支。
    groups: buildBookGroups(kb.books),
    budgetTruncated: budgetHit || undefined,
    hint: hasMore
      ? `共 ${total} 部，本页第 ${off + 1}–${end} 部；续取传 offset=${end}。`
        + '按法域/文献类型/效力状态定向取用 filter_books，可一次拿到符合条件的全部书目'
      : (wantFull ? undefined : '当前为精简档。需要书目全称、文号、通过日期与效力说明时传 detail="full"；'
        + '按法域/文献类型/效力状态筛选用 filter_books。'),
  };
}

// ============ 以下六项为阶段5.13b 新增（7 → 13 工具） ============
//
// 六项的共同取向是「一次往返拿到可直接组合的结构化结果」，替代原来「多次调用 + 人工拼装」
// 的路径——这既是 MCP 相对站点静态页的差异价值，也直接减少往返次数，与输出治理同向。
// 全部只消费数据包内既有字段，无一需要扩充 build-data.mjs 的语料侧产出。

// ============ 法条效力著录透出（阶段5.13b 补丁） ============
//
// 起因：本库的商标法是 2026 修订、2027-01-01 起施行的版本，其第30条是「展览会优先权」，
// 而现行 2019 版第30条是驳回条款——同一条号在两个版本下是完全不同的规范。法条类工具
// 原本只回法名与条号，以现行条号查询者拿到新版条文却无从察觉，属实质的法律信息误读风险。
// 故凡返回法条的工具一律透出所属书目的 effectiveDate 与 statusCode。
//
// 提示（warning）只对 not-yet-effective 与 repealed 发出，不对 unknown 发。
// 理由：statusCode=unknown 的 8 部书里含专利法、专利法实施细则、审查指南这三部最高频的——
// 它们的 status 在上游 book-meta.json 中是空串，是「著录未及」而非「效力存疑」。
// 若对 unknown 也发提示，最常用的 find_law('专利法第22条') 每次都要挂一句「状态未知」，
// 警示被稀释到无人再看，真正该警惕的「尚未施行」反被淹没。结构化字段照常透出，
// 调用方需要自行判断时取 statusCode 即可，信息并未隐藏。
const EFFECTIVITY_WARN = new Set(['not-yet-effective', 'repealed']);

/**
 * 取书目的效力著录。
 * @returns {{ effectiveDate: string, statusCode: string, effectivityWarning?: string }}
 */
function effectivityOf(kb, domain) {
  const b = kb.allBooks.find((x) => x.domain === domain);
  if (!b) return { effectiveDate: '', statusCode: 'unknown' };
  const statusCode = b.statusCode || 'unknown';
  const out = { effectiveDate: b.effectiveDate || '', statusCode };
  if (EFFECTIVITY_WARN.has(statusCode)) {
    const name = b.lawName || b.short || b.domain;
    out.effectivityWarning = statusCode === 'not-yet-effective'
      ? `注意：《${name}》${b.effectiveDate ? `自${b.effectiveDate}起施行，` : ''}目前尚未生效。`
        + '其条号与编排可能与现行版本不一致，按现行条号查询时请核对版本。'
      : `注意：《${name}》已废止或失效，仅供沿革查考，不得作为现行依据引用。`;
  }
  return out;
}

/** 法条节点 label 形如「第二十二条 · 发明/实用新型授权条件」，取分隔符后半段为条旨 */
const ARTICLE_TITLE_SEP = ' · ';
function articleTitleOf(label) {
  if (!label) return '';
  const i = label.indexOf(ARTICLE_TITLE_SEP);
  return i >= 0 ? label.slice(i + ARTICLE_TITLE_SEP.length) : label;
}

/**
 * 把「法名或域键」归一为注册表中的法名。
 * 接受全称、简称与域键三种写法，与 find_law 的法名识别共用同一份注册表，
 * 不另立一套口径——两处对「细则」的理解必须一致，否则用户会在两个工具间看到矛盾结果。
 * @returns {{ lawName: string, domain?: string }|null}
 */
function resolveLawName(kb, { lawName, domain }) {
  const reg = lawRegistry(kb);
  if (domain) {
    const nm = reg.lawNameByDomain.get(domain);
    return nm ? { lawName: nm, domain } : null;
  }
  if (!lawName) return null;
  const hit = matchLawAlias(kb, lawName, { includeFindOnly: true });
  if (hit) return { lawName: hit.lawName, domain: hit.domain };
  // 兜底：调用方直接给了注册表未收录但 lawArticles 用得上的法名全称
  for (const key of kb.lawArticles.keys()) {
    if (key.startsWith(`${lawName}第`)) return { lawName };
  }
  return null;
}

/** 某法的全部条号（按数字升序）。lawArticles 的键即「法名第N条」，前缀匹配后取尾号。 */
function articleNumsOf(kb, lawName) {
  const prefix = `${lawName}第`;
  const out = [];
  for (const [key, nodeId] of kb.lawArticles) {
    if (!key.startsWith(prefix) || !key.endsWith('条')) continue;
    const numText = key.slice(prefix.length, -1);
    const num = Number(numText);
    if (!Number.isFinite(num)) continue;
    // 「专利法第22条」的前缀也命中「专利法实施细则第22条」的反向情形已由 endsWith 排除不了，
    // 故再校验一次：截出的段必须是纯数字，含法名残留（如「实施细则第22」）即跳过。
    if (!/^\d+$/.test(numText)) continue;
    out.push({ key, num, nodeId });
  }
  return out.sort((a, b) => a.num - b.num);
}

// ============ 8. list_articles ============
/**
 * 列某部法的条号-条旨全表。
 *
 * 现有路径只能对单条走 find_law，要通览一部法的条文骨架就得逐条问；站点侧亦只能逐页翻。
 * 本工具一次给出「第N条 + 条旨 + 节点 id + 正文字数」的全表，供快速定位与引用核对。
 */
export function listArticles(ctx, { lawName, domain, from, to, limit, offset }) {
  const { kb } = ctx;
  const resolved = resolveLawName(kb, { lawName, domain });
  if (!resolved) {
    const reg = lawRegistry(kb);
    return {
      error: `未找到有条文的规范「${lawName || domain || ''}」`,
      hint: `本库有条文正文的规范共 ${reg.lawNameByDomain.size} 部，域键与法名可用 list_books / filter_books 查询；`
        + '法名写全称或常用简称均可（如「专利法」「细则」「商标法」）',
    };
  }

  const all = articleNumsOf(kb, resolved.lawName);
  if (!all.length) return { error: `《${resolved.lawName}》在本库中无条文正文索引`, hint: '请核对法名' };

  const lo = Number.isFinite(from) ? from : -Infinity;
  const hi = Number.isFinite(to) ? to : Infinity;
  const ranged = all.filter((a) => a.num >= lo && a.num <= hi);
  const off = clamp(offset, 0, Math.max(0, ranged.length), 0);
  const max = clamp(limit, 1, 400, 200);

  const budget = makeBudget();
  const articles = [];
  let budgetHit = false;
  for (const a of ranged.slice(off, off + max)) {
    const n = kb.byId.get(a.nodeId);
    if (!n) continue;
    const item = {
      article: a.key,
      num: a.num,
      title: articleTitleOf(n.label),
      id: a.nodeId,
      chars: (kb.bodies[a.nodeId] || {}).own ? kb.bodies[a.nodeId].own.length : (n.charLen || 0),
    };
    if (!budget.tryAdd(item)) { budgetHit = true; break; }
    articles.push(item);
  }
  const end = off + articles.length;
  const hasMore = end < ranged.length;

  return {
    lawName: resolved.lawName,
    domain: resolved.domain,
    // 整表同属一部法，效力著录出在顶层即可，不逐条重复
    ...effectivityOf(kb, resolved.domain || kb.byId.get(all[0].nodeId).domain),
    total: all.length,
    matched: ranged.length,
    offset: off,
    returned: articles.length,
    articles,
    hasMore,
    nextOffset: hasMore ? end : null,
    budgetTruncated: budgetHit || undefined,
    hint: hasMore
      ? `共 ${ranged.length} 条，已返回第 ${off + 1}–${end} 条；续取传 offset=${end}`
      : undefined,
  };
}

// ============ 9. compare_articles ============
const COMPARE_MAX = 10;

/**
 * 多条法条并列取正文，供逐条对照。
 *
 * 典型场景：同法连续条号的沿革比对（专利法第22、23条）、跨法同主题条文的横向比对
 * （专利法第33条 vs 商标法第30条）。原来要 N 次 find_law，现在一次往返取回。
 * 正文按 charsPerArticle 逐条截断，总量再受预算约束——N 条全文相加极易超限。
 */
export function compareArticles(ctx, { articles, withCitations, charsPerArticle }) {
  const { kb } = ctx;
  const list = Array.isArray(articles) ? articles.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (!list.length) {
    return { error: '未给出待对照的法条', hint: `articles 传字符串数组，如 ["专利法第22条","专利法第23条"]，最多 ${COMPARE_MAX} 条` };
  }
  const perChars = clamp(charsPerArticle, 100, 4000, 1500);
  const budget = makeBudget();

  const items = [];
  const notFound = [];
  let budgetHit = false;
  for (const q of list.slice(0, COMPARE_MAX)) {
    if (budgetHit) break;
    const hit = normalizeLawKey(kb, q);
    // 未命中、多义与「无此条」一律计入 notFound 并说明原因，不静默丢弃——
    // 对照场景下少一条就是结论错一半，调用方必须看得见缺口。
    if (!hit || hit.error || hit.candidates) {
      notFound.push({
        query: q,
        reason: !hit ? '无法解析'
          : hit.error === 'unknown-law' ? `未收录法律「${hit.text}」`
            : hit.error === 'no-such-article' ? `《${hit.lawName}》无第${hit.num}条`
              : `裸条号多义（${hit.candidates.length} 部规范均有第${hit.num}条），请写明法名`,
      });
      continue;
    }
    const nodeId = hit.nodeId || kb.lawArticles.get(hit.key);
    const node = kb.byId.get(nodeId);
    if (!node) { notFound.push({ query: q, reason: '条文节点未开放' }); continue; }
    let key = hit.key;
    if (!key) for (const [k, v] of kb.lawArticles) if (v === nodeId) { key = k; break; }
    const b = nodeBrief(kb, nodeId);
    const raw = (kb.bodies[nodeId] || {}).own || node.summary || '';
    const cited = key ? kb.lawCitedBy.get(key) || [] : [];
    const item = {
      query: q,
      article: key || node.label,
      lawName: key ? key.slice(0, key.lastIndexOf('第')) : undefined,
      id: b.id,
      title: articleTitleOf(b.title),
      book: b.book,
      path: breadcrumbPath(kb, nodeId),
      slug: b.slug,
      // 效力著录逐条给：跨法对照正是版本歧义最易出事的场景——两条并列时，
      // 一条现行、一条尚未施行而调用方不知情，得出的对照结论就是错的
      ...effectivityOf(kb, node.domain),
      text: raw.slice(0, perChars),
      chars: raw.length,
      textTruncated: raw.length > perChars || undefined,
      citedByCount: cited.length,
      citedBy: withCitations
        ? cited.slice(0, 10).map((cid) => {
          const c = nodeBrief(kb, cid);
          return { id: cid, title: c.title, book: c.book };
        })
        : undefined,
    };
    if (!budget.tryAdd(item)) { budgetHit = true; break; }
    items.push(item);
  }

  return {
    requested: list.length,
    returned: items.length,
    charsPerArticle: perChars,
    articles: items,
    // 需警示的条目汇总到顶层，供调用方一眼看到本次对照里有几条不是现行有效的
    effectivityWarnings: items.filter((x) => x.effectivityWarning)
      .map((x) => ({ article: x.article, statusCode: x.statusCode, warning: x.effectivityWarning })),
    notFound,
    overflow: list.length > COMPARE_MAX ? list.length - COMPARE_MAX : undefined,
    budgetTruncated: budgetHit || undefined,
    hint: budgetHit
      ? budgetHint(`前 ${items.length} 条`, '请调小 charsPerArticle，或分批对照')
      : (list.length > COMPARE_MAX ? `单次最多对照 ${COMPARE_MAX} 条，超出部分已忽略` : undefined),
  };
}

// ============ 10. batch_read ============
const BATCH_READ_MAX = 20;

/**
 * 一次读取多个节点的摘要或正文，省 N 次往返。
 *
 * search_kb / browse_toc / find_citing_sections 给出的是节点 id 清单，逐个 read_node
 * 意味着 N 次协议往返；本工具把「拿到清单 → 判断哪些值得精读」这一步压成一次调用。
 * mode='brief' 只出一句话摘要（数据层预解析，覆盖 5929/5963 节点），mode='own' 出正文节选。
 */
export function batchRead(ctx, { ids, mode, charsPerNode }) {
  const { kb } = ctx;
  const list = Array.isArray(ids) ? ids.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (!list.length) {
    return { error: '未给出节点 id', hint: `ids 传字符串数组，如 ["02-04-05","law-02-01"]，最多 ${BATCH_READ_MAX} 个` };
  }
  const wantOwn = mode === 'own';
  const perChars = clamp(charsPerNode, 100, 4000, wantOwn ? 1200 : 400);
  const budget = makeBudget();

  const nodes = [];
  const notFound = [];
  let budgetHit = false;
  for (const id of list.slice(0, BATCH_READ_MAX)) {
    if (budgetHit) break;
    const node = kb.byId.get(id);
    if (!node) { notFound.push(id); continue; }
    const b = nodeBrief(kb, id);
    const detail = kb.docDetails[id] || {};
    const body = kb.bodies[id] || {};
    const raw = wantOwn ? (body.own || node.summary || '') : (detail.brief || node.summary || '');
    const item = {
      id: b.id,
      title: b.title,
      book: b.book,
      level: b.level,
      path: breadcrumbPath(kb, id),
      slug: b.slug,
      chars: (body.own || '').length,
      text: raw.slice(0, perChars),
      textTruncated: raw.length > perChars || undefined,
      // 正文为空的节点（全库 33 个，其标题即全部内容，如质量评价指南的逐条条文）
      // 显式给出说明，避免调用方把「空正文」误判为读取失败
      empty: raw ? undefined : '该节点无独立正文（标题即全部内容，或内容分布在子节点中）',
    };
    if (!budget.tryAdd(item)) { budgetHit = true; break; }
    nodes.push(item);
  }

  return {
    mode: wantOwn ? 'own' : 'brief',
    requested: list.length,
    returned: nodes.length,
    charsPerNode: perChars,
    nodes,
    notFound,
    overflow: list.length > BATCH_READ_MAX ? list.length - BATCH_READ_MAX : undefined,
    budgetTruncated: budgetHit || undefined,
    hint: budgetHit
      ? budgetHint(`前 ${nodes.length} 个节点`, '请调小 charsPerNode 或分批读取')
      : (list.length > BATCH_READ_MAX ? `单次最多读取 ${BATCH_READ_MAX} 个节点，超出部分已忽略` : undefined),
  };
}

// ============ 11. filter_books ============
/**
 * 按国家／法域／文献类型／效力状态筛选书目。
 *
 * 与 list_books 的分工：list_books 回答「库里有什么」（全量清单 + 分布摘要），
 * filter_books 回答「符合条件的有哪些」（条件命中 + 域键清单）。后者同时是输出瘦身的抓手——
 * 「专利法域的全部司法解释」不必先拉 76 部全量再自行过滤。
 */
export function filterBooks(ctx, { country, field, docType, statusCode, hasLawName, query, detail, offset, limit }) {
  const { kb } = ctx;
  const q = typeof query === 'string' ? query.trim() : '';
  const wantFull = detail === 'full';

  const matched = kb.books.filter((b) => {
    if (country && b.country !== country) return false;
    if (field && b.field !== field) return false;
    if (docType && b.docType !== docType) return false;
    if (statusCode && b.statusCode !== statusCode) return false;
    if (hasLawName === true && !b.lawName) return false;
    if (hasLawName === false && b.lawName) return false;
    if (q && !`${b.title || ''}${b.short || ''}${b.domain}${b.lawName || ''}`.includes(q)) return false;
    return true;
  });

  // 命中集可达全部 76 部，full 档单部约 146 tok，故与 list_books 同法分页。
  const off = clamp(offset, 0, Math.max(0, matched.length), 0);
  const max = clamp(limit, 1, 200, 200);
  const budget = makeBudget();
  const books = [];
  let budgetHit = false;
  for (const b of matched.slice(off, off + max)) {
    const item = wantFull ? fullBook(b) : briefBook(b);
    if (!budget.tryAdd(item)) { budgetHit = true; break; }
    books.push(item);
  }
  const end = off + books.length;
  const hasMore = end < matched.length;

  // 命中集自身的分布摘要：便于调用方判断条件是否过宽/过窄，无须再拉一次 list_books。
  // facets 统计的是全部命中项而非本页，故分页不影响它的口径。
  const facets = {
    field: countBy(matched, 'field'),
    docType: countBy(matched, 'docType'),
    statusCode: countBy(matched, 'statusCode'),
    country: countBy(matched, 'country'),
  };

  return {
    criteria: { country, field, docType, statusCode, hasLawName, query: q || undefined },
    total: matched.length,
    offset: off,
    returned: books.length,
    detail: wantFull ? 'full' : 'brief',
    books,
    hasMore,
    nextOffset: hasMore ? end : null,
    facets,
    nodeCount: matched.reduce((a, b) => a + (b.nodeCount || 0), 0),
    budgetTruncated: budgetHit || undefined,
    hint: matched.length
      ? (hasMore
        ? `命中 ${matched.length} 部，本页第 ${off + 1}–${end} 部；续取传 offset=${end}`
          + (budgetHit ? '。本页受输出体量上限约束，改用 detail="brief" 可一次多取几部' : '')
        : undefined)
      : '无书目符合该条件。field 取值为 专利／商标／著作权／竞争法／品种布图／综合程序；'
        + 'docType 取值为 D1–D6；statusCode 取值为 in-force／not-yet-effective／unknown',
  };
}

/** 按字段取值计数，缺字段者计入 '(未标注)' —— 覆盖率不全时不可让调用方误判为零 */
function countBy(books, key) {
  const out = {};
  for (const b of books) {
    const v = b[key] || '(未标注)';
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}

// ============ 12. find_citing_sections ============
/**
 * 反查「引用了某法某条的章节」，支持按条批量与按法全量。
 *
 * 数据依据：条文 → 引用节点的反向索引（kb.lawCitedBy，512 键、合计 2 649 条引用关系），
 * 其来源是 lawref 类边。这里特意不走 xref（交叉引用）边——实测 xref 共 375 条而跨书仅 2 条，
 * 跨书关联实际由 lawref(2 648) 与 colaw(615) 承担，按 xref 设计会得到一个几乎空的结果集。
 *
 * 与 find_law 的分工：find_law 是「取一条的原文，附带看看谁引了它」，本工具是
 * 「以引用关系为主体做批量反查」——按法名一次拿到全法被引情况，是 find_law 没有的能力。
 */
export function findCitingSections(ctx, { lawName, articles, books, limit, offset, citingPerArticle }) {
  const { kb } = ctx;
  const perArticle = clamp(citingPerArticle, 1, 60, 10);
  const max = clamp(limit, 1, 200, 40);

  // —— 一、确定待反查的法条键集合 ——
  let keys = [];
  const notFound = [];
  if (Array.isArray(articles) && articles.length) {
    for (const q of articles) {
      if (typeof q !== 'string' || !q.trim()) continue;
      const hit = normalizeLawKey(kb, q);
      if (!hit || hit.error || hit.candidates) {
        notFound.push({ query: q, reason: !hit ? '无法解析' : hit.candidates ? '裸条号多义，请写明法名' : '未收录或无该条' });
        continue;
      }
      let key = hit.key;
      if (!key && hit.nodeId) for (const [k, v] of kb.lawArticles) if (v === hit.nodeId) { key = k; break; }
      if (key) keys.push(key);
    }
  } else if (lawName) {
    const resolved = resolveLawName(kb, { lawName });
    if (!resolved) {
      return {
        error: `未找到有条文的规范「${lawName || ''}」`,
        hint: '给 lawName（如「专利法」）取该法全部条文的被引情况，或给 articles 数组（如 ["专利法第22条"]）逐条反查',
      };
    }
    keys = articleNumsOf(kb, resolved.lawName).map((a) => a.key);
  }
  if (!keys.length && !notFound.length) {
    return { error: '未给出待反查的法条', hint: '传 lawName（按法全量）或 articles（按条批量），二者至少给一个' };
  }

  // —— 二、只保留确有被引记录的条，并按被引数降序（信息量大的先出） ——
  // 域键不做 schema 级枚举校验（见 server.mjs 入参体量纪律），故在此校一遍并把
  // 无效值显式回报——静默忽略会让调用方以为「该书目下确无引用」，属静默错误。
  const notes = [];
  const requestedBooks = Array.isArray(books) ? books.filter((s) => typeof s === 'string' && s.trim()) : [];
  const validBooks = requestedBooks.filter((d) => kb.allowedDomains.has(d));
  const unknownBooks = requestedBooks.filter((d) => !kb.allowedDomains.has(d));
  if (unknownBooks.length) {
    notes.push(`以下书目域键未开放或不存在，已忽略：${unknownBooks.join('、')}（可用 list_books 查看域键）`);
  }
  if (requestedBooks.length && !validBooks.length) {
    return {
      error: `指定的书目均未开放或不存在：${unknownBooks.join('、')}`,
      hint: '域键可用 list_books 或 filter_books 查询；去掉 books 参数则统计全库',
    };
  }
  const bookFilter = validBooks.length ? new Set(validBooks) : null;
  const withCites = [];
  for (const key of keys) {
    const cited = kb.lawCitedBy.get(key) || [];
    const kept = bookFilter ? cited.filter((cid) => bookFilter.has((kb.byId.get(cid) || {}).domain)) : cited;
    if (kept.length) withCites.push({ key, cited: kept });
  }
  withCites.sort((a, b) => b.cited.length - a.cited.length || a.key.localeCompare(b.key, 'zh'));

  // —— 三、分页 + 预算内装配 ——
  const off = clamp(offset, 0, Math.max(0, withCites.length), 0);
  const budget = makeBudget();
  const items = [];
  let budgetHit = false;
  for (const { key, cited } of withCites.slice(off, off + max)) {
    const nodeId = kb.lawArticles.get(key);
    const artNode = nodeId ? kb.byId.get(nodeId) : null;
    const citing = [];
    const bookSet = new Set();
    for (const cid of cited) {
      const c = nodeBrief(kb, cid);
      if (c) bookSet.add(c.book);
      if (citing.length >= perArticle) continue;
      citing.push({ id: cid, title: c.title, book: c.book, path: breadcrumbPath(kb, cid), slug: c.slug });
    }
    const item = {
      article: key,
      id: nodeId,
      title: artNode ? articleTitleOf(artNode.label) : '',
      citingCount: cited.length,
      bookCount: bookSet.size,
      citing,
      truncated: cited.length > citing.length || undefined,
    };
    if (!budget.tryAdd(item)) { budgetHit = true; break; }
    items.push(item);
  }
  const end = off + items.length;
  const hasMore = end < withCites.length;

  // 效力著录出在顶层而非逐条：本工具的主体是引用关系，条目动辄数十条，
  // 逐条重复同一部法的效力信息纯属浪费。按被查法条所属书目去重后汇总。
  const lawDomains = [...new Set(keys.map((k) => (kb.byId.get(kb.lawArticles.get(k)) || {}).domain).filter(Boolean))];
  const effectivity = lawDomains.map((d) => {
    const bk = kb.allBooks.find((x) => x.domain === d) || {};
    return { domain: d, lawName: bk.lawName || bk.short || d, ...effectivityOf(kb, d) };
  });

  return {
    criteria: { lawName, articles: articles || undefined, books: books || undefined },
    effectivity,
    articleCount: keys.length,
    citedArticleCount: withCites.length,
    totalCitations: withCites.reduce((a, x) => a + x.cited.length, 0),
    offset: off,
    returned: items.length,
    items,
    notFound,
    notes,
    hasMore,
    nextOffset: hasMore ? end : null,
    budgetTruncated: budgetHit || undefined,
    hint: hasMore
      ? `有被引记录的条文共 ${withCites.length} 条（按被引数降序），已返回第 ${off + 1}–${end} 条；`
        + `续取传 offset=${end}`
        + (budgetHit ? `。本次受输出体量上限约束，调小 citingPerArticle（现 ${perArticle}）可一次多取几条` : '')
      : (keys.length && !withCites.length ? '所查条文在本库中无被引用记录' : undefined),
  };
}

// ============ 13. get_brief ============
const BRIEF_IDS_MAX = 100;

/**
 * 取节点的一句话摘要，供「先判断再决定是否精读」。
 *
 * 数据依据：docDetails.brief，覆盖 5 929/5 963 个文档节点（99.4%），缺失者回落 summary。
 * 与 batch_read(mode='brief') 的分工：本工具不出正文、不出路径与 slug，单条成本约为其三分之一，
 * 因此可一次覆盖上百个节点——适合对 browse_toc 或 search_kb 的整页结果做一遍「值不值得读」的筛查。
 */
export function getBrief(ctx, { ids, root, depth, limit }) {
  const { kb } = ctx;
  const max = clamp(limit, 1, BRIEF_IDS_MAX, BRIEF_IDS_MAX);

  // —— 目标节点集合：显式 ids 优先，否则按 root + depth 收集后代 ——
  let targets = [];
  let source;
  if (Array.isArray(ids) && ids.length) {
    targets = ids.filter((s) => typeof s === 'string' && s.trim());
    source = 'ids';
  } else if (root) {
    const d = clamp(depth, 1, 8, 2);
    const book = kb.books.find((b) => b.domain === root);
    const seeds = book ? (kb.rootsByDomain.get(book.domain) || []) : (kb.byId.has(root) ? kb.childrenOf.get(root) || [] : null);
    if (seeds === null) return { error: `未知的书目域或节点：${root}（书目域可用 list_books 查询）` };
    targets = collectDescendants(kb, seeds, d);
    source = 'root';
  } else {
    return { error: '未给出目标节点', hint: 'ids 传节点 id 数组，或 root 传书目域键／节点 id（可配 depth）' };
  }

  const budget = makeBudget();
  const items = [];
  const notFound = [];
  let budgetHit = false;
  for (const id of targets.slice(0, max)) {
    if (budgetHit) break;
    const node = kb.byId.get(id);
    if (!node) { notFound.push(id); continue; }
    const detail = kb.docDetails[id] || {};
    const item = {
      id,
      title: node.label,
      level: node.level,
      chars: node.charLen || 0,
      brief: detail.brief || node.summary || '',
    };
    if (!budget.tryAdd(item)) { budgetHit = true; break; }
    items.push(item);
  }

  return {
    source,
    root: source === 'root' ? root : undefined,
    total: targets.length,
    returned: items.length,
    items,
    notFound,
    truncated: targets.length > items.length || undefined,
    budgetTruncated: budgetHit || undefined,
    hint: targets.length > items.length
      ? `匹配 ${targets.length} 个节点，已返回前 ${items.length} 个；缩小 root 范围或调小 depth 可取全`
      : undefined,
  };
}

/** 广度优先收集 depth 层内的后代 id（含本层），供 get_brief 的 root 形态用 */
function collectDescendants(kb, seeds, depth) {
  const out = [];
  let layer = seeds;
  for (let d = 0; d < depth && layer.length; d++) {
    out.push(...layer);
    layer = layer.flatMap((id) => kb.childrenOf.get(id) || []);
  }
  return out;
}

export { EDGE_LABEL };
