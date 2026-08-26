// 一次性脚本（阶段5.3 批次 W4）：生成阶段5.2 终态 → 阶段5.3（W2 后）的节点 id 迁移映射表
//
// ── 用途 ────────────────────────────────────────────────────────────────────
// 阶段5.3 的两项语料改造使 doc 节点 id 大面积位移，下游三个批次需要一张权威对照表：
//   · W5 坐标基线迁移（layout-baseline.json 键改名）
//   · W6 切片重切（slice-manifest.json 节点引用改名）
//   · W7 术语资产迁移（term→node 关联改名）
// 本脚本机械推导该对照表并落盘 data/id-map-phase53.json，**不含任何手写映射**。
//
// ── 阶段5.3 的两项改造（本表要刻画的净效应）────────────────────────────────
//   1) W1 删除各域「公布与施行」节点：79 个（78 chapter ＋ tmeg 顶层 part「tmeg-01」1 个）。
//      删除后同级后继节点序号整体前移，触发 66 个无子域 2781 条改名、
//      tmeg 部序整体 −1（tmeg-0K-* → tmeg-0(K-1)-*）812 条改名。
//   2) W2 深解析把正文行升格为合成节点：新增 951 个（专利审查指南 563 ＋ tmeg 388）。
//      合成节点插入到既有节点之前时会再次挤动同级序号——这正是 tmeg 3 条
//      「非纯部序位移」的成因（见下方 EXPECT_TMEG_IMPURE）。
//   另有 12 个「树根域」在改造中把单一 part 外壳摘除、子节点整体上提一层
//      （形如 xxx-01-05 → xxx-05，section→chapter 降段），293 条。
//
// ── 输入 ────────────────────────────────────────────────────────────────────
//   旧树（阶段5.2 终态，doc 5375）：
//     _整理工作区/仓库快照/nodes_20260825_阶段5.3前.json
//     _整理工作区/仓库快照/node-bodies_20260825_阶段5.3前.json
//   新树（W2 后，doc 6247）：
//     site/data/nodes.json、site/data/node-bodies.json
//   四个路径均可用环境变量覆盖（OLD_NODES / OLD_BODIES / NEW_NODES / NEW_BODIES），
//   便于在并行批次改写现场文件时改用冻结副本运行。
//
// ── 对齐口径 ────────────────────────────────────────────────────────────────
//   主键 ＝ (domain, line)。domain 取自 nodes.json，line 取自 node-bodies.json，
//   语义为该节点标题（或被升格的正文行）在源 md 中的行号。
//   · doc 节点集合 ＝ nodes.json 中 id 命中 node-bodies.json 键的那些条目。
//     旧 nodes.json 另含 1035 个 level==='term' 的术语节点（无 body），不属对照表管辖范围。
//   · 选键证据（详见批次报告）：
//     ① 双侧 (domain,line) 均 100% 唯一（5375/5375、6247/6247，零冲突）；
//     ② 88 个域的 max(line) 双侧完全相同 → 源 md 未增删行，行号可直接跨树比对；
//     ③ 备选键 (domain,level,label) 双侧分别有 96 / 150 个碰撞键，不可用作主键；
//        且 label 本身在本阶段发生 2 处 cleanLabel 反转义漂移（「…审查\*」→「…审查*」），
//        以 label 入键会把这 2 条误判为 deleted＋added。
//   · 合成节点行号语义已核查：951 个新增节点的 line 全部严格大于其父节点 line，
//     且不与任何既有节点行号相撞，与既有标题节点同处一个行号坐标系。
//
// ── 下游消费须知（W5/W6/W7 必读）────────────────────────────────────────────
//   本表**必须整体原子改写，严禁逐条就地改名**。id 空间存在大量复用：
//     · renamed 的 3886 个新 id 中有 2072 个同时是另一条的旧 id（链式改名）；
//     · 79 个 deleted 旧 id 全部被复用为某条 renamed 的新 id（如 wktmr-01 被删，
//       同时 wktmr-01-01 → wktmr-01）。
//   正确做法：遍历旧集合，按 renamed/deleted 查表后写入**一个全新集合**；
//   错误做法：在原集合上 for(k of keys){ obj[map[k]] = obj[k]; delete obj[k] }。
//   反向安全性已断言：renamed 值与 added 零交集、与 unchanged 零交集，
//   deleted 与 added/unchanged 零交集，added 与旧树全集零交集——故原子改写无碰撞。
//
// ── 确定性 ──────────────────────────────────────────────────────────────────
//   产物不含时间戳（原设计的 generated 字段会破坏「两跑逐字节一致」），
//   改以 content_sha256 承担版本标识：其值为 payload（renamed/deleted/added/stats）
//   规范化 JSON 的 sha256。所有键与数组均按 ASCII 升序排序后落盘。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/oneoff-build-idmap-phase53.mjs [--dry-run]
//   全部硬断言通过才落盘；任一不满足即打印明细并 exit 1。
//
// ⚠ 本脚本为阶段5.3 一次性产物生成器，执行完毕后仅作留档与复算依据。

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const SNAP = join(
  process.env.HOME ?? '',
  '知识产权工作站', '_整理工作区', '仓库快照',
);

const OLD_NODES = process.env.OLD_NODES ?? join(SNAP, 'nodes_20260825_阶段5.3前.json');
const OLD_BODIES = process.env.OLD_BODIES ?? join(SNAP, 'node-bodies_20260825_阶段5.3前.json');
const NEW_NODES = process.env.NEW_NODES ?? join(DATA, 'nodes.json');
const NEW_BODIES = process.env.NEW_BODIES ?? join(DATA, 'node-bodies.json');
const OUT_PATH = join(DATA, 'id-map-phase53.json');
const DRY = process.argv.includes('--dry-run');

// ── 期望值（背景账，全部来自 W1/W2 实测定版；断言不满足即视为上游异常）──────
const EXPECT = {
  oldDoc: 5375,
  newDoc: 6247,
  renamed: 3886,
  deleted: 79,
  added: 951,
  unchanged: 1410,
  deletedLabel: '公布与施行',
  addedByDomain: { 'examination-guideline': 563, 'trademark-exam-guide-2021': 388 },
  tmegDomain: 'trademark-exam-guide-2021',
  tmegRenamed: 812,
  // 12 树根域各自的改名条数（＝各域条文数），降序
  treeRootCounts: [38, 38, 35, 33, 27, 27, 21, 19, 17, 16, 12, 10],
};
// tmeg 中不服从「部序 −1」纯位移的 3 条（W2 深解析插入同级新节点所致）
const EXPECT_TMEG_IMPURE = [
  ['tmeg-05-03-02-05-01', 'tmeg-04-03-02-05-02'],
  ['tmeg-07-03-02-02-09-01', 'tmeg-06-03-02-02-09-05'],
  ['tmeg-07-16-02-02-02-01', 'tmeg-06-16-02-02-02-02'],
];

// ── 断言机 ──────────────────────────────────────────────────────────────────
const failures = [];
function assert(ok, label, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`;
  console.log(line);
  if (!ok) failures.push(label);
}
const eqNum = (got, want, label) => assert(got === want, label, `got=${got} want=${want}`);
const asc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);          // ASCII 序，locale 无关
const canon = (v) => JSON.stringify(v);

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ── 载入并抽取 doc 节点 ─────────────────────────────────────────────────────
/** doc 节点 ＝ nodes.json 中 id 命中 node-bodies.json 的条目；term 节点无 body，天然排除 */
function loadSide(nodesPath, bodiesPath, tag) {
  const nodes = readJson(nodesPath);
  const bodies = readJson(bodiesPath);
  const out = [];
  for (const n of nodes) {
    const body = Object.prototype.hasOwnProperty.call(bodies, n.id) ? bodies[n.id] : null;
    if (!body) continue;
    if (typeof body.line !== 'number' || !Number.isFinite(body.line)) {
      console.error(`[${tag}] 节点 ${n.id} 的 body.line 非有限数值：${canon(body.line)}`);
      process.exit(1);
    }
    if (typeof n.domain !== 'string' || n.domain === '') {
      console.error(`[${tag}] 节点 ${n.id} 缺少 domain`);
      process.exit(1);
    }
    out.push({ id: n.id, domain: n.domain, level: n.level, label: n.label, line: body.line });
  }
  return out;
}

/** 主键索引；同 (domain,line) 出现多节点即打印明细并 exit 1 */
function indexByKey(rows, tag) {
  const map = new Map();
  const dups = new Map();
  for (const r of rows) {
    const k = `${r.domain}@${r.line}`;
    if (map.has(k)) {
      if (!dups.has(k)) dups.set(k, [map.get(k)]);
      dups.get(k).push(r);
    } else {
      map.set(k, r);
    }
  }
  if (dups.size > 0) {
    console.error(`\n[${tag}] 主键冲突：${dups.size} 个 (domain,line) 命中多个节点，无法机械对齐。`);
    for (const [k, rs] of dups) {
      console.error(`  ${k}`);
      for (const r of rs) console.error(`    - id=${r.id} level=${r.level} label=${canon(r.label)}`);
    }
    process.exit(1);
  }
  return map;
}

const oldRows = loadSide(OLD_NODES, OLD_BODIES, 'OLD');
const newRows = loadSide(NEW_NODES, NEW_BODIES, 'NEW');
const oldMap = indexByKey(oldRows, 'OLD');
const newMap = indexByKey(newRows, 'NEW');

console.log('=== 输入 ===');
console.log(`OLD nodes  : ${OLD_NODES}`);
console.log(`OLD bodies : ${OLD_BODIES}`);
console.log(`NEW nodes  : ${NEW_NODES}`);
console.log(`NEW bodies : ${NEW_BODIES}`);
console.log(`old doc=${oldRows.length}  new doc=${newRows.length}  (主键唯一，零冲突)\n`);

// ── 对齐 ────────────────────────────────────────────────────────────────────
const renamedPairs = [];   // [oldRow, newRow]
const unchangedRows = [];
const deletedRows = [];
const addedRows = [];
for (const [k, o] of oldMap) {
  const n = newMap.get(k);
  if (!n) deletedRows.push(o);
  else if (n.id === o.id) unchangedRows.push(o);
  else renamedPairs.push([o, n]);
}
for (const [k, n] of newMap) if (!oldMap.has(k)) addedRows.push(n);

renamedPairs.sort((a, b) => asc(a[0].id, b[0].id));
deletedRows.sort((a, b) => asc(a.id, b.id));
addedRows.sort((a, b) => asc(a.id, b.id));

const renamed = {};
for (const [o, n] of renamedPairs) renamed[o.id] = n.id;
const deleted = deletedRows.map((r) => r.id);
const added = addedRows.map((r) => r.id);
const stats = {
  renamed: renamedPairs.length,
  deleted: deleted.length,
  added: added.length,
  unchanged: unchangedRows.length,
};

// ── 硬断言 ──────────────────────────────────────────────────────────────────
console.log('=== 硬断言 ===');
eqNum(oldRows.length, EXPECT.oldDoc, '旧树 doc 节点数');
eqNum(newRows.length, EXPECT.newDoc, '新树 doc 节点数');
eqNum(stats.renamed, EXPECT.renamed, 'stats.renamed');
eqNum(stats.deleted, EXPECT.deleted, 'stats.deleted');
eqNum(stats.added, EXPECT.added, 'stats.added');
eqNum(stats.unchanged, EXPECT.unchanged, 'stats.unchanged');

// deleted 全部 label ≡「公布与施行」
{
  const bad = deletedRows.filter((r) => r.label !== EXPECT.deletedLabel);
  assert(bad.length === 0, `deleted ${EXPECT.deleted} 条 label 全≡「${EXPECT.deletedLabel}」`,
    bad.length ? `例外 ${bad.length} 条：${bad.slice(0, 5).map((r) => `${r.id}=${canon(r.label)}`).join(' ')}` : `levels=${canon(tally(deletedRows, (r) => r.level))}`);
}

// added 全部 ∈ 新树，且按域分布符合预期
{
  const newIds = new Set(newRows.map((r) => r.id));
  assert(added.every((id) => newIds.has(id)), 'added 全部 ∈ 新树');
  const byDomain = tally(addedRows, (r) => r.domain);
  assert(canon(sortObj(byDomain)) === canon(sortObj(EXPECT.addedByDomain)),
    'added 按域分布', `got=${canon(sortObj(byDomain))}`);
}

// renamed 键全 ∈ 旧树、值全 ∈ 新树、单射、与 added 零交集、无恒等项
{
  const oldIds = new Set(oldRows.map((r) => r.id));
  const newIds = new Set(newRows.map((r) => r.id));
  const keys = Object.keys(renamed);
  const vals = Object.values(renamed);
  assert(keys.every((k) => oldIds.has(k)), 'renamed 键全 ∈ 旧树');
  assert(vals.every((v) => newIds.has(v)), 'renamed 值全 ∈ 新树');
  assert(new Set(vals).size === vals.length, 'renamed 值无重复（单射）', `distinct=${new Set(vals).size}/${vals.length}`);
  const addedSet = new Set(added);
  const inter = vals.filter((v) => addedSet.has(v));
  assert(inter.length === 0, 'renamed 值与 added 零交集', `交集 ${inter.length}`);
  assert(keys.every((k) => renamed[k] !== k), 'renamed 无恒等项');
}

// tmeg：812 条，其中非纯部序位移恰 3 条且逐字匹配
{
  const tmeg = renamedPairs.filter(([o]) => o.domain === EXPECT.tmegDomain);
  eqNum(tmeg.length, EXPECT.tmegRenamed, 'renamed 中 tmeg 条数');
  const impure = [];
  for (const [o, n] of tmeg) {
    const m = /^tmeg-(\d{2})(.*)$/.exec(o.id);
    const pure = m ? `tmeg-${String(parseInt(m[1], 10) - 1).padStart(2, '0')}${m[2]}` : null;
    if (pure !== n.id) impure.push([o.id, n.id]);
  }
  impure.sort((a, b) => asc(a[0], b[0]));
  const want = [...EXPECT_TMEG_IMPURE].sort((a, b) => asc(a[0], b[0]));
  assert(canon(impure) === canon(want), 'tmeg 非纯部序位移恰 3 条且逐字相同',
    `got=${canon(impure)}`);
  eqNum(tmeg.length - impure.length, EXPECT.tmegRenamed - 3, 'tmeg 纯部序位移条数');
}

// 12 树根域：以「level 变化」识别，各域条数向量匹配，且形如 xxx-01-NN → xxx-NN
{
  const lifted = renamedPairs.filter(([o, n]) => o.level !== n.level);
  const byDomain = tally(lifted, ([o]) => o.domain);
  const counts = Object.values(byDomain).sort((a, b) => b - a);
  eqNum(Object.keys(byDomain).length, EXPECT.treeRootCounts.length, '树根域域数');
  assert(canon(counts) === canon(EXPECT.treeRootCounts), '12 树根域各域 renamed 数向量',
    `got=${canon(counts)}`);
  const bad = lifted.filter(([o, n]) => {
    const m = /^(.*)-01-(\d+)$/.exec(o.id);
    return !m || n.id !== `${m[1]}-${m[2]}`;
  });
  assert(bad.length === 0, '树根域改名全部形如 xxx-01-NN → xxx-NN（降段）',
    bad.length ? `例外 ${bad.length} 条：${bad.slice(0, 5).map(([o, n]) => `${o.id}→${n.id}`).join(' ')}` : `共 ${lifted.length} 条`);
  // 树根域内不得混入非降段改名（保证三类改名互斥可分）
  const liftedDomains = new Set(Object.keys(byDomain));
  const mixed = renamedPairs.filter(([o, n]) => liftedDomains.has(o.domain) && o.level === n.level);
  assert(mixed.length === 0, '树根域内无非降段改名（三类改名互斥）', `混入 ${mixed.length} 条`);
  // 三类改名加总覆盖 renamed 全集
  const plain = renamedPairs.filter(([o, n]) => o.domain !== EXPECT.tmegDomain && o.level === n.level);
  eqNum(plain.length + lifted.length + EXPECT.tmegRenamed, stats.renamed,
    '三类改名（66 无子域 + 12 树根域 + tmeg）加总 ＝ renamed');
  console.log(`      · 66 无子域 ${plain.length} 条（${new Set(plain.map(([o]) => o.domain)).size} 域）`
    + ` / 12 树根域 ${lifted.length} 条 / tmeg ${EXPECT.tmegRenamed} 条`);
}

// 双侧全集覆盖
{
  const oldIds = new Set(oldRows.map((r) => r.id));
  const newIds = new Set(newRows.map((r) => r.id));
  const coverOld = new Set([...Object.keys(renamed), ...deleted, ...unchangedRows.map((r) => r.id)]);
  const coverNew = new Set([...Object.values(renamed), ...added, ...unchangedRows.map((r) => r.id)]);
  assert(coverOld.size === oldIds.size && [...coverOld].every((id) => oldIds.has(id)),
    'renamed+deleted+unchanged 覆盖旧树全集', `${coverOld.size}/${oldIds.size}`);
  assert(coverNew.size === newIds.size && [...coverNew].every((id) => newIds.has(id)),
    'renamed值+added+unchanged 覆盖新树全集', `${coverNew.size}/${newIds.size}`);
}

// id 复用度量（供下游判断改写方式）＋ 原子改写无碰撞的安全性断言
const reuse = (() => {
  const keys = Object.keys(renamed);
  const vals = Object.values(renamed);
  const keySet = new Set(keys);
  const delSet = new Set(deleted);
  const addSet = new Set(added);
  const unchangedSet = new Set(unchangedRows.map((r) => r.id));
  const oldIds = new Set(oldRows.map((r) => r.id));
  const chain = vals.filter((v) => keySet.has(v)).length;
  const revive = vals.filter((v) => delSet.has(v)).length;
  eqNum(revive, stats.deleted, 'deleted 旧 id 全部被复用为 renamed 新 id');
  assert(vals.filter((v) => unchangedSet.has(v)).length === 0, 'renamed 值 ∩ unchanged ＝ ∅');
  assert(deleted.filter((d) => addSet.has(d) || unchangedSet.has(d)).length === 0, 'deleted ∩ (added ∪ unchanged) ＝ ∅');
  assert(added.filter((a) => oldIds.has(a)).length === 0, 'added ∩ 旧树全集 ＝ ∅');
  assert(keys.filter((k) => addSet.has(k)).length === 0, 'renamed 键 ∩ added ＝ ∅');
  console.log(`      · 链式改名（renamed 值同时是另一条的旧 id）${chain} 条；被删 id 复用 ${revive} 条`);
  return { chain, revive };
})();

// 合成节点行号语义核查：新增节点 line 必须严格大于其父节点 line
{
  const newById = new Map(newRows.map((r) => [r.id, r]));
  const bad = [];
  for (const r of addedRows) {
    const parentId = r.id.replace(/-\d+$/, '');
    const p = newById.get(parentId);
    if (p && !(r.line > p.line)) bad.push(`${r.id}(line=${r.line}) ≤ ${parentId}(line=${p.line})`);
  }
  assert(bad.length === 0, '合成节点 line 严格大于父节点 line', bad.length ? bad.slice(0, 5).join(' ') : `${added.length}/${added.length}`);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项硬断言未通过：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}

// ── 落盘 ────────────────────────────────────────────────────────────────────
const payload = {
  old_doc_count: oldRows.length,
  new_doc_count: newRows.length,
  renamed,
  deleted,
  added,
  stats,
};
const contentSha = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
const out = {
  schema: 'id-map-phase53/1',
  phase: '阶段5.3 批次 W4',
  // 无时间戳：确定性优先（两跑逐字节一致），版本标识由 content_sha256 承担
  content_sha256: contentSha,
  key: 'domain+node-bodies.line（源 md 标题/升格正文行行号），双侧唯一',
  apply_note: `id 空间存在复用（renamed 新 id 中 ${reuse.chain} 个同时是另一条的旧 id；`
    + `${reuse.revive} 个 deleted 旧 id 全部被复用为某条 renamed 的新 id）。`
    + '必须遍历旧集合查表后写入全新集合（原子改写），严禁在原集合上逐条就地改名。',
  ...payload,
};
const text = `${JSON.stringify(out, null, 2)}\n`;

console.log(`\n=== 产物 ===`);
console.log(`content_sha256 = ${contentSha}`);
if (DRY) {
  console.log(`--dry-run：未写入 ${OUT_PATH}（${text.length} 字节）`);
} else {
  writeFileSync(OUT_PATH, text, 'utf8');
  console.log(`已写入 ${OUT_PATH}（${text.length} 字节）`);
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
function tally(rows, keyOf) {
  const m = {};
  for (const r of rows) { const k = keyOf(r); m[k] = (m[k] ?? 0) + 1; }
  return m;
}
function sortObj(o) {
  const out = {};
  for (const k of Object.keys(o).sort(asc)) out[k] = o[k];
  return out;
}
