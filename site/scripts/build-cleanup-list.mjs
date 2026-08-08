// 把 Opus 复核结论固化为两份黑名单，供数据管线与前端消费（只读复核结果，生成 data/*-blacklist.json）。
//   ① edge-blacklist.json：concept/colaw 固化边中"纯不相关"(无任一方向判相关)的，extract-edges 据此剔除。
//   ② peer-blacklist.json：{pairs:动态(topicPeers)纯不相关对, excludeNodes:被判不相关≥阈值的"污染源"节点}，前端 topicPeers 据此提纯。
//   保守策略：方向冲突(一端相关一端不相关)与纯存疑一律保留，不进黑名单。
//   运行：node scripts/build-cleanup-list.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const OUT = join(__dirname, '..', 'audit');
const DIRS = [join(OUT, 'review-nodes'), join(OUT, 'review-focused'), join(OUT, 'review-all'), join(OUT, 'review-suspect')];

const REL2TYPE = { '同主题桥': 'concept', '共引法条': 'colaw' };
// 按用户决策：存疑一律按"不相关"处理（不保留存疑弱连）；仅"相关"为相关，其余（不相关/存疑）归不相关。
const norm = (v) => (v?.startsWith('相关') ? '相关' : '不相关');
const ukey = (a, b) => [a, b].sort().join('~');

const rows = [];
for (const dir of DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => /^(result|fresult|aresult|sresult)-(\d+|fix)\.json$/.test(x))) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const nd of r.nodes || []) for (const j of nd.judged || []) rows.push({ c: nd.centerId, n: j.id, rel: j.relation, v: norm(j.verdict) });
  }
}

const fixed = new Map(); // "a~b::type" -> Set(verdict)
const dyn = new Map(); // "a~b" -> Set(verdict)
const polluteBad = new Map(); // nodeId -> 被判不相关次数
for (const r of rows) {
  if (r.v === '不相关') polluteBad.set(r.n, (polluteBad.get(r.n) || 0) + 1);
  const t = REL2TYPE[r.rel];
  if (t) {
    const k = ukey(r.c, r.n) + '::' + t;
    if (!fixed.has(k)) fixed.set(k, new Set());
    fixed.get(k).add(r.v);
  } else {
    const k = ukey(r.c, r.n);
    if (!dyn.has(k)) dyn.set(k, new Set());
    dyn.get(k).add(r.v);
  }
}

// 固化边：只有不相关（含 不相关+存疑），无任一方向判相关 → 删
const edgeBlacklist = [];
let keepRel = 0, conflict = 0, pureSuspect = 0;
for (const [k, vs] of fixed) {
  if (vs.has('不相关') && !vs.has('相关')) edgeBlacklist.push(k);
  else if (vs.has('不相关') && vs.has('相关')) conflict++;
  else if (vs.has('相关')) keepRel++;
  else pureSuspect++;
}

// 动态 topicPeers：纯不相关对 → 黑名单
const peerPairs = [];
for (const [k, vs] of dyn) if (vs.has('不相关') && !vs.has('相关')) peerPairs.push(k);

// 污染源：被判不相关 ≥ 阈值的"万能邻居" → topicPeers 不再拉取
const EXCLUDE_MIN = 12;
const excludeNodes = [...polluteBad.entries()].filter(([, c]) => c >= EXCLUDE_MIN).sort((a, b) => b[1] - a[1]).map(([id]) => id);

writeFileSync(join(D, 'edge-blacklist.json'), JSON.stringify(edgeBlacklist));
writeFileSync(join(D, 'peer-blacklist.json'), JSON.stringify({ pairs: peerPairs, excludeNodes }));

const cConcept = edgeBlacklist.filter((k) => k.endsWith('::concept')).length;
const cColaw = edgeBlacklist.filter((k) => k.endsWith('::colaw')).length;
console.log(`固化边删名单 ${edgeBlacklist.length} 条（concept ${cConcept} / colaw ${cColaw}）`);
console.log(`  保守保留：判相关 ${keepRel}、纯存疑 ${pureSuspect}、方向冲突 ${conflict}`);
console.log(`topicPeers 动态黑名单 ${peerPairs.length} 对；污染源排除节点(被判不相关≥${EXCLUDE_MIN}次) ${excludeNodes.length} 个`);
console.log('→ data/edge-blacklist.json、data/peer-blacklist.json');
