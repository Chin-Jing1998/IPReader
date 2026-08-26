// 一次性脚本（阶段5.2 批次 W-3）：term-extract 的 109 个 tmeg 片「双指针」迁移
//
// 背景
//   · 批次 W-1 把 tmeg 由 104 节点扩为 813 节点（52 个 id 不变 / 52 个改名 / 新增 709），
//     term-extract 里 109 个 tmeg 片的 anchorNode 仍指向阶段5.1 的旧 id；
//   · 批次 W-2 用 slice-tools v3 原生切片（1201 片）整体覆写了
//     trademark-exam-guide-2021/_chunks/，109 个片的 chunk 字段（v2 路径如
//     `trademark-exam-guide-2021/07-10/004`）**全部失效**。
//   两根指针都要重指：anchorNode → 新树节点 id，chunk → v3 切片路径。
//
// 定位口径（双指针同源，保证互相自洽）
//   1. 逐条 evidence 在 v3 切片正文（剥掉面包屑首行后的文本）中做**逐字子串检索**，
//      候选限制在该片旧 chunk 所属的章目录内（45 个旧一级目录名在 v3 下原样存续，见
//      _chunks/README.md），命中 0 个时回退全域检索并计入清单；
//   2. 同一 evidence 命中多片时，取与本片「无歧义 evidence 的切片序号中位数」最接近者
//      （切片序号取自 slice-tools/data/slice-manifest.json 的 records[].order，即全书文档序）；
//      本片全部 evidence 皆有歧义时退回旧锚对应新节点的切片序号；
//   3. 片级 chunk = 全部 evidence 所在切片的**最深公共目录**；若全部落在同一切片，
//      chunk 直接取该切片文件（含深叶片 dNN，此时 chunk 指向深叶片本身）；
//   4. 片级 anchorNode = pathToNodeId(chunk)（与 slice-tools/lib/tmeg.mjs:39-45 同实现：
//      去 .md → 去尾部 `_preamble` → 剥掉尾部全部 `d\d+` 段 → 段间以 `-` 连接、前置 `tmeg-`）。
//      故恒有 anchorNode ≡ pathToNodeId(chunk)，且 anchorNode 的子树覆盖本片全部 evidence。
//
// 与 merge-terms.mjs::chunkText() 的口径兼容
//   chunkText 把 chunkId 按 `/` 切段，拼 `<ROOT>/<段0>/_chunks/<段1..n>.md`，段数不限，
//   四段以上天然兼容；该路径不是文件时回退 collectMd(目录) 递归拼接目录下全部 .md。
//   因此「单切片 → 文件路径」「多切片 → 目录路径」两种写法都能被 chunkText 正确解析。
//
// 文件名方案（降级案，见 data/term-extract/README.md）
//   既有恒等式「文件名 = chunk 路径以 __ 连接 + .json」在本批**不可维持**：
//   109 片中 75 片的 evidence 散落在同一节点/章下的多个 v3 切片，chunk 必须落到目录级，
//   其中 11 个目录被 2~3 个片共用（如 `08` 被 3 片共用），改名必然撞名。
//   故采用降级案：**文件名一律保留旧名不动，只改内部 chunk / anchorNode 字段**。
//   代码侧无影响：merge-terms.mjs:192 与 lib/term-extract-index.mjs:29 都以 rec.chunk 为准，
//   仅在 chunk 缺失时才回退按文件名拼路径，而本批 109 片的 chunk 字段均存在。
//
// 用法：node scripts/oneoff-migrate-term-extract-phase52.mjs [--dry-run]
// 迁移前备份：_整理工作区/仓库快照/term-extract-tmeg片_20260824_W3前.tar.gz

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const ROOT = join(__dirname, '..', '..', '..');            // PatentReader/
const BOOK = 'trademark-exam-guide-2021';
const CHUNKS = join(ROOT, BOOK, '_chunks');
const MANIFEST = join(ROOT, 'slice-tools', 'data', 'slice-manifest.json');
const EXTRACT_DIR = join(D, 'term-extract');
const MAP_PATH = join(D, 'tmeg-id-map-phase52.json');
const NODES_PATH = join(D, 'nodes.json');
const DRY = process.argv.includes('--dry-run');

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const assert = (cond, msg) => { if (!cond) fail(`断言失败：${msg}`); };

// slice-tools/lib/tmeg.mjs::pathToNodeId 的等价实现
function pathToNodeId(relPath) {
  const segs = relPath.replace(/\.md$/, '').split('/');
  if (segs[segs.length - 1] === '_preamble') segs.pop();
  while (segs.length && /^d\d+$/.test(segs[segs.length - 1])) segs.pop();
  if (!segs.length) return null;
  return `tmeg-${segs.join('-')}`;
}

// ---- 读入 ----
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')).books[BOOK].records;
assert(manifest.length === 1201, `slice-manifest 应有 1201 片，实际 ${manifest.length}`);
const orderOf = new Map(manifest.map((r) => [r.path, r.order]));
const nodeOrder = new Map();                    // 节点 id → 其名下最小切片序号（含深叶片，归属其所有者节点）
for (const r of manifest) {
  const nid = pathToNodeId(r.path);
  if (!nodeOrder.has(nid) || r.order < nodeOrder.get(nid)) nodeOrder.set(nid, r.order);
}
const sliceBody = new Map();                    // 切片相对路径 → 剥面包屑后的正文
for (const r of manifest) {
  const txt = readFileSync(join(CHUNKS, r.path), 'utf8');
  sliceBody.set(r.path, txt.startsWith('> ') ? txt.slice(txt.indexOf('\n') + 1) : txt);
  // manifest 对 388 个深叶片记 node_id=null（无对应节点）；节点级切片须与反查逐一相符
  assert(r.node_id === null || pathToNodeId(r.path) === r.node_id, `切片 ${r.path} 反查 id 与 manifest 不符`);
}
const nodes = JSON.parse(readFileSync(NODES_PATH, 'utf8'));
const nodeIds = new Set(nodes.map((n) => n.id));
const o2n = JSON.parse(readFileSync(MAP_PATH, 'utf8'))['old→new'];

const files = readdirSync(EXTRACT_DIR).filter((f) => f.startsWith(`${BOOK}__`) && f.endsWith('.json')).sort();
assert(files.length === 109, `tmeg 片应为 109，实际 ${files.length}`);

// ---- 逐片解析 ----
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const results = [];
const stats = { evidences: 0, outRegion: [], ambiguous: [], deepLeafChunk: 0, dirChunk: 0, fileChunk: 0 };

for (const f of files) {
  const rec = JSON.parse(readFileSync(join(EXTRACT_DIR, f), 'utf8'));
  const oldChunk = rec.chunk;
  const oldAnchor = rec.anchorNode;
  assert(o2n[oldAnchor], `片 ${f} 的旧锚 ${oldAnchor} 不在 tmeg-id-map-phase52 定义域`);
  const region = oldChunk.split('/')[1];        // 旧 chunk 的章目录（v3 下原样存续）
  const inRegion = (p) => p === `${region}.md` || p.startsWith(`${region}/`);

  // 第一遍：收集每条 evidence 的候选切片
  const cands = [];
  for (const t of rec.terms || []) {
    const e = String(t.evidence || '');
    assert(e.trim(), `片 ${f} 的词「${t.name}」evidence 为空`);
    stats.evidences++;
    let c = [...sliceBody.keys()].filter((p) => inRegion(p) && sliceBody.get(p).includes(e));
    let out = false;
    if (!c.length) {                             // 章内无命中 → 全域回退
      c = [...sliceBody.keys()].filter((p) => sliceBody.get(p).includes(e));
      out = true;
    }
    assert(c.length, `片 ${f} 的词「${t.name}」evidence 在 v3 切片中无任何命中：${e.slice(0, 30)}…`);
    if (out) stats.outRegion.push(`${f}|${t.name}|→${c[0]}`);
    if (c.length > 1) stats.ambiguous.push(`${f}|${t.name}|${c.length} 候选`);
    cands.push({ name: t.name, list: c });
  }

  // 第二遍：以「无歧义 evidence 的切片序号中位数」为参照消歧
  const anchorOrd = nodeOrder.get(o2n[oldAnchor]) ?? 0;
  const solo = cands.filter((c) => c.list.length === 1).map((c) => orderOf.get(c.list[0]));
  const ref = solo.length ? median(solo) : anchorOrd;
  const picked = cands.map((c) => [...c.list].sort(
    (a, b) => Math.abs(orderOf.get(a) - ref) - Math.abs(orderOf.get(b) - ref) || orderOf.get(a) - orderOf.get(b),
  )[0]);

  // 片级 chunk：单切片 → 该切片文件；多切片 → 最深公共目录
  const uniq = [...new Set(picked)].sort((a, b) => orderOf.get(a) - orderOf.get(b));
  let chunkRel;
  if (uniq.length === 1) {
    chunkRel = uniq[0].replace(/\.md$/, '');
    if (/(^|\/)d\d+$/.test(chunkRel)) stats.deepLeafChunk++;
    stats.fileChunk++;
  } else {
    const segsl = uniq.map((p) => p.replace(/\.md$/, '').split('/'));
    const common = [];
    for (let i = 0; i < Math.min(...segsl.map((s) => s.length)); i++) {
      const v = new Set(segsl.map((s) => s[i]));
      if (v.size === 1) common.push(segsl[0][i]); else break;
    }
    while (common.length && !(existsSync(join(CHUNKS, ...common)) && statSync(join(CHUNKS, ...common)).isDirectory())) common.pop();
    assert(common.length, `片 ${f} 的 ${uniq.length} 个证据切片无公共目录：${uniq.join(', ')}`);
    chunkRel = common.join('/');
    stats.dirChunk++;
  }
  const anchor = pathToNodeId(chunkRel);
  assert(anchor && nodeIds.has(anchor), `片 ${f} 推得的新锚 ${anchor} 不在 nodes.json`);
  results.push({ file: f, rec, oldChunk, oldAnchor, chunk: `${BOOK}/${chunkRel}`, chunkRel, anchor, uniq });
}

// ---- 硬校验 1/2：anchorNode 全部存在于 nodes.json；chunk 全部对应磁盘实存 ----
for (const r of results) {
  assert(nodeIds.has(r.anchor), `${r.file}: anchorNode ${r.anchor} 不在 nodes.json`);
  const segs = r.chunk.split('/');
  const p = join(ROOT, segs[0], '_chunks', ...segs.slice(1));
  const okFile = existsSync(`${p}.md`) && statSync(`${p}.md`).isFile();
  const okDir = existsSync(p) && statSync(p).isDirectory();
  assert(okFile || okDir, `${r.file}: chunk ${r.chunk} 在磁盘上既非 .md 文件也非目录`);
  assert(!(okFile && okDir), `${r.file}: chunk ${r.chunk} 同时存在同名 .md 与目录，路径有歧义`);
}

// ---- 硬校验 3：evidence ⊂ chunk 文本（复刻 merge-terms::chunkText 的解析与回退）----
function collectMd(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...collectMd(p));
    else if (f.endsWith('.md')) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}
function chunkText(chunkId) {
  const segs = chunkId.split('/');
  const p = join(ROOT, segs[0], '_chunks', ...segs.slice(1));
  try { return readFileSync(`${p}.md`, 'utf8'); } catch { /* 回退目录 */ }
  return collectMd(p).join('\n');
}
let evChecked = 0;
const evBad = [];
for (const r of results) {
  const text = chunkText(r.chunk);
  for (const t of r.rec.terms || []) {
    evChecked++;
    if (!text.includes(t.evidence)) evBad.push(`${r.file}|${t.name}`);
  }
}
assert(evBad.length === 0, `${evBad.length} 条 evidence 不是新 chunk 文本的连续子串：${evBad.slice(0, 5).join(', ')}`);

// ---- 统计 ----
const dep = (id) => id.split('-').length - 1;
const sink = {};
for (const r of results) {
  const d = dep(r.anchor) - dep(r.oldAnchor);
  sink[d] = (sink[d] || 0) + 1;
}
const renamedOnly = results.filter((r) => r.anchor !== o2n[r.oldAnchor]).length;
console.log('—— 109 片迁移账 ——');
console.log(`evidence 总数 ${stats.evidences}（逐条子串校验通过 ${evChecked}）`);
console.log(`chunk 形态：单切片文件 ${stats.fileChunk}（其中指向深叶片 dNN ${stats.deepLeafChunk}）/ 目录级 ${stats.dirChunk}`);
console.log(`锚点深度变化（新锚深度 − 旧锚深度）：${Object.entries(sink).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k >= 0 ? '+' : ''}${k}:${v} 片`).join('  ')}`);
console.log(`新锚 ≠ 旧锚按映射表直接改名的结果（即真正重定位）：${renamedOnly} 片`);
console.log(`章内无命中回退全域：${stats.outRegion.length} 条${stats.outRegion.length ? ' → ' + stats.outRegion.join('; ') : ''}`);
console.log(`同一 evidence 多切片命中（已按文档序消歧）：${stats.ambiguous.length} 条${stats.ambiguous.length ? ' → ' + stats.ambiguous.join('; ') : ''}`);
console.log('样例：');
for (const r of results.slice(0, 3)) console.log(`  ${r.file}\n    chunk ${r.oldChunk} → ${r.chunk}\n    anchor ${r.oldAnchor} → ${r.anchor}`);
if (process.argv.includes('--verbose')) {
  console.log('—— 逐片明细（旧 chunk | 旧锚 → 新 chunk | 新锚 | 深度差 | 证据切片数）——');
  for (const r of results) {
    console.log(`  ${r.oldChunk} | ${r.oldAnchor} → ${r.chunk} | ${r.anchor} | ${dep(r.anchor) - dep(r.oldAnchor) >= 0 ? '+' : ''}${dep(r.anchor) - dep(r.oldAnchor)} | ${r.uniq.length}`);
  }
}

// ---- 写盘（文件名不变；对原始文本做定点替换，只动 chunk / anchorNode 两行，
//      其余字节——含自定义缩进、terms 单行紧凑排版、尾换行——逐字节保留）----
if (DRY) { console.log('（--dry-run：未写盘）'); process.exit(0); }
let written = 0;
for (const r of results) {
  const raw = readFileSync(join(EXTRACT_DIR, r.file), 'utf8');
  const before = JSON.parse(raw);
  const reC = /^(\s*"chunk":\s*)"(?:[^"\\]|\\.)*"/m;
  const reA = /^(\s*"anchorNode":\s*)"(?:[^"\\]|\\.)*"/m;
  assert(reC.test(raw) && reA.test(raw), `${r.file}: 未找到可定点替换的 chunk / anchorNode 行`);
  const next = raw
    .replace(reC, (_m, p1) => p1 + JSON.stringify(r.chunk))
    .replace(reA, (_m, p1) => p1 + JSON.stringify(r.anchor));
  const after = JSON.parse(next);
  assert(after.chunk === r.chunk && after.anchorNode === r.anchor, `${r.file}: 替换后字段值不符`);
  before.chunk = r.chunk; before.anchorNode = r.anchor;
  assert(JSON.stringify(before) === JSON.stringify(after), `${r.file}: 替换改动了 chunk/anchorNode 之外的内容`);
  writeFileSync(join(EXTRACT_DIR, r.file), next);
  written++;
}
console.log(`✓ 已写回 ${written} 片（文件名不变；仅 chunk / anchorNode 两字段更新，其余字节不变）`);
