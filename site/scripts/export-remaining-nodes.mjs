// 全量复核导出：基于"当前提纯后"的图，对每个节点导出其点击点亮的弱关联邻居中"尚未复核过"的，按节点切批。
//   弱关联 = concept/colaw 边邻居 + 提纯后 topicPeers（已套 peer-blacklist）。已判无序对（result/fresult 里出现过）一律排除。
//   只读，不改数据。运行：node scripts/export-remaining-nodes.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPIC_NAME } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const OUT = join(__dirname, '..', 'audit', 'review-all');
mkdirSync(OUT, { recursive: true });
const PRIOR = [join(__dirname, '..', 'audit', 'review-nodes'), join(__dirname, '..', 'audit', 'review-focused')];

const DOMAIN_CN = {
  'examination-guideline-2025': '审查指南', 'patent-law': '专利法', 'implementation-rules': '实施细则',
  'infringement-guide': '侵权判定', 'mechanical-drafting-rules': '机械撰写', 'chemistry-drafting-rules': '化学撰写', 'oa-response-guide': '答复指引',
};
const dcn = (d) => DOMAIN_CN[d] || d;
const CENTER_LEN = 1400, NBR_LEN = 360;
const MAX_NODES_PER_BATCH = 8, MAX_JUDGE_PER_BATCH = 100;

const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const edges = JSON.parse(readFileSync(join(D, 'edges.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));
const pb = JSON.parse(readFileSync(join(D, 'peer-blacklist.json'), 'utf8'));
const PEER_EXCLUDE = new Set(pb.excludeNodes);
const PEER_BLACKPAIRS = new Set(pb.pairs);
const byId = new Map(nodes.map((n) => [n.id, n]));
const ukey = (a, b) => (a < b ? `${a}~${b}` : `${b}~${a}`);

// 邻接（按类型）
const parent = new Map();
const relByPair = new Map();
const adj = new Map();
for (const n of nodes) adj.set(n.id, new Set());
for (const e of edges) {
  if (e.type === 'hierarchy') parent.set(e.target, e.source);
  adj.get(e.source)?.add(e.target);
  adj.get(e.target)?.add(e.source);
  relByPair.set(`${e.source}|${e.target}`, e.type);
  relByPair.set(`${e.target}|${e.source}`, e.type);
}
const TOPIC_NODES = new Map();
for (const n of nodes) for (const tk of n.topics || []) {
  if (!TOPIC_NODES.has(tk)) TOPIC_NODES.set(tk, []);
  TOPIC_NODES.get(tk).push(n.id);
}
// 提纯后 topicPeers（与 main.ts 一致：排除污染源 + 剔除黑名单对）
function topicPeers(id) {
  const self = byId.get(id);
  if (!self) return [];
  const picked = new Map();
  for (const tk of self.topics || []) {
    const byDom = new Map();
    for (const pid of TOPIC_NODES.get(tk) || []) {
      const p = byId.get(pid);
      if (!p || p.domain === self.domain || pid === id) continue;
      if (PEER_EXCLUDE.has(pid)) continue;
      if (PEER_BLACKPAIRS.has(ukey(id, pid))) continue;
      if (!byDom.has(p.domain)) byDom.set(p.domain, []);
      byDom.get(p.domain).push({ id: pid, deg: p.degree || 0 });
    }
    for (const arr of byDom.values()) { arr.sort((a, b) => b.deg - a.deg); for (const c of arr.slice(0, 2)) picked.set(c.id, c.deg); }
  }
  return [...picked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([pid]) => pid);
}
function bodyText(n, len) {
  const b = bodies[n.id] || {};
  const own = (b.ownText || '').trim();
  if (own) return { text: own.slice(0, len), note: '自身正文' };
  if (b.fullText) return { text: (b.fullText || '').slice(0, len), note: '容器节点(自身无正文,下为涵盖范围预览)' };
  return { text: n.summary || '', note: '仅摘要' };
}
function relationOf(centerId, mid) {
  const t = relByPair.get(`${centerId}|${mid}`);
  if (t === 'colaw') return '共引法条';
  if (t === 'concept') return '同主题桥';
  return '主题相关(动态)';
}

// 已判无序对（第一阶段全部结果）
const judged = new Set();
for (const dir of PRIOR) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => /^(f?result)-\d+\.json$/.test(x))) {
    try { const r = JSON.parse(readFileSync(join(dir, f), 'utf8')); for (const nd of r.nodes || []) for (const j of nd.judged || []) judged.add(ukey(nd.centerId, j.id)); } catch {}
  }
}

// 每节点的弱关联待判邻居（排除硬关联与已判对）
const HARD_RELS = new Set(['hierarchy', 'xref', 'lawref']);
const cards = [];
for (const n of nodes) {
  const weak = new Set();
  for (const mid of adj.get(n.id) || []) {
    const t = relByPair.get(`${n.id}|${mid}`);
    if (t === 'concept' || t === 'colaw') weak.add(mid);
  }
  for (const p of topicPeers(n.id)) weak.add(p);
  weak.delete(n.id);
  const neighbors = [];
  for (const mid of weak) {
    if (judged.has(ukey(n.id, mid))) continue; // 该无序对已复核过
    const m = byId.get(mid);
    if (!m) continue;
    const bt = bodyText(m, NBR_LEN);
    neighbors.push({ id: m.id, label: m.label, path: (m.breadcrumb || []).join(' / '), domain: dcn(m.domain), topics: (m.topics || []).map((k) => TOPIC_NAME[k] || k), relation: relationOf(n.id, mid), crossDomain: m.domain !== n.domain, needJudge: true, textNote: bt.note, text: bt.text });
  }
  if (!neighbors.length) continue;
  const ct = bodyText(n, CENTER_LEN);
  cards.push({ center: { id: n.id, label: n.label, path: (n.breadcrumb || []).join(' / '), domain: dcn(n.domain), topics: (n.topics || []).map((k) => TOPIC_NAME[k] || k), degree: n.degree || 0, textNote: ct.note, text: ct.text }, neighbors, judgeCnt: neighbors.length });
}
cards.sort((a, b) => b.judgeCnt - a.judgeCnt);

// 切批
const batches = [];
let cur = [], curJ = 0;
for (const c of cards) {
  if (cur.length && (cur.length >= MAX_NODES_PER_BATCH || curJ + c.judgeCnt > MAX_JUDGE_PER_BATCH)) { batches.push(cur); cur = []; curJ = 0; }
  cur.push(c); curJ += c.judgeCnt;
}
if (cur.length) batches.push(cur);

const manifest = [];
batches.forEach((b, i) => {
  const file = `abatch-${String(i + 1).padStart(3, '0')}.json`;
  writeFileSync(join(OUT, file), JSON.stringify(b, null, 2));
  manifest.push({ file, nodes: b.length, judge: b.reduce((s, c) => s + c.judgeCnt, 0) });
});
const totalJudge = cards.reduce((s, c) => s + c.judgeCnt, 0);
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ alreadyJudgedPairs: judged.size, remainingNodes: cards.length, remainingJudge: totalJudge, batches: manifest }, null, 2));
console.log(`已判无序对：${judged.size}`);
console.log(`剩余待判：${cards.length} 个节点 / ${totalJudge} 个弱关联邻居（无序对去重、排除已判）`);
console.log(`切 ${batches.length} 批 → audit/review-all/abatch-*.json`);
