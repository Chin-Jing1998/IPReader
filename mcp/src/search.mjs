// search.mjs —— 全文检索：中文分词器 + FlexSearch 索引 + 术语表召回增强
//
// 分词器与索引配置自 quartz-kb/quartz/components/scripts/search.inline.ts:25-90 原样移植
// （该 encoder 为无 DOM 依赖的纯函数），使 MCP 的检索口径与应用内搜索完全一致。
//
// 分词策略：CJK 逐字切分（unigram）+ 非 CJK 按空白切词，配 tokenize:"forward" 前缀匹配。
// 该策略召回充分但精度有限——「专利」会命中含「专」或「利」的页面。为此叠加一层
// 术语表精确匹配：查询命中 851 条术语之一时，把该术语的出处节点提权到结果前列。
import FlexSearch from 'flexsearch';
import { normalizeTermKey } from './data.mjs';

// 与 search.inline.ts:25-68 逐字一致
const encoder = (str) => {
  const tokens = [];
  let bufferStart = -1;
  let bufferEnd = -1;
  const lower = str.toLowerCase();

  let i = 0;
  for (const char of lower) {
    const code = char.codePointAt(0);

    const isCJK =
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x20000 && code <= 0x2a6df);

    const isWhitespace = code === 32 || code === 9 || code === 10 || code === 13;

    if (isCJK) {
      if (bufferStart !== -1) {
        tokens.push(lower.slice(bufferStart, bufferEnd));
        bufferStart = -1;
      }
      tokens.push(char);
    } else if (isWhitespace) {
      if (bufferStart !== -1) {
        tokens.push(lower.slice(bufferStart, bufferEnd));
        bufferStart = -1;
      }
    } else {
      if (bufferStart === -1) bufferStart = i;
      bufferEnd = i + char.length;
    }

    i += char.length;
  }

  if (bufferStart !== -1) {
    tokens.push(lower.slice(bufferStart));
  }

  return tokens;
};

/**
 * 为知识库建立检索索引。文档节点索引正文，术语节点索引释义与别名。
 * @param {object} kb loadKb() 的产物
 */
export function buildIndex(kb) {
  const index = new FlexSearch.Document({
    encode: encoder,
    document: {
      id: 'id',
      index: [
        { field: 'title', tokenize: 'forward' },
        { field: 'content', tokenize: 'forward' },
      ],
    },
  });

  for (const n of kb.nodes) {
    let content;
    if (n.level === 'term') {
      const d = kb.termDetails[n.id] || {};
      // 术语的可检索文本 = 释义 + 别名 + 各出处的原文摘录
      const evidence = Object.values(d.occurrences || {})
        .flat()
        .map((o) => o.evidence || '')
        .filter(Boolean)
        .join(' ');
      content = [d.definition || '', (n.aliases || []).join(' '), evidence].filter(Boolean).join(' ');
    } else {
      const b = kb.bodies[n.id] || {};
      // 优先本节净文本；容器节点无 own 时用 summary 兜底（full 含整棵子树，
      // 拿它索引会让每个祖先都命中子节点内容，把结果挤满同一条链路）
      content = b.own || n.summary || '';
    }
    index.add({ id: n.id, title: n.label || '', content });
  }

  return index;
}

/**
 * 查询串里出现的术语。
 * 每条附一个 0..1 的置信度：术语名占查询的比重越大越可信，别名再打对折——
 * 「外观设计相同或近似」既命中正名「外观设计相同」(6/9)，也命中别名「外观设计」(4/9×0.5)，
 * 前者理应排得更高。
 */
function matchTerms(kb, query) {
  const hits = [];
  const q = normalizeTermKey(query);
  if (!q) return hits;
  for (const [name, rec] of kb.termByName) {
    if (name.length < 2 || !q.includes(name)) continue;
    const ratio = Math.min(1, name.length / q.length);
    hits.push({ id: rec.id, name, confidence: ratio * (rec.canonical ? 1 : 0.5) });
  }
  return hits.sort((a, b) => b.confidence - a.confidence);
}

/**
 * 查询串的 bigram 集合——中文检索精度的关键。
 *
 * encoder 把 CJK 逐字切开，FlexSearch 又对多 token 取 OR 语义，于是「等同原则」
 * 会召回一切含「等」「同」「原」「则」任一字的页面（实测该词在全库零命中，
 * 却能返回 5 条完全无关的结果）。以相邻二字组作最低相关性门槛可滤掉这类分散命中，
 * 同时保留「等同原则 → 等同侵权」这种部分匹配的有效召回。
 */
function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
  return [...new Set(out)];
}

/** 文本对 bigram 集合的覆盖率 0..1 */
function coverage(text, grams) {
  if (!grams.length) return 0;
  const t = String(text || '').toLowerCase();
  let hit = 0;
  for (const g of grams) if (t.includes(g)) hit++;
  return hit / grams.length;
}

/**
 * 提取命中上下文：在正文中定位查询词，截取其前后各半窗的字符。
 * 中文不以空白分词，故按字符窗口而非词窗口截取。
 * @returns {{ text: string, matched: boolean }}
 */
export function excerpt(text, query, chars) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) return { text: '', matched: false };
  if (body.length <= chars) return { text: body, matched: true };

  // 依次尝试整串、去空白串、各 bigram，取首个命中位置。
  // 不回落到单字——单字会把窗口定位到无关处（「等同原则」定位到某个孤立的「则」字）
  const grams = bigrams(query);
  const candidates = [query, query.replace(/\s+/g, ''), ...grams, ...(grams.length ? [] : encoder(query))]
    .filter((t) => t && t.length >= 1);
  let at = -1;
  let hitLen = 0;
  const lower = body.toLowerCase();
  for (const c of candidates) {
    const p = lower.indexOf(c.toLowerCase());
    if (p !== -1) {
      at = p;
      hitLen = c.length;
      break;
    }
  }
  if (at === -1) return { text: body.slice(0, chars) + '…', matched: false };

  const half = Math.max(0, Math.floor((chars - hitLen) / 2));
  const start = Math.max(0, at - half);
  const end = Math.min(body.length, start + chars);
  return {
    text: (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : ''),
    matched: true,
  };
}

// 打分权重：原串精确匹配 ≫ bigram 覆盖 ≫ 术语信号 ≫ FlexSearch 保底召回。
// 术语出处只作提权，不得盖过正文的精确命中——出处回答的是「该词在哪出现过」，
// 未必是查询最相关的正文。
const W = {
  exactTitle: 1000,
  exactBody: 500,
  covTitle: 300,
  covBody: 150,
  termPage: 400,
  termSource: 100,
  fsTitle: 30,
  fsBody: 10,
};

/** 节点的可检索标题与正文（与 buildIndex 的取材保持一致） */
function textsOf(kb, n) {
  if (n.level === 'term') {
    const d = kb.termDetails[n.id] || {};
    return { title: n.label || '', body: d.definition || '' };
  }
  const b = kb.bodies[n.id] || {};
  return { title: n.label || '', body: b.own || n.summary || '' };
}

/**
 * 检索。
 * @param {object} kb 运行时知识库
 * @param {object} index buildIndex 的产物
 * @param {{ query: string, books?: string[], limit?: number, includeTerms?: boolean }} opts
 * @returns {Array<{ id: string, score: number, via: string }>} 按相关度降序，已去重
 */
export function search(kb, index, opts) {
  const { query, books, limit = 8, includeTerms = true } = opts;
  const wanted = books && books.length ? new Set(books) : null;
  const keep = (id) => {
    const n = kb.byId.get(id);
    if (!n) return false;
    if (n.level === 'term') return includeTerms;
    return !wanted || wanted.has(n.domain);
  };

  const qFull = String(query || '').toLowerCase().replace(/\s+/g, '');
  const grams = bigrams(query);
  const cand = new Map(); // id → { score, via[] }
  const bump = (id, points, via) => {
    if (!keep(id)) return;
    const cur = cand.get(id) || { score: 0, via: [] };
    cur.score += points;
    if (via && !cur.via.includes(via)) cur.via.push(via);
    cand.set(id, cur);
  };

  // 一、术语表匹配：术语页本身与其出处节点按置信度提权
  const termHits = includeTerms || wanted ? matchTerms(kb, query) : [];
  for (const t of termHits) {
    bump(t.id, W.termPage * t.confidence, 'term');
    const d = kb.termDetails[t.id] || {};
    for (const list of Object.values(d.occurrences || {})) {
      for (const o of list) bump(o.nodeId, W.termSource * t.confidence, 'term-source');
    }
  }

  // 二、FlexSearch 召回（保底），候选取 limit 数倍以留出过滤与重排余量
  const pool = Math.max(limit * 8, 80);
  const raw = index.search(query, { limit: pool });
  const byField = new Map(raw.map((r) => [r.field, r.result]));
  for (const id of byField.get('title') || []) bump(id, W.fsTitle, 'fs-title');
  for (const id of byField.get('content') || []) bump(id, W.fsBody, 'fs-body');

  // 三、精排：原串与 bigram 覆盖重算分数，并据此设最低相关性门槛
  const ranked = [];
  for (const [id, info] of cand) {
    const n = kb.byId.get(id);
    const { title, body } = textsOf(kb, n);
    const lowTitle = title.toLowerCase();
    const lowBody = body.toLowerCase();

    let score = info.score;
    const exactTitle = qFull && lowTitle.includes(qFull);
    const exactBody = qFull && lowBody.includes(qFull);
    if (exactTitle) score += W.exactTitle;
    if (exactBody) score += W.exactBody;

    const covT = coverage(lowTitle, grams);
    const covB = coverage(lowBody, grams);
    score += covT * W.covTitle + covB * W.covBody;

    // 门槛：既无 bigram 覆盖、也无术语信号的候选一律剔除。
    // 它们只是若干单字碰巧散落在长正文里，对提问者没有意义。
    const hasTermSignal = info.via.includes('term') || info.via.includes('term-source');
    if (grams.length && covT === 0 && covB === 0 && !hasTermSignal) continue;

    ranked.push({
      id,
      score,
      via: exactTitle ? 'title' : exactBody ? 'body' : info.via[0] || 'fuzzy',
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return ranked.slice(0, limit);
}
