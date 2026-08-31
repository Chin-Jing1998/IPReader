// search.mjs —— 全文检索：中文分词器 + FlexSearch 索引 + 术语表召回增强
//
// 分词器与索引配置自 quartz-kb/quartz/components/scripts/search.inline.ts:25-90 原样移植
// （该 encoder 为无 DOM 依赖的纯函数），使 MCP 的检索口径与应用内搜索完全一致。
//
// 分词策略：CJK 逐字切分（unigram）+ 非 CJK 按空白切词，配 tokenize:"forward" 前缀匹配。
// 该策略召回充分但精度有限——「专利」会命中含「专」或「利」的页面。为此叠加两层增强：
// 其一，术语表精确匹配——查询命中 1743 条术语之一时，把该术语的出处节点提权到结果前列；
// 其二，法条直达路由——查询形如「专利法第26条」时，条号经归一后直接查 lawArticles，
// 不再让 bigram 去猜（详见 parseArticleQuery）。
import FlexSearch from 'flexsearch';
import { normalizeTermKey } from './data.mjs';
import { cn2num } from '../../site/scripts/lib/cn-num.mjs';

// 标点与符号视作切分点。中文排版中的「（Animal Cell Lysis Solution）」，其全角左括号
// 既非 CJK 也非空白，原会被并入其后的英文缓冲区，切出「（animal」这样的 token——而索引
// 配置为 tokenize:'forward'（前缀匹配），「animal」不是「（animal」的前缀，该词遂永远
// 检索不到；FlexSearch 又取 AND 交集语义，一词落空即整条多词查询落空。
// 保留 - . _ ' 四个字符：它们在词内有构词意义（one-way、No.1、snake_case、don't），
// 剔除会把既有词形切碎。
const PUNCT = /[\p{P}\p{S}]/u;
const KEEP_IN_WORD = new Set(['-', '.', '_', "'"]);

// 与 search.inline.ts:25-75 逐字一致
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
    // 标点与空白同等对待：二者都只作切分，自身不进入 token
    const isBreak = isWhitespace || (!KEEP_IN_WORD.has(char) && PUNCT.test(char));

    if (isCJK) {
      if (bufferStart !== -1) {
        tokens.push(lower.slice(bufferStart, bufferEnd));
        bufferStart = -1;
      }
      tokens.push(char);
    } else if (isBreak) {
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

// 打分权重：原串精确匹配 ≫ bigram 覆盖 ≫ 术语信号。
// 术语出处只作提权，不得盖过正文的精确命中——出处回答的是「该词在哪出现过」，
// 未必是查询最相关的正文。
//
// ⚠️ exactBody 若日后引入按正文长度的阻尼，阈值下限不得低于 3000 字。
// smoke.mjs 的哨兵断言要求「等同侵权」首条恒为 infr-02-03，该节点正文 2559 字，
// 而其竞争者 dg22-03-04 仅 143 字；任何按长度惩罚的方案都对哨兵单向不利。
// 当前二者分差仅 100 分（2050 vs 1950），阈值取到 2559 以下即断裂。
const W = {
  exactTitle: 1000,
  exactBody: 500,
  covTitle: 300,
  covBody: 150,
  termPage: 400,
  termSource: 100,
  // FlexSearch 只作候选发生器，不参与计分。原先的 30／10 分会把「有没有落进
  // pool 的截断窗口」变成名次差：全库 102 个节点在 content 字段命中「强制许可」，
  // pool=80 截掉 22 个，被截者恒少 10 分，语料每次扩容就换一批，
  // 制造与相关性无关的排名抖动（批次四 3 处「纯重排」即由此而来）。
  // 归零无信息损失——「AND 全 token 命中」的信息已被 covTitle／covBody 的
  // bigram 覆盖率以更细粒度覆盖。
  fsTitle: 0,
  fsBody: 0,
  // 目录倾倒页的正文信号折算系数，见 bodyFactor
  tocFactor: 0.1,
  // —— 法条直达（见 parseArticleQuery）——
  // 2400 的取法：法条型查询下非条文节点的理论分数上限为
  //   exactTitle 1000 + covTitle 300 + exactBody 500 + covBody 150 + termSource 100 + lawCited 250 = 2300
  //（termPage 400 需整条查询等于某术语名，法条引用串不可能是术语名，故不计入）。
  // 取 2400 使条文原文由构造保证位列第一，不随语料增长而失效。
  lawArticle: 2400,
  // 无法名前缀的「第26条」：法域推定存在歧义（库内只收专利法与细则，用户可能想问商标法），
  // 故只保证进入前列而不强制置顶。
  lawArticleWeak: 1200,
  // 引用该条的节点作第二梯队：需高于 covBody 满分 150（稳定压过纯长文覆盖），
  // 低于 exactTitle 1000（不得盖过标题精确命中的审查指南专节）。
  lawCited: 250,
  // 标题条号与查询条号冲突时的惩罚系数。取惩罚而非过滤：标题带其他条号的节点仍可能相关。
  artClashFactor: 0.25,
};

// 目录倾倒页判别：正文由「标题 …… 页码」构成的节点，对本书内任何查询都能给出
// exactBody，属虚假强断言。以页码行条数判别——历史上全库 4008 个有正文节点中仅
// patent-adjudication-manual-2019 的「公布与施行」节点（padm-01，4696 字）命中（327 行，
// 整本目录被并入该节点），次高者 4 行，判别面无歧义，故取阈值 20：距最近的假阳性 5 倍余量，
// 距真阳性 16 倍余量。
// 现状复核（阶段5.3 批次 W9）：padm-01 已随「公布与施行」前置内容一并被阶段5.3 批次 W1 摘除，
// 唯一命中者从数据中消失——复核当前全库有正文节点，TOC_LINE_MIN=20 命中数为 0（现存最高者
// 仍是 4 行，与摘除前的「次高者」持平）。判别器逻辑原样保留、不作精简：一旦未来入库语料再现
// 同类「整本目录被并入单节点」的情形，仍需靠它拦截虚假强断言，当前零命中是防御生效而非冗余。
const TOC_LINE = /…+\s*\d+/g;
const TOC_LINE_MIN = 20;

/**
 * 正文信号的可信度系数，作用于 exactBody 与 covBody。
 * 容器节点（无 own）不降权——其正文槽虽回落 summary，但命中容器多为「找章入口」的
 * 合法诉求，降权在 50 条基线上净损；无正文的可读性缺口改由 tools 层附实体子节点补偿。
 */
function bodyFactor(kb, n) {
  if (n.level === 'term') return 1;
  const own = (kb.bodies[n.id] || {}).own || '';
  if (!own) return 1;
  return (own.match(TOC_LINE) || []).length >= TOC_LINE_MIN ? W.tocFactor : 1;
}

// ============ 法条直达 ============
//
// bigram 精排对条号是失效的：查询「专利法第26条」切出的二元组是
// [专利, 利法, 法第, 第2, 26, 6条]，而语料写作「专利法第二十六条」，后三组全部错配，
// 查询实际退化为「专利法第」三组通用二元组——任何提及任一专利法条文的节点都得分，
// 且 covTitle 是 covBody 的两倍，于是标题里带「专利法第X条」的要旨案例通吃：
// 实测「专利法第2条」的原第一名是标题含「专利法第二十三条」的 dg23-02-26，
// 而真正的条文节点 law-01-02 连候选集都进不去。
//
// 解法不是改分词（那会破坏与 search.inline.ts 的 encoder 契约），而是在查询期识别
// 条号形态，直接消费 data.mjs 已建好的 lawArticles（2496 条）与 lawCitedBy（132 键）。
const ART_NUM = '([0-9]+|[一二三四五六七八九十百零]+)';
// 查询侧只认「第N条」写法。「法22」「22」「细则57」这类简写不在此路由，仍交 find_law
// （tools.mjs 的 normalizeLawKey，尾锚写法见 splitArticleTail）承接，
// 以免把纯数字查询劫持为法条查询。
const QUERY_ART_RE = new RegExp('第\\s*' + ART_NUM + '\\s*条');
// find_law 入参的尾锚写法：「专利法第22条」「专利法第二十二条」「细则22」「22」
const TAIL_ART_RE = /第?([一二三四五六七八九十百零]+|\d+)条?\s*$/;
const TITLE_ART_RE = new RegExp('第\\s*' + ART_NUM + '\\s*条', 'g');

// ============ 法名注册表（阶段 3） ============
//
// 阶段 3 前，法名是写死在本文件里的两条正则（专利法／专利法实施细则）白名单：
// 商标法、著作权法等一律不路由，find_law 侧更严重——`normalizeLawKey` 只锚定查询结尾
// 的条号、完全不看法名，「商标法第8条」静默返回专利法第8条。
//
// 阶段 3 改为注册表驱动：有条文规范的法名由数据包 kb.books 的 {domain, short, lawName}
// 在运行时派生（build-data.mjs 已装配该三元组，数据包 schema 零变更），
// 按归一后长度降序排列以解子串包含（「专利法」⊂「专利法实施细则」、「商标法」⊂「商标法实施条例」…）。
//
// 条目数随开放书目动态变化，阶段5.13b 实测为 129 条：65 全称（有 lawName 的域数）
// + 61 简称（该 65 部中 4 部的 short 与 lawName 同名，不另登记）+ 3 遗留简写
//（LEGACY_ALIASES 共 4 项，其中「实施细则」已被 implementation-rules 的 short 抢先登记）。
// 本行原写「69 全称 + 65 简称 = 134，共 137 条」，系阶段5.11 波O 下线 12 部书（其中 5 部
// 有 lawName，69 → 65 域）之前的数值，已随该批次失效——此处按实测改正，与 README 的 129 口径一致。
//
// 设计定稿把注册表挂在 data.mjs 的 kb 上；本批白名单不含 data.mjs（红线外但未授权改动），
// 故改为在本模块内以 kb 为键的 WeakMap 惰性派生，语义与挂载位置无关，
// tools.mjs 经 import 共用同一份注册表，不存在两套法名口径。
const REGISTRY_CACHE = new WeakMap();

// 专利法系遗留简写：既有 smoke.mjs:153「细则22」断言与基线第 37 题依赖，且本工具为
// IPReader，「细则」缺省指专利法实施细则符合用户直觉（集成电路布图设计保护条例
// 实施细则须以「布图细则」指称，其别名更长、按最长优先先命中）。
// exact 者要求法名文本与别名完全相等而非后缀命中——「则」「法」是泛化单字，
// 若允许后缀命中，「原则第5条」会被判成实施细则第5条。
// findOnly 者只对 find_law 生效：「法22」是 find_law 的历史写法，而 search_kb 侧
// 「本法第22条」原本就不路由，把「法」放进检索侧别名池会把它变成 2400 分强制置顶。
const LEGACY_ALIASES = [
  { alias: '实施细则', domain: 'implementation-rules', lawName: '专利法实施细则' },
  { alias: '细则', domain: 'implementation-rules', lawName: '专利法实施细则' },
  { alias: '则', domain: 'implementation-rules', lawName: '专利法实施细则', exact: true },
  { alias: '法', domain: 'patent-law', lawName: '专利法', exact: true, findOnly: true },
];

/**
 * 法名注册表。惰性派生并按 kb 缓存——同一进程内 kb 恒为同一对象，故每进程只建一次。
 * @returns {{ entries: Array<{alias,domain,lawName,kind,exact?,findOnly?}>,
 *             byAlias: Map<string, object>, lawNameByDomain: Map<string, string> }}
 *   entries 已按归一后长度降序（同长按字典序），最长优先匹配由该序保证。
 */
export function lawRegistry(kb) {
  const cached = REGISTRY_CACHE.get(kb);
  if (cached) return cached;

  const byAlias = new Map();
  const lawNameByDomain = new Map();
  // norm 为别名的归一形态（剥书名号、括号与分隔符），与查询侧同一把尺子：
  // 司法解释全称自带括号序号（「…若干问题的解释（二）」），只有两侧同等归一，
  // 用户写全称、写「侵权解释（二）」、写「侵权解释二」才会落到同一条目。
  const push = (e) => {
    if (!e.alias || byAlias.has(e.alias)) return;
    byAlias.set(e.alias, { ...e, norm: normLawText(e.alias) });
  };

  for (const b of kb.books) {
    // 用 books 而非 allBooks：被域白名单关闭的书不参与路由
    if (!b.lawName) continue;
    lawNameByDomain.set(b.domain, b.lawName);
    push({ alias: b.lawName, domain: b.domain, lawName: b.lawName, kind: 'full' });
    // lawAlias 为 domains.mjs 侧的显式别名（如 copyright-civil-interp 的「著作权解释」），
    // 由 build-data.mjs 的书目装配透传进数据包；缺省时回落 short。
    const short = b.lawAlias || b.short;
    if (short && short !== b.lawName) push({ alias: short, domain: b.domain, lawName: b.lawName, kind: 'short' });
  }
  for (const e of LEGACY_ALIASES) {
    if (!kb.allowedDomains.has(e.domain)) continue; // 该域被关闭时不登记，免得指向取不到的条文
    push({ ...e, kind: 'legacy' });
  }

  // 按归一后长度降序——最长优先匹配即由该序保证（比对用的是 norm，故排序也用 norm）
  const entries = [...byAlias.values()].sort(
    (x, y) => y.norm.length - x.norm.length || (x.alias < y.alias ? -1 : x.alias > y.alias ? 1 : 0),
  );
  const reg = { entries, byAlias, lawNameByDomain };
  REGISTRY_CACHE.set(kb, reg);
  return reg;
}

// 法名文本的修饰字符：书名号、引号、括号（只去括号本身、保留括内序号）、空白与分隔标点。
// 勘误二的 7 类漏判同源于「书名号《》、括号序号、阿拉伯序号均不在 [一-龥] 字符类内」，
// 故在比对别名前先把它们剥掉，而不是让正则去跨越它们。
const LAW_DECOR_RE = /[《》〈〉「」『』【】""'']|[()（）[\]]|[\s,，、;；:：·・—-]/g;
// 拉丁字母一并计入「法名样文本」：条号左侧残留字母多为节点 id 笔误（rule-99-99），
// 与「有法名但不认识」同属「左侧还有东西、不该替用户猜法域」的情形。
const LAW_NAME_LIKE_RE = /[一-龥a-zA-Z]/;

/** 法名文本归一：《商标法》→ 商标法；侵权解释（二）→ 侵权解释二；商标法 2026 → 商标法2026 */
function normLawText(s) {
  return String(s || '').replace(LAW_DECOR_RE, '');
}

/**
 * 条号左侧文本是否命中注册表别名（最长优先）。
 *
 * 以「后缀命中」而非「全等」为判据，故「《中华人民共和国商标法》第8条」「关于商标法第8条」
 * 都能落到「商标法」；exact 项（则／法）例外，要求全等。
 * 另试一次剥掉尾部年份／版本号的形态，使「商标法2026第8条」「商标法（2026）第8条」成立。
 *
 * @param {object} kb 运行时知识库
 * @param {string} leftRaw 条号左侧的原始文本
 * @param {{includeFindOnly?: boolean}} [opts] includeFindOnly 为真时纳入 find_law 专属遗留别名
 */
export function matchLawAlias(kb, leftRaw, opts = {}) {
  const base = normLawText(leftRaw);
  if (!base) return null;
  const forms = [base];
  const noVer = base.replace(/[0-9]{2,4}$/, '');
  if (noVer && noVer !== base) forms.push(noVer);

  for (const e of lawRegistry(kb).entries) {
    if (e.findOnly && !opts.includeFindOnly) continue;
    for (const f of forms) {
      if (e.exact ? f === e.norm : f.endsWith(e.norm)) return e;
    }
  }
  return null;
}

/**
 * 条号左侧是否存在「法名样文本」——剥掉书名号、括号与空白后仍有中文或拉丁字母即算。
 * 这是勘误一（find_law 静默回落专利法）与勘误二（检索侧七类漏判）的共同根治点：
 * 有法名而未命中注册表时，一律不回落专利法。
 */
export function lawNameLike(leftRaw) {
  return LAW_NAME_LIKE_RE.test(normLawText(leftRaw));
}

/**
 * 尾锚式拆分「（法名）第N条」，供 find_law 入参归一。
 * @returns {{left: string, num: number}|null} left 为条号左侧文本（可能为空串）
 */
export function splitArticleTail(s) {
  const str = String(s || '');
  const m = str.match(TAIL_ART_RE);
  if (!m) return null;
  const num = cn2num(m[1]);
  if (!Number.isFinite(num)) return null;
  return { left: str.slice(0, m.index), num };
}

// 裸条号候选的排序：专利法 → 专利法实施细则 → 其余按 kb.books 既有顺序（sort 稳定）
const CAND_HEAD = ['patent-law', 'implementation-rules'];
const candRank = (d) => { const i = CAND_HEAD.indexOf(d); return i === -1 ? CAND_HEAD.length : i; };

/**
 * 某条号在全部有条文规范中的候选清单（专利法系置首）。
 * 实测「第1条」69 部、「第8条」68 部、「第26条」45 部、中位 5 部——
 * 同条号跨法冲突是常态，故裸条号不得静默单选。
 */
export function articleCandidates(kb, num) {
  const out = [];
  for (const b of kb.books) {
    if (!b.lawName) continue;
    const key = `${b.lawName}第${num}条`;
    if (kb.lawArticles.has(key)) out.push({ key, lawName: b.lawName, domain: b.domain, short: b.short });
  }
  return out.sort((a, b) => candRank(a.domain) - candRank(b.domain));
}

/**
 * 识别「（法名）第N条」形态的查询并归一为 lawArticles 的键。
 *
 * 三级语义（与 tools.mjs 的 normalizeLawKey 同源）：
 *   1. 条号左侧命中注册表别名 → 直达该法域的键，explicit=true（2400 分强制置顶）；
 *   2. 左侧有法名样文本但不认识 → 返回 null，不路由（绝不回落专利法）；
 *   3. 左侧为空的真裸条号 → 沿用专利法优先的既有口径，explicit=false（1200 分弱路由），
 *      法域推定的歧义由 tools 层在 notes 中提示。
 *
 * @returns {{key:string,num:number,domain:string,lawName:string,explicit:boolean,missing:boolean}|null}
 *   explicit 标记查询是否写明了法名；missing 标记该条号在该法中无对应条文节点
 *   （此时不置顶、不提权，但条号冲突惩罚照常施加）
 */
export function parseArticleQuery(kb, query) {
  const q = String(query || '').trim();
  const m = q.match(QUERY_ART_RE);
  if (!m) return null;
  const num = cn2num(m[1]);
  if (!Number.isFinite(num)) return null;

  const left = q.slice(0, m.index);
  const named = matchLawAlias(kb, left);
  if (named) {
    const key = `${named.lawName}第${num}条`;
    return { key, num, domain: named.domain, lawName: named.lawName, explicit: true, missing: !kb.lawArticles.has(key) };
  }
  if (lawNameLike(left)) return null;

  const key = `专利法第${num}条`;
  return { key, num, domain: 'patent-law', lawName: '专利法', explicit: false, missing: !kb.lawArticles.has(key) };
}

/** 标题中出现的条号集合，用于冲突判定 */
function titleArticleNums(title) {
  const out = new Set();
  TITLE_ART_RE.lastIndex = 0;
  let m;
  while ((m = TITLE_ART_RE.exec(title))) {
    const v = cn2num(m[1]);
    if (Number.isFinite(v)) out.add(v);
  }
  return out;
}

/**
 * 目标条文的中文写法，如「专利法第二十六条」，供 exact 判定用作第三个候选串——
 * 使阿拉伯数字的查询也能命中以中文数字书写的语料。
 * 中文条号直接取自条文节点的 label：条文节点的 label 均以「第X条」开头，
 * 中文条号经 cn2num 反推与键中的阿拉伯数字一致，故无需另写 num2cn。
 * 法名取解析结果的 lawName（阶段 3 起可为 69 部规范中的任一部），不再是专利法系二选一。
 */
function chineseArticleForm(kb, art) {
  const node = kb.byId.get(kb.lawArticles.get(art.key));
  const m = node && (node.label || '').match(/^第[一二三四五六七八九十百零]+条/);
  return m ? `${art.lawName}${m[0]}`.toLowerCase() : null;
}

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
  // 多词查询另留一份保留空白的原串：正文里的「inventive step」带空格，仅以去空白的
  // qFull 判定会使 exactTitle/exactBody 恒 false，白丢 1000 分与 500 分两笔决定性加权。
  // 分支条件取「查询串是否含空白」——不含空白时 qRaw 恒为 null，精确匹配判定与修复前
  // 逐位一致，故纯中文查询与英文单词查询的既有结果不可能发生变化。
  const qRaw = /\s/.test(query || '') ? String(query).trim().toLowerCase() : null;
  const grams = bigrams(query);
  // 法条直达：识别「（专利法系法名）第N条」，非该形态时 art 恒为 null，
  // 此后全部新增逻辑均不生效，故不含「第…条」的查询行为与本改动前逐位一致。
  const art = parseArticleQuery(kb, query);
  const qCn = art && !art.missing ? chineseArticleForm(kb, art) : null;
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

  // 二、FlexSearch 召回（保底）。候选取 limit 数倍以留出过滤与重排余量；
  // 加权为 0（见 W 注释），此处只把节点纳入候选池，名次全交给第三段的精排。
  const pool = Math.max(limit * 8, 80);
  const raw = index.search(query, { limit: pool });
  const byField = new Map(raw.map((r) => [r.field, r.result]));
  for (const id of byField.get('title') || []) bump(id, W.fsTitle, 'fs-title');
  for (const id of byField.get('content') || []) bump(id, W.fsBody, 'fs-body');

  // 二·五、法条直达：条文原文置顶，引用该条的节点作第二梯队。
  // 二者都经 bump，故仍受 books 域过滤约束——限定书目时不会凭空冒出域外条文。
  if (art && !art.missing) {
    bump(kb.lawArticles.get(art.key), art.explicit ? W.lawArticle : W.lawArticleWeak, 'law-article');
    for (const id of kb.lawCitedBy.get(art.key) || []) bump(id, W.lawCited, 'law-cited');
  }

  // 三、精排：原串与 bigram 覆盖重算分数，并据此设最低相关性门槛
  const ranked = [];
  for (const [id, info] of cand) {
    const n = kb.byId.get(id);
    const { title, body } = textsOf(kb, n);
    const lowTitle = title.toLowerCase();
    const lowBody = body.toLowerCase();

    let score = info.score;
    // 正文信号可信度：目录倾倒页折算至 10%，其余节点不变
    const bf = bodyFactor(kb, n);
    // qCn 是法条查询的中文条号写法（仅法条型查询非空），作为第三个候选串参与精确判定
    const exactTitle = (qFull && lowTitle.includes(qFull)) || (qRaw && lowTitle.includes(qRaw))
      || (qCn && lowTitle.includes(qCn));
    const exactBody = (qFull && lowBody.includes(qFull)) || (qRaw && lowBody.includes(qRaw))
      || (qCn && lowBody.includes(qCn));
    if (exactTitle) score += W.exactTitle;
    if (exactBody) score += W.exactBody * bf;

    const covT = coverage(lowTitle, grams);
    const covB = coverage(lowBody, grams);
    // 门槛判定用折算前的 covB（见下），故降权不会新增零结果
    score += covT * W.covTitle + covB * W.covBody * bf;

    // 门槛：既无 bigram 覆盖、也无术语信号的候选一律剔除。
    // 它们只是若干单字碰巧散落在长正文里，对提问者没有意义。
    // 条文原文豁免——「专利法第26条」的条文节点标题为「第二十六条 · …」，
    // 对查询串的 bigram 覆盖可以是 0，但它恰恰是唯一的正确答案。
    const hasTermSignal = info.via.includes('term') || info.via.includes('term-source');
    const isLawArticle = info.via.includes('law-article');
    if (grams.length && covT === 0 && covB === 0 && !hasTermSignal && !isLawArticle) continue;

    // 条号冲突惩罚：法条型查询下，标题带其他条号的节点几乎必然答非所问
    // （「专利法第2条」的原第一名 dg23-02-26 标题条号是二十三）。
    // 条文原文与「已证引用目标条」的节点豁免——后者标题条号不同但内容确实相关，
    // 如「根据专利法第三十三条的审查」确实引用了实施细则第57条。
    //
    // 阶段 3 起判定分两维：
    //   numClash 标题条号 ≠ 查询条号（原判据，跨法域下会误伤——查「商标法第8条」时
    //     专利法第八条节点的标题条号恰为 8、并不冲突，却与查询分属不同法）；
    //   lawClash 命中节点属另一部「有自身条文」的规范，且查询写明了法名。
    // lawClash 以 art.explicit 为前提，故裸条号查询行为与阶段 3 前逐位一致；
    // 且只惩罚同为条文源的他域，审查指南、办案指南等无 lawName 的实务解读类文档不受影响——
    // 它们正是用户查条文时想一并看到的第二梯队。
    if (art && !isLawArticle && !info.via.includes('law-cited')) {
      const tn = titleArticleNums(title);
      const numClash = tn.size > 0 && !tn.has(art.num);
      const lawClash = art.explicit && n.domain !== art.domain
        && lawRegistry(kb).lawNameByDomain.has(n.domain);
      if (numClash || lawClash) score *= W.artClashFactor;
    }

    ranked.push({
      id,
      score,
      via: isLawArticle ? 'law' : exactTitle ? 'title' : exactBody ? 'body' : info.via[0] || 'fuzzy',
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return ranked.slice(0, limit);
}
