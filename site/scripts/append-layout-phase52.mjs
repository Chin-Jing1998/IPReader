// 一次性脚本（阶段5.2 批次 W-3）：layout-baseline.json 的 tmeg 扩树迁移 + qeval 整域落位
//
// 背景
//   · 批次 W-1 把《商标审查审理指南》域（tmeg）由 104 节点四级树扩为 813 节点六级树
//     （part8 / chapter44 / section206 / subsection555，语义深度上限 6）：旧 104 节点全部存续
//     （52 个 id 不变 + 52 个改名），新增 709 个来自正文一级/二级数字编号段的节点。
//     新旧对应关系由 data/tmeg-id-map-phase52.json 固化（主键＝源 md 行号）。
//   · 批次 Q-1 召回《专利质量评价指南》（qeval）为第 88 域，214 节点（chapter15 / section199），
//     全新入库、无任何坐标基线，书根不成节点（域内顶层即 15 章）。
//   · compute-layout.mjs 增量模式要求每个非 term 节点都能在基线中命中键，否则 exit 1；
//     故须在重跑管线之前把基线由 4452 键补到 5375 键（＝非 tmeg 4348 + tmeg 813 + qeval 214）。
//
// 三段处理
//   A. tmeg 迁移：52 个 unchanged 键原地保留、52 个 renamed 键按映射表改名搬运——两类均**值对象
//      原样搬运（引用相等）**，坐标与 size 一律不动。
//   B. tmeg 新增 709 键合成：以「最近有坐标祖先」为质心 + id 哈希确定性抖动散布。
//   C. qeval 整域 214 键合成：先为域选全局落位（见 QEVAL_CENTER 选位依据），15 章绕域质心散布、
//      199 条绕各自章散布，同款「质心 + 哈希抖动」。
//   D. 去重叠松弛：仅 923 个新键参与，4452 个既有键作为固定障碍每轮强制还原
//      （与 compute-layout.mjs 增量模式「仅 term 参与 noverlap、非 term 每轮还原基线」同构）。
//
// 合成算法与 compute-layout.mjs:230-258（term 坐标合成）看齐：
//   · 同一枚 FNV-1a 32 位哈希 hash32(id) 作唯一随机源（重跑逐位一致）；
//   · 角度 = ((h % 3600) / 3600) × 2π —— 与 compute-layout 取同一比特切片；
//   · 半径 = R_lo + ((h >>> 12) % 1000) / 1000 × (R_hi − R_lo) —— 同上，仅把 term 的固定
//     [10, 34) 换成按「代际／层级」分档（见 TMEG_JITTER / QEVAL_JITTER），量级对齐同域兄弟间距
//     （tmeg 既有 100 个基线点的最近邻间距中位数 23.15，全库中位数 24.36）。
//
// 幂等防护：脚本只接受一种基线形态——
//   · 键总数 4452、tmeg 键集 ≡ 映射表定义域（104 键）、无任何 qeval- 前缀键 → 执行；
//   · tmeg 键集 ≡ nodes.json 的 813 个 tmeg id 或已存在 qeval- 键 → 判定已迁移，拒绝并 exit 1；
//   · 其余任何形态一律判为基线与本批产物不匹配，拒绝并 exit 1（不做部分迁移）。
//
// 用法：node scripts/append-layout-phase52.mjs [--dry-run] [--stats]
// 落盘格式与 compute-layout.mjs 一致：JSON.stringify(obj, null, 0)
// 迁移前备份：data/layout-baseline.json.bak_20260824_W3前

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const D = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const BASELINE_PATH = join(D, 'layout-baseline.json');
const BACKUP_PATH = join(D, 'layout-baseline.json.bak_20260824_W3前');
const MAP_PATH = join(D, 'tmeg-id-map-phase52.json');
const NODES_PATH = join(D, 'nodes.json');

const DRY = process.argv.includes('--dry-run');
const STATS = process.argv.includes('--stats');
// 调参旋钮（仅供 --dry-run 试算；正式执行用默认值）
const argNum = (name, def) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : def;
};

const TMEG = 'trademark-exam-guide-2021';
const QEVAL = 'quality-evaluation';
const TMEG_PREFIX = 'tmeg-';
const QEVAL_PREFIX = 'qeval-';

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const assert = (cond, msg) => { if (!cond) fail(`断言失败：${msg}`); };
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// ============ 参数 ============

// qeval 域质心：选位依据（数据见脚本尾部 --stats 输出）
//   1. 同 field（专利）：qeval 为 D5 审查与实务指引、field=专利，落位限定在专利域半平面；
//   2. 净空最大：以 25 单位网格遍历全图，在「撰写实务三书（chemistry / mechanical-drafting-rules /
//      oa-response-guide）质心 (396.5, −252.1)」1600 半径邻域内，(1375, −425) 对全部 4452 个既有
//      基线点的最小距离 364.4 为该邻域最大值；
//   3. 容量足够：214 节点按全库最近邻间距中位数 24.4 估算需 r≈180 的圆盘，364 的净空留出 ≥170 余量；
//   4. 语义邻书：最近四个域质心依次为 plant-variety-interp-2001@399、punitive-damages-interp@430、
//      patent-law@653、patent-dispute-rules@671，皆属专利／司法解释扩展组，无跨 field 侵占。
const QEVAL_CENTER = { x: 1375, y: -425 };
const QEVAL_CHAPTER_RING = { r: 105, jitter: 30 }; // 15 章均分环半径 105、半径抖动 ±15
const QEVAL_SECTION_JITTER = { lo: 20, hi: 52 };   // 条绕章：环带 [20, 52)，与章间距 2π×105/15≈44 同量级

// tmeg 新增节点抖动环带（按距最近**基线**祖先的代际分档，量级对齐同域兄弟间距 23.15）
const TMEG_JITTER = [
  { lo: 18, hi: 44 }, // 第 1 代（父为基线节点）
  { lo: 14, hi: 34 }, // 第 2 代
  { lo: 11, hi: 26 }, // 第 3 代及更深
];

// 新键 size：取同级中位数（tmeg 用同域基线同级中位数 section 6 / subsection 4；
//   qeval 用全库基线同级中位数 chapter 9 / section 6），与 compute-layout 的
//   baseNodeSize = SIZE[level] + min(4, √degree) 的常见取值一致。
const SIZE_BY_LEVEL = { part: 9, chapter: 9, section: 6, subsection: 4 };

// 去重叠松弛（结构同 compute-layout 的 noverlap：固定点每轮还原、仅新点可动）
//   margin=12 而非 compute-layout 的 4：目标接触距 = size_v + size_u + 12，对两个 subsection（size 4）
//   为 20、对两个 qeval 条（size 6）为 24，正好落在同域既有最近邻间距（tmeg 23.15 / 全库 24.36）量级，
//   使新域与老域的视觉疏密一致；margin=4 只能排掉硬重叠、簇会挤成中位间距 8 的团。
const RELAX = {
  iterations: argNum('iters', 2500), margin: argNum('margin', 12), damp: 0.5, maxStep: 10, cell: 64,
  leashK: argNum('leashK', 0.15),
};
const LS = argNum('leashScale', 1); // 调参旋钮，默认 1（即下方即为最终绳长）
const LEASH = [145, 110, 90].map((v) => v * LS); // tmeg 各代际的牵引绳长；超出则被父节点拉回
const QEVAL_LEASH = { chapter: 337.5 * LS, section: 165 * LS };

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

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const baselineRaw = readFileSync(BASELINE_PATH, 'utf8');
const mapFile = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
const o2n = mapFile['old→new'];
assert(o2n && typeof o2n === 'object', 'tmeg-id-map-phase52.json 缺少 old→new 表');
const nodes = JSON.parse(readFileSync(NODES_PATH, 'utf8'));

const nodeById = new Map(nodes.map((n) => [n.id, n]));
const tmegNodes = nodes.filter((n) => n.domain === TMEG);
const qevalNodes = nodes.filter((n) => n.domain === QEVAL);
const tmegIds = new Set(tmegNodes.map((n) => n.id));
const qevalIds = new Set(qevalNodes.map((n) => n.id));

const baseKeys = Object.keys(baseline);
const tmegKeys = baseKeys.filter((k) => k.startsWith(TMEG_PREFIX));
const qevalKeys = baseKeys.filter((k) => k.startsWith(QEVAL_PREFIX));
const otherKeys = baseKeys.filter((k) => !k.startsWith(TMEG_PREFIX) && !k.startsWith(QEVAL_PREFIX));

// ============ 幂等防护 ============

const domain = new Set(Object.keys(o2n));
const image = new Set(Object.values(o2n));
assert(image.size === domain.size, `映射表非单射：定义域 ${domain.size} ≠ 值域 ${image.size}`);
assert(domain.size === 104, `映射表定义域应为 104 键，实际 ${domain.size}`);
for (const t of image) assert(tmegIds.has(t), `映射表目标 ${t} 不在 nodes.json 的 tmeg 节点集中`);

if (qevalKeys.length || eqSet(new Set(tmegKeys), tmegIds)) {
  fail(
    '基线已含 qeval 键或 tmeg 键集已等于 nodes.json 的 813 个 tmeg id，判定为**已迁移**，拒绝重复执行。\n' +
    `  当前：tmeg ${tmegKeys.length} 键 / qeval ${qevalKeys.length} 键 / 总 ${baseKeys.length} 键\n` +
    '  如确需回滚重做，请先从 layout-baseline.json.bak_20260824_W3前 恢复。',
  );
}
if (!eqSet(new Set(tmegKeys), domain)) {
  const extra = tmegKeys.filter((k) => !domain.has(k));
  const miss = [...domain].filter((k) => !tmegKeys.includes(k));
  fail(
    '基线 tmeg 键集与映射表迁移前形态不一致，拒绝执行（不做部分迁移）。\n' +
    `  基线 tmeg ${tmegKeys.length} / 期望 ${domain.size}\n` +
    `  基线多出：${extra.join(', ') || '（无）'}\n  基线缺失：${miss.join(', ') || '（无）'}`,
  );
}
assert(baseKeys.length === 4452, `迁移前基线键数应为 4452，实际 ${baseKeys.length}`);
assert(otherKeys.length === 4348, `非 tmeg/qeval 键数应为 4348，实际 ${otherKeys.length}`);
assert(tmegIds.size === 813, `nodes.json 的 tmeg 节点应为 813，实际 ${tmegIds.size}`);
assert(qevalIds.size === 214, `nodes.json 的 qeval 节点应为 214，实际 ${qevalIds.size}`);
assert(nodes.length === 5375, `nodes.json 节点总数应为 5375，实际 ${nodes.length}`);
if (!existsSync(BACKUP_PATH)) fail(`缺少迁移前备份 ${BACKUP_PATH}，拒绝执行`);

// ============ A. tmeg 迁移（值对象原样搬运） ============

const out = {};                 // 最终基线（保持「非 tmeg 前缀段 → tmeg 块 → 非 tmeg 后缀段 → qeval 块」顺序）
const migrated = new Map();     // 新 id → 原值对象（引用）
for (const [ok, nk] of Object.entries(o2n)) migrated.set(nk, baseline[ok]);
const renamed = Object.entries(o2n).filter(([a, b]) => a !== b);
const unchanged = Object.entries(o2n).filter(([a, b]) => a === b);

// ============ B/C. 新键坐标合成 ============

const parentIdOf = (id) => {
  const segs = id.split('-');
  return segs.length > 2 ? segs.slice(0, -1).join('-') : null;
};

const pos = new Map();          // id → {x, y}（含既有基线 + 本批合成，供松弛用）
for (const k of otherKeys) pos.set(k, { x: baseline[k].x, y: baseline[k].y, fixed: true, size: baseline[k].size });
for (const [nk, v] of migrated) pos.set(nk, { x: v.x, y: v.y, fixed: true, size: v.size });

const freeList = [];            // 本批新增（可动）节点：{id, gen, anchorId, size}

// ---- B. tmeg 709 新键：按 id 段数（树深）升序逐层合成，父节点届时必已有坐标 ----
const tmegNew = tmegNodes.filter((n) => !migrated.has(n.id));
assert(tmegNew.length === 709, `tmeg 新增节点应为 709，实际 ${tmegNew.length}`);
const genOf = new Map();        // id → 距最近**基线**祖先的代际（1 起）
for (const n of [...tmegNew].sort((a, b) => a.id.split('-').length - b.id.split('-').length || (a.id < b.id ? -1 : 1))) {
  const pid = parentIdOf(n.id);
  assert(pid && pos.has(pid), `tmeg 新节点 ${n.id} 的父 ${pid} 无坐标（层序合成被打断）`);
  const gen = migrated.has(pid) || !genOf.has(pid) ? 1 : genOf.get(pid) + 1;
  genOf.set(n.id, gen);
  const band = TMEG_JITTER[Math.min(gen, TMEG_JITTER.length) - 1];
  const h = hash32(n.id);
  const a = angleOf(h);
  const r = band.lo + radFrac(h) * (band.hi - band.lo);
  const p = pos.get(pid);
  const size = SIZE_BY_LEVEL[n.level] ?? 4;
  pos.set(n.id, { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, fixed: false, size });
  freeList.push({ id: n.id, gen, anchorId: pid, size, leash: LEASH[Math.min(gen, LEASH.length) - 1] });
}

// ---- C. qeval 214 键：15 章绕域质心均分环、199 条绕各自章 ----
const qChapters = qevalNodes.filter((n) => n.id.split('-').length === 2);
const qSections = qevalNodes.filter((n) => n.id.split('-').length === 3);
assert(qChapters.length === 15 && qSections.length === 199,
  `qeval 应为 15 章 + 199 条，实际 ${qChapters.length} + ${qSections.length}`);
qChapters.forEach((n, i) => {
  const h = hash32(n.id);
  // 均分环 + 槽内哈希抖动（±0.3 槽宽），避免 15 章挤成一堆的同时保持确定性
  const a = (2 * Math.PI * (i + (radFrac(h) - 0.5) * 0.6)) / qChapters.length;
  const r = QEVAL_CHAPTER_RING.r + (angleOf(h) / (2 * Math.PI) - 0.5) * QEVAL_CHAPTER_RING.jitter;
  const size = SIZE_BY_LEVEL[n.level] ?? 4;
  pos.set(n.id, { x: QEVAL_CENTER.x + Math.cos(a) * r, y: QEVAL_CENTER.y + Math.sin(a) * r, fixed: false, size });
  freeList.push({ id: n.id, gen: 0, anchorId: null, size, leash: QEVAL_LEASH.chapter });
});
for (const n of qSections) {
  const pid = parentIdOf(n.id);
  assert(pid && pos.has(pid), `qeval 条 ${n.id} 的章 ${pid} 无坐标`);
  const h = hash32(n.id);
  const a = angleOf(h);
  const r = QEVAL_SECTION_JITTER.lo + radFrac(h) * (QEVAL_SECTION_JITTER.hi - QEVAL_SECTION_JITTER.lo);
  const p = pos.get(pid);
  const size = SIZE_BY_LEVEL[n.level] ?? 4;
  pos.set(n.id, { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, fixed: false, size });
  freeList.push({ id: n.id, gen: 1, anchorId: pid, size, leash: QEVAL_LEASH.section });
}
assert(freeList.length === 923, `本批新键应为 923（709 + 214），实际 ${freeList.length}`);

// 合成初值快照（用于统计对比）
const rawSynth = new Map([...freeList].map((f) => [f.id, { ...pos.get(f.id) }]));

// ============ D. 去重叠松弛（仅新键可动；既有 4452 键为固定障碍） ============
// Jacobi 迭代（先算全部位移再统一应用）→ 与遍历顺序无关，重跑逐位一致。
{
  const all = [...pos.entries()].map(([id, p]) => ({ id, p }));
  const freeSet = new Map(freeList.map((f) => [f.id, f]));
  const CELL = RELAX.cell;
  const maxR = 2 * Math.max(...Object.values(SIZE_BY_LEVEL)) + RELAX.margin;
  assert(maxR < CELL, `网格边长 ${CELL} 必须大于最大作用半径 ${maxR}，否则 3×3 邻域漏点`);
  for (let it = 0; it < RELAX.iterations; it++) {
    // 网格分桶（每轮重建：坐标已变）
    const grid = new Map();
    for (const e of all) {
      const gx = Math.floor(e.p.x / CELL), gy = Math.floor(e.p.y / CELL);
      const k = `${gx},${gy}`;
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
      // 牵引绳：超出绳长则被锚点（父节点当前位置／qeval 域质心）拉回，保住层级locality
      const anchor = f.anchorId ? pos.get(f.anchorId) : QEVAL_CENTER;
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

// ============ 组装输出（保持既有键的原有相对次序与字面值） ============
// 原基线中 tmeg 的 104 键连续占据第 3879–3982 位；此处把整块替换为 813 个 tmeg 键
// （按 nodes.json 的 tmeg 节点次序），其余 4348 键位置与字面值原样不动，qeval 块追加至末尾。
const round2 = (v) => +v.toFixed(2);
let emitted = false;
for (let i = 0; i < baseKeys.length; i++) {
  const k = baseKeys[i];
  if (k.startsWith(TMEG_PREFIX)) {
    if (!emitted) {
      emitted = true;
      for (const n of tmegNodes) {
        if (migrated.has(n.id)) out[n.id] = migrated.get(n.id); // 引用原值对象：坐标/size 逐位不动
        else {
          const p = pos.get(n.id);
          out[n.id] = { x: round2(p.x), y: round2(p.y), size: p.size };
        }
      }
    }
    continue;
  }
  out[k] = baseline[k]; // 引用原值对象
}
for (const n of qevalNodes) {
  const p = pos.get(n.id);
  out[n.id] = { x: round2(p.x), y: round2(p.y), size: p.size };
}

// ============ 断言 ============
const outKeys = Object.keys(out);
assert(outKeys.length === 5375, `终态键数应为 5375，实际 ${outKeys.length}`);
assert(new Set(outKeys).size === outKeys.length, '终态存在重复键');
const outTmeg = new Set(outKeys.filter((k) => k.startsWith(TMEG_PREFIX)));
const outQeval = new Set(outKeys.filter((k) => k.startsWith(QEVAL_PREFIX)));
assert(eqSet(outTmeg, tmegIds), `终态 tmeg 键集 ≠ nodes.json tmeg id 集（${outTmeg.size} vs ${tmegIds.size}）`);
assert(eqSet(outQeval, qevalIds), `终态 qeval 键集 ≠ nodes.json qeval id 集（${outQeval.size} vs ${qevalIds.size}）`);
// 非 tmeg/qeval 4348 键：引用相等 + 序列化逐字节相等 + 相对次序不变
const outOther = outKeys.filter((k) => !k.startsWith(TMEG_PREFIX) && !k.startsWith(QEVAL_PREFIX));
assert(outOther.length === 4348, `终态非 tmeg/qeval 键应为 4348，实际 ${outOther.length}`);
assert(outOther.join(' ') === otherKeys.join(' '), '非 tmeg/qeval 键的相对次序发生变化');
for (const k of otherKeys) assert(out[k] === baseline[k], `非 tmeg/qeval 键 ${k} 的值对象未原样保留`);
const serOld = otherKeys.map((k) => JSON.stringify({ [k]: baseline[k] })).join('');
const serNew = outOther.map((k) => JSON.stringify({ [k]: out[k] })).join('');
assert(serOld === serNew, '非 tmeg/qeval 键序列化不逐字节相等');
// 迁移的 104 键值对象引用相等
for (const [ok, nk] of Object.entries(o2n)) assert(out[nk] === baseline[ok], `tmeg 键 ${ok}→${nk} 值未原样搬运`);
// 全部键 x/y/size 有限
let nonFinite = 0;
for (const k of outKeys) {
  const v = out[k];
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.size)) { nonFinite++; console.error(`  非有限值：${k} ${JSON.stringify(v)}`); }
}
assert(nonFinite === 0, `${nonFinite} 个键的 x/y/size 非有限值`);
// compute-layout 前置检查自证：全部非 term 节点命中基线
const missing = nodes.filter((n) => n.kind !== 'term' && !out[n.id]);
assert(missing.length === 0, `${missing.length} 个非 term 节点不在终态基线内：${missing.slice(0, 8).map((n) => n.id).join(', ')}`);
// 未在 nodes.json 出现的孤儿基线键（迁移后应为 0）
const orphan = outKeys.filter((k) => !nodeById.has(k));
assert(orphan.length === 0, `${orphan.length} 个基线键在 nodes.json 中无对应节点：${orphan.slice(0, 8).join(', ')}`);

// ============ 统计 ============
function nnStats(ids, against) {
  const arr = ids.map((id) => out[id]);
  const ref = against.map((id) => out[id]);
  const ds = [];
  for (const a of arr) {
    let m = Infinity;
    for (const b of ref) {
      if (a === b) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < m) m = d;
    }
    ds.push(m);
  }
  ds.sort((p, q) => p - q);
  const q = (f) => ds[Math.min(ds.length - 1, Math.floor(f * ds.length))];
  return { min: ds[0], p05: q(0.05), med: q(0.5), max: ds[ds.length - 1] };
}
const tmegAll = [...tmegIds];
const qevalAll = [...qevalIds];
const tmegNewIds = tmegNew.map((n) => n.id);
const st1 = nnStats(tmegNewIds, tmegAll);
const st2 = nnStats(qevalAll, qevalAll);
const cxy = (ids) => {
  const xs = ids.map((i) => out[i].x), ys = ids.map((i) => out[i].y);
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = ys.reduce((a, b) => a + b, 0) / ys.length;
  const rr = ids.map((i) => Math.hypot(out[i].x - cx, out[i].y - cy)).sort((a, b) => a - b);
  return { cx, cy, r50: rr[Math.floor(rr.length / 2)], rmax: rr[rr.length - 1] };
};
const ctm = cxy(tmegAll), cqe = cxy(qevalAll);
// 新键到「其他域」既有基线点的最小距离（越界检测）
let minToOther = Infinity, minPair = null;
for (const f of freeList) {
  const v = out[f.id];
  for (const k of otherKeys) {
    const b = out[k];
    const d = Math.hypot(v.x - b.x, v.y - b.y);
    if (d < minToOther) { minToOther = d; minPair = [f.id, k]; }
  }
}
// 视觉硬重叠（圆心距 < 两圆半径和）计数：新键 × 全库
let hardOverlap = 0;
const overlapPairs = [];
const freeIdSet = new Set(freeList.map((f) => f.id));
for (const f of freeList) {
  const v = out[f.id];
  for (const k of outKeys) {
    if (k === f.id) continue;
    const b = out[k];
    const d = Math.hypot(v.x - b.x, v.y - b.y);
    if (d < v.size + b.size) {
      hardOverlap++;
      overlapPairs.push(`${f.id}↔${k}${freeIdSet.has(k) ? '' : '(固)'} d=${d.toFixed(1)}`);
      break;
    }
  }
}
// 松弛位移量
let moved = 0, movedMax = 0;
for (const f of freeList) {
  const a = rawSynth.get(f.id), b = out[f.id];
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  moved += d; if (d > movedMax) movedMax = d;
}

console.log('—— 坐标账 ——');
console.log(`迁移前：${baseKeys.length} 键（tmeg ${tmegKeys.length} + 其他 ${otherKeys.length}）`);
console.log(`tmeg：unchanged ${unchanged.length} 原地保留 / renamed ${renamed.length} 改名搬运 / 新增合成 ${tmegNew.length} → ${outTmeg.size}`);
console.log(`  改名抽样：${renamed.slice(0, 3).map(([a, b]) => `${a}→${b}`).join(', ')} …… ${renamed.slice(-2).map(([a, b]) => `${a}→${b}`).join(', ')}`);
console.log(`qeval：整域合成 ${outQeval.size}（章 ${qChapters.length} + 条 ${qSections.length}），域质心 (${QEVAL_CENTER.x}, ${QEVAL_CENTER.y})`);
console.log(`终态：${outKeys.length} 键 = 4348 + ${outTmeg.size} + ${outQeval.size}`);
console.log(`零变动断言：非 tmeg/qeval ${outOther.length} 键 引用相等 ✓ 序列化逐字节相等 ✓ 相对次序不变 ✓`);
console.log(`有限值断言：${outKeys.length}/${outKeys.length} 键 x/y/size 全有限 ✓`);
console.log(`compute-layout 前置检查自证：${nodes.length} 个非 term 节点全部命中基线 ✓（孤儿基线键 0）`);
console.log('—— 几何 ——');
console.log(`tmeg 云：质心 (${ctm.cx.toFixed(1)}, ${ctm.cy.toFixed(1)}) r50=${ctm.r50.toFixed(1)} rmax=${ctm.rmax.toFixed(1)}；新键最近邻 min=${st1.min.toFixed(1)} p05=${st1.p05.toFixed(1)} 中位=${st1.med.toFixed(1)}`);
console.log(`qeval 云：质心 (${cqe.cx.toFixed(1)}, ${cqe.cy.toFixed(1)}) r50=${cqe.r50.toFixed(1)} rmax=${cqe.rmax.toFixed(1)}；域内最近邻 min=${st2.min.toFixed(1)} p05=${st2.p05.toFixed(1)} 中位=${st2.med.toFixed(1)}`);
console.log(`新键到既有 4348 键的最小距离 ${minToOther.toFixed(1)}（${minPair && minPair.join(' ↔ ')}）`);
console.log(`视觉硬重叠（圆心距 < 半径和）新键 ${hardOverlap}/${freeList.length}`);
console.log(`松弛位移：均值 ${(moved / freeList.length).toFixed(1)} 最大 ${movedMax.toFixed(1)}（${RELAX.iterations} 轮 Jacobi，margin=${RELAX.margin}）`);

if (STATS) {
  if (overlapPairs.length) console.log('  重叠明细：' + overlapPairs.join('  '));
  const s = JSON.stringify(out, null, 0);
  console.log(`产物字节数 ${s.length}；sha1-lite ${hash32(s).toString(16)}`);
}

if (DRY) {
  console.log('（--dry-run：未写盘）');
} else {
  writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 0));
  // 写后复核：非 tmeg/qeval 键在文件字面层面亦逐字节不变
  const after = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const beforeObj = JSON.parse(baselineRaw);
  for (const k of otherKeys) {
    assert(JSON.stringify(after[k]) === JSON.stringify(beforeObj[k]), `写盘后 ${k} 值发生变化`);
  }
  assert(Object.keys(after).length === 5375, '写盘后键数不符');
  console.log(`✓ 已写回 ${BASELINE_PATH}（5375 键）`);
}
