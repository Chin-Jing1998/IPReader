#!/usr/bin/env node
// 数据管线 D3-1：术语提取批次准备
//   枚举 7 个规范域 `_chunks/**` 的叶子切片（跳过 _preamble.md，含 _full-chapter.md），
//   解析每片首行面包屑与首个标题，在该域 nodes.json 节点中四级 fallback 匹配 anchorNodeId：
//     override（lib/anchor-overrides.mjs 手工映射）→ 精确 label → 归一（全半角/空白/序号剥离）
//     → 面包屑逐级路径 → 前缀；层内多候选时先按祖先路径过滤、再按切片路径编号派生 id tie-break。
//   产物：
//     - data/term-batches/manifest.json   [{batchNo, chunks:[{chunkPath, chunkId, domain,
//                                           anchorNodeId, breadcrumb, charLen}]}]
//       批规模 8~10 片、同域切片聚在同批（提示词共享域上下文）。
//     - audit/terms/anchor-unresolved.csv 锚定失败清单（UTF-8 BOM；正常应仅表头）。
//   末尾断言：切片总数 636±5 且锚定率 100%，不满足则打印全部失败项并 exit 1。
//   运行：node scripts/prep-term-extraction.mjs
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_DOMAINS, projectRoot } from './lib/domains.mjs';
import { ANCHOR_OVERRIDES } from './lib/anchor-overrides.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(__dirname);
const DATA_DIR = join(__dirname, '..', 'data');
const BATCH_DIR = join(DATA_DIR, 'term-batches');
const AUDIT_DIR = join(__dirname, '..', 'audit', 'terms');
mkdirSync(BATCH_DIR, { recursive: true });
mkdirSync(AUDIT_DIR, { recursive: true });

// 批规模约束：8~10 片/批（同域）
const BATCH_MAX = 10;
// 切片总数断言区间（任务书基线 636±5）
const EXPECTED_CHUNKS = 636;
const CHUNK_TOLERANCE = 5;

const pad = (n) => String(n).padStart(2, '0');
// 归一化：NFKC（全半角统一）+ 去空白 + 小写（与 build-seed-lexicon.mjs 同口径）
const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// 序号剥离（作用于归一化后的串）：剥去一层结构序号前缀，用于「第X章YYY」↔「YYY」等价比对。
//   注意：不剥「第X条」——条号本身就是法/细则节点的语义主体。
const ORD_RES = [
  /^第[0-9一二三四五六七八九十百零〇两]+(?:部分|章|节)/, // 第一部分/第八章/第三节
  /^[0-9]+(?:\.[0-9]+)*[.、]?/, // 8. / 4.12 / 3.6.（NFKC 后全角句点已归半角）
  /^[一二三四五六七八九十]+、/, // 一、
  /^\([一二三四五六七八九十]+\)/, // （一） NFKC 后为 (一)
];
function stripOrd(s) {
  for (const re of ORD_RES) {
    const t = s.replace(re, '');
    if (t && t !== s) return t; // 只剥一层；剥空则视为无效、保留原串
  }
  return s;
}
const keyOf = (s) => stripOrd(norm(s));

// ============ 节点索引：按域预计算匹配用字段 ============
const nodes = JSON.parse(readFileSync(join(DATA_DIR, 'nodes.json'), 'utf8'));
const nodesByDomain = new Map();
for (const n of nodes) {
  // 面包屑路径：guideline 的 breadcrumb 不含书名；通用域首元素为规范全名，剥掉后与切片段对齐
  const bc = n.domain === 'examination-guideline-2025' ? n.breadcrumb : n.breadcrumb.slice(1);
  const entry = {
    id: n.id,
    label: n.label,
    labelNorm: norm(n.label),
    labelKey: keyOf(n.label),
    pathSegs: [...bc, n.label].map(keyOf),
  };
  if (!nodesByDomain.has(n.domain)) nodesByDomain.set(n.domain, []);
  nodesByDomain.get(n.domain).push(entry);
}

// ============ 切片枚举 ============
function walkMd(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkMd(p));
    else if (name.endsWith('.md') && name !== '_preamble.md') out.push(p);
  }
  return out;
}

// 解析切片：首行面包屑 `> 〔《书名》｜段1｜段2…〕` + 首个 markdown 标题
function parseChunk(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const lines = raw.split('\n');
  const bm = lines[0].match(/^>\s*〔(.+)〕\s*$/);
  if (!bm) return { error: '首行不是面包屑' };
  const allSegs = bm[1].split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
  if (allSegs.length < 2) return { error: '面包屑段数不足' };
  let heading = null;
  for (const line of lines.slice(1)) {
    const hm = line.match(/^#{1,6}\s+(.*\S)\s*$/);
    if (hm) {
      heading = hm[1].trim();
      break;
    }
  }
  if (!heading) return { error: '未找到标题行' };
  // 正文字符量（去掉面包屑行后的非空白字符数），供批次均衡与下游参考
  const charLen = lines.slice(1).join('\n').replace(/\s/g, '').length;
  return { breadcrumb: bm[1].trim(), segs: allSegs.slice(1), heading, charLen };
}

// 由切片相对路径的数字段派生候选节点 id（仅作层内多候选 tie-break，不作独立匹配层级）：
//   guideline: 02/008/04/12 → 02-08-04-12；通用域: 03/001 → <prefix>-03-01
function deriveIdFromPath(dom, relSegs) {
  const digits = relSegs.filter((s) => /^\d+$/.test(s)).map((s) => pad(parseInt(s, 10)));
  if (!digits.length) return null;
  return dom.special === 'guideline' ? digits.join('-') : [dom.prefix, ...digits].join('-');
}

// ============ 四级锚定匹配 ============
const arrEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// 路径叶子容差：相等，或节点 label 为「切片叶子 + · 小标题」（法/细则条文节点的升级 label）
function leafCompatible(nodeLeaf, chunkLeaf) {
  return nodeLeaf === chunkLeaf || (nodeLeaf.startsWith(chunkLeaf) && nodeLeaf.charAt(chunkLeaf.length) === '·');
}

// 层内收敛：唯一即中；多候选先按祖先路径过滤，仍多则用路径编号派生 id tie-break
function settle(cands, chunkAnc, derivedId) {
  if (cands.length === 1) return cands[0];
  if (!cands.length) return null;
  const byAnc = cands.filter((n) => arrEq(n.pathSegs.slice(0, -1), chunkAnc));
  if (byAnc.length === 1) return byAnc[0];
  const pool = byAnc.length ? byAnc : cands;
  return pool.find((n) => n.id === derivedId) || null;
}

function resolveAnchor(domainKey, chunkId, parsed, derivedId) {
  const domainNodes = nodesByDomain.get(domainKey) || [];
  // 切片路径段（归一+剥序号）。连续重复段去重仅看「归一后原样相等」（_full-chapter 的
  // 「章｜章」真实重复），不看剥序号后的键——否则「第十章X｜4.X」会被误并成一段。
  const segKeys = [];
  let prevNorm = null;
  for (const s of parsed.segs) {
    const nk = norm(s);
    if (nk === prevNorm) continue;
    prevNorm = nk;
    segKeys.push(keyOf(s));
  }
  const leafRaw = parsed.segs[parsed.segs.length - 1];
  const leafKey = segKeys[segKeys.length - 1];
  const anc = segKeys.slice(0, -1);

  // 第 0 级：手工映射表
  const ov = ANCHOR_OVERRIDES.get(chunkId);
  if (ov) return { id: ov, method: 'override' };

  // 第 1 级：精确 label 匹配（原文串相等：标题行或面包屑末段）
  let hit = settle(
    domainNodes.filter((n) => n.label === parsed.heading || n.label === leafRaw),
    anc, derivedId,
  );
  if (hit) return { id: hit.id, method: 'exact' };

  // 第 2 级：归一匹配（全半角/空白归一，或再剥一层结构序号后相等）
  const leafNorm = norm(leafRaw);
  const headNorm = norm(parsed.heading);
  hit = settle(
    domainNodes.filter(
      (n) => n.labelNorm === leafNorm || n.labelNorm === headNorm || n.labelKey === leafKey,
    ),
    anc, derivedId,
  );
  if (hit) return { id: hit.id, method: 'norm' };

  // 第 3 级：面包屑逐级路径匹配（祖先段全等 + 叶子容差「· 小标题」扩展）
  hit = settle(
    domainNodes.filter(
      (n) =>
        n.pathSegs.length === segKeys.length &&
        arrEq(n.pathSegs.slice(0, -1), anc) &&
        leafCompatible(n.pathSegs[n.pathSegs.length - 1], leafKey),
    ),
    anc, derivedId,
  );
  if (hit) return { id: hit.id, method: 'path' };

  // 第 4 级：前缀匹配（叶子与节点 label 互为前缀，重叠 ≥2 字符）
  hit = settle(
    domainNodes.filter((n) => {
      const a = n.labelKey;
      const b = leafKey;
      if (Math.min(a.length, b.length) < 2) return false;
      return a.startsWith(b) || b.startsWith(a);
    }),
    anc, derivedId,
  );
  if (hit) return { id: hit.id, method: 'prefix' };

  return null;
}

// ============ 主流程：逐域枚举 → 锚定 → 分批 ============
const domains = KNOWN_DOMAINS.filter((d) => existsSync(join(ROOT, d.key, '_chunks')));
const allChunks = []; // {chunkPath, chunkId, domain, anchorNodeId, breadcrumb, charLen}
const unresolved = []; // {domain, chunkId, chunkPath, breadcrumb, heading, reason}
const domainStats = {}; // key → {chunks, methods:{}, derivedAgree}

for (const dom of domains) {
  const chunksRoot = join(ROOT, dom.key, '_chunks');
  const st = { chunks: 0, methods: {}, derivedAgree: 0 };
  domainStats[dom.key] = st;
  for (const absPath of walkMd(chunksRoot)) {
    const relSegs = relative(chunksRoot, absPath).replace(/\.md$/, '').split(sep);
    const chunkId = [dom.key, ...relSegs].join('/');
    const parsed = parseChunk(absPath);
    st.chunks++;
    if (parsed.error) {
      unresolved.push({ domain: dom.key, chunkId, chunkPath: absPath, breadcrumb: '', heading: '', reason: parsed.error });
      continue;
    }
    const derivedId = deriveIdFromPath(dom, relSegs);
    const res = resolveAnchor(dom.key, chunkId, parsed, derivedId);
    if (!res) {
      unresolved.push({
        domain: dom.key, chunkId, chunkPath: absPath,
        breadcrumb: parsed.breadcrumb, heading: parsed.heading, reason: '四级匹配均未唯一命中',
      });
      continue;
    }
    st.methods[res.method] = (st.methods[res.method] || 0) + 1;
    if (derivedId && res.id === derivedId) st.derivedAgree++;
    allChunks.push({
      chunkPath: absPath,
      chunkId,
      domain: dom.key,
      anchorNodeId: res.id,
      breadcrumb: parsed.breadcrumb,
      charLen: parsed.charLen,
    });
  }
}

// ---- 失败清单 CSV（UTF-8 BOM，恒写出；正常应仅表头）----
const csvEsc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv =
  '﻿' +
  [
    'domain,chunkId,chunkPath,breadcrumb,heading,reason',
    ...unresolved.map((r) => [r.domain, r.chunkId, r.chunkPath, r.breadcrumb, r.heading, r.reason].map(csvEsc).join(',')),
  ].join('\n') +
  '\n';
writeFileSync(join(AUDIT_DIR, 'anchor-unresolved.csv'), csv);

// ---- 分批：同域聚批，k=ceil(n/10) 后均匀分摊（余数批 +1），保证每批 8~10 片 ----
const manifest = [];
let batchNo = 0;
for (const dom of domains) {
  const domChunks = allChunks.filter((c) => c.domain === dom.key);
  if (!domChunks.length) continue;
  const k = Math.ceil(domChunks.length / BATCH_MAX);
  const base = Math.floor(domChunks.length / k);
  const rem = domChunks.length - base * k;
  let cursor = 0;
  for (let i = 0; i < k; i++) {
    const size = base + (i < rem ? 1 : 0);
    batchNo++;
    manifest.push({ batchNo, chunks: domChunks.slice(cursor, cursor + size) });
    cursor += size;
  }
}
writeFileSync(join(BATCH_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1));

// ---- 统计打印 ----
console.log('—— 各域切片锚定统计 ——');
for (const dom of domains) {
  const st = domainStats[dom.key];
  const okN = Object.values(st.methods).reduce((a, b) => a + b, 0);
  const rate = st.chunks ? ((okN / st.chunks) * 100).toFixed(1) : '0.0';
  console.log(
    `${dom.key}: 切片 ${st.chunks} | 锚定 ${okN}（${rate}%）| 层级 ${JSON.stringify(st.methods)} | 与路径编号派生 id 一致 ${st.derivedAgree}`,
  );
}
const totalMethods = {};
for (const st of Object.values(domainStats))
  for (const [m, c] of Object.entries(st.methods)) totalMethods[m] = (totalMethods[m] || 0) + c;
const sizes = manifest.map((b) => b.chunks.length);
console.log(
  `—— 汇总 ——\n切片总数: ${allChunks.length + unresolved.length}（锚定 ${allChunks.length} / 失败 ${unresolved.length}）` +
  `\n匹配层级分布: ${JSON.stringify(totalMethods)}（override 映射表 ${ANCHOR_OVERRIDES.size} 条）` +
  `\n批次: ${manifest.length} 批，批规模 min=${Math.min(...sizes)} max=${Math.max(...sizes)}`,
);
console.log(`产物: data/term-batches/manifest.json、audit/terms/anchor-unresolved.csv（${unresolved.length} 行）`);

// ---- 断言 ----
let ok = true;
const total = allChunks.length + unresolved.length;
if (Math.abs(total - EXPECTED_CHUNKS) > CHUNK_TOLERANCE) {
  ok = false;
  console.error(`✗ 断言失败：切片总数 ${total} 超出 ${EXPECTED_CHUNKS}±${CHUNK_TOLERANCE}`);
}
if (unresolved.length) {
  ok = false;
  console.error(`✗ 断言失败：锚定率未达 100%，失败 ${unresolved.length} 片：`);
  for (const r of unresolved) console.error(`  [${r.domain}] ${r.chunkId} | ${r.heading} | ${r.reason}`);
}
for (const b of manifest) {
  if (b.chunks.length < 8 || b.chunks.length > BATCH_MAX) {
    // 域内切片不足 8 片时允许单批小于 8（当前 7 域最小 17 片，正常不触发）
    if (b.chunks.length >= 8) continue;
    const domTotal = domainStats[b.chunks[0]?.domain]?.chunks || 0;
    if (domTotal >= 8) {
      ok = false;
      console.error(`✗ 断言失败：批 ${b.batchNo} 规模 ${b.chunks.length} 超出 8~${BATCH_MAX}`);
    }
  }
}
console.log(ok ? '✓ 断言全部通过' : '✗ 断言未通过');
if (!ok) process.exit(1);
