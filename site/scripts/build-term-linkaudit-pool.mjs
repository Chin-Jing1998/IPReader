// 行内链接化精审池构建（P1，一次性审计工具）。
// 作用：在真实语料上模拟行内链接化（口径与生产完全一致：import lib/term-link.mjs），
// 按确定性规则 A-E 选出疑似问题词池，产出批审输入材料与 Tier-2 报告素材。
// 只读：data/nodes.json、data/terms-merged.json、public/content/term-*.json、../quartz-kb/content/**
// 产出：data/term-linkaudit-batches/batch-NN.json + pool-overview.json
// 用法：node scripts/build-term-linkaudit-pool.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTermMatcher, collectHits, wikilinkSpans } from './lib/term-link.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(SITE, 'data');
const CONTENT = join(SITE, '..', 'quartz-kb', 'content');
const OUT_DIR = join(DATA, 'term-linkaudit-batches');
const BATCH_COUNT = 11;
const SAMPLE_LIMIT = 10;
const CTX_RADIUS = 35;
const CJK_RE = /[一-鿿]/;
const KNOWN_RESIDUE_IDS = ['term-0326', 'term-0230', 'term-0412', 'term-0386']; // 规则 A
const DOMAIN_NAME = {
  'patent-law': '专利法',
  'implementation-rules': '实施细则',
  'examination-guideline-2025': '审查指南',
  'infringement-judgment-guide': '侵权判定',
  'oa-response-guide': '答复指引',
  'chemistry-drafting-rules': '化学撰写',
  'mechanical-drafting-rules': '机械撰写',
};

// ---------- 数据载入 ----------
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const nodes = readJson(join(DATA, 'nodes.json'));
const merged = readJson(join(DATA, 'terms-merged.json'));
const termNodes = nodes.filter((n) => n.kind === 'term');
const mergedByCanonical = new Map(merged.map((t) => [t.canonical, t]));
if (termNodes.length !== merged.length) {
  throw new Error(`term 节点数 ${termNodes.length} 与 terms-merged ${merged.length} 不一致`);
}

function definitionOf(id) {
  const p = join(SITE, 'public', 'content', `${id}.json`);
  if (!existsSync(p)) return '';
  return (readJson(p).definition || '').trim();
}

// surface 词面表：canonical 全量 + high/mid 别名（seed 别名按方案整体排除）
function buildSurfaceEntries() {
  const entries = [];
  for (const n of termNodes) {
    const rec = mergedByCanonical.get(n.label);
    if (!rec) throw new Error(`nodes 术语 ${n.id}(${n.label}) 在 terms-merged 无记录`);
    entries.push({ surface: n.label, id: n.id, type: 'canonical', tier: rec.tier });
    if (rec.tier === 'seed') continue;
    for (const alias of n.aliases || []) {
      entries.push({ surface: alias, id: n.id, type: 'alias', tier: rec.tier });
    }
  }
  return entries;
}

// ---------- 语料遍历 ----------
function walkMd(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkMd(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

// 生成器文案页（首页/图谱/书根/术语索引目录）不参与行内链接化，与生产接入一致
function isGeneratorPage(rel) {
  if (rel === 'index.md' || rel === '0-图谱总览/index.md') return true;
  if (/^[^/]+\/index\.md$/.test(rel)) return true; // 各书根 + 9-关键词索引 总目录
  if (/^9-关键词索引\/[^/]+\/index\.md$/.test(rel)) return true; // 32 个主题 index
  return false;
}

// 正文区：frontmatter 之后、首个 "## " 之前，剔除面包屑行
function extractBodyRegion(md) {
  let s = md;
  if (s.startsWith('---\n')) {
    const end = s.indexOf('\n---\n', 4);
    if (end !== -1) s = s.slice(end + 5);
  }
  const h2 = s.search(/^## /m);
  const body = h2 === -1 ? s : s.slice(0, h2);
  return body
    .split('\n')
    .filter((line) => !line.startsWith('上级：'))
    .join('\n');
}

function loadCorpus() {
  const pages = [];
  for (const p of walkMd(CONTENT)) {
    const rel = relative(CONTENT, p);
    if (isGeneratorPage(rel)) continue;
    const base = rel.split('/').pop();
    const selfId = /^term-\d{4}\.md$/.test(base) ? base.replace(/\.md$/, '') : null;
    const body = extractBodyRegion(readFileSync(p, 'utf8'));
    if (body.trim()) pages.push({ rel, selfId, body });
  }
  return pages;
}

// ---------- 首链模拟（生产口径：collectHits + 页级去重 + 自链排除） ----------
function ctxOf(body, index, len) {
  const left = body.slice(Math.max(0, index - CTX_RADIUS), index).replace(/\n/g, ' ');
  const mid = body.slice(index, index + len);
  const right = body.slice(index + len, index + len + CTX_RADIUS).replace(/\n/g, ' ');
  return `…${left}【${mid}】${right}…`;
}

function simulateFirstLinks(pages, matcher) {
  const perId = new Map(); // id → [{page, surface, ctx}]
  for (const { rel, selfId, body } of pages) {
    for (const h of collectHits(body, matcher, new Set(), selfId)) {
      const list = perId.get(h.id) || [];
      list.push({ page: rel, surface: h.surface, ctx: ctxOf(body, h.index, h.surface.length) });
      perId.set(h.id, list);
    }
  }
  return perId;
}

// ---------- 朴素命中统计（禁区外全部出现，含重叠/自身，供嵌入率与邻字画像） ----------
function collectRawStats(pages, matcher) {
  const perSurface = new Map(); // surface → {total, embedded, left: Map, right: Map}
  const bump = (map, ch) => map.set(ch, (map.get(ch) || 0) + 1);
  for (const { body } of pages) {
    const spans = wikilinkSpans(body);
    let spanIdx = 0;
    for (let i = 0; i < body.length; i++) {
      while (spanIdx < spans.length && spans[spanIdx][1] <= i) spanIdx++;
      if (spanIdx < spans.length && i >= spans[spanIdx][0]) {
        i = spans[spanIdx][1] - 1;
        continue;
      }
      const bucket = matcher.byFirst.get(body[i]);
      if (!bucket) continue;
      for (const { surface } of bucket) {
        if (!body.startsWith(surface, i)) continue;
        const st = perSurface.get(surface) || { total: 0, embedded: 0, left: new Map(), right: new Map() };
        const l = body[i - 1] || '';
        const r = body[i + surface.length] || '';
        st.total++;
        if (CJK_RE.test(l) || CJK_RE.test(r)) st.embedded++;
        bump(st.left, l || '⟂');
        bump(st.right, r || '⟂');
        perSurface.set(surface, st);
      }
    }
  }
  return perSurface;
}

const topN = (map, n) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([ch, c]) => `${ch}(${c})`);

// ---------- 池筛选（规则 A-E 并集） ----------
function selectPool(perId, rawStats) {
  const pool = new Map(); // id → Set<reason>
  const mark = (id, reason) => {
    const set = pool.get(id) || new Set();
    set.add(reason);
    pool.set(id, set);
  };
  for (const id of KNOWN_RESIDUE_IDS) mark(id, 'A-切分残词');
  for (const n of termNodes) {
    const len = n.label.length;
    const pages = (perId.get(n.id) || []).length;
    const st = rawStats.get(n.label);
    const emb = st && st.total ? st.embedded / st.total : 0;
    if (len <= 2 && pages > 0) mark(n.id, 'B-二字词');
    if (len === 3 && pages >= 3) mark(n.id, 'C-三字词');
    if (len === 4 && pages >= 8 && emb >= 0.8) mark(n.id, 'D-四字高嵌入');
    if (pages >= 40) mark(n.id, 'E-高频词');
  }
  return pool;
}

// ---------- 审查单元组装 ----------
function longerContaining(surface) {
  return termNodes
    .filter((n) => n.label !== surface && n.label.includes(surface))
    .map((n) => n.label)
    .slice(0, 12);
}

function stratifiedSamples(links) {
  const byBook = new Map();
  for (const l of links) {
    const book = l.page.split('/')[0];
    (byBook.get(book) || byBook.set(book, []).get(book)).push(l);
  }
  const groups = [...byBook.values()];
  const out = [];
  for (let round = 0; out.length < SAMPLE_LIMIT; round++) {
    let added = false;
    for (const g of groups) {
      if (g[round]) {
        out.push(g[round]);
        added = true;
        if (out.length >= SAMPLE_LIMIT) break;
      }
    }
    if (!added) break;
  }
  return out;
}

function buildTermUnit(id, reasons, perId, rawStats) {
  const n = termNodes.find((t) => t.id === id);
  const rec = mergedByCanonical.get(n.label);
  const links = perId.get(id) || [];
  const st = rawStats.get(n.label) || { total: 0, embedded: 0, left: new Map(), right: new Map() };
  return {
    unitType: 'term',
    id,
    canonical: n.label,
    aliases: rec.tier === 'seed' ? [] : n.aliases || [],
    seedAliasesDropped: rec.tier === 'seed' ? n.aliases || [] : [],
    tier: rec.tier,
    df: rec.df,
    evidenceCount: (rec.evidence || []).length,
    definition: definitionOf(id),
    poolReasons: [...reasons].sort(),
    stats: {
      firstLinkPages: links.length,
      rawHits: st.total,
      embedRate: st.total ? Number((st.embedded / st.total).toFixed(3)) : 0,
    },
    neighborProfile: { left: topN(st.left, 5), right: topN(st.right, 5) },
    longerTermsContaining: longerContaining(n.label),
    firstLinkSamples: stratifiedSamples(links),
  };
}

function buildAliasUnits(entries, rawStats, pages, matcher) {
  // high/mid ≤3 字别名：独立审查单元（别名误链风险不受 canonical 长度保护）
  const units = [];
  for (const e of entries) {
    if (e.type !== 'alias' || e.surface.length > 3) continue;
    const n = termNodes.find((t) => t.id === e.id);
    const st = rawStats.get(e.surface) || { total: 0, embedded: 0, left: new Map(), right: new Map() };
    const links = [];
    for (const { rel, selfId, body } of pages) {
      for (const h of collectHits(body, matcher, new Set(), selfId)) {
        if (h.surface === e.surface) {
          links.push({ page: rel, surface: h.surface, ctx: ctxOf(body, h.index, h.surface.length) });
        }
      }
    }
    units.push({
      unitType: 'alias',
      id: e.id,
      canonical: n.label,
      alias: e.surface,
      tier: e.tier,
      stats: {
        firstLinkPages: links.length,
        rawHits: st.total,
        embedRate: st.total ? Number((st.embedded / st.total).toFixed(3)) : 0,
      },
      neighborProfile: { left: topN(st.left, 5), right: topN(st.right, 5) },
      firstLinkSamples: stratifiedSamples(links),
    });
  }
  return units;
}

// ---------- Tier-2 报告素材 ----------
function tier2Data(perId, corpusText) {
  const zeroHit = termNodes.filter((n) => !(perId.get(n.id) || []).length);
  const byBook = {};
  for (const n of zeroHit) {
    const rec = mergedByCanonical.get(n.label);
    const books = Object.keys(rec.sources || {}).map((k) => DOMAIN_NAME[k] || k);
    const key = books.length ? books.join('+') : '（无出处记录）';
    (byBook[key] = byBook[key] || []).push({ id: n.id, canonical: n.label, tier: rec.tier });
  }
  const spaced = termNodes
    .filter((n) => /\s/.test(n.label))
    .map((n) => ({ id: n.id, canonical: n.label, zeroHit: !(perId.get(n.id) || []).length }));
  const nearMiss = [];
  for (const n of zeroHit) {
    const variants = new Set();
    const noSpace = n.label.replace(/\s+/g, '');
    if (noSpace !== n.label) variants.add(noSpace);
    if (n.label.length >= 5 && !/\s/.test(n.label)) {
      for (let i = 1; i < n.label.length; i++) {
        variants.add(`${n.label.slice(0, i)}的${n.label.slice(i)}`);
      }
    }
    for (const v of variants) {
      const count = corpusText.split(v).length - 1;
      if (count > 0) nearMiss.push({ id: n.id, canonical: n.label, variant: v, count });
    }
  }
  nearMiss.sort((a, b) => b.count - a.count);
  return { zeroHitCount: zeroHit.length, zeroHitByBook: byBook, spacedTerms: spaced, nearMiss };
}

// ---------- 主流程 ----------
function main() {
  const entries = buildSurfaceEntries();
  const matcher = buildTermMatcher(entries);
  const pages = loadCorpus();
  const t0 = Date.now();
  const perId = simulateFirstLinks(pages, matcher);
  const rawStats = collectRawStats(pages, matcher);
  const elapsed = Date.now() - t0;

  const pool = selectPool(perId, rawStats);
  const termUnits = [...pool.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, reasons]) => buildTermUnit(id, reasons, perId, rawStats));
  const aliasUnits = buildAliasUnits(entries, rawStats, pages, matcher);
  const units = [...termUnits, ...aliasUnits];

  mkdirSync(OUT_DIR, { recursive: true });
  const per = Math.ceil(units.length / BATCH_COUNT);
  for (let b = 0; b < BATCH_COUNT; b++) {
    const slice = units.slice(b * per, (b + 1) * per);
    if (!slice.length) break;
    const name = `batch-${String(b + 1).padStart(2, '0')}.json`;
    writeFileSync(join(OUT_DIR, name), JSON.stringify(slice, null, 2));
  }

  const totalFirstLinks = [...perId.values()].reduce((s, l) => s + l.length, 0);
  const poolFirstLinks = [...pool.keys()].reduce((s, id) => s + (perId.get(id) || []).length, 0);
  const corpusText = pages.map((p) => p.body).join('\n');
  const overview = {
    generatedAt: new Date().toISOString(),
    corpus: { pages: pages.length, chars: corpusText.length, scanMs: elapsed },
    matcher: { surfaces: matcher.size, canonical: termNodes.length, aliasIncluded: entries.filter((e) => e.type === 'alias').length },
    firstLinks: { total: totalFirstLinks, coveredTerms: perId.size, poolShare: Number((poolFirstLinks / totalFirstLinks).toFixed(3)) },
    pool: {
      termUnits: termUnits.length,
      aliasUnits: aliasUnits.length,
      byReason: ['A-切分残词', 'B-二字词', 'C-三字词', 'D-四字高嵌入', 'E-高频词'].map((r) => ({
        rule: r,
        count: termUnits.filter((u) => u.poolReasons.includes(r)).length,
      })),
    },
    tier2: tier2Data(perId, corpusText),
  };
  writeFileSync(join(OUT_DIR, 'pool-overview.json'), JSON.stringify(overview, null, 2));
  console.log(JSON.stringify({ ...overview, tier2: { zeroHitCount: overview.tier2.zeroHitCount, nearMissTop: overview.tier2.nearMiss.slice(0, 5) } }, null, 2));
}

main();
