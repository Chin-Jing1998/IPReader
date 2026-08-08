// 以"节点"为中心导出复核单元：还原每个节点点击后点亮的完整关联集合（neighborsOf 全边 + topicPeers 动态），
//   按关系类型分组（硬关联=下一层/参见/引法条 可靠；弱关联=同主题桥/跨域共引/主题相关 需判），切批自包含。
//   供 Opus 4.8 子 agent 逐个节点读正文、判定每个"弱关联邻居"是否与中心节点真相关。只读，不改数据。
//   运行：node scripts/export-node-review.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS, TOPIC_NAME } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const OUT = join(__dirname, '..', 'audit', 'review-nodes');
mkdirSync(OUT, { recursive: true });

const DOMAIN_CN = {
  'examination-guideline-2025': '审查指南',
  'patent-law': '专利法',
  'implementation-rules': '实施细则',
  'infringement-guide': '侵权判定',
  'mechanical-drafting-rules': '机械撰写',
  'chemistry-drafting-rules': '化学撰写',
  'oa-response-guide': '答复指引',
};
const dcn = (d) => DOMAIN_CN[d] || d;

const CENTER_LEN = 1400; // 中心节点正文
const NBR_LEN = 360; // 邻居正文摘要
const MAX_NODES_PER_BATCH = 10;
const MAX_JUDGE_PER_BATCH = 110; // 每批待判邻居数上限

const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const edges = JSON.parse(readFileSync(join(D, 'edges.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));
const byId = new Map(nodes.map((n) => [n.id, n]));

// ---- 索引 ----
const children = new Map();
const parent = new Map();
const relByPair = new Map(); // "a|b" -> edgeType（无向）
const adj = new Map();
for (const n of nodes) adj.set(n.id, new Set());
for (const e of edges) {
  if (e.type === 'hierarchy') {
    if (!children.has(e.source)) children.set(e.source, []);
    children.get(e.source).push(e.target);
    parent.set(e.target, e.source);
  }
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
// 复现前端 topicPeers（main.ts）：每主题每跨域取 degree 高的 2 个，封顶 24
function topicPeers(id) {
  const self = byId.get(id);
  if (!self) return [];
  const picked = new Map();
  for (const tk of self.topics || []) {
    const byDom = new Map();
    for (const pid of TOPIC_NODES.get(tk) || []) {
      const p = byId.get(pid);
      if (!p || p.domain === self.domain || pid === id) continue;
      if (!byDom.has(p.domain)) byDom.set(p.domain, []);
      byDom.get(p.domain).push({ id: pid, deg: p.degree || 0 });
    }
    for (const arr of byDom.values()) {
      arr.sort((a, b) => b.deg - a.deg);
      for (const c of arr.slice(0, 2)) picked.set(c.id, c.deg);
    }
  }
  return [...picked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([pid]) => pid);
}

function bodyText(n, len) {
  const b = bodies[n.id] || {};
  const own = (b.ownText || '').trim();
  if (own) return { text: own.slice(0, len), note: '自身正文', container: false };
  if (b.fullText) return { text: (b.fullText || '').slice(0, len), note: '容器节点(自身无正文,下为涵盖范围预览)', container: true };
  return { text: n.summary || '', note: '仅摘要', container: !own };
}

// 关系类型 → 是否硬关联（事实性可靠）
const HARD = new Set(['下一层', '上一层', '参见', '引用法条']);
function relationOf(centerId, mid) {
  const t = relByPair.get(`${centerId}|${mid}`);
  if (t === 'hierarchy') return parent.get(mid) === centerId ? '下一层' : (parent.get(centerId) === mid ? '上一层' : '同层级');
  if (t === 'xref') return '参见';
  if (t === 'lawref') return '引用法条';
  if (t === 'colaw') return '共引法条';
  if (t === 'concept') return '同主题桥';
  return '主题相关(动态)'; // 仅来自 topicPeers，无显式边
}

// ---- 为每个节点构造点亮卡片 ----
const cards = [];
for (const n of nodes) {
  const litSet = new Set(adj.get(n.id) || []);
  for (const p of topicPeers(n.id)) litSet.add(p);
  litSet.delete(n.id);
  if (litSet.size === 0) continue;

  const neighbors = [];
  for (const mid of litSet) {
    const m = byId.get(mid);
    if (!m) continue;
    const rel = relationOf(n.id, mid);
    const cross = m.domain !== n.domain;
    const weak = !HARD.has(rel); // 同主题桥/共引法条/主题相关 → 需判
    // 跨域 colaw 才需判；同域 colaw 视为较可靠（同域共引法条通常确实相关），降级为不判但标注
    const needJudge = weak && !(rel === '共引法条' && !cross);
    const bt = bodyText(m, NBR_LEN);
    neighbors.push({
      id: m.id,
      label: m.label,
      path: (m.breadcrumb || []).join(' / '),
      domain: dcn(m.domain),
      topics: (m.topics || []).map((k) => TOPIC_NAME[k] || k),
      relation: rel,
      crossDomain: cross,
      needJudge,
      textNote: bt.note,
      text: bt.text,
    });
  }
  const judgeCnt = neighbors.filter((x) => x.needJudge).length;
  const ct = bodyText(n, CENTER_LEN);
  cards.push({
    center: {
      id: n.id,
      label: n.label,
      path: (n.breadcrumb || []).join(' / '),
      domain: dcn(n.domain),
      topics: (n.topics || []).map((k) => TOPIC_NAME[k] || k),
      degree: n.degree || 0,
      textNote: ct.note,
      text: ct.text,
    },
    neighbors: neighbors.sort((a, b) => Number(b.needJudge) - Number(a.needJudge)),
    judgeCnt,
  });
}

// ---- 划分：需复核（含待判邻居） vs 免复核（纯硬关联） ----
const needReview = cards.filter((c) => c.judgeCnt > 0).sort((a, b) => b.judgeCnt - a.judgeCnt);
const safeCnt = cards.length - needReview.length;
const totalJudge = needReview.reduce((s, c) => s + c.judgeCnt, 0);

// ---- 切批：每批 ≤ MAX_NODES_PER_BATCH 节点且 ≤ MAX_JUDGE_PER_BATCH 待判邻居；超大节点单独成批 ----
const batches = [];
let cur = [];
let curJudge = 0;
for (const c of needReview) {
  if (cur.length && (cur.length >= MAX_NODES_PER_BATCH || curJudge + c.judgeCnt > MAX_JUDGE_PER_BATCH)) {
    batches.push(cur);
    cur = [];
    curJudge = 0;
  }
  cur.push(c);
  curJudge += c.judgeCnt;
}
if (cur.length) batches.push(cur);

const manifest = [];
batches.forEach((b, i) => {
  const file = `node-batch-${String(i + 1).padStart(2, '0')}.json`;
  writeFileSync(join(OUT, file), JSON.stringify(b, null, 2));
  manifest.push({ file, nodes: b.length, judge: b.reduce((s, c) => s + c.judgeCnt, 0) });
});
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ totalNodes: cards.length, needReview: needReview.length, safe: safeCnt, totalJudge, batches: manifest }, null, 2));

console.log(`有点亮邻居的节点：${cards.length}`);
console.log(`  免复核(点亮集纯硬关联·可靠)：${safeCnt}`);
console.log(`  需复核(含弱关联邻居)：${needReview.length}，待判邻居合计 ${totalJudge}`);
console.log(`切 ${batches.length} 批：`, manifest.map((m) => `${m.file}(${m.nodes}节点/${m.judge}判)`).join('  '));
console.log(`→ audit/review-nodes/`);
