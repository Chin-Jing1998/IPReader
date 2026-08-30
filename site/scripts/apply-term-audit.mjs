#!/usr/bin/env node
// 数据管线 D3-4：审校回灌 —— 读审校决策，固化为 data/term-merges.json（词条归并映射）
//   与 data/term-blacklist.json（剔除清单），供 merge-terms.mjs 重跑时应用
//   （格式对标既有 edge-blacklist.json：黑名单为扁平数组）。
//
//   两个输入入口（可单用，也可同时给；同一 termKey 后读者覆盖先读者）：
//     ① CSV（默认，历史入口）：audit/terms/term-audit.csv 的 decision 列；
//     ② JSON 批次（--from-decisions，阶段5.11 波F 新增）：直读 data/term-audit-decisions/
//        下的 batch-NN.json，元素形如 { termKey, canonical, decision, note }。
//        动机：该目录自 batch-01 起已积累 15 批 LLM/人工裁决，但此前无任何脚本消费——
//        历史做法是人工把 decision 转抄回 CSV 再跑本脚本，转抄环节既费力又易错。
//
//   decision 取值（两个入口同一套解析，大小写不敏感，前后空白容忍）：
//     - 空 / keep               不动作
//     - drop                    该 termKey 进黑名单
//     - merge-into:<termKey>    该词并入目标词（支持全角冒号）
//   幂等：与既有固化文件做并集、排序后写出；内容无变化则不写文件；
//         输入缺失或无任何 decision 且固化文件不存在时为纯无操作。
//
//   运行：
//     node scripts/apply-term-audit.mjs                          仅读 CSV（行为与历史逐字一致）
//     node scripts/apply-term-audit.mjs --from-decisions         读 CSV + 默认决策目录
//     node scripts/apply-term-audit.mjs --from-decisions <dir>   读 CSV + 指定决策目录
//     node scripts/apply-term-audit.mjs --from-decisions --no-csv --since 16
//                                                                只读 batch-16 起的 JSON 批次
//     附加：--verify-targets [terms.json]  校验 merge-into 目标是否已在词表（仅告警，不改退出码）
//           --dry-run                      只统计不写文件
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CSV_PATH = join(__dirname, '..', 'audit', 'terms', 'term-audit.csv');
const MERGES_PATH = join(DATA_DIR, 'term-merges.json');
const BLACKLIST_PATH = join(DATA_DIR, 'term-blacklist.json');
const DECISIONS_DIR = join(DATA_DIR, 'term-audit-decisions');
const TERMS_PATH = join(DATA_DIR, 'terms-merged.json');

// ---- 参数解析（无参数时全部取历史默认值，行为不变）----
const opt = { fromDecisions: null, useCsv: true, since: null, verifyTargets: null, dryRun: false };
{
  const argv = process.argv.slice(2);
  const isValue = (v) => v != null && !v.startsWith('--');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-decisions') {
      opt.fromDecisions = isValue(argv[i + 1]) ? resolve(argv[++i]) : DECISIONS_DIR;
    } else if (a === '--no-csv') opt.useCsv = false;
    else if (a === '--since') opt.since = Number(argv[++i]);
    else if (a === '--verify-targets') {
      opt.verifyTargets = isValue(argv[i + 1]) ? resolve(argv[++i]) : TERMS_PATH;
    } else if (a === '--dry-run') opt.dryRun = true;
    else {
      console.error(`✗ 未知参数：${a}`);
      process.exit(1);
    }
  }
  if (!opt.useCsv && !opt.fromDecisions) {
    console.error('✗ --no-csv 关闭了 CSV 入口，但未提供 --from-decisions，无任何输入。');
    process.exit(1);
  }
  if (opt.since != null && !Number.isInteger(opt.since)) {
    console.error(`✗ --since 非法：${process.argv.slice(2).join(' ')}`);
    process.exit(1);
  }
}

// 归一化：与 merge-terms.mjs 同口径（termKey 即 canonical 归一）
const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// ---- 极简 CSV 解析（支持引号包裹、内嵌逗号/换行/双引号转义、UTF-8 BOM）----
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuote = false;
      } else cell += c;
      continue;
    }
    if (c === '"') inQuote = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

// ---- 决策解析（CSV 与 JSON 两个入口共用同一套语义）----
const decisions = { keep: 0, drop: [], merge: [], unknown: [] };
function collectDecision(termKeyRaw, decRaw, src) {
  const termKey = norm(termKeyRaw);
  const dec = String(decRaw || '').trim();
  if (!termKey || !dec) return;
  const low = dec.toLowerCase();
  if (low === 'keep') {
    decisions.keep++;
    return;
  }
  if (low === 'drop') {
    decisions.drop.push(termKey);
    return;
  }
  const mm = dec.match(/^merge-into[:：]\s*(.+)$/i);
  if (mm) {
    const target = norm(mm[1]);
    if (!target || target === termKey) {
      decisions.unknown.push(`${termKey} → 归并目标非法（空或指向自身）${src}`);
      return;
    }
    decisions.merge.push([termKey, target]);
    return;
  }
  decisions.unknown.push(`${termKey} → 无法识别的 decision「${dec}」${src}`);
}

// ---- 入口①：CSV ----
let csvRead = 0;
if (opt.useCsv) {
  if (!existsSync(CSV_PATH)) {
    // 历史行为：CSV 缺失即整体无操作退出。仅当没有 JSON 入口时沿用该行为，
    // 否则 CSV 缺失只是少一个来源，不应中断 JSON 批次的回灌。
    if (!opt.fromDecisions) {
      console.log(`审校表不存在（${CSV_PATH}），无操作。`);
      process.exit(0);
    }
    console.log(`（审校表不存在，跳过 CSV 入口：${CSV_PATH}）`);
  } else {
    const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
    if (!rows.length) {
      if (!opt.fromDecisions) {
        console.log('审校表为空，无操作。');
        process.exit(0);
      }
      console.log('（审校表为空，跳过 CSV 入口）');
    } else {
      const header = rows[0].map((h) => h.trim());
      const keyCol = header.indexOf('termKey');
      const decCol = header.indexOf('decision');
      if (keyCol < 0 || decCol < 0) {
        console.error('✗ 审校表缺少 termKey / decision 列，无法回灌。');
        process.exit(1);
      }
      for (const row of rows.slice(1)) {
        collectDecision(row[keyCol], row[decCol], '');
        csvRead++;
      }
      console.log(`CSV 入口：${CSV_PATH}（${csvRead} 行）`);
    }
  }
}

// ---- 入口②：JSON 决策批次 ----
const BATCH_RE = /^batch-(\d+)\.json$/;
let jsonFiles = 0;
let jsonRecords = 0;
if (opt.fromDecisions) {
  if (!existsSync(opt.fromDecisions) || !statSync(opt.fromDecisions).isDirectory()) {
    console.error(`✗ 决策目录不存在：${opt.fromDecisions}`);
    process.exit(1);
  }
  const files = readdirSync(opt.fromDecisions)
    .map((f) => ({ f, m: BATCH_RE.exec(f) }))
    .filter((x) => x.m)
    .map((x) => ({ f: x.f, no: Number(x.m[1]) }))
    .filter((x) => opt.since == null || x.no >= opt.since)
    .sort((a, b) => a.no - b.no);
  for (const { f } of files) {
    let arr;
    try {
      arr = JSON.parse(readFileSync(join(opt.fromDecisions, f), 'utf8'));
    } catch (err) {
      console.error(`✗ 决策批次解析失败：${f}（${err.message}）`);
      process.exit(1);
    }
    if (!Array.isArray(arr)) {
      console.error(`✗ 决策批次不是数组：${f}`);
      process.exit(1);
    }
    for (const d of arr) {
      collectDecision(d?.termKey || d?.canonical, d?.decision, `（${f}）`);
      jsonRecords++;
    }
    jsonFiles++;
  }
  console.log(
    `JSON 入口：${opt.fromDecisions}（${jsonFiles} 批 / ${jsonRecords} 条` +
    `${opt.since != null ? `，仅 batch-${String(opt.since).padStart(2, '0')} 起` : ''}）`,
  );
}
for (const u of decisions.unknown) console.warn(`⚠ ${u}`);

// ---- 与既有固化文件并集 ----
const readJsonIf = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const blacklist = new Set(readJsonIf(BLACKLIST_PATH, []).map(norm));
const merges = {};
for (const [k, v] of Object.entries(readJsonIf(MERGES_PATH, {}))) merges[norm(k)] = norm(v);

for (const k of decisions.drop) blacklist.add(k);
for (const [k, v] of decisions.merge) {
  if (merges[k] && merges[k] !== v) console.warn(`⚠ 归并冲突：${k} 原→${merges[k]}，新→${v}，以新为准`);
  merges[k] = v;
}
// drop 优先：同一词既 drop 又 merge 时移除归并映射
for (const k of Object.keys(merges)) {
  if (blacklist.has(k)) {
    console.warn(`⚠ ${k} 同时被 drop 与 merge-into，按 drop 处理`);
    delete merges[k];
  }
}

// ---- 可选：归并目标存在性校验（默认关闭，仅告警不改退出码）----
//   merge-terms.mjs 在应用归并时对目标不存在只打一条警告后跳过，链路继续；此处提前暴露，
//   便于审校阶段就发现「并入一个并不在表里的词」这类裁决错误。
if (opt.verifyTargets) {
  if (!existsSync(opt.verifyTargets)) {
    console.warn(`⚠ --verify-targets 指定的词表不存在：${opt.verifyTargets}，跳过校验`);
  } else {
    const known = new Set();
    for (const e of JSON.parse(readFileSync(opt.verifyTargets, 'utf8'))) {
      known.add(norm(e.termKey || e.canonical));
      for (const a of e.aliases || []) known.add(norm(a));
    }
    const missing = [...new Set(Object.values(merges))].filter((t) => !known.has(t));
    if (missing.length) {
      console.warn(`⚠ 归并目标不在词表（${missing.length} 个）：${missing.slice(0, 20).join('、')}`);
      if (missing.length > 20) console.warn(`  …另有 ${missing.length - 20} 个未列出`);
    } else {
      console.log(`✓ 归并目标存在性校验通过（${Object.keys(merges).length} 条全部命中 ${opt.verifyTargets}）`);
    }
  }
}

// ---- 幂等写出：内容无变化则不写 ----
const blOut = JSON.stringify([...blacklist].sort(), null, 1) + '\n';
const mgOut =
  JSON.stringify(Object.fromEntries(Object.entries(merges).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 1) + '\n';
let wrote = 0;
function writeIfChanged(p, content, empty) {
  const exists = existsSync(p);
  if (!exists && empty) return; // 无既有文件且内容为空：不落新文件（纯无操作）
  if (exists && readFileSync(p, 'utf8') === content) return;
  if (opt.dryRun) {
    console.log(`（--dry-run）本应写出 ${p}`);
    wrote++;
    return;
  }
  writeFileSync(p, content);
  wrote++;
  console.log(`写出 ${p}`);
}
writeIfChanged(BLACKLIST_PATH, blOut, blacklist.size === 0);
writeIfChanged(MERGES_PATH, mgOut, Object.keys(merges).length === 0);

console.log(
  `决策统计: keep ${decisions.keep} | drop ${decisions.drop.length} | merge-into ${decisions.merge.length} | 非法 ${decisions.unknown.length}`,
);
console.log(
  `固化后: 黑名单 ${blacklist.size} 词、归并映射 ${Object.keys(merges).length} 条${wrote ? '' : '（内容无变化，未写文件）'}`,
);
