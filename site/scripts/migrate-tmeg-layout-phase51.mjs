// 一次性脚本（阶段5.1 批次 T-2）：layout-baseline.json 的 tmeg 键迁移
//
// 背景：批次 T-1 把《商标审查审理指南》域（tmeg）由 105 个平铺节点重构为 104 个节点的
//   语义四级树（part8 / chapter44 / section48 / subsection4），全域 id 重排；空壳
//   「形式审查和事务工作编」（旧 tmeg-02）溶解为其下辖各部分 label 的「上编·」前缀，不再成节点。
//   新旧 id 的对应关系由 T-1 产出的 data/tmeg-id-map-phase51.json 固化（主键＝源 md 行号）。
//
//   compute-layout.mjs 的增量模式要求每个非 term 节点都能在基线中命中键，否则 exit 1；
//   故须在重跑管线之前把基线的 105 个 tmeg 键迁到新 id 上（104 改名 + 1 删除）。
//   非 tmeg 键（4348 个）不参与迁移，逐键原样搬运。
//
// 幂等防护：脚本只接受两种基线状态——
//   · 迁移前：tmeg 键集 ≡ 映射表定义域 ∪ unmatched_old（105 键）→ 执行迁移；
//   · 迁移后：tmeg 键集 ≡ 映射表值域（104 键）→ 判定已迁移，拒绝执行并 exit 1；
//   其余任何状态一律判为基线与映射表不匹配，拒绝执行并 exit 1（不做部分迁移）。
//
// 用法：node scripts/migrate-tmeg-layout-phase51.mjs [--dry-run]
// 落盘格式与 compute-layout.mjs 一致：JSON.stringify(obj, null, 0)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const D = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const BASELINE_PATH = join(D, 'layout-baseline.json');
const MAP_PATH = join(D, 'tmeg-id-map-phase51.json');
const NODES_PATH = join(D, 'nodes.json');
const DRY = process.argv.includes('--dry-run');
const PREFIX = 'tmeg-';

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const assert = (cond, msg) => { if (!cond) fail(`断言失败：${msg}`); };

// ---- 读入 ----
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const mapFile = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
const o2n = mapFile['old→new'];
const droppedOld = mapFile.unmatched_old || [];
assert(o2n && typeof o2n === 'object', 'tmeg-id-map-phase51.json 缺少 old→new 表');

const oldKeys = Object.keys(baseline);
const tmegKeys = oldKeys.filter((k) => k.startsWith(PREFIX));
const otherKeys = oldKeys.filter((k) => !k.startsWith(PREFIX));

const domain = new Set(Object.keys(o2n));
const image = new Set(Object.values(o2n));
assert(image.size === domain.size, `映射表非单射：定义域 ${domain.size} ≠ 值域 ${image.size}`);
for (const k of droppedOld) assert(!domain.has(k), `unmatched_old 键 ${k} 同时出现在 old→new 定义域`);

// ---- 幂等防护：先判定当前基线处于哪一侧 ----
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const cur = new Set(tmegKeys);
const before = new Set([...domain, ...droppedOld]);

if (eqSet(cur, image)) {
  fail(
    `基线 tmeg 键集已等于映射表值域（${image.size} 键），判定为已迁移，拒绝重复执行。\n` +
    '  如确需回滚重做，请先从 layout-baseline.json.bak_20260824_T2前 恢复。',
  );
}
if (!eqSet(cur, before)) {
  const extra = [...cur].filter((k) => !before.has(k));
  const miss = [...before].filter((k) => !cur.has(k));
  fail(
    `基线 tmeg 键集与映射表迁移前形态不一致，拒绝执行（不做部分迁移）。\n` +
    `  基线 tmeg 键 ${cur.size} / 期望 ${before.size}\n` +
    `  基线多出：${extra.join(', ') || '（无）'}\n  基线缺失：${miss.join(', ') || '（无）'}`,
  );
}

// ---- 迁移 ----
const out = {};
const changed = [];
const dropped = [];
const kept = [];
for (const k of oldKeys) {
  if (!k.startsWith(PREFIX)) {
    out[k] = baseline[k];
    kept.push(k);
    continue;
  }
  if (droppedOld.includes(k)) { dropped.push(k); continue; }
  const nk = o2n[k];
  assert(nk !== undefined, `tmeg 键 ${k} 在映射表中无对应新 id`);
  assert(!Object.prototype.hasOwnProperty.call(out, nk), `迁移产生重复键 ${nk}（来源 ${k}）`);
  out[nk] = baseline[k];
  if (nk !== k) changed.push([k, nk]);
}

// ---- 断言 ----
const newKeys = Object.keys(out);
assert(dropped.length === droppedOld.length,
  `应恰好丢弃 ${droppedOld.length} 个键，实际 ${dropped.length}（${dropped.join(', ')}）`);
assert(newKeys.length === oldKeys.length - droppedOld.length,
  `新键总数应为旧总数 −${droppedOld.length} = ${oldKeys.length - droppedOld.length}，实际 ${newKeys.length}`);
assert(new Set(newKeys).size === newKeys.length, '新键存在重复');
const newTmeg = new Set(newKeys.filter((k) => k.startsWith(PREFIX)));
assert(eqSet(newTmeg, image), `迁移后 tmeg 键集 ≠ 映射表值域（${newTmeg.size} vs ${image.size}）`);
// 值对象必须原样搬运（引用相等），非 tmeg 键必须原地保留
for (const [ok, nk] of changed) assert(out[nk] === baseline[ok], `键 ${ok}→${nk} 值未原样搬运`);
for (const k of kept) assert(out[k] === baseline[k], `非 tmeg 键 ${k} 丢失或被覆盖`);
assert(kept.length === otherKeys.length, `非 tmeg 键数变动：${otherKeys.length} → ${kept.length}`);

// ---- 与 nodes.json 交叉校验（tmeg 域内键集须完全一致）----
try {
  const nodes = JSON.parse(readFileSync(NODES_PATH, 'utf8'));
  const nodeTmeg = new Set(
    nodes.filter((n) => n.domain === 'trademark-exam-guide-2021' && n.kind !== 'term').map((n) => n.id),
  );
  assert(eqSet(newTmeg, nodeTmeg),
    `迁移后 tmeg 键集与 nodes.json 的 tmeg 节点 id 集不一致（基线 ${newTmeg.size} / 节点 ${nodeTmeg.size}）`);
  console.log(`✓ 与 nodes.json 交叉校验通过：tmeg 键集 ≡ 节点 id 集（${nodeTmeg.size}）`);
} catch (err) {
  if (err?.code === 'ENOENT') console.warn('⚠ 未找到 nodes.json，跳过交叉校验');
  else throw err;
}

// ---- 输出统计 ----
console.log(`旧键总数：${oldKeys.length}（tmeg ${tmegKeys.length} + 其他 ${otherKeys.length}）`);
console.log(`弃：${dropped.length}（${dropped.join(', ')}）`);
console.log(`改名：${changed.length}`);
console.log(`存：${newKeys.length}（tmeg ${newTmeg.size} + 其他 ${kept.length}）`);
console.log(`  抽样：${changed.slice(0, 5).map(([a, b]) => `${a}→${b}`).join(', ')} …… ${changed.slice(-3).map(([a, b]) => `${a}→${b}`).join(', ')}`);

if (DRY) {
  console.log('（--dry-run：未写盘）');
} else {
  writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 0));
  console.log(`✓ 已写回 ${BASELINE_PATH}`);
}
