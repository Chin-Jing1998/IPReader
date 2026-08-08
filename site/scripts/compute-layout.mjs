// 数据管线 3/4（D4 增量布局版）：
//   背景：FA2 力导具有非确定性，git 中 nodes.json 的坐标是人工调优后的权威基线，绝不能因重跑而漂移。
//   因此默认走**增量模式**：
//     - 非 term 节点：x/y/size 一律取 data/layout-baseline.json（基线），逐一相等（断言）；
//     - term 节点：初始坐标 = termref 邻居基线坐标的 weight 加权质心 + 确定性抖动（按 term id 哈希，重跑一致）；
//       仅 term 参与 noverlap（每轮迭代后把非 term 坐标强制还原为基线）；size = 6~14 平滑函数（按 degree）。
//   命令行：
//     --extract-baseline  仅从当前 nodes.json（须含坐标）提取非 term 节点 id→{x,y,size} 生成基线后退出；
//     --full-relayout     旧全量路径：circlepack → FA2（term 参与，termref 边 FA2 权重 0.25）→ 向心 → noverlap
//                         → 归一化；跑完用新坐标刷新基线（慎用：会替换人工调优坐标）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';
import { circlepack } from 'graphology-layout';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const BASELINE_PATH = join(D, 'layout-baseline.json');

const args = process.argv.slice(2);
const FULL = args.includes('--full-relayout');
const EXTRACT_ONLY = args.includes('--extract-baseline');

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(D, name), 'utf8'));
  } catch (err) {
    console.error(`✗ 无法读取/解析 data/${name}：${err.message}\n  请先运行 npm run data 的前序步骤。`);
    process.exit(1);
  }
}

const isTerm = (n) => n.kind === 'term';

// 节点视觉尺寸（星等）：部最大 → 子节最小；同时用于 noverlap 留白
const SIZE = { part: 16, chapter: 9, section: 5, subsection: 3 };
function baseNodeSize(n) {
  const base = SIZE[n.level] ?? 4;
  return base + Math.min(4, Math.sqrt(n.degree || 0));
}
// term 尺寸：6~14 平滑函数（按 degree；deg=0 → 6，deg≥64 饱和到 14）
function termSize(degree) {
  return +Math.min(14, 6 + Math.sqrt(degree || 0)).toFixed(2);
}
function nodeSize(n) {
  return isTerm(n) ? termSize(n.degree) : baseNodeSize(n);
}

// 确定性 32 位哈希（FNV-1a）：term 抖动的唯一随机源，保证重跑坐标一致
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// 从节点数组提取基线（仅非 term 且坐标齐全者）；bad = 非 term 但坐标缺失/非有限的节点数
function extractBaseline(nodesArr) {
  const base = {};
  let bad = 0;
  for (const n of nodesArr) {
    if (isTerm(n)) continue;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.size)) { bad++; continue; }
    base[n.id] = { x: n.x, y: n.y, size: n.size };
  }
  return { base, bad };
}

const nodes = readJson('nodes.json');
const edges = readJson('edges.json');

// ============ --extract-baseline：仅固化基线 ============
if (EXTRACT_ONLY) {
  const { base, bad } = extractBaseline(nodes);
  const count = Object.keys(base).length;
  if (bad > 0 || count === 0) {
    console.error(`✗ 无法提取基线：${bad} 个非 term 节点缺少有效 x/y/size（共提取到 ${count} 个）。`);
    console.error('  请在 nodes.json 仍保有已提交坐标时（管线运行前）执行本命令。');
    process.exit(1);
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(base, null, 0));
  console.log(`✓ 基线已固化: ${count} 个非 term 节点 → data/layout-baseline.json`);
  process.exit(0);
}

// ============ --full-relayout：旧全量路径（term 参与 FA2）============
if (FULL) {
  const g = new Graph({ type: 'undirected' });
  for (const n of nodes) {
    // domainCommunity 为一级（域），community 为二级 → 两级 circlepack 形成"团中有团"；term 归入 0 号簇
    g.addNode(n.id, { x: 0, y: 0, size: nodeSize(n), domainCommunity: n.domainCommunity, community: n.community, level: n.level });
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target) && !g.hasEdge(e.source, e.target)) {
      // termref 参与 FA2 时压低权重（0.25），避免上千条出处边把星图拽变形
      const w = e.type === 'termref' ? 0.25 : (e.weight ?? 1);
      g.addEdge(e.source, e.target, { weight: w });
    }
  }

  // 1. circlepack 两级初始
  circlepack.assign(g, { hierarchyAttributes: ['domainCommunity', 'community'], scale: 0.8 });

  // 2. forceatlas2 全局力导（参数沿用人工调优值）
  forceAtlas2.assign(g, {
    iterations: 800,
    getEdgeWeight: 'weight',
    settings: {
      barnesHutOptimize: true,
      barnesHutTheta: 0.6,
      scalingRatio: 5,
      gravity: 2.8,
      slowDown: 9,
      outboundAttractionDistribution: true,
      linLogMode: true,
      adjustSizes: true,
      edgeWeightInfluence: 1.3,
    },
  });

  // 3. noverlap 去重叠
  noverlap.assign(g, {
    maxIterations: 200,
    settings: { margin: 6, ratio: 1.0, expansion: 1.1, gridSize: 40, speed: 3 },
  });

  // 4. 向心压拢：域团整体朝全局中心平移，使团间软过渡
  const COHESION = 0.72;
  {
    let gx = 0, gy = 0, gn = 0;
    g.forEachNode((_, a) => { gx += a.x; gy += a.y; gn++; });
    gx /= gn; gy /= gn;
    const dc = new Map();
    g.forEachNode((_, a) => {
      const e = dc.get(a.domainCommunity) ?? { sx: 0, sy: 0, n: 0 };
      e.sx += a.x; e.sy += a.y; e.n++;
      dc.set(a.domainCommunity, e);
    });
    const center = new Map([...dc].map(([d, e]) => [d, { x: e.sx / e.n, y: e.sy / e.n }]));
    g.forEachNode((id, a) => {
      const c = center.get(a.domainCommunity);
      g.setNodeAttribute(id, 'x', a.x + (gx - c.x) * (1 - COHESION));
      g.setNodeAttribute(id, 'y', a.y + (gy - c.y) * (1 - COHESION));
    });
  }

  // 5. noverlap 再去重叠
  noverlap.assign(g, {
    maxIterations: 260,
    settings: { margin: 5, ratio: 1.0, expansion: 1.05, gridSize: 40, speed: 3 },
  });

  // 归一化到以 0 为中心、最大跨度约 2600 的坐标系
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  g.forEachNode((_, a) => { minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y); });
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const SCALE = 2600 / span;

  for (const n of nodes) {
    const a = g.getNodeAttributes(n.id);
    n.x = +(((a.x - cx) * SCALE).toFixed(2));
    n.y = +(((a.y - cy) * SCALE).toFixed(2));
    n.size = +nodeSize(n).toFixed(2);
  }

  writeFileSync(join(D, 'nodes.json'), JSON.stringify(nodes, null, 0));
  // 全量重排后旧基线随之作废：用新坐标刷新（人工调优坐标被替换，需重新审视）
  const { base } = extractBaseline(nodes);
  writeFileSync(BASELINE_PATH, JSON.stringify(base, null, 0));
  console.log(`✓ 全量重排完成（${nodes.length} 节点）；⚠ layout-baseline.json 已用新坐标刷新，人工调优坐标已被替换`);
  process.exit(0);
}

// ============ 默认：增量模式 ============
// 1. 基线加载（缺失时尝试从当前 nodes.json 自动提取——仅当其仍保有坐标；否则失败退出）
let baseline;
if (existsSync(BASELINE_PATH)) {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} else {
  const { base, bad } = extractBaseline(nodes);
  if (bad > 0 || Object.keys(base).length === 0) {
    console.error('✗ 增量布局需要 data/layout-baseline.json，且当前 nodes.json 无可用坐标（管线前序步骤已重建节点）。');
    console.error('  请先在坐标仍在时执行：node scripts/compute-layout.mjs --extract-baseline');
    console.error('  或显式全量重排：node scripts/compute-layout.mjs --full-relayout');
    process.exit(1);
  }
  baseline = base;
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 0));
  console.log(`（基线缺失，已从当前 nodes.json 首跑提取 ${Object.keys(baseline).length} 个非 term 节点坐标落盘）`);
}

// 2. 非 term 节点必须全部有基线（新增内容节点须走 --full-relayout 重排后再固化）
const missing = nodes.filter((n) => !isTerm(n) && !baseline[n.id]);
if (missing.length) {
  console.error(`✗ ${missing.length} 个非 term 节点不在基线内（新增/改名的内容节点）：${missing.slice(0, 8).map((n) => n.id).join(', ')}${missing.length > 8 ? ' …' : ''}`);
  console.error('  非 term 坐标一律取基线，无法为新内容节点定位。请运行 --full-relayout 重排并复核后继续。');
  process.exit(1);
}

// 3. 非 term：一律取基线；term：termref 邻居加权质心 + 确定性抖动
for (const n of nodes) {
  if (isTerm(n)) continue;
  const b = baseline[n.id];
  n.x = b.x; n.y = b.y; n.size = b.size;
}
const posById = new Map(nodes.filter((n) => !isTerm(n)).map((n) => [n.id, n]));
const termIds = new Set(nodes.filter(isTerm).map((n) => n.id));

// termref 邻接：term id → [{id: 对端非 term 节点, w}]
const refNbr = new Map();
for (const e of edges) {
  if (e.type !== 'termref') continue;
  const [tid, oid] = termIds.has(e.source) ? [e.source, e.target] : [e.target, e.source];
  if (!termIds.has(tid) || !posById.has(oid)) continue;
  if (!refNbr.has(tid)) refNbr.set(tid, []);
  refNbr.get(tid).push({ id: oid, w: e.weight ?? 1 });
}

// 全局基线质心（无 termref 邻居的孤词兜底落点）
let gx = 0, gy = 0, gn = 0;
for (const [, p] of posById) { gx += p.x; gy += p.y; gn++; }
gx /= gn || 1; gy /= gn || 1;

let orphanTerms = 0;
for (const n of nodes) {
  if (!isTerm(n)) continue;
  const nbrs = refNbr.get(n.id) || [];
  const h = hash32(n.id);
  let x0, y0;
  if (nbrs.length) {
    let sx = 0, sy = 0, sw = 0;
    for (const nb of nbrs) {
      const p = posById.get(nb.id);
      sx += p.x * nb.w; sy += p.y * nb.w; sw += nb.w;
    }
    x0 = sx / sw; y0 = sy / sw;
    // 确定性抖动：半径 10~34、角度 0~2π，均由 id 哈希导出，重跑一致
    const ang = ((h % 3600) / 3600) * Math.PI * 2;
    const r = 10 + (((h >>> 12) % 1000) / 1000) * 24;
    x0 += Math.cos(ang) * r;
    y0 += Math.sin(ang) * r;
  } else {
    // 兜底：绕全局质心的确定性圆环（理论上不出现——过闸词均有出处）
    orphanTerms++;
    const ang = ((h % 3600) / 3600) * Math.PI * 2;
    const r = 420 + ((h >>> 12) % 380);
    x0 = gx + Math.cos(ang) * r;
    y0 = gy + Math.sin(ang) * r;
  }
  n.x = x0; n.y = y0;
  n.size = termSize(n.degree);
}

// 4. 仅 term 参与 noverlap：整图入图（term 需避让固定星点），每轮迭代后把非 term 坐标强制还原为基线
const g = new Graph({ type: 'undirected' });
for (const n of nodes) g.addNode(n.id, { x: n.x, y: n.y, size: n.size });
const NOVERLAP_ROUNDS = 6;
for (let r = 0; r < NOVERLAP_ROUNDS; r++) {
  noverlap.assign(g, {
    maxIterations: 80,
    settings: { margin: 4, ratio: 1.0, expansion: 1.02, gridSize: 40, speed: 2 },
  });
  for (const [id, p] of posById) {
    g.setNodeAttribute(id, 'x', p.x);
    g.setNodeAttribute(id, 'y', p.y);
  }
}

// 5. 写回：term 取图内坐标（2 位小数）；非 term 直接取基线原值保证逐位相等
for (const n of nodes) {
  if (!isTerm(n)) continue;
  const a = g.getNodeAttributes(n.id);
  n.x = +a.x.toFixed(2);
  n.y = +a.y.toFixed(2);
}

// ---- 断言：非 term 坐标与基线逐一相等；term x/y 全有限 ----
let ok = true;
let driftCount = 0;
for (const n of nodes) {
  if (isTerm(n)) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      ok = false;
      console.error(`✗ term 坐标非有限: ${n.id} (${n.x}, ${n.y})`);
    }
  } else {
    const b = baseline[n.id];
    if (n.x !== b.x || n.y !== b.y || n.size !== b.size) driftCount++;
  }
}
if (driftCount) { ok = false; console.error(`✗ ${driftCount} 个非 term 节点坐标偏离基线`); }

writeFileSync(join(D, 'nodes.json'), JSON.stringify(nodes, null, 0));

// ---- 统计：term 落点概览 ----
const termArr = nodes.filter(isTerm);
if (termArr.length) {
  let tnX = Infinity, txX = -Infinity, tnY = Infinity, txY = -Infinity;
  for (const n of termArr) { tnX = Math.min(tnX, n.x); txX = Math.max(txX, n.x); tnY = Math.min(tnY, n.y); txY = Math.max(txY, n.y); }
  // 每个 term 的主锚域：termref 邻居按域聚合权重取最大
  const domOfNode = new Map(nodes.filter((n) => !isTerm(n)).map((n) => [n.id, n.domain]));
  const anchorDist = {};
  for (const n of termArr) {
    const agg = new Map();
    for (const nb of refNbr.get(n.id) || []) {
      const d = domOfNode.get(nb.id);
      agg.set(d, (agg.get(d) || 0) + nb.w);
    }
    const top = [...agg].sort((a, b) => b[1] - a[1])[0];
    const k = top ? top[0] : '(无锚)';
    anchorDist[k] = (anchorDist[k] || 0) + 1;
  }
  console.log(`term 落点: ${termArr.length} 个，X[${tnX.toFixed(0)},${txX.toFixed(0)}] Y[${tnY.toFixed(0)},${txY.toFixed(0)}]，无邻居兜底 ${orphanTerms} 个`);
  console.log('term 主锚域分布:', Object.entries(anchorDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
}
console.log(ok
  ? `✓ 增量布局完成：非 term ${nodes.length - termArr.length} 个坐标与基线逐一相等，term ${termArr.length} 个坐标全有限`
  : '✗ 增量布局校验未通过');
if (!ok) process.exit(1);
