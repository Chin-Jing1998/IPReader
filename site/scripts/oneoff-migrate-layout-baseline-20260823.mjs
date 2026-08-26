// 一次性脚本（阶段5 波A / A-0 批）：layout-baseline.json 键迁移
//
// 背景：本批修复两处语料缺陷，重跑 parse-domains 后节点 id 会位移——
//   1) copyright-pledge-registration-2011：删除伪标题「# 第十三条」（原 cppl-14，
//      系第十二条列举项被误升为独立条），其后 cppl-15..cppl-27 → cppl-14..cppl-26；
//   2) trademark-exam-guide-2021：示例商标文字「# OFFENSIVE」降级为正文（原顶层 tmeg-40，
//      无子孙），其后首段 ≥41 的全部 id（含子孙）首段 −1。
//
// compute-layout.mjs 增量模式要求非 term 节点全部命中基线键，否则 exit 1；
// 故在重跑管线之前先把基线键迁移到位。
//
// 用法：node scripts/oneoff-migrate-layout-baseline-20260823.mjs [--dry-run]
// 落盘格式与 compute-layout.mjs 一致：JSON.stringify(obj, null, 0)
//
// ⚠ 本脚本已执行完毕、仅作留档。文中 tmeg-* id（tmeg-40 等）属**阶段5.1 批次 T-1 之前**的平铺 id
//   空间，与当前四级树 id 无对应关系，勿按现行 nodes.json 解读；本批次（T-2）的新旧 id 对照见
//   data/tmeg-id-map-phase51.json，其基线迁移脚本为 scripts/migrate-tmeg-layout-phase51.mjs。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const D = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const BASELINE_PATH = join(D, 'layout-baseline.json');
const DRY = process.argv.includes('--dry-run');

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const oldKeys = Object.keys(baseline);

// 被弃键（精确匹配）
const DROP = new Set(['cppl-14', 'tmeg-40']);

// 首段减 1，保留原零填充位宽与后缀
const shiftHead = (prefix, digits, rest) =>
  `${prefix}-${String(parseInt(digits, 10) - 1).padStart(digits.length, '0')}${rest}`;

/** 返回迁移后的键；null 表示丢弃；原样返回表示不变 */
function mapKey(key) {
  if (DROP.has(key)) return null;
  let m = /^cppl-(\d+)$/.exec(key);
  if (m && parseInt(m[1], 10) >= 15) return shiftHead('cppl', m[1], '');
  m = /^tmeg-(\d+)((?:-.*)?)$/.exec(key);
  if (m && parseInt(m[1], 10) >= 41) return shiftHead('tmeg', m[1], m[2]);
  return key;
}

const out = {};
const changed = [];
const dropped = [];
for (const k of oldKeys) {
  const nk = mapKey(k);
  if (nk === null) { dropped.push(k); continue; }
  if (nk !== k) changed.push([k, nk]);
  if (Object.prototype.hasOwnProperty.call(out, nk)) {
    throw new Error(`断言失败：迁移产生重复键 ${nk}（来源 ${k}）`);
  }
  out[nk] = baseline[k];
}

// ---- 断言 ----
const newKeys = Object.keys(out);
const assert = (cond, msg) => { if (!cond) throw new Error(`断言失败：${msg}`); };

assert(dropped.length === 2, `应恰好丢弃 2 个键，实际 ${dropped.length}（${dropped.join(', ')}）`);
assert(DROP.has(dropped[0]) && DROP.has(dropped[1]), `被弃键不是 cppl-14 / tmeg-40：${dropped.join(', ')}`);
assert(newKeys.length === oldKeys.length - 2,
  `新键总数应为旧总数 −2 = ${oldKeys.length - 2}，实际 ${newKeys.length}`);
assert(new Set(newKeys).size === newKeys.length, '新键存在重复');
// 一一映射：除两个被弃键外，旧键全部有像，且像集合等于新键集合
const image = new Set(oldKeys.filter((k) => !DROP.has(k)).map(mapKey));
assert(image.size === newKeys.length, `映射非单射：像集合 ${image.size} ≠ 新键集合 ${newKeys.length}`);
for (const k of newKeys) assert(image.has(k), `新键 ${k} 不在像集合内`);
// 值对象必须原样搬运（引用相等）
for (const [ok, nk] of changed) assert(out[nk] === baseline[ok], `键 ${ok}→${nk} 值未原样搬运`);
// 未被弃、未被改的键必须原地保留
const untouched = oldKeys.filter((k) => !DROP.has(k) && mapKey(k) === k);
for (const k of untouched) assert(out[k] === baseline[k], `未变更键 ${k} 丢失或被覆盖`);

// ---- 输出统计 ----
const cpplChanged = changed.filter(([k]) => k.startsWith('cppl-'));
const tmegChanged = changed.filter(([k]) => k.startsWith('tmeg-'));
console.log(`旧键总数：${oldKeys.length}`);
console.log(`弃：${dropped.length}（${dropped.join(', ')}）`);
console.log(`改：${changed.length}（cppl ${cpplChanged.length} + tmeg ${tmegChanged.length}）`);
console.log(`存：${newKeys.length}（未变更 ${untouched.length}）`);
console.log(`  cppl 改键：${cpplChanged.map(([a, b]) => `${a}→${b}`).join(', ')}`);
console.log(`  tmeg 改键：${tmegChanged.map(([a, b]) => `${a}→${b}`).join(', ')}`);

if (DRY) {
  console.log('（--dry-run：未写盘）');
} else {
  writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 0));
  console.log(`✓ 已写回 ${BASELINE_PATH}`);
}
