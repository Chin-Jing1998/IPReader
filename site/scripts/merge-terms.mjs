#!/usr/bin/env node
// 数据管线 D3-3：术语合并 —— LLM 提取产物 + 种子词表 → 最终词表
//   输入：
//     - data/term-extract/*.json（可用第一个位置参数改目录）：wf-extract-terms 逐片产物
//     - data/terms-seed.json（D1 产出 424 种子词）
//     - data/term-merges.json / data/term-blacklist.json（若存在；由 apply-term-audit.mjs 固化）
//     - data/term-whitelist.json（若存在）：入图白名单，扁平数组，格式对标 term-blacklist.json。
//       名单内的新词无条件放行入图（不受「df≥2 或 跨≥2 域 或 defined+high」门槛约束）。
//       黑名单优先级更高：同时出现在两张表时按剔除处理。
//     - data/term-topic-decisions.json（若存在）：主题归类的人工决策，[{termKey,canonical,topicKey,note}]，
//       优先级高于算法；topicKey 为空/"misc" 表示强制留 99-综合
//   处理：
//     1. evidence 校验：必须是对应切片原文的连续子串（读原片验证），不过则该词降为 low 并计数；
//     2. 归一（NFKC 全半角/空白/大小写）后并入种子词（命中 canonical 或 aliases → 并入，
//        sources 增补该片 anchorNode）；停用词直接丢弃；
//     3. 纯新词入图门槛：df≥2 切片 或 跨≥2 域 或 (role=defined 且 confidence=high 且 evidence 有效)；
//        其余进候选池 data/term-candidates.json（不入图）；
//     4. 应用 term-merges（词条归并）与 term-blacklist（剔除）；
//     5. 分级 tier：seed（种子）> high（defined+high 新词）> mid（多处 used 新词）；
//     6. 主题归类：人工决策 > 种子既有 topicKey > lib/topics.mjs::classifyTopic 三级算法
//        （精确相等 → 双向子串 → 定义句/evidence 计分），判不出即留 99-综合。
//   产物：
//     - data/terms-merged.json   最终词表（termKey/canonical/aliases/matchers/topicKey/sources/
//                                lawKeys/tier/df/evidence 样例）
//     - data/term-candidates.json 候选池
//     - audit/terms/term-topic-trace.csv 归类留痕（每条落类词的判定级别与命中词，供抽查复核）
//     - audit/terms/term-audit.csv 审校表（UTF-8 BOM；decision 列留空供审校填写，
//       审校结果经 apply-term-audit.mjs 固化后重跑本脚本即生效——本 CSV 每次重跑会重新生成）
//   末尾断言：合并后总词数（seed+入图新词）落 400~700 区间，超限 exit 1。
//   运行：node scripts/merge-terms.mjs [extractDir]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cn2num } from './lib/cn-num.mjs';
import { KNOWN_DOMAINS, projectRoot } from './lib/domains.mjs';
import { STOPWORDS } from './lib/term-stopwords.mjs';
import { classifyTopic, TOPIC_NAME } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(__dirname);
const DATA_DIR = join(__dirname, '..', 'data');
const AUDIT_DIR = join(__dirname, '..', 'audit', 'terms');
mkdirSync(AUDIT_DIR, { recursive: true });

const EXTRACT_DIR = process.argv[2] ? resolve(process.argv[2]) : join(DATA_DIR, 'term-extract');
const EVIDENCE_SAMPLES = 3; // 每词保留的 evidence 样例上限
const TOP_SOURCES = 5; // 审校表「topN出处」列上限
const TOTAL_MIN = 400;
// 上限由 700 放宽至 1000：审校复核后 keep 数（545）高于预估，且前端按 hub 分层显隐、
//   图渲染量级无压力；与 build-term-nodes.mjs 的硬断言保持同一口径。
// 2026-08-23 阶段5波C：商标审查审理指南 24 万字语料入索引，851→约 1034 词，
//   上限随语料规模一次性上调 1000→1200（build-term-nodes.mjs 的 DEFAULT_CAP 同步）。
// 2026-08-29 阶段5.9 波0：术语索引扩充批（商标指南全量重提取 ＋ 著作权/竞争法/品种布图/
//   综合程序四法域核心法律 8 部首次纳入），上限 1200→2000。推算依据（四项相乘后取余量）：
//     · 现入图率 33.8%（候选池→终表）；
//     · tmeg 样本实测 1.39 个新词/片，条文体（8 部法律）产出率按 0.85-1.1 新词/片估；
//     · 跨域重复系数 1.37（同一术语在多域出现只计一词）；
//     · 本批新增提取片：商标 895 ＋ 四法域 384 = 1279 片。
//   由此落点区间 1380-1590 词；取 2000 为上限，留 25-45% 余量以吸收审校裁决波动。
//   与 build-term-nodes.mjs 的 DEFAULT_CAP 保持同一口径，两处必须同步修改。
const TOTAL_MAX = 2000;

// 归一化：与 build-seed-lexicon.mjs / prep-term-extraction.mjs 同口径
const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const STOP_NORM = new Set([...STOPWORDS].map(norm));

// 法条引用（agent 产物 laws 数组的元素）→ 条级 lawKey（如「专利法第22条」），与 laws.json 键位对齐
// 2026-08-23 阶段5波C：法名白名单由硬编码三项改为按 KNOWN_DOMAINS 的 lawName/lawAlias 动态生成，
//   否则非专利法域（商标法、著作权法…）的条文引用一律静默丢弃（波C 前实测商标词 lawKeys 全空）。
//   法名段按长度降序拼入正则，防子串吞噬（「商标法实施条例」须排在「商标法」之前；
//   参照 mcp/src/search.mjs 与 law-cite.mjs 的既有教训）。条号解析沿用原有中文/阿拉伯双支持与「之N」。
const LAW_NAME_TO_KEY = new Map();
for (const d of KNOWN_DOMAINS) {
  if (!d.lawName) continue;
  LAW_NAME_TO_KEY.set(d.lawName, d.lawName);
  if (d.lawAlias) LAW_NAME_TO_KEY.set(d.lawAlias, d.lawName);
}
LAW_NAME_TO_KEY.set('实施细则', '专利法实施细则'); // 历史简称，证据片沿用
const LAW_NAME_ALT = [...LAW_NAME_TO_KEY.keys()]
  .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const LAW_KEY_RE = new RegExp(
  `^《?(${LAW_NAME_ALT})》?第([0-9]+|[一二三四五六七八九十百零〇两]+)条(?:之([0-9]+|[一二三四五六七八九十]+))?`,
);
function toLawKey(cite) {
  const m = String(cite || '').match(LAW_KEY_RE);
  if (!m) return null;
  const law = LAW_NAME_TO_KEY.get(m[1]) || m[1];
  const art = cn2num(m[2]);
  if (!Number.isFinite(art)) return null;
  const zhi = m[3] ? cn2num(m[3]) : null;
  return `${law}第${art}条${Number.isFinite(zhi) ? `之${zhi}` : ''}`;
}

// ============ 词条累加器 ============
//   index: normKey（canonical 或 alias）→ entry；entry.key 为 termKey（canonical 归一）
const index = new Map();
const entries = []; // 保持出现顺序（种子在前）
function registerAlias(entry, raw) {
  const k = norm(raw);
  if (!k || k === entry.key || k.length < 2 || STOP_NORM.has(k)) return;
  if (index.has(k)) return; // 已被其他词条占用（含已独立成词），不抢占
  entry.aliasMap.set(k, raw);
  index.set(k, entry);
}
function newEntry(canonical, isSeed, seed = null) {
  const entry = {
    key: norm(canonical),
    canonical,
    isSeed,
    // seed 侧法条是否为空——在建条时一次性定格，不随后续吸收而翻转
    //   （若读 lawKeys.size 判空，首片吸收后即变非空，后续切片会被误挡）
    seedLawEmpty: !!isSeed && !(seed && (seed.lawKeys || []).length),
    aliasMap: new Map(),
    matchers: seed ? [...(seed.matchers || [])] : [],
    topicKey: seed?.topicKey,
    sources: new Map(), // domain → Set(nodeId)
    lawKeys: new Set(seed ? seed.lawKeys || [] : []),
    chunks: new Set(), // 提取来源切片（df 口径）
    extractDomains: new Set(), // 提取来源域（跨域门槛口径）
    evid: [], // {chunk, text}
    definition: '', // 首个 role=defined 且 evidence 有效的原文定义句（仅供三级归类计分，不入产物）
    definedHigh: false, // 存在 role=defined 且 confidence=high 且 evidence 有效的提取
    demoted: 0, // evidence 校验失败而降 low 的次数
  };
  entries.push(entry);
  index.set(entry.key, entry);
  return entry;
}
function addSource(entry, domain, nodeId) {
  if (!entry.sources.has(domain)) entry.sources.set(domain, new Set());
  entry.sources.get(domain).add(nodeId);
}

// ---- 种子词注册 ----
function collectMd(dir) {
  // 递归收集目录下全部 .md 文件文本（v3 切片下钻更深，回退拼接须含子目录）
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...collectMd(p));
    else if (f.endsWith('.md')) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}
const seeds = JSON.parse(readFileSync(join(DATA_DIR, 'terms-seed.json'), 'utf8'));
for (const s of seeds) {
  const entry = newEntry(s.canonical, true, s);
  for (const [dom, ids] of Object.entries(s.sources || {})) for (const id of ids) addSource(entry, dom, id);
  for (const a of s.aliases || []) registerAlias(entry, a);
}

// ============ 读提取产物并校验合入 ============
const stats = {
  files: 0, parseFail: 0, termOcc: 0, stopword: 0, tooShort: 0,
  evidenceBad: 0, mergedToSeed: 0, newOcc: 0,
};
const chunkTextCache = new Map();
function chunkText(chunkId) {
  if (!chunkTextCache.has(chunkId)) {
    const segs = chunkId.split('/');
    const p = join(ROOT, segs[0], '_chunks', ...segs.slice(1)) + '.md';
    let text = null;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      text = null; // 原片缺失：evidence 一律视为未通过
    }
    // 回退：term-extract 的 chunk 引用 v2 切片路径，v3 切片下钻更深（如 01/003 →
    // 01/003/05.md 目录级）。递归拼接目录下全部切片文本，保证 evidence 可命中。
    // （2026-08-09 法条修订重切后暴露：不回退会致 193 个提取词 evidence 失败而降级剔除）
    if (text === null) {
      const dir = join(ROOT, segs[0], '_chunks', ...segs.slice(1));
      try {
        text = collectMd(dir).join('\n');
      } catch {
        text = null;
      }
    }
    chunkTextCache.set(chunkId, text);
  }
  return chunkTextCache.get(chunkId);
}

const extractFiles = existsSync(EXTRACT_DIR)
  ? readdirSync(EXTRACT_DIR).filter((f) => f.endsWith('.json')).sort()
  : [];
if (!extractFiles.length) console.log(`（提取目录 ${EXTRACT_DIR} 为空或不存在：按空转模式仅基于种子词产出）`);

for (const f of extractFiles) {
  let rec;
  try {
    rec = JSON.parse(readFileSync(join(EXTRACT_DIR, f), 'utf8'));
  } catch {
    stats.parseFail++;
    console.warn(`⚠ 解析失败，跳过：${f}`);
    continue;
  }
  stats.files++;
  const chunkId = rec.chunk || f.replace(/\.json$/, '').split('__').join('/');
  const domain = chunkId.split('/')[0];
  const anchorNode = rec.anchorNode;
  const text = chunkText(chunkId);
  const chunkLawKeys = [...new Set((rec.laws || []).map(toLawKey).filter(Boolean))];

  for (const t of rec.terms || []) {
    const name = String(t.name || '').trim();
    const key = norm(name);
    stats.termOcc++;
    if (!key || key.length < 2) {
      stats.tooShort++;
      continue;
    }
    if (STOP_NORM.has(key)) {
      stats.stopword++;
      continue;
    }
    // evidence 校验：必须是原片的连续子串；不过则降 low
    const evRaw = typeof t.evidence === 'string' ? t.evidence : '';
    const evidenceOk = !!(evRaw.trim() && text && text.includes(evRaw));
    let confidence = t.confidence === 'high' || t.confidence === 'mid' ? t.confidence : 'low';
    if (!evidenceOk) {
      confidence = 'low';
      stats.evidenceBad++;
    }

    let entry = index.get(key);
    if (entry) {
      if (entry.isSeed) stats.mergedToSeed++;
      else stats.newOcc++;
      if (norm(entry.canonical) !== key || entry.canonical !== name) registerAlias(entry, name);
    } else {
      entry = newEntry(name, false);
      stats.newOcc++;
    }
    if (anchorNode) addSource(entry, domain, anchorNode);
    entry.chunks.add(chunkId);
    entry.extractDomains.add(domain);
    for (const a of t.aliases || []) registerAlias(entry, String(a).trim());
    if (evidenceOk && entry.evid.length < EVIDENCE_SAMPLES) entry.evid.push({ chunk: chunkId, text: evRaw });
    if (!evidenceOk) entry.demoted++;
    if (t.role === 'defined' && evidenceOk && !entry.definition) entry.definition = evRaw;
    if (t.role === 'defined' && confidence === 'high') entry.definedHigh = true;
    // 新词的 lawKeys 取所在切片的条级引用；种子词 lawKeys 原则上由 D1 归集、保持不动。
    // 2026-08-23 阶段5波C 修法：种子词「仅当 seed 侧 lawKeys 为空时」也吸收切片法条。
    //   动机——D1 的 lawKeys 只从 patent-law / implementation-rules 两域出处归集，
    //   商标审查审理指南接入关键词速查表后：① 补正通知书/不予受理/外观设计专利权 三个既有 high 词
    //   升格为种子，原本已吸收的 20/4/42 条 lawKeys 归零，属回归；② 74 个 tmeg 种子词中 66 个法条全空。
    //   两者同因。非空种子维持只信 seed 侧，避免切片法条稀释人工归集结果。
    if (!entry.isSeed || entry.seedLawEmpty) for (const lk of chunkLawKeys) entry.lawKeys.add(lk);
  }
}

// ============ 应用审校固化产物：term-merges（归并）→ term-blacklist（剔除） ============
function readJsonIf(p, fallback) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
}
const mergesRaw = readJsonIf(join(DATA_DIR, 'term-merges.json'), {});
const blacklist = new Set(readJsonIf(join(DATA_DIR, 'term-blacklist.json'), []).map(norm));
// 入图白名单（2026-08-30 阶段5.11 波F）：商标指南全量重提取后，5 个原 1035 词表中的现网词条
//   因新一轮提取只在单片单域出现且非 defined+high，被入图门槛挡进候选池而从终表消失
//   （共同申请／国际申请撤回／声音要素编码／集体商标使用管理规则／马德里商标领土延伸申请）。
//   经用户裁决全部救回。门槛本身不放宽——放宽会连带放行 779 个候选词，故设定点白名单。
const whitelist = new Set(readJsonIf(join(DATA_DIR, 'term-whitelist.json'), []).map(norm));

// 归并链解析（含环保护）：a→b→c 时 a 直接并入 c
function resolveMergeTarget(fromKey) {
  let cur = fromKey;
  const seen = new Set([cur]);
  while (mergesRaw[cur] != null) {
    const next = norm(mergesRaw[cur]);
    if (seen.has(next)) {
      console.warn(`⚠ term-merges 存在环：${[...seen].join(' → ')} → ${next}，该链不生效`);
      return null;
    }
    seen.add(next);
    cur = next;
  }
  return cur === fromKey ? null : cur;
}
let mergeApplied = 0;
for (const fromRaw of Object.keys(mergesRaw)) {
  const fromKey = norm(fromRaw);
  const from = index.get(fromKey);
  const targetKey = resolveMergeTarget(fromKey);
  if (!from || !targetKey) continue;
  const to = index.get(targetKey);
  if (!to || to === from || norm(from.canonical) !== fromKey) {
    if (!to) console.warn(`⚠ term-merges 目标不存在：${fromRaw} → ${mergesRaw[fromRaw]}`);
    continue;
  }
  // 并入：from 的 canonical/aliases 成为 to 的别名；来源/切片/法条/证据合并
  //   canonical 直接写入别名表（其归一键此刻仍指向 from 自身，不能走 registerAlias 的占用检查）
  if (fromKey !== to.key && !to.aliasMap.has(fromKey)) to.aliasMap.set(fromKey, from.canonical);
  for (const [k, v] of from.aliasMap) {
    if (!index.has(k) || index.get(k) === from) {
      index.set(k, to);
      if (k !== to.key && !to.aliasMap.has(k)) to.aliasMap.set(k, v);
    }
  }
  for (const [dom, ids] of from.sources) for (const id of ids) addSource(to, dom, id);
  for (const c of from.chunks) to.chunks.add(c);
  for (const d of from.extractDomains) to.extractDomains.add(d);
  for (const lk of from.lawKeys) if (!to.isSeed || from.isSeed) to.lawKeys.add(lk);
  for (const e of from.evid) if (to.evid.length < EVIDENCE_SAMPLES) to.evid.push(e);
  if (!to.definition) to.definition = from.definition;
  to.definedHigh = to.definedHigh || from.definedHigh;
  index.set(fromKey, to);
  entries.splice(entries.indexOf(from), 1);
  mergeApplied++;
}
let blacklisted = 0;
for (let i = entries.length - 1; i >= 0; i--) {
  if (blacklist.has(entries[i].key)) {
    for (const [k, e] of index) if (e === entries[i]) index.delete(k);
    entries.splice(i, 1);
    blacklisted++;
  }
}

// ============ 新词入图门槛 + 分级 ============
const kept = [];
const candidates = [];
for (const e of entries) {
  const df = e.chunks.size;
  if (e.isSeed) {
    e.tier = 'seed';
    e.df = df;
    kept.push(e);
    continue;
  }
  // 白名单无条件放行（黑名单已在上一步整条剔除，两表冲突时黑名单胜出）
  const pass = df >= 2 || e.extractDomains.size >= 2 || e.definedHigh || whitelist.has(e.key);
  e.df = df;
  e.tier = e.definedHigh ? 'high' : 'mid';
  (pass ? kept : candidates).push(e);
}

// 白名单落实核对：逐条报是否真的靠白名单入图，名单里却查无此词的一律告警（防写错词面静默失效）
if (whitelist.size) {
  const keptKeys = new Set(kept.map((e) => e.key));
  const missing = [...whitelist].filter((k) => !keptKeys.has(k));
  console.log(`入图白名单: ${whitelist.size} 词，入图 ${whitelist.size - missing.length}`);
  if (missing.length) console.warn(`⚠ 白名单词未入图（提取产物中查无此词或已被剔除）：${missing.join('、')}`);
}

// ============ 主题归类（三级算法 + 人工决策覆盖）============
//   优先级：人工决策（data/term-topic-decisions.json）> 种子既有 topicKey > 三级算法。
//   决策文件格式沿用 data/term-audit-decisions/ 的批次审核格式，多一个 topicKey 字段：
//     [{ termKey, canonical, topicKey, note }]
//     topicKey 为主题 key → 强制归入该主题；为 null / "" / "misc" → 强制留 99-综合（可推翻算法误配）。
//   缺席即交给算法判定。未知 topicKey 一律告警并忽略，避免静默落到综合。
const topicDecisions = new Map();
{
  const raw = readJsonIf(join(DATA_DIR, 'term-topic-decisions.json'), []);
  for (const d of Array.isArray(raw) ? raw : []) {
    const k = norm(d.termKey || d.canonical);
    if (!k) continue;
    const tk = (d.topicKey || '').trim();
    if (tk && tk !== 'misc' && !TOPIC_NAME[tk]) {
      console.warn(`⚠ term-topic-decisions 未知 topicKey「${tk}」（${d.canonical || k}），已忽略`);
      continue;
    }
    topicDecisions.set(k, tk === 'misc' ? '' : tk);
  }
}

const topicStats = { decision: 0, decisionMisc: 0, seed: 0, 1: 0, 2: 0, 3: 0, none: 0 };
const topicTrace = []; // 供归类抽查：{canonical, before, after, level, kw}
for (const e of kept) {
  const before = e.topicKey || '';
  if (topicDecisions.has(e.key)) {
    e.topicKey = topicDecisions.get(e.key) || undefined;
    topicStats[e.topicKey ? 'decision' : 'decisionMisc']++;
    topicTrace.push({ canonical: e.canonical, before, after: e.topicKey || '', level: 'decision', kw: '' });
    continue;
  }
  if (e.topicKey) {
    topicStats.seed++;
    continue;
  }
  const hit = classifyTopic({
    canonical: e.canonical,
    aliases: [...e.aliasMap.values()],
    text: [e.definition, ...e.evid.map((v) => v.text)].filter(Boolean).join('\n'),
  });
  if (!hit) {
    topicStats.none++;
    continue;
  }
  e.topicKey = hit.topicKey;
  topicStats[hit.level]++;
  topicTrace.push({ canonical: e.canonical, before, after: hit.topicKey, level: `L${hit.level}`, kw: hit.kw });
}

// 排序：种子按原序在前；新词 high 在前、df 降序、canonical 升序
const seedPart = kept.filter((e) => e.isSeed);
const newPart = kept
  .filter((e) => !e.isSeed)
  .sort(
    (a, b) =>
      (a.tier === b.tier ? 0 : a.tier === 'high' ? -1 : 1) ||
      b.df - a.df ||
      a.canonical.localeCompare(b.canonical, 'zh'),
  );
const finalTerms = [...seedPart, ...newPart];

// ============ 输出 ============
function serialize(e) {
  const out = {
    termKey: e.key,
    canonical: e.canonical,
    aliases: [...e.aliasMap.values()],
    matchers: e.matchers,
  };
  if (e.topicKey) out.topicKey = e.topicKey;
  out.sources = Object.fromEntries([...e.sources.entries()].map(([d, set]) => [d, [...set].sort()]));
  out.lawKeys = [...e.lawKeys].sort();
  out.tier = e.tier;
  out.df = e.df;
  out.evidence = e.evid;
  return out;
}
writeFileSync(join(DATA_DIR, 'terms-merged.json'), JSON.stringify(finalTerms.map(serialize), null, 2));
writeFileSync(
  join(DATA_DIR, 'term-candidates.json'),
  JSON.stringify(
    candidates
      .sort((a, b) => b.df - a.df || a.canonical.localeCompare(b.canonical, 'zh'))
      .map((e) => ({ ...serialize(e), reason: '入图门槛未达（df<2 且未跨域 且非 defined+high）' })),
    null,
    2,
  ),
);

// 审校表 CSV（UTF-8 BOM）：decision 填 keep / merge-into:<termKey> / drop，note 自由填写
const csvEsc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvRows = finalTerms.map((e) => {
  const srcFlat = [...e.sources.entries()].flatMap(([d, set]) => [...set].sort().map((id) => `${d}:${id}`));
  return [
    e.key,
    e.canonical,
    [...e.aliasMap.values()].join('；'),
    e.tier,
    String(e.df),
    String(e.sources.size),
    srcFlat.slice(0, TOP_SOURCES).join('；'),
    e.evid[0]?.text || '',
    '', // decision（审校填写）
    '', // note
  ].map((x) => csvEsc(String(x))).join(',');
});
writeFileSync(
  join(AUDIT_DIR, 'term-audit.csv'),
  '﻿' + ['termKey,canonical,aliases,tier,df,domains,topN出处,sampleEvidence,decision,note', ...csvRows].join('\n') + '\n',
);

// ============ 统计与断言 ============
const tierCount = finalTerms.reduce((a, e) => ((a[e.tier] = (a[e.tier] || 0) + 1), a), {});
console.log('—— 合并统计 ——');
console.log(
  `提取片文件: ${stats.files}（解析失败 ${stats.parseFail}）| 术语出现次数: ${stats.termOcc}` +
  `（并入种子 ${stats.mergedToSeed} / 新词出现 ${stats.newOcc} / 停用词丢弃 ${stats.stopword} / 过短 ${stats.tooShort}）`,
);
console.log(`evidence 校验失败降 low: ${stats.evidenceBad}`);
console.log(`审校固化应用: 归并 ${mergeApplied} 条 / 剔除 ${blacklisted} 条`);
{
  const classified = finalTerms.filter((e) => e.topicKey).length;
  const pct = ((finalTerms.length - classified) / finalTerms.length) * 100;
  console.log(
    `主题归类: 人工决策 ${topicStats.decision}（强制留综合 ${topicStats.decisionMisc}）| 种子既有 ${topicStats.seed} | ` +
    `一级精确 ${topicStats[1]} | 二级子串 ${topicStats[2]} | 三级文本 ${topicStats[3]} | 未归类 ${topicStats.none}`,
  );
  console.log(`  → 落类 ${classified} 词，99-综合 ${finalTerms.length - classified} 词（${pct.toFixed(1)}%）`);
  const rows = topicTrace.map((r) =>
    [r.canonical, r.before, r.after, TOPIC_NAME[r.after] || '综合', r.level, r.kw].map((x) => csvEsc(String(x))).join(','),
  );
  writeFileSync(
    join(AUDIT_DIR, 'term-topic-trace.csv'),
    '﻿' + ['canonical,原topicKey,新topicKey,新主题名,判定级别,命中词', ...rows].join('\n') + '\n',
  );
}
console.log(`最终词表: ${finalTerms.length} 词 ${JSON.stringify(tierCount)} | 候选池: ${candidates.length} 词`);
console.log(
  `产物: data/terms-merged.json、data/term-candidates.json、audit/terms/term-audit.csv（${finalTerms.length} 行）`,
);

let ok = true;
if (finalTerms.length < TOTAL_MIN || finalTerms.length > TOTAL_MAX) {
  ok = false;
  console.error(`✗ 断言失败：合并后总词数 ${finalTerms.length} 不在 ${TOTAL_MIN}~${TOTAL_MAX} 区间`);
}
console.log(ok ? '✓ 断言全部通过' : '✗ 断言未通过');
if (!ok) process.exit(1);
