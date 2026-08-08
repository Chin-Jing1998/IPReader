// 把 edge-blacklist.json（Opus 复核判不相关的 concept/colaw 固化边）从 data/edges.json 直接删除。
//   仅删弱关联固化边（concept/colaw），硬关联(hierarchy/xref/lawref)一律保留；
//   删后重算 degree 写回 nodes.json（保留 x/y 布局坐标不动，不重算 layout）。
//   运行：node scripts/apply-edge-blacklist.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const ukey = (a, b) => [a, b].sort().join('~');

const edges = JSON.parse(readFileSync(join(D, 'edges.json'), 'utf8'));
const bl = new Set(JSON.parse(readFileSync(join(D, 'edge-blacklist.json'), 'utf8')));

const before = edges.length;
const byType0 = {};
for (const e of edges) byType0[e.type] = (byType0[e.type] || 0) + 1;

const kept = edges.filter((e) => {
  if (e.type !== 'concept' && e.type !== 'colaw') return true; // 硬关联不动
  return !bl.has(ukey(e.source, e.target) + '::' + e.type);
});
const removed = before - kept.length;
const byType1 = {};
for (const e of kept) byType1[e.type] = (byType1[e.type] || 0) + 1;

writeFileSync(join(D, 'edges.json'), JSON.stringify(kept, null, 0));

// 重算 degree（仅改 degree，保留坐标等其余字段）
const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const deg = new Map();
for (const e of kept) {
  deg.set(e.source, (deg.get(e.source) || 0) + 1);
  deg.set(e.target, (deg.get(e.target) || 0) + 1);
}
for (const n of nodes) n.degree = deg.get(n.id) || 0;
writeFileSync(join(D, 'nodes.json'), JSON.stringify(nodes, null, 0));

console.log(`edge-blacklist ${bl.size} 条，实际从 edges.json 命中删除 ${removed} 条固化边`);
console.log(`边 type 分布：${JSON.stringify(byType0)}\n           → ${JSON.stringify(byType1)}`);
console.log(`edges 合计：${before} → ${kept.length}`);
const dangling = kept.filter((e) => !nodes.some((n) => n.id === e.source) || !nodes.some((n) => n.id === e.target));
console.log(dangling.length === 0 ? '✓ 无悬空边' : `✗ 悬空边 ${dangling.length}`);
