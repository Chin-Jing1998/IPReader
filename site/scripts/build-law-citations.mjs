#!/usr/bin/env node
// 数据管线 D2：全量节点法条引用清单 → data/law-citations.json
//   产物：[{sourceNode, lawKey, fullCite, count}]，按 sourceNode+fullCite 聚合；
//   抽取器：lib/law-cite.mjs 的增强版 extractCitations（阿拉伯/中文条号、款/项、域内指代、范围展开、枚举续接）。
// 数据源：data/node-bodies.json（ownText/fullText）+ data/nodes.json。
//   抽取文本范围与 parse-domains.mjs 的 lawScope 规则对齐，以保证"不丢既有信息"断言成立：
//     - guideline 特例域（KNOWN_DOMAINS 中 special==='guideline'）：section/subsection 取 fullText，
//       part/chapter 取 ownText——与 parse-domains.mjs::parseGuideline 的 lawScope 同规则；
//     - 通用域：有子节点取 ownText，无子节点取 fullText（子节点内容由子节点自行计）。
//   （若一律仅取 ownText，实测将丢失 296 个既有 (node,lawKey) 对，无法覆盖 nodes.json 的 laws[] 集合。）
//   ⚠ 2026-08-22 修复：本判定原写死域名字面量 'examination-guideline-2025'，而该域已更名为
//     'examination-guideline'，致判定长期恒假、审查指南 section/subsection 误走通用分支取 ownText，
//     丢失 325 个 (node,lawKey) 对。现改为从 KNOWN_DOMAINS 读 special 标记，杜绝域名更名再次失配。
// 末尾断言：law-citations 的 (sourceNode,lawKey) 对 ⊇ nodes.json 各节点 laws[] 的对集合；差集非空则打印明细并退出 1。
//   ⚠ 2026-08-22 修复：产物写盘已移至断言之后，断言失败不再留下坏产物。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCitations } from './lib/law-cite.mjs';
import { KNOWN_BY_KEY } from './lib/domains.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');

// ---- 读入基础数据 ----
if (!existsSync(join(D, 'node-bodies.json'))) {
  console.error(
    '✗ 缺少 data/node-bodies.json（正文数据源）。\n' +
    '  请先运行：node scripts/parse-domains.mjs 生成；\n' +
    '  注意：parse-domains 会同时覆写 data/nodes.json 等产物（布局坐标以 git 为权威），\n' +
    '  生成后须执行 git checkout -- data public/content 还原被覆盖的数据产物，再运行本脚本。',
  );
  process.exit(1);
}
const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));

// ---- 子节点判定：某 id 的任意后代存在，即其所有真前缀 id 记为"有子"（与 parseGeneric 的 hasChild 等价）----
const hasDescendant = new Set();
for (const n of nodes) {
  const parts = n.id.split('-');
  for (let i = 1; i < parts.length; i++) hasDescendant.add(parts.slice(0, i).join('-'));
}

// 与 parse-domains 一致的法条抽取文本范围
const isGuidelineDomain = (domain) => KNOWN_BY_KEY.get(domain)?.special === 'guideline';
function lawScopeOf(node, body) {
  if (!body) return '';
  if (isGuidelineDomain(node.domain))
    return node.level === 'section' || node.level === 'subsection' ? body.fullText : body.ownText;
  return hasDescendant.has(node.id) ? body.ownText : body.fullText;
}

// ---- 逐节点抽取并聚合 ----
const records = []; // 产物行：{sourceNode, lawKey, fullCite, count}
const snippetOf = new Map(); // `${sourceNode}::${fullCite}` → 首次命中的原文片段（±30 字，供抽查）
const citePairs = new Set(); // `${sourceNode}::${lawKey}`，供超集断言
const labelOf = new Map(nodes.map((n) => [n.id, n.label]));

for (const n of nodes) {
  const scope = lawScopeOf(n, bodies[n.id]) || '';
  if (!scope) continue;
  const trace = [];
  const cites = extractCitations(scope, n.domain, { trace });
  if (!cites.length) continue;
  // 首次命中片段：±30 字，换行归一为 ⏎
  for (const t of trace) {
    const key = `${n.id}::${t.fullCite}`;
    if (!snippetOf.has(key)) {
      const s = scope.slice(Math.max(0, t.index - 30), t.index + t.raw.length + 30);
      snippetOf.set(key, s.replace(/\s*\n\s*/g, '⏎'));
    }
  }
  cites.sort((a, b) => (a.fullCite < b.fullCite ? -1 : a.fullCite > b.fullCite ? 1 : 0));
  for (const c of cites) {
    records.push({ sourceNode: n.id, lawKey: c.lawKey, fullCite: c.fullCite, count: c.count });
    citePairs.add(`${n.id}::${c.lawKey}`);
  }
}

// ---- 统计打印 ----
const totalHits = records.reduce((a, r) => a + r.count, 0);
console.log(`law-citations 记录数: ${records.length}（sourceNode+fullCite 聚合），累计命中次数: ${totalHits}`);

const byLawKey = new Map();
for (const r of records) byLawKey.set(r.lawKey, (byLawKey.get(r.lawKey) || 0) + r.count);
const top10 = [...byLawKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('按 lawKey 命中次数 Top10:');
for (const [k, v] of top10) console.log(`  ${k}: ${v}`);

const detailRecords = records.filter((r) => r.fullCite !== r.lawKey); // 带款/项后缀者
const detailHits = detailRecords.reduce((a, r) => a + r.count, 0);
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '0%');
console.log(
  `款/项级引用占比: 记录 ${detailRecords.length}/${records.length}（${pct(detailRecords.length, records.length)}），` +
  `命中 ${detailHits}/${totalHits}（${pct(detailHits, totalHits)}）`,
);

// ---- 断言：不丢既有信息 —— (sourceNode,lawKey) 对 ⊇ nodes.json 的 laws[] 对集合 ----
//   ⚠ 2026-08-22 修复：断言范围限定为文档节点。2026-08-12 起 nodes.json 并入 851 个 term 节点，
//   其 laws[] 来自词表 terms-merged.json 的 lawKeys（词条→法条映射），并非从正文抽取而来，
//   本脚本也不为其产出记录（term 节点无 node-bodies 条目）。把它们计入覆盖断言属口径错配。
const isDocNode = (n) => n.level !== 'term' && n.kind !== 'term';
const docNodes = nodes.filter(isDocNode);
const missing = [];
for (const n of docNodes)
  for (const lk of n.laws || [])
    if (!citePairs.has(`${n.id}::${lk}`)) missing.push(`${n.id} :: ${lk}`);
if (missing.length) {
  console.error(`✗ 断言失败：law-citations 未覆盖 nodes.json 既有 laws[] 对，差集 ${missing.length} 项：`);
  for (const s of missing) console.error('  ' + s);
  process.exit(1);
}
const baselinePairs = docNodes.reduce((a, n) => a + (n.laws || []).length, 0);
console.log(`✓ 断言通过：(sourceNode,lawKey) 对 ${citePairs.size} ⊇ nodes.laws 基线对 ${baselinePairs}（差集为空）`);

// ---- 写盘：仅在全部断言通过后落地，避免坏产物覆盖既有数据 ----
writeFileSync(join(D, 'law-citations.json'), JSON.stringify(records, null, 0));
console.log(`✓ 已写入 data/law-citations.json（${records.length} 条记录）`);

// ---- 款/项抽查：确定性随机取 20 条，打印 fullCite + 节点 label + 命中原文片段（±30 字）----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260712); // 固定种子，抽样可复现
const pool = [...detailRecords];
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const SAMPLE_N = 20;
console.log(`\n款/项级引用抽查（${Math.min(SAMPLE_N, pool.length)} 条，种子 20260712）:`);
for (const r of pool.slice(0, SAMPLE_N)) {
  const snip = snippetOf.get(`${r.sourceNode}::${r.fullCite}`) || '（未留存片段）';
  console.log(`- ${r.fullCite}  ×${r.count}`);
  console.log(`  节点 ${r.sourceNode}「${labelOf.get(r.sourceNode) || '?'}」`);
  console.log(`  原文 …${snip}…`);
}
