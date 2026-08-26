// 一次性脚本（阶段5.3 批次 W7）：术语资产随 id 大迁移的同步改写
//
// ── 用途 ────────────────────────────────────────────────────────────────────
//   阶段5.3 W4 完成全库 id 重排（renamed 3886 / deleted 79 / added 951），W6 用
//   slice-tools 对《商标审查审理指南》重新切片（节点级 1200 片 + 全书 preamble 1 片）。
//   术语侧四份资产的节点指针与切片指针随之失效，本脚本按查表机械改写：
//     a) data/term-extract/ 的 109 个 tmeg 片：anchorNode（节点指针）+ chunk（切片指针）双指针；
//     b) data/terms-merged.json：sources['trademark-exam-guide-2021'] 的 105 个旧 id
//        （209 个词条持有）+ evidence[].chunk 的 232 处 tmeg 切片指针；
//     c) data/terms-seed.json：sources['trademark-exam-guide-2021'] 的 43 个旧 id（68 个词条持有）；
//     d) data/term-candidates.json：**不迁**（管线内无消费者，仅登记现状，见文末登记块）。
//
// ── 输入（全部只读）────────────────────────────────────────────────────────
//   data/id-map-phase53.json                     W4 产物，renamed/deleted/added，旧 id → 新 id 唯一权威
//   ../../slice-tools/data/slice-manifest.json   W6 产物，books[tmeg].records[]：node_id → path 唯一权威
//   ../../trademark-exam-guide-2021/_chunks/     W6 重切后的切片树，evidence 硬校验的唯一依据
//   data/nodes.json                              新树 6247 节点，id 存在性判定的唯一依据
//
// ── 纪律 ────────────────────────────────────────────────────────────────────
//   1. **不跑 merge-terms**：terms-merged.json 为冻结产物，只做定点字段改写，不重新生成。
//   2. **严禁「同名 id 在新树存在就沿用」的兜底**：tmeg 的 id 空间是链式复用的
//      （新 tmeg-01 = 旧 tmeg-02，依此类推），105 个旧 id 中 32 个在新树「碰巧存在」
//      但指向完全不同的章节。一律整体查 renamed 表改写，命中不到即停报。
//   3. **严禁对旧切片路径做「部序−1 + dNN→NN」的朴素文本变换**：W6 实测该变换在
//      「真 H3 与深叶混居」的父目录下会错出真实存在的路径（静默指错内容）。
//      切片指针一律走「节点 id → manifest.path」查表。
//   4. 文件名一律保留旧名，只改内部字段（沿用 5.2 降级案，见 data/term-extract/README.md）。
//   5. 幂等：重跑时若判定已处于新态则拒绝执行并 exit 0；处于旧态才改写；两态皆不符即 exit 1。
//   6. 改前对每个涉改文件在同目录做 `<原名>.bak_20260825_W7前` 备份（已存在则不覆盖，
//      以保住首次迁移前的原始快照）。
//   7. 严禁虚构：任何一处查表未命中、硬校验不过，立即 exit 1 停报，不做猜测性回退。
//
// ── 切片指针的解析口径（与 merge-terms.mjs::chunkText 兼容）────────────────
//   新 chunk = `<BOOK>/<rel>`，其中 rel 由「新节点 id → manifest.path」查表后按下式归一：
//     · 容器节点（manifest.path 形如 `X/_preamble.md`）→ rel = `X`（目录，覆盖该节点子树）；
//     · 叶节点  （manifest.path 形如 `X.md`）          → rel = `X`（单片文件）。
//   两种写法 chunkText 都能解析：先试 `<rel>.md` 文件，失败回退目录递归拼接。
//   本口径恒满足 pathToNodeId(rel) ≡ anchorNode，且天然保住 5.2 的粒度分布
//   （实测 109 片 = 容器目录形 75 + 叶文件形 34，与 5.2 的「目录级 75 / 文件级 34」一致）。
//   之所以不能简单取 manifest.path 单片：W6 重切后容器节点的切片只含自身导语
//   （`_preamble.md`），不含子树正文，395 条 evidence 中有 320 条会落空。
//
// ── 兜底（本批实测未触发，保留为安全网）────────────────────────────────────
//   若某片按上式得到的 chunk 不能覆盖其全部 evidence，则逐条 evidence 在新 _chunks
//   全树内做逐字子串定位：命中唯一片则取全部命中片的最深公共路径并复验；
//   零命中或多片歧义即停报。
//
// ── 沿革 ────────────────────────────────────────────────────────────────────
//   5.1  migrate-tmeg-layout-phase51.mjs        tmeg 104 → 813 节点，布局迁移
//   5.2  oneoff-migrate-term-extract-phase52.mjs term-extract 109 片双指针（v2 → v3 切片）
//   5.3  oneoff-build-idmap-phase53.mjs (W4)     全库 id 重排映射表
//        append-layout-phase53.mjs               布局随 id 迁移
//        本脚本 (W7)                             术语资产随 id 迁移
//
// 用法：node scripts/oneoff-migrate-term-phase53.mjs [--dry-run] [--verbose]

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const ROOT = join(__dirname, '..', '..', '..');              // PatentReader/
const BOOK = 'trademark-exam-guide-2021';
const CHUNKS = join(ROOT, BOOK, '_chunks');
const MANIFEST = join(ROOT, 'slice-tools', 'data', 'slice-manifest.json');
const EXTRACT_DIR = join(D, 'term-extract');
const IDMAP_PATH = join(D, 'id-map-phase53.json');
const NODES_PATH = join(D, 'nodes.json');
const MERGED_PATH = join(D, 'terms-merged.json');
const SEED_PATH = join(D, 'terms-seed.json');
const CAND_PATH = join(D, 'term-candidates.json');
const BAK_SUFFIX = '.bak_20260825_W7前';

const DRY = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const fail = (msg) => { console.error(`✗ 停报：${msg}`); process.exit(1); };
const assert = (cond, msg) => { if (!cond) fail(msg); };
const log = (s = '') => console.log(s);

// ── 通用工具 ────────────────────────────────────────────────────────────────

// slice-tools/lib/tmeg.mjs::pathToNodeId 的等价实现（切片相对路径 → 节点 id）
function pathToNodeId(relPath) {
  const segs = relPath.replace(/\.md$/, '').split('/');
  if (segs[segs.length - 1] === '_preamble') segs.pop();
  while (segs.length && /^d\d+$/.test(segs[segs.length - 1])) segs.pop();
  return segs.length ? `tmeg-${segs.join('-')}` : null;
}

function collectMd(dir) {
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...collectMd(p));
    else if (f.endsWith('.md')) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}

// merge-terms.mjs::chunkText 的等价实现：先文件、后目录递归；两者皆无返回 null
const _textCache = new Map();
function chunkText(chunkId) {
  if (_textCache.has(chunkId)) return _textCache.get(chunkId);
  const segs = chunkId.split('/');
  const p = join(ROOT, segs[0], '_chunks', ...segs.slice(1));
  let t = null;
  try { t = readFileSync(`${p}.md`, 'utf8'); } catch { /* 回退目录 */ }
  if (t === null) { try { if (statSync(p).isDirectory()) t = collectMd(p).join('\n'); } catch { /* 无实体 */ } }
  _textCache.set(chunkId, t);
  return t;
}

function backup(path) {
  const bak = path + BAK_SUFFIX;
  if (existsSync(bak)) return 'kept';         // 已有首次迁移前快照，不覆盖
  if (DRY) return 'dry';
  copyFileSync(path, bak);
  return 'made';
}

// ── 读入与前提复核 ──────────────────────────────────────────────────────────

log('—— 前提复核 ——');

const idmap = JSON.parse(readFileSync(IDMAP_PATH, 'utf8'));
assert(idmap.schema === 'id-map-phase53/1', `id-map schema 非预期：${idmap.schema}`);
const renamed = idmap.renamed;
const deleted = new Set(idmap.deleted);
const added = new Set(idmap.added);
assert(Object.keys(renamed).length === 3886, `renamed 应 3886，实际 ${Object.keys(renamed).length}`);
assert(idmap.deleted.length === 79, `deleted 应 79，实际 ${idmap.deleted.length}`);
assert(idmap.added.length === 951, `added 应 951，实际 ${idmap.added.length}`);
const tmegRenamed = Object.keys(renamed).filter((k) => k.startsWith('tmeg-'));
assert(tmegRenamed.length === 812, `tmeg 段 renamed 应 812，实际 ${tmegRenamed.length}`);
assert(idmap.deleted.filter((x) => x.startsWith('tmeg-')).length === 1, 'tmeg 段 deleted 应恰为 1（tmeg-01）');
assert(idmap.added.filter((x) => x.startsWith('tmeg-')).length === 388, 'tmeg 段 added 应 388');
log(`P1 id-map-phase53：renamed 3886（tmeg 812）/ deleted 79（tmeg 1）/ added 951（tmeg 388）✓`);

const nodes = JSON.parse(readFileSync(NODES_PATH, 'utf8'));
const nodeIds = new Set(nodes.map((n) => n.id));
const nodeLabel = new Map(nodes.map((n) => [n.id, n.label]));
assert(nodes.length === 6247, `nodes.json 应 6247，实际 ${nodes.length}`);
assert(nodes.length === nodeIds.size, 'nodes.json 存在重复 id');
log(`P2 nodes.json：6247 节点、id 无重复 ✓`);

const mfRecords = JSON.parse(readFileSync(MANIFEST, 'utf8')).books[BOOK].records;
assert(mfRecords.length === 1201, `slice-manifest tmeg 应 1201 条，实际 ${mfRecords.length}`);
const pathOfNode = new Map();
const nodeOfPath = new Map();
for (const r of mfRecords) {
  if (!r.node_id) continue;
  assert(!pathOfNode.has(r.node_id), `manifest 中 node_id 重复：${r.node_id}`);
  pathOfNode.set(r.node_id, r.path);
  nodeOfPath.set(r.path, r.node_id);
}
assert(pathOfNode.size === 1200, `manifest 带 node_id 的记录应 1200，实际 ${pathOfNode.size}`);
assert([...pathOfNode.keys()].every((id) => nodeIds.has(id)), 'manifest 中存在不在 nodes.json 的 node_id');
log(`P3 slice-manifest（W6）：1201 条 = 节点级 1200 + preamble 1，node_id 唯一且全在 nodes.json ✓`);

// 新 chunk 归一：容器 → 目录；叶 → 文件（去 .md）
function newChunkRel(nodeId) {
  const mp = pathOfNode.get(nodeId);
  if (!mp) return null;
  return mp.endsWith('/_preamble.md') ? mp.slice(0, -'/_preamble.md'.length) : mp.replace(/\.md$/, '');
}
// 1200 个节点的 chunk 路径必须在磁盘上有唯一实体且无 file/dir 歧义
for (const id of pathOfNode.keys()) {
  const p = join(CHUNKS, newChunkRel(id));
  const isF = existsSync(`${p}.md`) && statSync(`${p}.md`).isFile();
  const isD = existsSync(p) && statSync(p).isDirectory();
  assert(isF || isD, `节点 ${id} 的 chunk 路径在磁盘上无实体：${newChunkRel(id)}`);
  assert(!(isF && isD), `节点 ${id} 的 chunk 路径同时存在同名 .md 与目录，有歧义：${newChunkRel(id)}`);
}
log(`P4 _chunks 实体：1200 个节点 chunk 路径全部实存、file/dir 无歧义 ✓`);

// term-extract 全域复核：745 片、anchorNode 域仅七书 + tmeg
const allExtractFiles = readdirSync(EXTRACT_DIR).filter((f) => f.endsWith('.json')).sort();
assert(allExtractFiles.length === 745, `term-extract 应 745 片，实际 ${allExtractFiles.length}`);
const BOOKS8 = new Set(['patent-law', 'implementation-rules', 'examination-guideline', 'infringement-guide',
  'mechanical-drafting-rules', 'chemistry-drafting-rules', 'oa-response-guide', BOOK]);
const extractRecs = new Map();
const domainTally = {};
for (const f of allExtractFiles) {
  const rec = JSON.parse(readFileSync(join(EXTRACT_DIR, f), 'utf8'));
  assert(rec.anchorNode, `片 ${f} 缺 anchorNode`);
  assert(rec.chunk, `片 ${f} 缺 chunk`);
  const dom = String(rec.chunk).split('/')[0];
  assert(BOOKS8.has(dom), `片 ${f} 的 chunk 域 ${dom} 不在八书清单内`);
  const isTmeg = String(rec.anchorNode).startsWith('tmeg-');
  assert(isTmeg === (dom === BOOK), `片 ${f} 的 anchorNode 域与 chunk 域不一致：${rec.anchorNode} / ${rec.chunk}`);
  domainTally[dom] = (domainTally[dom] || 0) + 1;
  extractRecs.set(f, rec);
}
const tmegFiles = allExtractFiles.filter((f) => String(extractRecs.get(f).anchorNode).startsWith('tmeg-'));
assert(tmegFiles.length === 109, `tmeg 片应 109，实际 ${tmegFiles.length}`);
// 七书片（本阶段 id 未变）的 anchorNode 必须已经全部落在新树上
const sevenBad = allExtractFiles.filter((f) => !String(extractRecs.get(f).anchorNode).startsWith('tmeg-'))
  .filter((f) => !nodeIds.has(extractRecs.get(f).anchorNode));
assert(sevenBad.length === 0,
  `${sevenBad.length} 个非 tmeg 片的 anchorNode 不在 nodes.json（七书 id 本阶段应未变）：${sevenBad.slice(0, 5).join(', ')}`);
log(`P5 term-extract：745 片、anchorNode 域分布 ${JSON.stringify(domainTally)}；`);
log(`   tmeg 109 片，其余 636 片（七书）anchorNode 全部已在新树 ✓`);

// terms-merged / terms-seed / term-candidates 读入与基线
const rawMerged = readFileSync(MERGED_PATH, 'utf8');
const merged = JSON.parse(rawMerged);
assert(rawMerged === JSON.stringify(merged, null, 2), 'terms-merged.json 排版非 JSON.stringify(x,null,2)，定点改写不安全');
assert(merged.length === 1035, `terms-merged 词表应 1035 条，实际 ${merged.length}`);
const rawSeed = readFileSync(SEED_PATH, 'utf8');
const seed = JSON.parse(rawSeed);
assert(rawSeed === JSON.stringify(seed, null, 2), 'terms-seed.json 排版非 JSON.stringify(x,null,2)，定点改写不安全');
assert(seed.length === 490, `terms-seed 应 490 条，实际 ${seed.length}`);
assert(seed.every((t) => !('evidence' in t)), 'terms-seed 出现 evidence 字段，与既有结构不符');

const mergedTmegTerms = merged.filter((t) => t.sources && t.sources[BOOK]);
const mergedTmegIds = new Set(mergedTmegTerms.flatMap((t) => t.sources[BOOK]));
assert(mergedTmegTerms.length === 209, `terms-merged tmeg 出处词条应 209，实际 ${mergedTmegTerms.length}`);
assert(mergedTmegIds.size === 105, `terms-merged tmeg 唯一 id 应 105，实际 ${mergedTmegIds.size}`);
const mergedTmegEv = [];
for (const t of merged) for (const e of t.evidence || []) if (String(e.chunk).startsWith(`${BOOK}/`)) mergedTmegEv.push({ t, e });
assert(mergedTmegEv.length === 232, `terms-merged tmeg evidence 指针应 232 处，实际 ${mergedTmegEv.length}`);
assert(new Set(mergedTmegEv.map((x) => x.e.chunk)).size === 79, 'terms-merged tmeg 唯一 chunk 应 79');
const seedTmegTerms = seed.filter((t) => t.sources && t.sources[BOOK]);
const seedTmegIds = new Set(seedTmegTerms.flatMap((t) => t.sources[BOOK]));
log(`P6 terms-merged：1035 词条 / tmeg 出处 209 词条、唯一 id 105 / tmeg evidence 232 处（唯一 79）✓`);
log(`P7 terms-seed：490 词条 / tmeg 出处 ${seedTmegTerms.length} 词条、唯一 id ${seedTmegIds.size}（无 evidence 字段）✓`);
log();

// ── 状态判定（幂等）──────────────────────────────────────────────────────────

function extractIsNew() {
  for (const f of tmegFiles) {
    const r = extractRecs.get(f);
    if (!nodeIds.has(r.anchorNode)) return false;
    if (!pathOfNode.has(r.anchorNode)) return false;
    if (r.chunk !== `${BOOK}/${newChunkRel(r.anchorNode)}`) return false;
    const txt = chunkText(r.chunk);
    if (txt === null) return false;
    for (const t of r.terms || []) if (!txt.includes(t.evidence)) return false;
  }
  return true;
}
function extractIsOld() {
  if (!tmegFiles.every((f) => renamed[extractRecs.get(f).anchorNode])) return false;
  // 旧态判据：现 chunk 在新切片树下一条 evidence 也覆盖不住（实测 0/395）
  let hit = 0;
  for (const f of tmegFiles) {
    const r = extractRecs.get(f);
    const txt = chunkText(r.chunk);
    if (txt === null) continue;
    for (const t of r.terms || []) if (txt.includes(t.evidence)) hit++;
  }
  return hit === 0;
}
const srcIsNew = (ids) => [...ids].every((i) => nodeIds.has(i));
const srcIsOld = (ids) => [...ids].every((i) => i in renamed) && ![...ids].every((i) => nodeIds.has(i));

const stateNew = extractIsNew() && srcIsNew(mergedTmegIds) && srcIsNew(seedTmegIds);
const stateOld = extractIsOld() && srcIsOld(mergedTmegIds) && srcIsOld(seedTmegIds);

if (stateNew) {
  log('◇ 幂等判定：三份资产均已处于阶段5.3 新态（anchorNode/sources 全部落在新树，');
  log('  109 片 395 条 evidence 全部被新 chunk 覆盖）。本脚本为一次性迁移，拒绝重复执行。');
  process.exit(0);
}
assert(stateOld, '既非「阶段5.3 前旧态」也非「已迁移新态」，数据处于未知中间态，拒绝执行');
log('◇ 幂等判定：三份资产处于阶段5.3 前旧态，开始迁移。');
log();

// ── a) term-extract 109 片：anchorNode + chunk 双指针 ────────────────────────

log('—— a) term-extract 109 片 ——');
const teResults = [];
const teStat = { dirForm: 0, fileForm: 0, fallback: 0, evidences: 0 };
const allSliceBody = new Map();
for (const r of mfRecords) allSliceBody.set(r.path, readFileSync(join(CHUNKS, r.path), 'utf8'));

for (const f of tmegFiles) {
  const rec = extractRecs.get(f);
  const oldAnchor = rec.anchorNode;
  const oldChunk = rec.chunk;
  const newAnchor = renamed[oldAnchor];
  assert(newAnchor, `片 ${f} 的旧锚 ${oldAnchor} 不在 id-map.renamed（tmeg 全域皆应 renamed）`);
  assert(nodeIds.has(newAnchor), `片 ${f} 的新锚 ${newAnchor} 不在 nodes.json`);
  assert(pathOfNode.has(newAnchor), `片 ${f} 的新锚 ${newAnchor} 在 slice-manifest 无对应切片`);

  const terms = rec.terms || [];
  assert(terms.length > 0, `片 ${f} 无 terms`);
  for (const t of terms) assert(String(t.evidence || '').trim(), `片 ${f} 的词「${t.name}」evidence 为空`);
  teStat.evidences += terms.length;

  // 主路径：新锚 → manifest.path → 归一
  let rel = newChunkRel(newAnchor);
  let text = chunkText(`${BOOK}/${rel}`);
  let via = pathOfNode.get(newAnchor).endsWith('/_preamble.md') ? 'dir' : 'file';
  let uncovered = terms.filter((t) => text === null || !text.includes(t.evidence));

  // 兜底：逐条 evidence 在全树唯一定位 → 取最深公共路径（本批实测未触发）
  if (uncovered.length) {
    const picked = [];
    for (const t of terms) {
      const hits = [...allSliceBody.keys()].filter((p) => allSliceBody.get(p).includes(t.evidence));
      assert(hits.length > 0, `兜底失败：片 ${f} 的词「${t.name}」evidence 在新 _chunks 全树零命中`);
      assert(hits.length === 1, `兜底失败：片 ${f} 的词「${t.name}」evidence 在新 _chunks 命中 ${hits.length} 片（不唯一）`);
      picked.push(hits[0]);
    }
    const segl = [...new Set(picked)].map((p) => p.replace(/\.md$/, '').split('/'));
    const common = [];
    for (let i = 0; i < Math.min(...segl.map((s) => s.length)); i++) {
      const v = new Set(segl.map((s) => s[i]));
      if (v.size === 1) common.push(segl[0][i]); else break;
    }
    while (common.length && !(existsSync(join(CHUNKS, ...common)) && statSync(join(CHUNKS, ...common)).isDirectory())) common.pop();
    assert(common.length, `兜底失败：片 ${f} 的证据切片无公共目录`);
    rel = common.join('/');
    text = chunkText(`${BOOK}/${rel}`);
    uncovered = terms.filter((t) => !text.includes(t.evidence));
    assert(uncovered.length === 0, `兜底失败：片 ${f} 复验仍有 ${uncovered.length} 条 evidence 未覆盖`);
    assert(pathToNodeId(rel) === newAnchor, `兜底失败：片 ${f} 兜底路径 ${rel} 反查 id ≠ 新锚 ${newAnchor}`);
    via = 'fallback';
    teStat.fallback++;
  } else {
    teStat[via === 'dir' ? 'dirForm' : 'fileForm']++;
  }
  assert(pathToNodeId(rel) === newAnchor, `片 ${f}: chunk ${rel} 反查 id ≠ anchorNode ${newAnchor}`);
  teResults.push({ file: f, rec, oldAnchor, oldChunk, newAnchor, newChunk: `${BOOK}/${rel}`, via, terms });
}
log(`解析完成：109 片（容器目录形 ${teStat.dirForm} / 叶文件形 ${teStat.fileForm} / 兜底 ${teStat.fallback}）`
  + `，evidence ${teStat.evidences} 条`);

// ── b) terms-merged.json ────────────────────────────────────────────────────

log();
log('—— b) terms-merged.json ——');
const mergedNext = JSON.parse(rawMerged);            // 独立深拷贝，原对象保留作 diff 基准
let mSrcTerms = 0, mSrcIds = 0, mEvFixed = 0;
const chunkMapUsed = new Map();
for (let i = 0; i < mergedNext.length; i++) {
  const t = mergedNext[i];
  const list = t.sources && t.sources[BOOK];
  if (list) {
    mSrcTerms++;
    t.sources[BOOK] = list.map((old) => {
      const nid = renamed[old];
      assert(nid, `terms-merged 词条「${t.termKey}」的出处 ${old} 不在 id-map.renamed`);
      assert(nodeIds.has(nid), `terms-merged 词条「${t.termKey}」的出处 ${old} → ${nid} 不在 nodes.json`);
      mSrcIds++;
      return nid;
    });
    assert(new Set(t.sources[BOOK]).size === t.sources[BOOK].length,
      `terms-merged 词条「${t.termKey}」出处映射后出现重复 id`);
  }
  for (const e of t.evidence || []) {
    if (!String(e.chunk).startsWith(`${BOOK}/`)) continue;
    const relOld = e.chunk.slice(BOOK.length + 1);
    const oldId = pathToNodeId(relOld);
    assert(oldId, `terms-merged 词条「${t.termKey}」的 chunk ${e.chunk} 无法反查节点 id`);
    const nid = renamed[oldId];
    assert(nid, `terms-merged 词条「${t.termKey}」的 chunk ${e.chunk} 反查 id ${oldId} 不在 renamed`);
    assert(pathOfNode.has(nid), `terms-merged：新 id ${nid} 在 slice-manifest 无对应切片`);
    const relNew = newChunkRel(nid);
    const txt = chunkText(`${BOOK}/${relNew}`);
    assert(txt !== null, `terms-merged：重指后路径 ${BOOK}/${relNew} 在磁盘上无实体`);
    assert(txt.includes(e.text),
      `terms-merged 词条「${t.termKey}」evidence 文本不是新 chunk ${BOOK}/${relNew} 的子串：${String(e.text).slice(0, 24)}…`);
    chunkMapUsed.set(e.chunk, `${BOOK}/${relNew}`);
    e.chunk = `${BOOK}/${relNew}`;
    mEvFixed++;
  }
}
assert(mSrcTerms === 209 && mEvFixed === 232, `terms-merged 改写规模异常：sources ${mSrcTerms} 词条 / evidence ${mEvFixed} 处`);
log(`sources：${mSrcTerms} 词条、${mSrcIds} 处 id 引用整体查表改写（唯一旧 id 105 → 唯一新 id ${new Set(mergedNext.flatMap((t) => t.sources?.[BOOK] || [])).size}）`);
log(`evidence.chunk：${mEvFixed} 处重指（唯一旧 chunk ${chunkMapUsed.size} → 唯一新 chunk ${new Set(chunkMapUsed.values()).size}），`
  + `全部通过「evidence 文本 ⊂ 新 chunk 内容」硬校验`);

// ── c) terms-seed.json ──────────────────────────────────────────────────────

log();
log('—— c) terms-seed.json ——');
const seedNext = JSON.parse(rawSeed);
let sTerms = 0, sIds = 0;
for (const t of seedNext) {
  const list = t.sources && t.sources[BOOK];
  if (!list) continue;
  sTerms++;
  t.sources[BOOK] = list.map((old) => {
    const nid = renamed[old];
    assert(nid, `terms-seed 词条「${t.canonical}」的出处 ${old} 不在 id-map.renamed`);
    assert(nodeIds.has(nid), `terms-seed 词条「${t.canonical}」的出处 ${old} → ${nid} 不在 nodes.json`);
    sIds++;
    return nid;
  });
  assert(new Set(t.sources[BOOK]).size === t.sources[BOOK].length, `terms-seed 词条「${t.canonical}」出处映射后重复`);
}
assert(!/_chunks|\.md/.test(rawSeed), 'terms-seed 出现切片路径形态的引用，超出本脚本已核范围');
log(`sources：${sTerms} 词条、${sIds} 处 id 引用整体查表改写（唯一旧 id ${seedTmegIds.size}）；`
  + `全文无 _chunks / .md 路径引用，无切片指针需迁`);

// ── 硬校验 ──────────────────────────────────────────────────────────────────

log();
log('—— 硬校验 ——');

// V1 迁移后 term-extract 745 片 anchorNode 全部 ∈ nodes.json
const v1new = new Map(teResults.map((r) => [r.file, r.newAnchor]));
const v1bad = allExtractFiles.filter((f) => !nodeIds.has(v1new.get(f) ?? extractRecs.get(f).anchorNode));
assert(v1bad.length === 0, `V1 失败：${v1bad.length} 片 anchorNode 不在 nodes.json：${v1bad.slice(0, 5).join(', ')}`);
log(`V1 term-extract 745 片 anchorNode 全部 ∈ nodes.json ✓（tmeg 109 迁移后 + 七书 636 原样）`);

// V2 tmeg 109 片 evidence ⊂ 新 chunk，全量 395/395
let v2 = 0;
for (const r of teResults) {
  const txt = chunkText(r.newChunk);
  assert(txt !== null, `V2 失败：${r.file} 的新 chunk ${r.newChunk} 无实体`);
  for (const t of r.terms) { assert(txt.includes(t.evidence), `V2 失败：${r.file}｜${t.name}`); v2++; }
}
assert(v2 === 395, `V2 失败：evidence 校验条数 ${v2} ≠ 395`);
log(`V2 tmeg 109 片「evidence 文本 ⊂ 新 chunk 内容」全量通过 ${v2}/395 ✓`);

// V3 terms-merged 全库（八域）sources 引用 id 全部 ∈ nodes.json
const v3bad = [];
for (const t of mergedNext) for (const [dom, list] of Object.entries(t.sources || {}))
  for (const id of list) if (!nodeIds.has(id)) v3bad.push(`${dom}:${id}(${t.termKey})`);
assert(v3bad.length === 0, `V3 失败：${v3bad.length} 处 sources id 不在 nodes.json：${v3bad.slice(0, 5).join(', ')}`);
const v3total = mergedNext.reduce((a, t) => a + Object.values(t.sources || {}).flat().length, 0);
log(`V3 terms-merged 全库体检：八域共 ${v3total} 处 sources 引用全部 ∈ nodes.json ✓`);

// V4 规模恒等
assert(mergedNext.length === 1035, `V4 失败：词表总数 ${mergedNext.length} ≠ 1035`);
assert(mergedNext.filter((t) => t.sources?.[BOOK]).length === 209, 'V4 失败：tmeg 出处词条数 ≠ 209');
assert(mergedNext.reduce((a, t) => a + (t.evidence || []).length, 0)
  === merged.reduce((a, t) => a + (t.evidence || []).length, 0), 'V4 失败：evidence 总条数变化');
log(`V4 规模恒等：词表 1035、tmeg 出处词条 209、evidence 总条 ${mergedNext.reduce((a, t) => a + (t.evidence || []).length, 0)} 均不变 ✓`);

// V5 terms-merged 改写范围外结构 diff 零变化（掩码比对）
function maskMerged(arr) {
  return JSON.stringify(arr, (k, v) => {
    if (k === BOOK && Array.isArray(v)) return `«masked:${v.length}»`;
    return v;
  }, 2).replace(new RegExp(`"chunk": "${BOOK}/[^"]*"`, 'g'), '"chunk": "«masked»"');
}
assert(maskMerged(merged) === maskMerged(mergedNext), 'V5 失败：terms-merged 在改写范围之外发生了变化');
log(`V5 terms-merged 掩码比对：除 sources['${BOOK}'] 与 tmeg 段 evidence[].chunk 外，结构逐字符零变化 ✓`);

// V6 terms-seed 同口径体检
const v6bad = [];
for (const t of seedNext) for (const [dom, list] of Object.entries(t.sources || {}))
  for (const id of list) if (!nodeIds.has(id)) v6bad.push(`${dom}:${id}(${t.canonical})`);
assert(v6bad.length === 0, `V6 失败：terms-seed ${v6bad.length} 处 sources id 不在 nodes.json：${v6bad.slice(0, 5).join(', ')}`);
assert(seedNext.length === 490, 'V6 失败：terms-seed 词条数变化');
assert(maskMerged(seed) === maskMerged(seedNext), 'V6 失败：terms-seed 在改写范围之外发生了变化');
log(`V6 terms-seed：490 词条恒定，全库 ${seedNext.reduce((a, t) => a + Object.values(t.sources || {}).flat().length, 0)} 处 sources 引用全部 ∈ nodes.json，掩码比对零变化 ✓`);

// ── 写盘 ────────────────────────────────────────────────────────────────────

log();
if (DRY) { log('（--dry-run：以下写盘步骤跳过）'); }
log('—— 写盘 ——');

// a) term-extract：定点替换 chunk / anchorNode 两行，其余字节逐字保留
let teWritten = 0, bakMade = 0, bakKept = 0;
for (const r of teResults) {
  const p = join(EXTRACT_DIR, r.file);
  const st = backup(p); if (st === 'made') bakMade++; if (st === 'kept') bakKept++;
  const raw = readFileSync(p, 'utf8');
  const reC = /^(\s*"chunk":\s*)"(?:[^"\\]|\\.)*"/m;
  const reA = /^(\s*"anchorNode":\s*)"(?:[^"\\]|\\.)*"/m;
  assert(reC.test(raw) && reA.test(raw), `${r.file}: 未找到可定点替换的 chunk / anchorNode 行`);
  const next = raw.replace(reC, (_m, p1) => p1 + JSON.stringify(r.newChunk))
    .replace(reA, (_m, p1) => p1 + JSON.stringify(r.newAnchor));
  const before = JSON.parse(raw); const after = JSON.parse(next);
  before.chunk = r.newChunk; before.anchorNode = r.newAnchor;
  assert(JSON.stringify(before) === JSON.stringify(after), `${r.file}: 定点替换改动了 chunk/anchorNode 之外的内容`);
  if (!DRY) { writeFileSync(p, next); teWritten++; }
}
// b/c) terms-merged / terms-seed：同排版重序列化
for (const [p, obj] of [[MERGED_PATH, mergedNext], [SEED_PATH, seedNext]]) {
  const st = backup(p); if (st === 'made') bakMade++; if (st === 'kept') bakKept++;
  if (!DRY) writeFileSync(p, JSON.stringify(obj, null, 2));
}
log(`备份：新建 ${bakMade} 份、沿用既有 ${bakKept} 份（后缀 ${BAK_SUFFIX}）`);
log(DRY ? '（--dry-run：未写盘）' : `已写回 term-extract ${teWritten} 片 + terms-merged.json + terms-seed.json`);

// ── d) term-candidates.json：现状登记（不迁）────────────────────────────────

log();
log('—— d) term-candidates.json（不迁，现状登记）——');
const cand = JSON.parse(readFileSync(CAND_PATH, 'utf8'));
const candTmegTerms = cand.filter((t) => t.sources?.[BOOK]);
const candTmegIds = new Set(candTmegTerms.flatMap((t) => t.sources[BOOK]));
const candEv = cand.flatMap((t) => t.evidence || []).filter((e) => String(e.chunk).startsWith(`${BOOK}/`));
log(`候选池 ${cand.length} 条；tmeg 出处词条 ${candTmegTerms.length}（唯一旧 id ${candTmegIds.size}）；`
  + `tmeg evidence 指针 ${candEv.length} 处（唯一 ${new Set(candEv.map((e) => e.chunk)).size}）`);
log(`管线消费者查证：全仓仅 site/scripts/merge-terms.mjs:404 写入，无任何脚本读取 → 纯中间产物。`);
log(`处置：本批不迁。若日后重跑 merge-terms（当前冻结），该文件将由新态 term-extract 自然重生成。`);
log(`若需要保留历史候选池的可追溯性，建议另案按本脚本同法批量改写（旧 id ${candTmegIds.size} 个、chunk ${new Set(candEv.map((e) => e.chunk)).size} 条）。`);

// ── 抽样报告 ────────────────────────────────────────────────────────────────

log();
log('—— 抽样对照 ——');
const depthOf = (id) => id.split('-').length;
const pureShift = (o, n) => {
  const a = o.slice(5).split('-'), b = n.slice(5).split('-');
  return a.length === b.length && +a[0] === +b[0] + 1 && a.slice(1).join() === b.slice(1).join();
};
const naive = (rel) => rel.split('/').map((s, i) => i === 0
  ? s.replace(/^(\d+)(-.*)?$/, (m, x, y) => String(+x - 1).padStart(2, '0') + (y || ''))
  : (/^d\d+$/.test(s) ? s.slice(1) : s)).join('/');

const shown = (r) => `  ${r.file}\n      chunk  ${r.oldChunk}\n          →  ${r.newChunk}\n      anchor ${r.oldAnchor} → ${r.newAnchor}`;
log('【纯部序位移片】（锚 id 仅首段 −1，路径同构）');
teResults.filter((r) => pureShift(r.oldAnchor, r.newAnchor)).slice(0, 3).forEach((r) => log(shown(r)));
log(`  （此类共 ${teResults.filter((r) => pureShift(r.oldAnchor, r.newAnchor)).length} 片）`);

log('【深叶升节点片】（evidence 落在 W6 新增节点 added 上，旧树中它们只是 dNN 深叶）');
const promoted = [];
for (const r of teResults) {
  const scope = [...allSliceBody.keys()].filter((p) => p === `${r.newChunk.slice(BOOK.length + 1)}.md`
    || p.startsWith(`${r.newChunk.slice(BOOK.length + 1)}/`));
  let n = 0;
  for (const t of r.terms) {
    const hits = scope.filter((p) => allSliceBody.get(p).includes(t.evidence));
    if (hits.length && hits.every((h) => added.has(nodeOfPath.get(h)))) n++;
  }
  if (n) promoted.push({ r, n });
}
promoted.slice(0, 3).forEach(({ r, n }) => log(`${shown(r)}\n      其中 ${n}/${r.terms.length} 条 evidence 落在新增节点（旧树为深叶）`));
log(`  （此类共 ${promoted.length} 片）`);

log('【混居父目录片】（W6 标记的 3 个「真 H3 与深叶混居」父目录，朴素文本变换在此静默指错）');
for (const mix of ['05-03/02/05', '07-16/02/02/02', '07-03/02/02/09']) {
  const parent = mix.split('/').slice(0, -1).join('/');
  const hits = teResults.filter((r) => {
    const rel = r.oldChunk.slice(BOOK.length + 1);
    return rel === mix || rel.startsWith(`${mix}/`) || rel === parent || rel.startsWith(`${parent}/`);
  });
  log(`  · 旧 ${mix}（含父目录 ${parent}）命中 ${hits.length} 片`);
  hits.forEach((r) => {
    const rel = r.oldChunk.slice(BOOK.length + 1);
    const nv = naive(rel);
    const tgt = r.newChunk.slice(BOOK.length + 1);
    log(`      ${r.file}\n        查表 ${tgt}${nv === tgt ? '（与朴素变换一致）' : `  ✗朴素变换会得到 ${nv}（该路径真实存在但内容不符）`}`);
  });
}

log();
log('【terms-merged 陷阱 id 抽样】（旧 id 在新树「碰巧存在」，沿用即静默指错）');
const traps = [...mergedTmegIds].filter((i) => nodeIds.has(i)).sort();
log(`  共 ${traps.length} 个；抽 5 例：`);
for (const id of traps.slice(0, 5)) {
  log(`  ${id} → ${renamed[id]}`);
  log(`      沿用旧 id 会指向「${nodeLabel.get(id)}」，实际正解为「${nodeLabel.get(renamed[id])}」`);
}

if (VERBOSE) {
  log();
  log('—— 109 片逐片明细（旧 chunk | 旧锚 → 新 chunk | 新锚 | 形态）——');
  for (const r of teResults) log(`  ${r.oldChunk} | ${r.oldAnchor} → ${r.newChunk} | ${r.newAnchor} | ${r.via}`);
  log('—— terms-merged 79 条 chunk 映射 ——');
  for (const [k, v] of [...chunkMapUsed].sort()) log(`  ${k} → ${v}`);
}

log();
log(DRY ? '✓ dry-run 完成：全部前提复核与硬校验通过，未写盘。' : '✓ W7 迁移完成：全部硬校验通过。');
