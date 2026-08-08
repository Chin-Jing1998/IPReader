#!/usr/bin/env node
// 数据管线 D3-4：审校回灌 —— 读 audit/terms/term-audit.csv 的 decision 列，
//   固化为 data/term-merges.json（词条归并映射）与 data/term-blacklist.json（剔除清单），
//   供 merge-terms.mjs 重跑时应用（格式对标既有 edge-blacklist.json：黑名单为扁平数组）。
//   decision 取值（大小写不敏感，前后空白容忍）：
//     - 空 / keep               不动作
//     - drop                    该 termKey 进黑名单
//     - merge-into:<termKey>    该词并入目标词（支持全角冒号）
//   幂等：与既有固化文件做并集、排序后写出；内容无变化则不写文件；
//         CSV 缺失或无任何 decision 且固化文件不存在时为纯无操作。
//   运行：node scripts/apply-term-audit.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CSV_PATH = join(__dirname, '..', 'audit', 'terms', 'term-audit.csv');
const MERGES_PATH = join(DATA_DIR, 'term-merges.json');
const BLACKLIST_PATH = join(DATA_DIR, 'term-blacklist.json');

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

// ---- 读 CSV 决策 ----
if (!existsSync(CSV_PATH)) {
  console.log(`审校表不存在（${CSV_PATH}），无操作。`);
  process.exit(0);
}
const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
if (!rows.length) {
  console.log('审校表为空，无操作。');
  process.exit(0);
}
const header = rows[0].map((h) => h.trim());
const keyCol = header.indexOf('termKey');
const decCol = header.indexOf('decision');
if (keyCol < 0 || decCol < 0) {
  console.error('✗ 审校表缺少 termKey / decision 列，无法回灌。');
  process.exit(1);
}

const decisions = { keep: 0, drop: [], merge: [], unknown: [] };
for (const row of rows.slice(1)) {
  const termKey = norm(row[keyCol]);
  const dec = (row[decCol] || '').trim();
  if (!termKey || !dec) continue;
  const low = dec.toLowerCase();
  if (low === 'keep') {
    decisions.keep++;
    continue;
  }
  if (low === 'drop') {
    decisions.drop.push(termKey);
    continue;
  }
  const mm = dec.match(/^merge-into[:：]\s*(.+)$/i);
  if (mm) {
    const target = norm(mm[1]);
    if (!target || target === termKey) {
      decisions.unknown.push(`${termKey} → 归并目标非法（空或指向自身）`);
      continue;
    }
    decisions.merge.push([termKey, target]);
    continue;
  }
  decisions.unknown.push(`${termKey} → 无法识别的 decision「${dec}」`);
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

// ---- 幂等写出：内容无变化则不写 ----
const blOut = JSON.stringify([...blacklist].sort(), null, 1) + '\n';
const mgOut =
  JSON.stringify(Object.fromEntries(Object.entries(merges).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 1) + '\n';
let wrote = 0;
function writeIfChanged(p, content, empty) {
  const exists = existsSync(p);
  if (!exists && empty) return; // 无既有文件且内容为空：不落新文件（纯无操作）
  if (exists && readFileSync(p, 'utf8') === content) return;
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
