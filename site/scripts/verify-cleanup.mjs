// 验证第二阶段成效：复现"修复前(旧edges+旧topicPeers)"与"修复后(新edges+分级+提纯topicPeers)"两套点击点亮逻辑，
//   对代表节点对比点亮集大小与跨域占比，量化"无关连接被清理"的程度。只读，不改数据。
//   运行：node scripts/verify-cleanup.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const BK = join(__dirname, '..', 'audit', 'backup');
const rd = (p) => JSON.parse(readFileSync(p, 'utf8'));

const oldNodes = rd(join(BK, 'nodes.json.bak'));
const oldEdges = rd(join(BK, 'edges.json.bak'));
const newNodes = rd(join(D, 'nodes.json'));
const newEdges = rd(join(D, 'edges.json'));
const pb = rd(join(D, 'peer-blacklist.json'));
const PEER_EXCLUDE = new Set(pb.excludeNodes);
const PEER_BLACKPAIRS = new Set(pb.pairs);
const peerKey = (a, b) => (a < b ? `${a}~${b}` : `${b}~${a}`);
const HARD = new Set(['hierarchy', 'xref', 'lawref']);

function index(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map(); // id -> [{id, etype}]
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.source)?.push({ id: e.target, etype: e.type });
    adj.get(e.target)?.push({ id: e.source, etype: e.type });
  }
  const TOPIC_NODES = new Map();
  for (const n of nodes) for (const tk of n.topics || []) {
    if (!TOPIC_NODES.has(tk)) TOPIC_NODES.set(tk, []);
    TOPIC_NODES.get(tk).push(n.id);
  }
  return { byId, adj, TOPIC_NODES };
}
const OLD = index(oldNodes, oldEdges);
const NEW = index(newNodes, newEdges);

// topicPeers 复现；filter=true 时套用黑名单与污染源排除（新逻辑）
function topicPeers(idx, id, filter) {
  const self = idx.byId.get(id);
  if (!self) return [];
  const picked = new Map();
  for (const tk of self.topics || []) {
    const byDom = new Map();
    for (const pid of idx.TOPIC_NODES.get(tk) || []) {
      const p = idx.byId.get(pid);
      if (!p || p.domain === self.domain || pid === id) continue;
      if (filter && PEER_EXCLUDE.has(pid)) continue;
      if (filter && PEER_BLACKPAIRS.has(peerKey(id, pid))) continue;
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

// 修复前点亮：全部邻居（不分类型）+ 旧 topicPeers（无过滤）
function litOld(id) {
  const s = new Set([id]);
  for (const nb of OLD.adj.get(id) || []) s.add(nb.id);
  for (const p of topicPeers(OLD, id, false)) s.add(p);
  s.delete(id);
  return s;
}
// 修复后点亮：strong(硬关联) + soft(弱关联 concept/colaw + 提纯 topicPeers)
function litNew(id) {
  const strong = new Set(), soft = new Set();
  for (const nb of NEW.adj.get(id) || []) (HARD.has(nb.etype) ? strong : soft).add(nb.id);
  for (const p of topicPeers(NEW, id, true)) soft.add(p);
  for (const x of strong) soft.delete(x);
  strong.delete(id);
  return { strong, soft, total: new Set([...strong, ...soft]) };
}

// ⚠ 2026-08-23 修复：旧键 'examination-guideline-2025' 随域改名同步为 'examination-guideline'；补登此前未登记的 trademark-exam-guide-2021。
const dcn = (d) => ({ 'examination-guideline': '审查指南', 'patent-law': '专利法', 'implementation-rules': '实施细则', 'infringement-guide': '侵权判定', 'mechanical-drafting-rules': '机械撰写', 'chemistry-drafting-rules': '化学撰写', 'oa-response-guide': '答复指引', 'trademark-exam-guide-2021': '商标审查指南' }[d] || d);
const cross = (id, set) => { const dom = NEW.byId.get(id)?.domain || OLD.byId.get(id)?.domain; let c = 0; for (const x of set) { const d = (NEW.byId.get(x) || OLD.byId.get(x))?.domain; if (d !== dom) c++; } return c; };

const samples = ['02-08-04', '02-09-06', '01-01-06', '06-02-06', 'infr-02-03', 'law-03-08', '02-01-02-01'];
console.log('节点 | 修复前点亮(跨域) → 修复后总点亮(跨域) | 其中 硬关联/弱关联淡显');
console.log('—'.repeat(92));
for (const id of samples) {
  const lbl = (NEW.byId.get(id) || OLD.byId.get(id))?.label || id;
  const o = litOld(id);
  const n = litNew(id);
  console.log(`${id} ${lbl}（${dcn((NEW.byId.get(id) || OLD.byId.get(id))?.domain)}）`);
  console.log(`   修复前 ${o.size}(跨域${cross(id, o)}) → 修复后 ${n.total.size}(跨域${cross(id, n.total)})　｜　硬关联 ${n.strong.size} / 弱关联淡显 ${n.soft.size}`);
}
