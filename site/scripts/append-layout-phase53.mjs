// 一次性脚本（阶段5.3 批次 W5）：layout-baseline.json 由 5375 键整体原子改写为 6247 键
//
// ── 用途 ────────────────────────────────────────────────────────────────────
//   阶段5.3 的两项语料改造（W1 删「公布与施行」节点、W2 正文行升格为合成节点）使 doc 节点
//   id 大面积位移：旧树 5375 → 新树 6247。compute-layout.mjs 增量模式要求每个非 term 节点
//   都能在基线中命中键，否则 exit 1；故须在重跑管线之前把坐标基线迁移到新 id 空间：
//     · 改名搬运 3886（值对象逐位不动）
//     · 删除      79（不入新集合）
//     · 原地保留 1410（unchanged，值对象逐位不动）
//     · 新增合成 951（W2 升格的 subsection 合成节点，全部落在 examination-guideline 563
//                     与 trademark-exam-guide-2021 388 两域的既有树内）
//   1410 + 3886 + 951 = 6247，与 nodes.json 的 doc 全集逐键吻合。
//
// ── 输入 ────────────────────────────────────────────────────────────────────
//   data/layout-baseline.json              迁移对象（迁移前 5375 键，值 {x, y, size}）
//   data/id-map-phase53.json               W4 产物：renamed / deleted / added（不含 unchanged
//                                          显式清单——unchanged ＝ 旧键集 − renamed 定义域 − deleted）
//   data/nodes.json                        新树 6247 doc 节点（本阶段中间态无 term 节点，属正常）
//   data/layout-baseline.json.bak_20260825_53前   迁移前备份（仅校验存在性，脚本绝不写它）
//
// ── 整体原子改写（本脚本的第一铁律）────────────────────────────────────────
//   id 空间存在大量复用：renamed 的 3886 个新 id 中 2072 个同时是另一条的旧 id（链式改名）；
//   79 个 deleted 旧 id 全部被复用为某条 renamed 的新 id。因此
//     错误做法：for (k of keys) { obj[map[k]] = obj[k]; delete obj[k] }  ← 必然互相覆盖丢数据
//     正确做法：遍历旧 Map 查表后写入**一个全新 Map**，并在写入时检测目标键碰撞。
//   本脚本按后者实现，且对每次写入做 `!newMap.has(target)` 硬断言。
//
// ── 四段处理 ────────────────────────────────────────────────────────────────
//   A. 搬运：unchanged 1410 键原名落位、renamed 3886 键按表落新键——两类均**值对象原样搬运
//      （引用相等）**，x / y / size 一律不动。
//   B. 删除：deleted 79 键不写入新 Map。
//   C. 合成：added 951 键 =「最近有坐标祖先」为质心 ＋ id 哈希确定性抖动散布。
//      祖先沿 id 段前缀逐级上溯（segs.slice(0, k)，k 递减），命中已在新 Map 中的键即止；
//      按 id 段数升序处理，保证任一 added 节点的 added 祖先届时已合成。
//   D. 去重叠松弛：仅 951 个新键参与，5296 个既有键作固定障碍（每轮不动、只被退让）
//      ——与 compute-layout.mjs 增量模式「仅 term 参与 noverlap、非 term 每轮还原基线」同构。
//
// ── 合成算法（沿用阶段5.2 append-layout-phase52.mjs 的常量与公式）──────────
//   · 同一枚 FNV-1a 32 位哈希 hash32(id) 作唯一随机源（重跑逐位一致）；
//   · 角度 = ((h % 3600) / 3600) × 2π                         —— 同 compute-layout.mjs:246
//   · 半径 = R_lo + ((h >>> 12) % 1000) / 1000 × (R_hi − R_lo) —— 同 compute-layout.mjs:247
//   · 环带 R_lo/R_hi 按「距最近既有祖先的代际」分档，取阶段5.2 的 TMEG_JITTER 原值
//     （[18,44) / [14,34) / [11,26)）：该档位当初即按 tmeg 同域兄弟间距 23.15、全库最近邻
//     间距中位 24.36 标定，本批实测全库既有最近邻中位 23.92，量级未变，故原值直接复用。
//   · size 取阶段5.2 的 level→size 口径；本批 951 个新键 level 全为 subsection，恒取 4。
//   本批与 5.2 的唯一算法性差异：5.2 的 qeval 是无基线的整域空降，需另设域质心 QEVAL_CENTER
//   与域级环带；本批 951 键全部挂在既有树的既有父节点下，无空降域，故域级参数整段不适用。
//
// ── 幂等防护（三态）─────────────────────────────────────────────────────────
//   · 输入基线键集 ≡ 新态（＝ nodes.json 的 6247 doc id 集）→ 打印「已迁移」并 exit 1；
//   · 输入基线键集 ≡ 旧态（5375 键；renamed 定义域与 deleted 全部命中；按映射表派生的终态
//     键集与 nodes.json doc 集双向零差）→ 执行；
//   · 其余任何形态 → 打印双向差集诊断并 exit 1（不做部分迁移）。
//
// ── 沿革 ────────────────────────────────────────────────────────────────────
//   阶段5.1 migrate-tmeg-layout-phase51.mjs（tmeg 四级树改名）
//   → 阶段5.2 append-layout-phase52.mjs（tmeg 扩树 ＋ qeval 整域空降，4452 → 5375）
//   → 本脚本 阶段5.3 W5（全库 id 空间原子改写，5375 → 6247）
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/append-layout-phase53.mjs [--dry-run] [--stats]
//   落盘格式与 compute-layout.mjs 一致：JSON.stringify(obj, null, 0)（单行紧凑，无缩进）
//   ——既有 layout-baseline.json 即为此形态，保持一致以免下游重跑产生无谓全文件 diff。
//   键序采用 nodes.json 的节点次序（与 5.2「保留旧文件键序」不同：本批 3886 键链式改名，
//   旧序已无对应语义，改用新树序既确定又可读）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const D = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const BASELINE_PATH = join(D, 'layout-baseline.json');
const BACKUP_PATH = join(D, 'layout-baseline.json.bak_20260825_53前');
const MAP_PATH = join(D, 'id-map-phase53.json');
const NODES_PATH = join(D, 'nodes.json');

const DRY = process.argv.includes('--dry-run');
const STATS = process.argv.includes('--stats');
// 调参旋钮（仅供 --dry-run 试算；正式执行用默认值）
const argNum = (name, def) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : def;
};

const OLD_COUNT = 5375;
const NEW_COUNT = 6247;
const EXPECT = { renamed: 3886, deleted: 79, added: 951, unchanged: 1410 };

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const assert = (cond, msg) => { if (!cond) fail(`断言失败：${msg}`); };
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const diffSet = (a, b) => [...a].filter((x) => !b.has(x));

// ============ 参数（沿用阶段5.2） ============

// 新键抖动环带：按距最近**既有坐标**祖先的代际分档（阶段5.2 TMEG_JITTER 原值）
const JITTER_BY_GEN = [
  { lo: 18, hi: 44 }, // 第 1 代（锚点为既有基线节点）
  { lo: 14, hi: 34 }, // 第 2 代
  { lo: 11, hi: 26 }, // 第 3 代及更深
];

// 新键 size：阶段5.2 口径（同级中位数，与 compute-layout 的 baseNodeSize 常见取值一致）
const SIZE_BY_LEVEL = { part: 9, chapter: 9, section: 6, subsection: 4 };

// 去重叠松弛（结构同 compute-layout 的 noverlap：固定点不动、仅新点可动）
//   margin=12 而非 compute-layout 的 4：目标接触距 = size_v + size_u + 12，对两个 subsection
//   （size 4）为 20，落在既有最近邻间距（全库中位 23.92）量级，使新键与老键疏密一致。
const RELAX = {
  iterations: argNum('iters', 2500), margin: argNum('margin', 12), damp: 0.5, maxStep: 10, cell: 64,
  leashK: argNum('leashK', 0.15),
};
const LS = argNum('leashScale', 1);
const LEASH = [145, 110, 90].map((v) => v * LS); // 各代际牵引绳长；超出则被锚点拉回，保住层级 locality

// ============ 工具 ============

// 确定性 32 位哈希（FNV-1a）：与 compute-layout.mjs 同实现，抖动的唯一随机源
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
const angleOf = (h) => ((h % 3600) / 3600) * Math.PI * 2;      // 同 compute-layout:246
const radFrac = (h) => ((h >>> 12) % 1000) / 1000;             // 同 compute-layout:247

// ============ 读入 ============

const baselineRaw = readFileSync(BASELINE_PATH, 'utf8');
const baseline = JSON.parse(baselineRaw);
const mapFile = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
const nodes = JSON.parse(readFileSync(NODES_PATH, 'utf8'));

const renamedMap = mapFile.renamed;
const deletedArr = mapFile.deleted;
const addedArr = mapFile.added;
assert(renamedMap && typeof renamedMap === 'object', 'id-map-phase53.json 缺少 renamed 表');
assert(Array.isArray(deletedArr) && Array.isArray(addedArr), 'id-map-phase53.json 缺少 deleted/added 数组');
assert(mapFile.old_doc_count === OLD_COUNT && mapFile.new_doc_count === NEW_COUNT,
  `映射表口径不符：old ${mapFile.old_doc_count} / new ${mapFile.new_doc_count}`);

const renamedPairs = Object.entries(renamedMap);
const domain = new Set(Object.keys(renamedMap));
const image = new Set(Object.values(renamedMap));
const deleted = new Set(deletedArr);
const added = new Set(addedArr);

const nodeById = new Map(nodes.map((n) => [n.id, n]));
const newIds = new Set(nodes.map((n) => n.id));

const baseKeys = Object.keys(baseline);
const baseSet = new Set(baseKeys);

// ============ 映射表自洽性 ============

assert(nodes.length === NEW_COUNT, `nodes.json 节点数应为 ${NEW_COUNT}，实际 ${nodes.length}`);
assert(newIds.size === nodes.length, 'nodes.json 存在重复 id');
assert(renamedPairs.length === EXPECT.renamed, `renamed 应为 ${EXPECT.renamed} 条，实际 ${renamedPairs.length}`);
assert(image.size === domain.size, `renamed 非单射：定义域 ${domain.size} ≠ 值域 ${image.size}`);
assert(deleted.size === EXPECT.deleted, `deleted 应为 ${EXPECT.deleted} 条，实际 ${deleted.size}`);
assert(added.size === EXPECT.added, `added 应为 ${EXPECT.added} 条，实际 ${added.size}`);
assert(diffSet(image, newIds).length === 0, 'renamed 值域存在不属于 nodes.json 的目标 id');
assert(diffSet(added, newIds).length === 0, 'added 存在不属于 nodes.json 的 id');
assert([...added].every((k) => !image.has(k)), 'added 与 renamed 值域相交');
assert([...deleted].every((k) => !added.has(k)), 'deleted 与 added 相交');

// ============ 幂等防护（三态） ============

if (eqSet(baseSet, newIds)) {
  fail(
    '基线键集已等于 nodes.json 的 6247 个 doc id，判定为**已迁移**，拒绝重复执行。\n' +
    `  当前：${baseKeys.length} 键\n` +
    '  如确需回滚重做，请先从 layout-baseline.json.bak_20260825_53前 恢复。',
  );
}
// 按映射表把当前基线键集派生为终态键集（搬运键 ∪ added），与新树 doc 集双向比对——旧态的判定式
const derive = (k) => (deleted.has(k) ? null : (renamedMap[k] ?? k));
const derivedTarget = new Set();
let deriveCollision = null;
for (const k of baseKeys) {
  const t = derive(k);
  if (t === null) continue;
  if (derivedTarget.has(t)) { deriveCollision = deriveCollision ?? [k, t]; }
  derivedTarget.add(t);
}
const derivedCarried = derivedTarget.size;
for (const k of added) {
  if (derivedTarget.has(k)) { deriveCollision = deriveCollision ?? [`added:${k}`, k]; }
  derivedTarget.add(k);
}
const missDomain = diffSet(domain, baseSet);
const missDeleted = diffSet(deleted, baseSet);
const extraAdded = [...added].filter((k) => baseSet.has(k));
const dA = diffSet(derivedTarget, newIds);   // 派生多出
const dB = diffSet(newIds, derivedTarget);   // 派生缺失
const isOldShape = baseKeys.length === OLD_COUNT
  && missDomain.length === 0 && missDeleted.length === 0 && extraAdded.length === 0
  && deriveCollision === null && dA.length === 0 && dB.length === 0;
if (!isOldShape) {
  fail(
    '基线形态既非迁移前旧态、也非迁移后新态，拒绝执行（不做部分迁移）。\n' +
    `  基线键数 ${baseKeys.length}（期望 ${OLD_COUNT}）\n` +
    `  renamed 定义域未命中基线：${missDomain.length}${missDomain.length ? '，如 ' + missDomain.slice(0, 6).join(', ') : ''}\n` +
    `  deleted 未命中基线：${missDeleted.length}${missDeleted.length ? '，如 ' + missDeleted.slice(0, 6).join(', ') : ''}\n` +
    `  added 已出现在基线：${extraAdded.length}${extraAdded.length ? '，如 ' + extraAdded.slice(0, 6).join(', ') : ''}\n` +
    `  派生键碰撞：${deriveCollision ? deriveCollision.join(' → ') : '（无）'}\n` +
    `  派生终态 ${derivedTarget.size}（搬运 ${derivedCarried} + added ${added.size}）\n` +
    `  派生终态 − 新树：${dA.length}${dA.length ? '，如 ' + dA.slice(0, 6).join(', ') : ''}\n` +
    `  新树 − 派生终态：${dB.length}${dB.length ? '，如 ' + dB.slice(0, 6).join(', ') : ''}`,
  );
}
if (!existsSync(BACKUP_PATH)) fail(`缺少迁移前备份 ${BACKUP_PATH}，拒绝执行`);

const unchangedKeys = baseKeys.filter((k) => !domain.has(k) && !deleted.has(k));
assert(unchangedKeys.length === EXPECT.unchanged,
  `unchanged 应为 ${EXPECT.unchanged} 键，实际 ${unchangedKeys.length}`);

// ============ A/B. 搬运与删除（值对象原样搬运，引用相等） ============

const carried = new Map();      // 新 id → 原值对象（引用）
const carriedFrom = new Map();  // 新 id → 旧 id（复核用）
for (const k of baseKeys) {
  if (deleted.has(k)) continue;                       // 段B：79 键不入新 Map
  const t = renamedMap[k] ?? k;
  assert(!carried.has(t), `原子改写目标键碰撞：${carriedFrom.get(t)} 与 ${k} 同时映射到 ${t}`);
  carried.set(t, baseline[k]);                        // 段A：值对象引用搬运
  carriedFrom.set(t, k);
}
assert(carried.size === OLD_COUNT - EXPECT.deleted,
  `搬运后应为 ${OLD_COUNT - EXPECT.deleted} 键，实际 ${carried.size}`);

// ============ C. 新键坐标合成 ============

const pos = new Map();          // id → {x, y, size, fixed}（既有 + 本批合成，供松弛用）
for (const [id, v] of carried) pos.set(id, { x: v.x, y: v.y, size: v.size, fixed: true });

// 最近有坐标祖先：沿 id 段前缀上溯
const nearestAnchor = (id) => {
  const segs = id.split('-');
  for (let k = segs.length - 1; k >= 1; k--) {
    const p = segs.slice(0, k).join('-');
    if (pos.has(p)) return { anchorId: p, skip: segs.length - k };
  }
  return null;
};

const freeList = [];            // 本批新增（可动）：{id, gen, anchorId, size, leash}
const genOf = new Map();        // id → 距最近既有祖先的代际（1 起）
const skipHist = new Map();     // 上溯跳级数分布（诊断用）
// 段数升序 → 同段数按 id 升序：保证 added 祖先先于其后代合成，且次序确定
const addedSorted = [...added].sort(
  (a, b) => a.split('-').length - b.split('-').length || (a < b ? -1 : a > b ? 1 : 0),
);
for (const id of addedSorted) {
  const anc = nearestAnchor(id);
  assert(anc, `新键 ${id} 找不到任何有坐标祖先`);
  const { anchorId, skip } = anc;
  skipHist.set(skip, (skipHist.get(skip) ?? 0) + 1);
  const gen = carried.has(anchorId) ? 1 : (genOf.get(anchorId) ?? 1) + 1;
  genOf.set(id, gen);
  const band = JITTER_BY_GEN[Math.min(gen, JITTER_BY_GEN.length) - 1];
  const h = hash32(id);
  const a = angleOf(h);
  const r = band.lo + radFrac(h) * (band.hi - band.lo);
  const p = pos.get(anchorId);
  const node = nodeById.get(id);
  assert(node, `新键 ${id} 不在 nodes.json 中`);
  const size = SIZE_BY_LEVEL[node.level] ?? 4;
  pos.set(id, { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, size, fixed: false });
  freeList.push({ id, gen, anchorId, size, leash: LEASH[Math.min(gen, LEASH.length) - 1] });
}
assert(freeList.length === EXPECT.added, `本批新键应为 ${EXPECT.added}，实际 ${freeList.length}`);
assert(pos.size === NEW_COUNT, `合成后坐标表应为 ${NEW_COUNT} 项，实际 ${pos.size}`);

// 合成初值快照（统计松弛位移用）
const rawSynth = new Map(freeList.map((f) => [f.id, { ...pos.get(f.id) }]));

// ============ D. 去重叠松弛（仅新键可动；既有 5296 键为固定障碍） ============
// Jacobi 迭代（先算全部位移再统一应用）→ 与遍历顺序无关，重跑逐位一致。
{
  const all = [...pos.entries()].map(([id, p]) => ({ id, p }));
  const freeSet = new Set(freeList.map((f) => f.id));
  const CELL = RELAX.cell;
  const maxFree = Math.max(...freeList.map((f) => f.size));
  const maxAny = Math.max(...[...pos.values()].map((p) => p.size));
  const maxR = maxFree + maxAny + RELAX.margin;
  assert(maxR < CELL, `网格边长 ${CELL} 必须大于最大作用半径 ${maxR}，否则 3×3 邻域漏点`);
  for (let it = 0; it < RELAX.iterations; it++) {
    // 网格分桶（每轮重建：自由点坐标已变）
    const grid = new Map();
    for (const e of all) {
      const k = `${Math.floor(e.p.x / CELL)},${Math.floor(e.p.y / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(e);
    }
    const disp = new Map();
    for (const f of freeList) {
      const v = pos.get(f.id);
      let dx = 0, dy = 0;
      const gx = Math.floor(v.x / CELL), gy = Math.floor(v.y / CELL);
      for (let ax = gx - 1; ax <= gx + 1; ax++) {
        for (let ay = gy - 1; ay <= gy + 1; ay++) {
          const bucket = grid.get(`${ax},${ay}`);
          if (!bucket) continue;
          for (const e of bucket) {
            if (e.id === f.id) continue;
            const u = e.p;
            const R = v.size + u.size + RELAX.margin;
            let ex = v.x - u.x, ey = v.y - u.y;
            let d = Math.hypot(ex, ey);
            if (d >= R) continue;
            if (d < 1e-6) { // 完全重合：用哈希导出的确定性方向拆开
              const a = angleOf(hash32(`${f.id}|${e.id}`));
              ex = Math.cos(a); ey = Math.sin(a); d = 1;
            }
            const w = freeSet.has(e.id) ? 0.5 : 1.0; // 对固定障碍全额退让，对同为自由的节点各让一半
            const push = ((R - d) / d) * w * RELAX.damp;
            dx += ex * push; dy += ey * push;
          }
        }
      }
      // 牵引绳：超出绳长则被锚点（最近有坐标祖先的当前位置）拉回，保住层级 locality
      const anchor = pos.get(f.anchorId);
      const lx = v.x - anchor.x, ly = v.y - anchor.y;
      const ld = Math.hypot(lx, ly);
      if (ld > f.leash) {
        const pull = ((ld - f.leash) / ld) * RELAX.leashK;
        dx -= lx * pull; dy -= ly * pull;
      }
      const m = Math.hypot(dx, dy);
      if (m > RELAX.maxStep) { dx = (dx / m) * RELAX.maxStep; dy = (dy / m) * RELAX.maxStep; }
      if (m > 0) disp.set(f.id, [dx, dy]);
    }
    if (!disp.size) break;
    for (const [id, [dx, dy]] of disp) { const p = pos.get(id); p.x += dx; p.y += dy; }
  }
}

// ============ 组装输出（键序 = nodes.json 节点次序） ============
const round2 = (v) => +v.toFixed(2);
const out = {};
for (const n of nodes) {
  if (carried.has(n.id)) out[n.id] = carried.get(n.id);   // 引用原值对象：x/y/size 逐位不动
  else {
    const p = pos.get(n.id);
    assert(p, `节点 ${n.id} 既未搬运也未合成`);
    out[n.id] = { x: round2(p.x), y: round2(p.y), size: p.size };
  }
}

// ============ 断言 ============
const outKeys = Object.keys(out);
assert(outKeys.length === NEW_COUNT, `终态键数应为 ${NEW_COUNT}，实际 ${outKeys.length}`);
assert(new Set(outKeys).size === outKeys.length, '终态存在重复键');
assert(eqSet(new Set(outKeys), newIds), '终态键集 ≠ nodes.json doc 集');
// 搬运的 5296 键：值对象引用相等（＝坐标与 size 逐位不动）
for (const [nk, ok] of carriedFrom) assert(out[nk] === baseline[ok], `搬运键 ${ok} → ${nk} 值未原样保留`);
assert([...carriedFrom].every(([nk, ok]) => JSON.stringify(out[nk]) === JSON.stringify(baseline[ok])),
  '搬运键序列化不逐字节相等');
// deleted 79 键不得出现在终态
const zombie = [...deleted].filter((k) => Object.prototype.hasOwnProperty.call(out, k) && !image.has(k));
assert(zombie.length === 0, `${zombie.length} 个 deleted 键仍存在于终态：${zombie.slice(0, 8).join(', ')}`);
const deletedAsNew = [...deleted].filter((k) => image.has(k));
// 全部键 x/y/size 有限
let nonFinite = 0;
for (const k of outKeys) {
  const v = out[k];
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.size)) {
    nonFinite++; console.error(`  非有限值：${k} ${JSON.stringify(v)}`);
  }
}
assert(nonFinite === 0, `${nonFinite} 个键的 x/y/size 非有限值`);
// compute-layout 前置检查自证：全部非 term 节点命中基线 + 无孤儿基线键
const missing = nodes.filter((n) => n.kind !== 'term' && n.level !== 'term' && !out[n.id]);
assert(missing.length === 0, `${missing.length} 个非 term 节点不在终态基线内：${missing.slice(0, 8).map((n) => n.id).join(', ')}`);
const orphan = outKeys.filter((k) => !nodeById.has(k));
assert(orphan.length === 0, `${orphan.length} 个基线键在 nodes.json 中无对应节点：${orphan.slice(0, 8).join(', ')}`);

// ============ 统计 ============
const freeIds = freeList.map((f) => f.id);
const fixedIds = [...carried.keys()];
const P = (id) => out[id];
// 最近邻间距（暴力精确；6247 × 951 与 5296² 量级均可接受）
function nnList(ids, refIds) {
  const ref = refIds.map((id) => ({ id, ...P(id) }));
  const ds = [];
  for (const id of ids) {
    const a = P(id);
    let m = Infinity;
    for (const b of ref) {
      if (b.id === id) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < m) m = d;
    }
    ds.push(m);
  }
  ds.sort((p, q) => p - q);
  return ds;
}
const qOf = (ds, f) => ds[Math.min(ds.length - 1, Math.floor(f * ds.length))];
const dsNew = nnList(freeIds, outKeys);
const dsFixed = nnList(fixedIds, fixedIds);
// 硬重叠（圆心距 < 两圆半径和）：节点计数，与既有基线量级对比
function overlapCount(ids, refIds) {
  const ref = refIds.map((id) => ({ id, ...P(id) }));
  let n = 0; const pairs = [];
  for (const id of ids) {
    const a = P(id);
    for (const b of ref) {
      if (b.id === id) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < a.size + b.size) { n++; pairs.push(`${id}↔${b.id}${carried.has(b.id) ? '(固)' : ''} d=${d.toFixed(1)}`); break; }
    }
  }
  return { n, pairs };
}
const ovNew = overlapCount(freeIds, outKeys);
const ovFixed = overlapCount(fixedIds, fixedIds);
// 松弛残余：仍未达到目标接触距 R = size_v + size_u + margin 的（新键, 任意键）对数
function violations(getPos) {
  let n = 0;
  const ref = outKeys.map((id) => ({ id, ...P(id) }));
  for (const f of freeList) {
    const a = getPos(f.id);
    for (const b of ref) {
      if (b.id === f.id) continue;
      const bp = carried.has(b.id) ? b : getPos(b.id);
      if (Math.hypot(a.x - bp.x, a.y - bp.y) < f.size + b.size + RELAX.margin) n++;
    }
  }
  return n;
}
const violAfter = violations((id) => P(id));
const violBefore = violations((id) => (rawSynth.has(id) ? rawSynth.get(id) : P(id)));
const ovBefore = (() => {
  let n = 0;
  const ref = outKeys.map((id) => ({ id, ...P(id) }));
  for (const f of freeList) {
    const a = rawSynth.get(f.id);
    for (const b of ref) {
      if (b.id === f.id) continue;
      const bp = carried.has(b.id) ? b : rawSynth.get(b.id);
      if (Math.hypot(a.x - bp.x, a.y - bp.y) < f.size + b.size) { n++; break; }
    }
  }
  return n;
})();
// 新键到既有键的最小距离（越界检测）
let minToFixed = Infinity, minPair = null;
for (const id of freeIds) {
  const a = P(id);
  for (const k of fixedIds) {
    const b = P(k);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < minToFixed) { minToFixed = d; minPair = [id, k]; }
  }
}
// 松弛位移
let moved = 0, movedMax = 0, movedMaxId = null;
for (const f of freeList) {
  const a = rawSynth.get(f.id), b = P(f.id);
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  moved += d; if (d > movedMax) { movedMax = d; movedMaxId = f.id; }
}
// 牵引绳越界（离锚点距离 > 绳长）
const leashBreak = freeList.filter((f) => {
  const a = P(f.id), b = P(f.anchorId);
  return Math.hypot(a.x - b.x, a.y - b.y) > f.leash * 1.001;
});
const genHist = {};
for (const f of freeList) genHist[f.gen] = (genHist[f.gen] ?? 0) + 1;
const domHist = {};
for (const id of freeIds) { const d = nodeById.get(id).domain; domHist[d] = (domHist[d] ?? 0) + 1; }

console.log('—— 坐标账 ——');
console.log(`迁移前：${baseKeys.length} 键`);
console.log(`  搬运：unchanged ${unchangedKeys.length} 原名保留 + renamed ${renamedPairs.length} 改名落新键 = ${carried.size}（值对象引用搬运）`);
console.log(`  删除：${deleted.size} 键不入新集合（其中 ${deletedAsNew.length} 个旧 id 被复用为某条 renamed 的新 id）`);
console.log(`  合成：${freeList.length} 键（${Object.entries(domHist).map(([k, v]) => `${k} ${v}`).join(' + ')}），代际 ${Object.entries(genHist).map(([k, v]) => `g${k}:${v}`).join(' ')}，上溯跳级 ${[...skipHist].map(([k, v]) => `${k}级:${v}`).join(' ')}`);
console.log(`终态：${outKeys.length} 键 = ${unchangedKeys.length} + ${renamedPairs.length} + ${freeList.length}`);
console.log(`双向差集（终态键集 ⇄ nodes.json doc 集）：多出 ${diffSet(new Set(outKeys), newIds).length} / 缺失 ${diffSet(newIds, new Set(outKeys)).length}`);
console.log(`零变动断言：搬运 ${carried.size} 键 引用相等 ✓ 序列化逐字节相等 ✓`);
console.log(`deleted 复活检查：${zombie.length} ✓；有限值：${outKeys.length}/${outKeys.length} ✓；孤儿基线键：${orphan.length} ✓`);
console.log(`compute-layout 前置自证：${nodes.length} 个非 term 节点全部命中基线 ✓`);
console.log('—— 几何 ——');
console.log(`新键最近邻（对全库 ${outKeys.length} 键）：min ${dsNew[0].toFixed(2)} p05 ${qOf(dsNew, 0.05).toFixed(2)} 中位 ${qOf(dsNew, 0.5).toFixed(2)} p95 ${qOf(dsNew, 0.95).toFixed(2)} max ${dsNew[dsNew.length - 1].toFixed(2)}`);
console.log(`既有键最近邻（对既有 ${fixedIds.length} 键，参照）：min ${dsFixed[0].toFixed(2)} p05 ${qOf(dsFixed, 0.05).toFixed(2)} 中位 ${qOf(dsFixed, 0.5).toFixed(2)} p95 ${qOf(dsFixed, 0.95).toFixed(2)} max ${dsFixed[dsFixed.length - 1].toFixed(2)}`);
console.log(`新键到既有键最小距离 ${minToFixed.toFixed(2)}（${minPair && minPair.join(' ↔ ')}）`);
console.log(`硬重叠（圆心距 < 半径和）：新键 ${ovNew.n}/${freeIds.length}（${(ovNew.n / freeIds.length * 100).toFixed(2)}%）；既有键 ${ovFixed.n}/${fixedIds.length}（${(ovFixed.n / fixedIds.length * 100).toFixed(2)}%，迁移前后不变）`);
console.log(`松弛：${RELAX.iterations} 轮 Jacobi margin=${RELAX.margin}；位移均值 ${(moved / freeList.length).toFixed(2)} 最大 ${movedMax.toFixed(2)}（${movedMaxId}）；牵引绳越界 ${leashBreak.length}`);
console.log(`松弛成效：硬重叠 ${ovBefore} → ${ovNew.n} 键；接触距违规对 ${violBefore} → ${violAfter}`);

if (STATS) {
  if (ovNew.pairs.length) console.log('  新键重叠明细：' + ovNew.pairs.join('  '));
  const s = JSON.stringify(out, null, 0);
  console.log(`产物字节数 ${s.length}；hash32 ${hash32(s).toString(16)}`);
}

if (DRY) {
  console.log('（--dry-run：未写盘）');
} else {
  writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 0));
  // 写后复核：搬运键在文件字面层面亦逐字节不变
  const after = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const beforeObj = JSON.parse(baselineRaw);
  for (const [nk, ok] of carriedFrom) {
    assert(JSON.stringify(after[nk]) === JSON.stringify(beforeObj[ok]), `写盘后 ${ok} → ${nk} 值发生变化`);
  }
  assert(Object.keys(after).length === NEW_COUNT, '写盘后键数不符');
  assert(eqSet(new Set(Object.keys(after)), newIds), '写盘后键集 ≠ nodes.json doc 集');
  console.log(`✓ 已写回 ${BASELINE_PATH}（${NEW_COUNT} 键）`);
}
