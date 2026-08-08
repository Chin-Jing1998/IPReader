#!/usr/bin/env node
// 数据管线 D4-4：术语详情内容 —— 每个 term 节点生成 public/content/term-NNNN.json，供详情卡懒加载。
//   内容结构：
//     { id, label, aliases, tier, df,
//       definition,                                    // 定义处 evidence（role=defined，无则回退词表 evidence 样例）
//       occurrences: { <domain>: [ { nodeId, nodeLabel, breadcrumb, evidence, fullCites[] } ] },
//                                                       // 全量出处，不受 extract-edges 的 termref 30 封顶影响
//       laws: [ { lawKey, fullCite, nodeId } ],         // 词表 lawKeys → 法/细则"第X条"节点
//       relatedTerms: [ { id, label, relation } ] }     // termrel 上下位（broader=上位组长 / narrower=下位组员）
//   evidence 取自 data/term-extract/ 636 片提取产物（只读）；运行时机在 npm run data 全链之后。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTermExtractIndex, pickDefinition, recordsOfTerm, normTerm } from './lib/term-extract-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const OUT = join(__dirname, '..', 'public', 'content');
mkdirSync(OUT, { recursive: true });

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(D, name), 'utf8'));
  } catch (err) {
    console.error(`✗ 无法读取/解析 data/${name}：${err.message}\n  请先跑完 npm run data 全链。`);
    process.exit(1);
  }
}

const nodes = readJson('nodes.json');
const edges = readJson('edges.json');
const termsMerged = readJson('terms-merged.json');

const byId = new Map(nodes.map((n) => [n.id, n]));
const termNodes = nodes.filter((n) => n.kind === 'term');
if (!termNodes.length) {
  console.error('✗ nodes.json 中没有 term 节点，请先运行 build-term-nodes.mjs（npm run data 已包含）。');
  process.exit(1);
}
const mergedByKey = new Map(termsMerged.map((t) => [normTerm(t.canonical), t]));

// 法条节点索引：lawKey → nodeId
const lawNodeByKey = new Map();
for (const n of nodes) if (n.lawKey) lawNodeByKey.set(n.lawKey, n.id);

// 法条引用（可缺省）：sourceNode → [{lawKey, fullCite, count}]
const citesByNode = new Map();
try {
  for (const c of JSON.parse(readFileSync(join(D, 'law-citations.json'), 'utf8'))) {
    if (!citesByNode.has(c.sourceNode)) citesByNode.set(c.sourceNode, []);
    citesByNode.get(c.sourceNode).push(c);
  }
} catch {
  console.warn('⚠ 未读到 data/law-citations.json：fullCites 将为空');
}

// termrel 邻接（source=下位组员 → target=上位组长）
const relByTerm = new Map(); // term id → [{id, relation}]
for (const e of edges) {
  if (e.type !== 'termrel') continue;
  if (!relByTerm.has(e.source)) relByTerm.set(e.source, []);
  relByTerm.get(e.source).push({ id: e.target, relation: 'broader' });
  if (!relByTerm.has(e.target)) relByTerm.set(e.target, []);
  relByTerm.get(e.target).push({ id: e.source, relation: 'narrower' });
}

// 提取产物索引（evidence 来源）
const extractIndex = loadTermExtractIndex(join(D, 'term-extract'));
console.log(`term-extract 索引: ${extractIndex.files} 片`);

const CONF_RANK = { high: 2, mid: 1, low: 0 };
let written = 0;
let occTotal = 0;
let occWithEvidence = 0;
let defCount = 0;

for (const tn of termNodes) {
  const t = mergedByKey.get(normTerm(tn.label));
  if (!t) {
    console.warn(`⚠ 词表中找不到节点 ${tn.id}（${tn.label}）对应词条，跳过`);
    continue;
  }
  const aliases = t.aliases || [];
  const lawKeys = t.lawKeys || [];
  const ownLawSet = new Set(lawKeys);

  // 该词全部提取记录，按出处节点分组（评选每个出处的最佳 evidence）
  const recs = recordsOfTerm(extractIndex, t.canonical, aliases);
  const recsByAnchor = new Map();
  for (const r of recs) {
    if (!r.anchorNode) continue;
    if (!recsByAnchor.has(r.anchorNode)) recsByAnchor.set(r.anchorNode, []);
    recsByAnchor.get(r.anchorNode).push(r);
  }
  const bestEvidenceAt = (nodeId) => {
    const list = recsByAnchor.get(nodeId);
    if (!list) return '';
    const sorted = [...list].sort(
      (a, b) =>
        (b.role === 'defined' ? 1 : 0) - (a.role === 'defined' ? 1 : 0) ||
        CONF_RANK[b.confidence] - CONF_RANK[a.confidence] ||
        b.evidence.length - a.evidence.length,
    );
    return sorted[0]?.evidence || '';
  };

  // definition：定义处 evidence（term-extract role=defined），回退词表 evidence 样例
  const srcNodeIds = new Set(Object.values(t.sources || {}).flat());
  const definition = pickDefinition(extractIndex, t.canonical, aliases, srcNodeIds) || t.evidence?.[0]?.text || '';
  if (definition) defCount++;

  // occurrences：全量出处（不受 termref 30 封顶影响），按域分组
  const occurrences = {};
  for (const [dom, nids] of Object.entries(t.sources || {})) {
    const list = [];
    for (const nid of nids) {
      const node = byId.get(nid);
      if (!node) continue; // 出处节点已不在图中（规范改版），静默跳过
      const evidence = bestEvidenceAt(nid);
      const fullCites = [
        ...new Set((citesByNode.get(nid) || []).filter((c) => ownLawSet.has(c.lawKey)).map((c) => c.fullCite)),
      ].sort();
      occTotal++;
      if (evidence) occWithEvidence++;
      list.push({ nodeId: nid, nodeLabel: node.label, breadcrumb: node.breadcrumb || [], evidence, fullCites });
    }
    if (list.length) occurrences[dom] = list;
  }

  // laws：每个 lawKey → 法条节点 + 最常见的 fullCite（在该词出处节点范围内按 count 聚合，缺省用 lawKey 本身）
  const laws = lawKeys.map((lk) => {
    const agg = new Map(); // fullCite → 累计 count
    for (const nid of srcNodeIds) {
      for (const c of citesByNode.get(nid) || []) {
        if (c.lawKey !== lk) continue;
        agg.set(c.fullCite, (agg.get(c.fullCite) || 0) + (c.count || 1));
      }
    }
    const top = [...agg].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return { lawKey: lk, fullCite: top ? top[0] : lk, nodeId: lawNodeByKey.get(lk) ?? null };
  });

  // relatedTerms：termrel 上下位
  const relatedTerms = (relByTerm.get(tn.id) || [])
    .map((r) => ({ id: r.id, label: byId.get(r.id)?.label || r.id, relation: r.relation }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const content = {
    id: tn.id,
    label: tn.label,
    aliases,
    tier: t.tier,
    df: t.df || 0,
    definition,
    occurrences,
    laws,
    relatedTerms,
  };
  writeFileSync(join(OUT, `${tn.id}.json`), JSON.stringify(content));
  written++;
}

console.log(`✓ 生成 ${written} 个 term 详情 → public/content/term-*.json`);
console.log(
  `  definition 覆盖: ${defCount}/${written}；出处 evidence 覆盖: ${occWithEvidence}/${occTotal}` +
    `（${occTotal ? ((occWithEvidence / occTotal) * 100).toFixed(1) : 0}%）`,
);
