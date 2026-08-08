// 数据管线 D1：种子词表归集
//   解析 7 部规范 _index.md 中「关键词速查」markdown 表（| 关键词 | 涉及条款/章节 |），
//   把关键词拆分变体、剥离括号注记，按域解析"涉及条款"列并锚定到 data/nodes.json 节点，
//   与 lib/topics.mjs 的 34 主题归并，同名合并后产出：
//     - data/terms-seed.json          种子词条（tmpKey/canonical/aliases/matchers/topicKey/sources/lawKeys/tier）
//     - audit/terms/seed-unresolved.csv  未解析引用清单（UTF-8 BOM，Excel 可直接打开）
//   结尾断言：合并后词数 300~500、未解析率 <10%，不满足则 exit 1。
//   运行：node scripts/build-seed-lexicon.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cn2num } from './lib/cn-num.mjs';
import { KNOWN_DOMAINS, projectRoot } from './lib/domains.mjs';
import { TOPICS } from './lib/topics.mjs';
import { STOPWORDS } from './lib/term-stopwords.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(__dirname);
const DATA_DIR = join(__dirname, '..', 'data');
const AUDIT_DIR = join(__dirname, '..', 'audit', 'terms');
mkdirSync(AUDIT_DIR, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
// 归一化：NFKC（全半角统一）+ 去空白 + 小写，用于同名合并/停用词/主题匹配
const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const STOP_NORM = new Set([...STOPWORDS].map(norm));

// ---- 共享正则 ----
const CN_NUM = '[一二三四五六七八九十百零〇两]+';
// 括号注记（全角/半角，不嵌套）
const PAREN_RE = /（([^（）]*)）|\(([^()]*)\)/g;
// 关键词单元格内嵌的法条注记，如"法 22.2""专利法 25 条""实施细则 51.3-57.3""细则 6/36 条"
const LAWREF_RE = /(?:专利法实施细则|专利法|实施细则|细则|法)\s*\d+(?:\.\d+)?(?:\s*[/／、\-－—–~～]\s*\d+(?:\.\d+)?)*\s*条?/g;
// 纯数量注记，如"18 个月""4000/1500""5%""300 字"（整段仅为数量时丢弃）
const QUANTITY_RE = /^[\d\s/／%％.．]+(?:个?[月日年天字幅项种条款次分])?$/;

// ============ 节点索引 ============
const nodes = JSON.parse(readFileSync(join(DATA_DIR, 'nodes.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(DATA_DIR, 'node-bodies.json'), 'utf8'));
const nodeById = new Map(nodes.map((n) => [n.id, n]));
const nodesByDomain = new Map();
for (const n of nodes) {
  if (!nodesByDomain.has(n.domain)) nodesByDomain.set(n.domain, []);
  nodesByDomain.get(n.domain).push(n);
}
// lawKey（如"专利法第22条"）→ 节点
const lawKeyIndex = new Map();
for (const n of nodes) if (n.lawKey) lawKeyIndex.set(n.lawKey, n);
// 撰写规范域：num（如"3.1"）→ 节点
function buildNumIndex(domainKey) {
  const idx = new Map();
  for (const n of nodesByDomain.get(domainKey) || []) {
    if (n.num && /^\d+(\.\d+)*$/.test(n.num)) idx.set(n.num, n);
  }
  return idx;
}
const numIndexByDomain = new Map(
  ['chemistry-drafting-rules', 'mechanical-drafting-rules'].map((k) => [k, buildNumIndex(k)]),
);
// 侵权判定域：正文条号（"35、…"起始行）→ 所在节点 id。
//   该域节点仅到"（一）"级、无逐条节点，故先按 num/label 找"第N条"（当前数据无，留作前向兼容），
//   再退到扫描各节点 ownText 的行首条号。
function buildInfrArticleIndex() {
  const idx = new Map();
  for (const n of nodesByDomain.get('infringement-guide') || []) {
    const lm = (n.num || n.label || '').match(/^第(\d+)条/);
    if (lm) idx.set(parseInt(lm[1], 10), n.id);
  }
  if (idx.size) return idx;
  for (const n of nodesByDomain.get('infringement-guide') || []) {
    const own = bodies[n.id]?.ownText || '';
    for (const m of own.matchAll(/^(\d{1,3})、/gm)) idx.set(parseInt(m[1], 10), n.id);
  }
  return idx;
}
const infrArticleIndex = buildInfrArticleIndex();

// ============ 关键词单元格处理 ============
// 拆分变体：按 、／/ 拆分；引号内片段与数字间斜杠（19/34）受保护不拆
function splitVariants(text) {
  const masks = [];
  let masked = text.replace(/“[^”]{0,40}”|"[^"]{0,40}"/g, (m) => {
    masks.push(m);
    return `\u0000${masks.length - 1}\u0000`;
  });
  masked = masked.replace(/(\d)\s*[/／]\s*(\d)/g, '$1\u0001$2');
  return masked
    .split(/[、／/]/)
    .map((p) =>
      p
        .replace(/\u0001/g, '/')
        .replace(/\u0000(\d+)\u0000/g, (_, i) => masks[+i])
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

const dropStats = { stopword: 0, tooShort: 0, quantity: 0, lawNote: 0, emptyRow: 0 };

// 变体过滤：停用词/过短（归一后 <2 字符）丢弃并计数；按归一去重
function filterVariants(list) {
  const kept = [];
  const seen = new Set();
  for (const v of list) {
    const k = norm(v);
    if (!k) continue;
    if (k.length < 2) {
      dropStats.tooShort++;
      continue;
    }
    if (STOP_NORM.has(k)) {
      dropStats.stopword++;
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(v);
  }
  return kept;
}

// 关键词单元格 → { variants, aliasCand }：
//   1) 剥离括号注记（内容进入别名候选）；2) 剔除内嵌法条注记；3) 拆分变体
function processKeywordCell(raw) {
  const parenNotes = [];
  let main = raw.replace(PAREN_RE, (_, a, b) => {
    parenNotes.push(a ?? b ?? '');
    return ' ';
  });
  main = main.replace(LAWREF_RE, ' ');
  const variants = filterVariants(splitVariants(main));

  const aliasCand = [];
  for (const note of parenNotes) {
    for (const c of splitVariants(note.replace(LAWREF_RE, ' '))) {
      if (QUANTITY_RE.test(c)) {
        dropStats.quantity++;
        continue;
      }
      // 残留的法条式注记（如"23.2 条"）按注记丢弃，不作别名
      if (/^\d+(\.\d+)?\s*条/.test(c)) {
        dropStats.lawNote++;
        continue;
      }
      aliasCand.push(c);
    }
  }
  return { variants, aliasCand: filterVariants(aliasCand) };
}

// ============ 「涉及条款」列分域解析器 ============
//   每个解析器返回 { ids, unresolved:[{raw,reason}], refCount, fallback }
//   refCount = 成功解析出的引用个数；unresolved 单独计数，未解析率 = unresolved/(refCount+unresolved)

// —— patent-law / implementation-rules：中文条号（含"第X条—第Y条"范围展开）——
function resolveLawCell(cell, lawName) {
  const ids = [];
  const unresolved = [];
  const arts = [];
  let text = cell.replace(PAREN_RE, ' ');
  const rangeRe = new RegExp(`第(${CN_NUM})条\\s*[—–―\\-~～]\\s*第(${CN_NUM})条`, 'g');
  text = text.replace(rangeRe, (m, a, b) => {
    const s = cn2num(a);
    const e = cn2num(b);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s && e - s <= 60) {
      for (let n = s; n <= e; n++) arts.push({ n, raw: m });
    } else {
      unresolved.push({ raw: m, reason: '条款范围无法解析' });
    }
    return ' ';
  });
  for (const m of text.matchAll(new RegExp(`第(${CN_NUM})条`, 'g'))) {
    const n = cn2num(m[1]);
    if (Number.isFinite(n)) arts.push({ n, raw: m[0] });
    else unresolved.push({ raw: m[0], reason: '中文数字无法转换' });
  }
  if (!arts.length && !unresolved.length) unresolved.push({ raw: cell, reason: '未识别出条款引用' });
  for (const { n, raw } of arts) {
    const node = lawKeyIndex.get(`${lawName}第${n}条`);
    if (node) ids.push(node.id);
    else unresolved.push({ raw, reason: `未找到节点 ${lawName}第${n}条` });
  }
  return { ids, unresolved, refCount: arts.length, fallback: 0 };
}

// —— examination-guideline-2025：部/章/节（数字周围可有空格；后续段继承部/章上下文）——
//   节号折叠为 pp-cc-ss-uu（节点 num 最深两段）；子节不存在时退级到节/章/部。
function resolveGuidelineCell(cell) {
  const ids = [];
  const unresolved = [];
  let refCount = 0;
  let fallback = 0;
  const ctx = { part: null, chapter: null };
  for (const seg of cell.replace(PAREN_RE, ' ').split('、').map((s) => s.trim()).filter(Boolean)) {
    const pm = seg.match(new RegExp(`第(${CN_NUM})部分`));
    const cm = seg.match(new RegExp(`第(${CN_NUM})章`));
    const sm = seg.match(/第\s*(\d[\d.\s]*?)\s*节/);
    if (!pm && !cm && !sm) {
      unresolved.push({ raw: seg, reason: '无法识别部/章/节结构' });
      continue;
    }
    if (pm) {
      ctx.part = cn2num(pm[1]);
      ctx.chapter = null;
    }
    if (cm) ctx.chapter = cn2num(cm[1]);
    if (ctx.part == null || !Number.isFinite(ctx.part)) {
      unresolved.push({ raw: seg, reason: '缺少"第X部分"上下文' });
      continue;
    }
    refCount++;
    // 候选 id 由细到粗；命中非首选即计一次退级
    const cands = [];
    const pp = pad(ctx.part);
    const secSegs = sm ? sm[1].replace(/\s+/g, '').split('.').filter(Boolean).map((x) => parseInt(x, 10)) : [];
    if (ctx.chapter != null) {
      const cc = pad(ctx.chapter);
      if (secSegs.length >= 2) cands.push(`${pp}-${cc}-${pad(secSegs[0])}-${pad(secSegs[1])}`);
      if (secSegs.length >= 1) cands.push(`${pp}-${cc}-${pad(secSegs[0])}`);
      cands.push(`${pp}-${cc}`);
    }
    cands.push(pp);
    const hit = cands.findIndex((id) => nodeById.has(id));
    if (hit < 0) {
      refCount--;
      unresolved.push({ raw: seg, reason: '部/章节点均不存在' });
    } else {
      ids.push(cands[hit]);
      if (hit > 0) fallback++;
    }
  }
  return { ids, unresolved, refCount, fallback };
}

// —— infringement-guide：阿拉伯条号（"条 35""条 26、41""条 44—50"）——
function resolveInfrCell(cell) {
  const ids = [];
  const unresolved = [];
  const arts = [];
  let text = cell.replace(PAREN_RE, ' ');
  text = text.replace(/(\d+)\s*[—–―\-~～]\s*(\d+)/g, (m, a, b) => {
    const s = +a;
    const e = +b;
    if (e >= s && e - s <= 60) for (let n = s; n <= e; n++) arts.push({ n, raw: m });
    else unresolved.push({ raw: m, reason: '条号范围无法解析' });
    return ' ';
  });
  for (const m of text.matchAll(/\d+/g)) arts.push({ n: +m[0], raw: `条 ${m[0]}` });
  if (!arts.length && !unresolved.length) unresolved.push({ raw: cell, reason: '未识别出条号' });
  for (const { n, raw } of arts) {
    const id = infrArticleIndex.get(n);
    if (id) ids.push(id);
    else unresolved.push({ raw, reason: `正文未找到第${n}条` });
  }
  return { ids, unresolved, refCount: arts.length, fallback: 0 };
}

// —— chemistry / mechanical：节号（"3.1.4、5.1"）按 num 匹配，逐级退级；
//    "第二章 权利要求书"式引用按章内标题匹配 ——
function resolveNumericCell(cell, domainKey) {
  const ids = [];
  const unresolved = [];
  let refCount = 0;
  let fallback = 0;
  const domainNodes = nodesByDomain.get(domainKey) || [];
  const numIndex = numIndexByDomain.get(domainKey);
  for (const seg of cell.replace(PAREN_RE, ' ').split('、').map((s) => s.trim()).filter(Boolean)) {
    const chap = seg.match(new RegExp(`^第(${CN_NUM})章\\s*(.*)$`));
    if (chap) {
      const chapNode = domainNodes.find((n) => n.num === `第${chap[1]}章`);
      if (!chapNode) {
        unresolved.push({ raw: seg, reason: '章节点不存在' });
        continue;
      }
      refCount++;
      const target = norm(chap[2]);
      if (target) {
        // 章内按标题包含匹配，取最深（id 最长）节点；无匹配则退级到章
        const inChap = domainNodes
          .filter((n) => n.id.startsWith(`${chapNode.id}-`) && norm(n.label).includes(target))
          .sort((a, b) => b.id.length - a.id.length);
        if (inChap.length) {
          ids.push(inChap[0].id);
        } else {
          ids.push(chapNode.id);
          fallback++;
        }
      } else {
        ids.push(chapNode.id);
      }
      continue;
    }
    const nm = seg.match(/\d+(?:\.\d+)*/);
    if (!nm) {
      unresolved.push({ raw: seg, reason: '未识别出节号' });
      continue;
    }
    let numStr = nm[0];
    let node = numIndex.get(numStr);
    let degraded = false;
    while (!node && numStr.includes('.')) {
      numStr = numStr.slice(0, numStr.lastIndexOf('.'));
      node = numIndex.get(numStr);
      degraded = true;
    }
    if (node) {
      refCount++;
      ids.push(node.id);
      if (degraded) fallback++;
    } else {
      unresolved.push({ raw: seg, reason: '节号无匹配节点' });
    }
  }
  return { ids, unresolved, refCount, fallback };
}

// —— oa-response-guide："第一节"→章；"1.2""2.7(8)""7.1 注意(5)"→ 节.项；括号注记剥离 ——
function resolveOaCell(cell) {
  const ids = [];
  const unresolved = [];
  let refCount = 0;
  let fallback = 0;
  const oaNodes = nodesByDomain.get('oa-response-guide') || [];
  for (const seg of cell.replace(PAREN_RE, ' ').split('、').map((s) => s.trim()).filter(Boolean)) {
    const sn = seg.match(new RegExp(`第(${CN_NUM})节`));
    if (sn) {
      const node = oaNodes.find((n) => n.num === `第${sn[1]}节`);
      if (node) {
        refCount++;
        ids.push(node.id);
      } else {
        unresolved.push({ raw: seg, reason: '节标题节点不存在' });
      }
      continue;
    }
    const m = seg.match(/(\d+)\.(\d+)/) || seg.match(/^(\d+)$/);
    if (!m) {
      unresolved.push({ raw: seg, reason: '无法识别节.项编号' });
      continue;
    }
    const cands = m[2] ? [`oa-${pad(+m[1])}-${pad(+m[2])}`, `oa-${pad(+m[1])}`] : [`oa-${pad(+m[1])}`];
    const hit = cands.findIndex((id) => nodeById.has(id));
    if (hit < 0) {
      unresolved.push({ raw: seg, reason: '节/项节点均不存在' });
    } else {
      refCount++;
      ids.push(cands[hit]);
      if (hit > 0) fallback++;
    }
  }
  return { ids, unresolved, refCount, fallback };
}

const RESOLVERS = {
  'patent-law': (cell) => resolveLawCell(cell, '专利法'),
  'implementation-rules': (cell) => resolveLawCell(cell, '专利法实施细则'),
  'examination-guideline-2025': resolveGuidelineCell,
  'infringement-guide': resolveInfrCell,
  'chemistry-drafting-rules': (cell) => resolveNumericCell(cell, 'chemistry-drafting-rules'),
  'mechanical-drafting-rules': (cell) => resolveNumericCell(cell, 'mechanical-drafting-rules'),
  'oa-response-guide': resolveOaCell,
};

// ============ _index.md「关键词速查」表提取 ============
function extractKeywordRows(indexPath) {
  const lines = readFileSync(indexPath, 'utf8').split('\n');
  const hi = lines.findIndex((l) => /^#{1,6}\s+.*关键词速查/.test(l));
  if (hi < 0) return [];
  const rows = [];
  let inTable = false;
  for (let i = hi + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) break; // 到下一节为止
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    if (/^\|[\s|:\-]+\|?$/.test(line)) continue; // 分隔行
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 2 || cells[0] === '关键词') continue; // 表头行
    rows.push({ keyword: cells[0], ref: cells[1] });
  }
  return rows;
}

// ============ 主流程：逐域解析 → 同名合并 ============
// 任务书给出的参考行数（含表头计数口径差异，落差 >10% 打警告）
const EXPECTED_ROWS = {
  'patent-law': 38,
  'implementation-rules': 89,
  'examination-guideline-2025': 187,
  'infringement-guide': 29,
  'chemistry-drafting-rules': 42,
  'mechanical-drafting-rules': 56,
  'oa-response-guide': 40,
};

const termMap = new Map(); // norm(canonical) → 词条累加器
const termOrder = []; // 保持首次出现顺序
const unresolvedRows = []; // CSV 明细：{domain, keyword, rawRef, reason}
const domainStats = {};

for (const dom of KNOWN_DOMAINS) {
  const rows = extractKeywordRows(join(ROOT, dom.key, '_index.md'));
  const st = { rows: rows.length, variants: 0, refOk: 0, refBad: 0, fallback: 0 };
  domainStats[dom.key] = st;
  const expected = EXPECTED_ROWS[dom.key];
  if (expected && Math.abs(rows.length - expected) > expected * 0.1) {
    console.warn(`⚠ ${dom.key} 解析行数 ${rows.length} 与参考值 ${expected} 落差超 10%，请检查表格式`);
  }

  for (const row of rows) {
    const { variants, aliasCand } = processKeywordCell(row.keyword);
    if (!variants.length) {
      dropStats.emptyRow++;
      continue; // 整行被停用词/过短过滤掉，不再解析其引用
    }
    st.variants += variants.length;

    const { ids, unresolved, refCount, fallback } = RESOLVERS[dom.key](row.ref);
    st.refOk += refCount;
    st.refBad += unresolved.length;
    st.fallback += fallback;
    for (const u of unresolved) {
      unresolvedRows.push({ domain: dom.key, keyword: row.keyword, rawRef: u.raw, reason: u.reason });
    }

    // 同名合并：canonical 归一后相同即并入同一词条（并查集思路的 Map 实现）
    const canonical = variants[0];
    const key = norm(canonical);
    let t = termMap.get(key);
    if (!t) {
      t = { canonical, aliases: new Map(), matchers: new Map(), sources: {}, lawKeys: new Set() };
      termMap.set(key, t);
      termOrder.push(t);
    }
    for (const v of [...variants.slice(1), ...aliasCand]) {
      const vk = norm(v);
      if (vk !== key && !t.aliases.has(vk)) t.aliases.set(vk, v);
    }
    if (ids.length) {
      const set = (t.sources[dom.key] ||= new Set());
      for (const id of ids) set.add(id);
    }
  }
}

// ---- 别名跨词条清理：别名若与其他词条的 canonical 同名，说明其已独立成词，移除避免混淆 ----
for (const t of termOrder) {
  for (const vk of [...t.aliases.keys()]) {
    if (termMap.has(vk)) t.aliases.delete(vk);
  }
}

// ---- 主题归并：canonical/aliases 与主题 name 同名 → 记 topicKey，并把该主题 kw 中
//      非同义的命中线索词放入 matchers（不进 aliases）；仅命中 kw 的只记 topicKey ----
for (const t of termOrder) {
  const selfKeys = new Set([norm(t.canonical), ...t.aliases.keys()]);
  for (const topic of TOPICS) {
    if (selfKeys.has(norm(topic.name))) {
      t.topicKey = topic.key;
      for (const k of topic.kw) {
        const kk = norm(k);
        if (!selfKeys.has(kk) && !t.matchers.has(kk)) t.matchers.set(kk, k);
      }
      break;
    }
  }
  if (!t.topicKey) {
    outer: for (const topic of TOPICS) {
      for (const k of topic.kw) {
        if (selfKeys.has(norm(k))) {
          t.topicKey = topic.key;
          break outer;
        }
      }
    }
  }
}

// ---- lawKeys：从 patent-law / implementation-rules 两域命中的条文节点归纳 ----
for (const t of termOrder) {
  for (const domKey of ['patent-law', 'implementation-rules']) {
    for (const id of t.sources[domKey] || []) {
      const lk = nodeById.get(id)?.lawKey;
      if (lk) t.lawKeys.add(lk);
    }
  }
}

// ============ 输出 ============
const terms = termOrder.map((t, i) => {
  const out = {
    tmpKey: `seed-${String(i + 1).padStart(3, '0')}`,
    canonical: t.canonical,
    aliases: [...t.aliases.values()],
    matchers: [...t.matchers.values()],
  };
  if (t.topicKey) out.topicKey = t.topicKey;
  out.sources = Object.fromEntries(
    Object.entries(t.sources).map(([d, set]) => [d, [...set].sort()]),
  );
  out.lawKeys = [...t.lawKeys].sort();
  out.tier = 'seed';
  return out;
});
writeFileSync(join(DATA_DIR, 'terms-seed.json'), JSON.stringify(terms, null, 2));

// 未解析清单 CSV（UTF-8 BOM，Excel 可直接打开）
const csvEsc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv =
  '\uFEFF' +
  ['domain,keyword,rawRef,reason', ...unresolvedRows.map((r) => [r.domain, r.keyword, r.rawRef, r.reason].map(csvEsc).join(','))].join('\n') +
  '\n';
writeFileSync(join(AUDIT_DIR, 'seed-unresolved.csv'), csv);

// ============ 统计与断言 ============
console.log('—— 各域解析统计 ——');
let totalRefOk = 0;
let totalRefBad = 0;
for (const [d, st] of Object.entries(domainStats)) {
  totalRefOk += st.refOk;
  totalRefBad += st.refBad;
  const rate = st.refOk + st.refBad ? ((st.refBad / (st.refOk + st.refBad)) * 100).toFixed(1) : '0.0';
  console.log(
    `${d}: 表行 ${st.rows} | 关键词变体 ${st.variants} | 引用解析 ${st.refOk} / 未解析 ${st.refBad}（${rate}%）| 退级 ${st.fallback}`,
  );
}
const badRate = totalRefOk + totalRefBad ? totalRefBad / (totalRefOk + totalRefBad) : 0;
console.log(
  `—— 汇总 ——\n合并后词数: ${terms.length}\n引用合计: 解析 ${totalRefOk} / 未解析 ${totalRefBad}（${(badRate * 100).toFixed(2)}%）`,
);
console.log(
  `丢弃计数: 停用词 ${dropStats.stopword} | 过短 ${dropStats.tooShort} | 数量注记 ${dropStats.quantity} | 法条注记 ${dropStats.lawNote} | 整行丢弃 ${dropStats.emptyRow}`,
);
console.log(`产物: data/terms-seed.json（${terms.length} 词）、audit/terms/seed-unresolved.csv（${unresolvedRows.length} 行）`);

let ok = true;
if (terms.length < 300 || terms.length > 500) {
  ok = false;
  console.error(`✗ 断言失败：合并后词数 ${terms.length} 不在 300~500 区间`);
}
if (badRate >= 0.1) {
  ok = false;
  console.error(`✗ 断言失败：未解析率 ${(badRate * 100).toFixed(2)}% ≥ 10%，明细如下：`);
  for (const r of unresolvedRows) console.error(`  [${r.domain}] ${r.keyword} | ${r.rawRef} | ${r.reason}`);
}
console.log(ok ? '✓ 断言全部通过' : '✗ 断言未通过');
if (!ok) process.exit(1);
