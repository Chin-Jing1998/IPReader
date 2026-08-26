// 聚焦导出（方案"聚焦能修的"）：复核节点集 = degree 最高的 FOCUS_TOP 个节点 ∪ 所有固化边(concept/跨域colaw)两端节点。
//   每个节点导出其点击点亮的全部"待判弱关联邻居"（concept/跨域colaw/topicPeers动态），切批自包含；已判节点(读取既有 result)自动排除以便续跑。
//   只读，不改数据。运行：node scripts/export-focused-nodes.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPIC_NAME } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const OUT = join(__dirname, '..', 'audit', 'review-focused');
const PRIOR = join(__dirname, '..', 'audit', 'review-nodes'); // 样本 result-01 在此
mkdirSync(OUT, { recursive: true });

// ⚠ 2026-08-23 修复：旧键 'examination-guideline-2025' 随域改名同步为 'examination-guideline'；补登此前未登记的 trademark-exam-guide-2021。
const DOMAIN_CN = {
  'examination-guideline': '审查指南', 'patent-law': '专利法', 'implementation-rules': '实施细则',
  'infringement-guide': '侵权判定', 'mechanical-drafting-rules': '机械撰写', 'chemistry-drafting-rules': '化学撰写', 'oa-response-guide': '答复指引',
  'trademark-exam-guide-2021': '商标审查指南',
};
const dcn = (d) => DOMAIN_CN[d] || d;
const CENTER_LEN = 1400, NBR_LEN = 360;
const FOCUS_TOP = 150;
const MAX_NODES_PER_BATCH = 12, MAX_JUDGE_PER_BATCH = 130;

const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const edges = JSON.parse(readFileSync(join(D, 'edges.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));
const byId = new Map(nodes.map((n) => [n.id, n]));

const children = new Map(), parent = new Map(), relByPair = new Map(), adj = new Map();
for (const n of nodes) adj.set(n.id, new Set());
for (const e of edges) {
  if (e.type === 'hierarchy') { if (!children.has(e.source)) children.set(e.source, []); children.get(e.source).push(e.target); parent.set(e.target, e.source); }
  adj.get(e.source)?.add(e.target); adj.get(e.target)?.add(e.source);
  relByPair.set(`${e.source}|${e.target}`, e.type); relByPair.set(`${e.target}|${e.source}`, e.type);
}
const TOPIC_NODES = new Map();
for (const n of nodes) for (const tk of n.topics || []) { if (!TOPIC_NODES.has(tk)) TOPIC_NODES.set(tk, []); TOPIC_NODES.get(tk).push(n.id); }
function topicPeers(id) {
  const self = byId.get(id); if (!self) return [];
  const picked = new Map();
  for (const tk of self.topics || []) {
    const byDom = new Map();
    for (const pid of TOPIC_NODES.get(tk) || []) {
      const p = byId.get(pid); if (!p || p.domain === self.domain || pid === id) continue;
      if (!byDom.has(p.domain)) byDom.set(p.domain, []); byDom.get(p.domain).push({ id: pid, deg: p.degree || 0 });
    }
    for (const arr of byDom.values()) { arr.sort((a, b) => b.deg - a.deg); for (const c of arr.slice(0, 2)) picked.set(c.id, c.deg); }
  }
  return [...picked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([pid]) => pid);
}
function bodyText(n, len) {
  const b = bodies[n.id] || {}; const own = (b.ownText || '').trim();
  if (own) return { text: own.slice(0, len), note: '自身正文' };
  if (b.fullText) return { text: (b.fullText || '').slice(0, len), note: '容器节点(自身无正文,下为涵盖范围预览)' };
  return { text: n.summary || '', note: '仅摘要' };
}
const HARD = new Set(['下一层', '上一层', '参见', '引用法条']);
function relationOf(centerId, mid) {
  const t = relByPair.get(`${centerId}|${mid}`);
  if (t === 'hierarchy') return parent.get(mid) === centerId ? '下一层' : (parent.get(centerId) === mid ? '上一层' : '同层级');
  if (t === 'xref') return '参见'; if (t === 'lawref') return '引用法条';
  if (t === 'colaw') return '共引法条'; if (t === 'concept') return '同主题桥';
  return '主题相关(动态)';
}
function buildCard(n) {
  const litSet = new Set(adj.get(n.id) || []);
  for (const p of topicPeers(n.id)) litSet.add(p);
  litSet.delete(n.id);
  const neighbors = [];
  for (const mid of litSet) {
    const m = byId.get(mid); if (!m) continue;
    const rel = relationOf(n.id, mid); const cross = m.domain !== n.domain;
    const weak = !HARD.has(rel);
    const needJudge = weak && !(rel === '共引法条' && !cross);
    if (!needJudge) continue; // 聚焦导出只装待判邻居（硬关联可靠，省 token）
    const bt = bodyText(m, NBR_LEN);
    neighbors.push({ id: m.id, label: m.label, path: (m.breadcrumb || []).join(' / '), domain: dcn(m.domain), topics: (m.topics || []).map((k) => TOPIC_NAME[k] || k), relation: rel, crossDomain: cross, needJudge: true, textNote: bt.note, text: bt.text });
  }
  const ct = bodyText(n, CENTER_LEN);
  return { center: { id: n.id, label: n.label, path: (n.breadcrumb || []).join(' / '), domain: dcn(n.domain), topics: (n.topics || []).map((k) => TOPIC_NAME[k] || k), degree: n.degree || 0, textNote: ct.note, text: ct.text }, neighbors, judgeCnt: neighbors.length };
}

// 聚焦节点集 = degree top FOCUS_TOP ∪ 固化边(concept/跨域colaw)两端
const focus = new Set();
nodes.slice().sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, FOCUS_TOP).forEach((n) => focus.add(n.id));
for (const e of edges) {
  const s = byId.get(e.source), t = byId.get(e.target); if (!s || !t) continue;
  if (e.type === 'concept' || (e.type === 'colaw' && s.domain !== t.domain)) { focus.add(s.id); focus.add(t.id); }
}

// 排除已判节点（续跑）
const judged = new Set();
for (const dir of [PRIOR, OUT]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => /^result-\d+\.json$/.test(x))) {
    try { const r = JSON.parse(readFileSync(join(dir, f), 'utf8')); for (const nd of r.nodes || []) judged.add(nd.centerId); } catch {}
  }
}

const cards = [];
for (const id of focus) {
  if (judged.has(id)) continue;
  const n = byId.get(id); if (!n) continue;
  const c = buildCard(n);
  if (c.judgeCnt > 0) cards.push(c);
}
cards.sort((a, b) => b.judgeCnt - a.judgeCnt);

// 切批
const batches = []; let cur = [], curJ = 0;
for (const c of cards) {
  if (cur.length && (cur.length >= MAX_NODES_PER_BATCH || curJ + c.judgeCnt > MAX_JUDGE_PER_BATCH)) { batches.push(cur); cur = []; curJ = 0; }
  cur.push(c); curJ += c.judgeCnt;
}
if (cur.length) batches.push(cur);

const manifest = [];
batches.forEach((b, i) => {
  const file = `fbatch-${String(i + 1).padStart(2, '0')}.json`;
  writeFileSync(join(OUT, file), JSON.stringify(b, null, 2));
  manifest.push({ file, nodes: b.length, judge: b.reduce((s, c) => s + c.judgeCnt, 0) });
});
const totalJudge = cards.reduce((s, c) => s + c.judgeCnt, 0);
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ focusNodes: focus.size, alreadyJudged: judged.size, toJudgeNodes: cards.length, totalJudge, batches: manifest }, null, 2));
console.log(`聚焦节点集：${focus.size}（degree top${FOCUS_TOP} ∪ 固化边两端）`);
console.log(`已判跳过：${judged.size} 节点；本轮待判：${cards.length} 节点 / ${totalJudge} 个邻居`);
console.log(`切 ${batches.length} 批：`, manifest.map((m) => `${m.file}(${m.nodes}节点/${m.judge}判)`).join('  '));
console.log(`→ audit/review-focused/`);
