// 导出"存疑"对的二次复核批次：扫描 review-nodes/review-focused/review-all 全部 result，
//   取"无序对的全部判定均为存疑"（真正悬而未决、未被任何相关/不相关明确化）的对，
//   带中心+邻居正文与一次判定理由，按中心节点组织切批 → audit/review-suspect/sbatch-*.json。
//   只读复核结果与数据，不改任何数据。运行：node scripts/export-suspect.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPIC_NAME } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const A = join(__dirname, '..', 'audit');
const OUT = join(A, 'review-suspect');
mkdirSync(OUT, { recursive: true });
const SRC = [join(A, 'review-nodes'), join(A, 'review-focused'), join(A, 'review-all')];

const DOMAIN_CN = {
  'examination-guideline-2025': '审查指南', 'patent-law': '专利法', 'implementation-rules': '实施细则',
  'infringement-guide': '侵权判定', 'mechanical-drafting-rules': '机械撰写', 'chemistry-drafting-rules': '化学撰写', 'oa-response-guide': '答复指引',
};
const dcn = (d) => DOMAIN_CN[d] || d;
const norm = (v) => (v?.startsWith('相关') ? '相关' : v?.startsWith('不相关') ? '不相关' : '存疑');
const ukey = (a, b) => (a < b ? `${a}~${b}` : `${b}~${a}`);
const CENTER_LEN = 1400, NBR_LEN = 420, MAX_NODES_PER_BATCH = 35, MAX_JUDGE_PER_BATCH = 120;

const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));
const byId = new Map(nodes.map((n) => [n.id, n]));

function bodyText(n, len) {
  const b = bodies[n.id] || {};
  const own = (b.ownText || '').trim();
  if (own) return { text: own.slice(0, len), note: '自身正文' };
  if (b.fullText) return { text: (b.fullText || '').slice(0, len), note: '容器节点(自身无正文,下为涵盖范围预览)' };
  return { text: n.summary || '', note: '仅摘要' };
}

// 按无序对汇总全部判定；记录一条"存疑"方向用于展示
const pairVerdicts = new Map(); // ukey -> Set(verdict)
const pairInfo = new Map();     // ukey -> {centerId, nbrId, relation, prevReason}
for (const dir of SRC) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => /^(result|fresult|aresult)-\d+\.json$/.test(x))) {
    let r; try { r = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const nd of r.nodes || []) for (const j of nd.judged || []) {
      const k = ukey(nd.centerId, j.id);
      if (!pairVerdicts.has(k)) pairVerdicts.set(k, new Set());
      pairVerdicts.get(k).add(norm(j.verdict));
      if (norm(j.verdict) === '存疑' && !pairInfo.has(k)) pairInfo.set(k, { centerId: nd.centerId, nbrId: j.id, relation: j.relation, prevReason: j.reason });
    }
  }
}

// 纯存疑对：Set 只含"存疑"（无相关、无不相关）
const pure = [];
for (const [k, vs] of pairVerdicts) {
  if (vs.has('存疑') && !vs.has('相关') && !vs.has('不相关')) {
    const info = pairInfo.get(k);
    if (info && byId.has(info.centerId) && byId.has(info.nbrId)) pure.push(info);
  }
}

// 按中心节点组织（复用中心正文）
const byCenter = new Map();
for (const info of pure) {
  if (!byCenter.has(info.centerId)) byCenter.set(info.centerId, []);
  byCenter.get(info.centerId).push(info);
}

const cards = [];
for (const [cid, list] of byCenter) {
  const c = byId.get(cid);
  const ct = bodyText(c, CENTER_LEN);
  const neighbors = [];
  for (const info of list) {
    const nn = byId.get(info.nbrId);
    const bt = bodyText(nn, NBR_LEN);
    neighbors.push({
      id: nn.id, label: nn.label, path: (nn.breadcrumb || []).join(' / '), domain: dcn(nn.domain),
      topics: (nn.topics || []).map((k) => TOPIC_NAME[k] || k), relation: info.relation,
      crossDomain: nn.domain !== c.domain, prevVerdict: '存疑', prevReason: info.prevReason,
      textNote: bt.note, text: bt.text,
    });
  }
  cards.push({
    center: { id: c.id, label: c.label, path: (c.breadcrumb || []).join(' / '), domain: dcn(c.domain), topics: (c.topics || []).map((k) => TOPIC_NAME[k] || k), degree: c.degree || 0, textNote: ct.note, text: ct.text },
    neighbors, judgeCnt: neighbors.length,
  });
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
  const file = `sbatch-${String(i + 1).padStart(3, '0')}.json`;
  writeFileSync(join(OUT, file), JSON.stringify(b, null, 2));
  manifest.push({ file, nodes: b.length, judge: b.reduce((s, c) => s + c.judgeCnt, 0) });
});
const total = cards.reduce((s, c) => s + c.judgeCnt, 0);
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ pureSuspectPairs: total, centers: cards.length, batches: manifest }, null, 2));
console.log(`纯存疑对（全部判定均为存疑）：${total}　按中心组织 ${cards.length} 个中心`);
console.log(`切 ${batches.length} 批 → audit/review-suspect/sbatch-*.json`);
