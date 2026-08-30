#!/usr/bin/env node
// 一次性脚本（阶段5.9 波3 / 阶段5.11 波F 后半）：救回 19 个在商标指南重提取后消失的现网词条
//
// 背景：5.9 波1 把《商标审查审理指南》全量重提取（旧 218 片 → 新 895 片，切片树由 `06-14/02/02`
//   改为 `06/14/02/02` 的多级目录）。重提取后有 19 个原 1035 词表中的商标词条从终表消失，
//   经主会话逐条核定后裁决「全部救回」。三类去向、三条救回路径：
//     ① 落候选池 5 词（df=1 单域、非 defined+high，被入图门槛挡下）
//        → 走 data/term-whitelist.json 白名单，由 merge-terms.mjs 放行入图（本脚本不处理，见该文件）；
//     ② 新提取未产出 11 词（LLM 本轮未再抽出该词面）
//        → 本脚本处理：以 data/term-extract-legacy-tmeg/ 的旧证据补录进新提取产物；
//     ③ 被别名化 3 词（词面成为另一词条的 alias）
//        → 逐条核过合理性后保留别名形态（别名参与检索与词表匹配），无需改数据。
//
// 补录形态（与既有 schema 逐字一致，另加两个标注字段，消费方一律忽略未知字段）：
//   写入目标 = 新切片树中**正文确实包含该 evidence** 的那一片的提取产物文件，
//   而不是旧 chunkId 直译——旧 `06-14/02/02` 在新树下已下钻到 `06/14/02/02/07/01` 一级，
//   写错片会导致 merge-terms 的 evidence 连续子串校验失败而降 low、再次落候选池。
//   term 对象追加：rescue: '5.9-救回'、rescueFrom: 旧证据文件名。
//
// 幂等：目标文件中已存在同名 term 即跳过；可重复执行。
// 运行：node scripts/oneoff-rescue-terms-59.mjs [--dry-run]
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './lib/domains.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(__dirname);
const DATA_DIR = join(__dirname, '..', 'data');
const EXTRACT_DIR = join(DATA_DIR, 'term-extract');
const LEGACY_DIR = join(DATA_DIR, 'term-extract-legacy-tmeg');
const DRY = process.argv.includes('--dry-run');

// 11 个待补录词条：[词面, 目标提取产物文件（新切片树）, 旧证据来源文件]
//   目标文件由「遍历 895 片新 tmeg 产物、取正文包含该 evidence 者」实测确定，逐条在案。
const RESCUE = [
  ['有一定影响的商品或者服务名称', 'trademark-exam-guide-2021__06__14__02__02__07__01.json'],
  ['驰名商标认定', 'trademark-exam-guide-2021__06__10__03.json'],
  ['公共事业名称', 'trademark-exam-guide-2021__06__03__02__02__09__05.json'],
  ['全部注册商标一并变更', 'trademark-exam-guide-2021__03__01__01__05.json'],
  ['缺乏显著特征', 'trademark-exam-guide-2021__06__04__02__01__03.json'],
  ['商标审查审理指南', 'trademark-exam-guide-2021__07.json'],
  ['商品通用名称', 'trademark-exam-guide-2021__06__17__06__03__01.json'],
  ['适用的限制', 'trademark-exam-guide-2021__06__16__02__02__02__04.json'],
  ['维也纳分类', 'trademark-exam-guide-2021__02__03__01.json'],
  ['以欺骗手段取得商标注册', 'trademark-exam-guide-2021__06__16__02__02__01.json'],
  ['有害于宗教信仰', 'trademark-exam-guide-2021__06__03__02__02__08__03__05.json'],
];

// ---- 旧证据检索：从 legacy 目录取该词的 role=defined 且 confidence=high 记录（无则取首条）----
function pickLegacy(name) {
  const hits = [];
  for (const f of readdirSync(LEGACY_DIR)) {
    if (!f.endsWith('.json')) continue; // .bak_* 备份一律跳过
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(LEGACY_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    for (const t of rec.terms || []) if (String(t.name || '').trim() === name) hits.push({ f, t });
  }
  return hits.find((h) => h.t.role === 'defined' && h.t.confidence === 'high') || hits[0] || null;
}

// ---- 切片正文（与 merge-terms.mjs::chunkText 同口径，含目录递归回退）----
function collectMd(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...collectMd(p));
    else if (f.endsWith('.md')) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}
function chunkText(chunkId) {
  const segs = chunkId.split('/');
  try {
    return readFileSync(join(ROOT, segs[0], '_chunks', ...segs.slice(1)) + '.md', 'utf8');
  } catch {
    /* 落目录级回退 */
  }
  try {
    return collectMd(join(ROOT, segs[0], '_chunks', ...segs.slice(1))).join('\n');
  } catch {
    return '';
  }
}

let added = 0;
let skipped = 0;
let failed = 0;
for (const [name, targetFile] of RESCUE) {
  const p = join(EXTRACT_DIR, targetFile);
  if (!existsSync(p)) {
    console.error(`✗ 目标产物缺失：${targetFile}（${name}）`);
    failed++;
    continue;
  }
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  rec.terms = rec.terms || [];
  if (rec.terms.some((t) => String(t.name || '').trim() === name)) {
    skipped++;
    continue;
  }
  const legacy = pickLegacy(name);
  if (!legacy) {
    console.error(`✗ 旧证据未找到：${name}`);
    failed++;
    continue;
  }
  // 落盘前复核：evidence 必须是目标片正文的连续子串，否则 merge-terms 会判失败并降 low
  const text = chunkText(rec.chunk);
  if (!text.includes(legacy.t.evidence)) {
    console.error(`✗ evidence 不在目标片正文中：${name} → ${rec.chunk}`);
    failed++;
    continue;
  }
  // 文本级插入而非 JSON.stringify 整体重写：既有产物是「每个 term 对象压成一行、外层缩进 2 空格」
  //   的定制排版，整体重排会把 895 片里的每一行都炸开成多行，diff 无法审阅。
  //   逐字段 JSON.stringify 后手工拼行，不对整体序列化结果做正则整形——证据句里含逗号引号，
  //   正则整形会误伤字符串内部。
  const fields = [
    ['name', name],
    ['aliases', legacy.t.aliases || []],
    ['role', legacy.t.role],
    ['confidence', legacy.t.confidence],
    ['evidence', legacy.t.evidence],
    ['rescue', '5.9-救回'],
    ['rescueFrom', `term-extract-legacy-tmeg/${legacy.f}`],
  ];
  const line = '    { ' + fields.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + ' }';
  const raw = readFileSync(p, 'utf8');
  const lines = raw.split('\n');
  const close = lines.findIndex((l) => l === '  ],');
  if (close < 0) {
    console.error(`✗ 未定位到 terms 数组结尾：${targetFile}`);
    failed++;
    continue;
  }
  lines[close - 1] += ',';
  lines.splice(close, 0, line);
  if (!DRY) writeFileSync(p, lines.join('\n'));
  console.log(`✓ 补录 ${name} → ${targetFile}（${rec.chunk} / ${rec.anchorNode}）`);
  added++;
}
console.log(`—— 补录完成：新增 ${added}、已存在跳过 ${skipped}、失败 ${failed}${DRY ? '（--dry-run 未写盘）' : ''}`);
if (failed) process.exit(1);
