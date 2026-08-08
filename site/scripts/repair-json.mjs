// 修复 content/*.json 中"字符串值内部未转义英文双引号"导致的非法 JSON
//   字符走查：在字符串内遇到 " 时前瞻——若其后(跳空白)是 ,}]: 或行尾则为闭合引号，否则判为内部引号→转义为 \"
//   用法：node scripts/repair-json.mjs [前缀]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', 'public', 'content');
const prefix = process.argv[2] || '';

function repair(src) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!inStr) {
      out += c;
      if (c === '"') inStr = true;
      continue;
    }
    // 在字符串内
    if (c === '\\') {
      out += c + (src[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') {
      // 前瞻：跳过空白，看下一个有意义字符
      let j = i + 1;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
      const next = src[j];
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        out += '"'; // 闭合引号
        inStr = false;
      } else {
        out += '\\"'; // 内部引号 → 转义
      }
      continue;
    }
    // 字符串内的裸换行也非法 → 转义为空格（保险）
    if (c === '\n' || c === '\r') {
      out += '\\n';
      continue;
    }
    out += c;
  }
  return out;
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f.startsWith(prefix));
let fixed = 0, stillBad = 0, ok = 0;
const bad = [];
for (const f of files) {
  const p = join(DIR, f);
  const raw = readFileSync(p, 'utf8');
  try { JSON.parse(raw); ok++; continue; } catch {}
  const rep = repair(raw);
  try {
    JSON.parse(rep);
    writeFileSync(p, rep);
    fixed++;
  } catch (e) {
    stillBad++;
    bad.push(f.replace('.json', ''));
  }
}
console.log(`扫描 ${files.length}：原本合法 ${ok}，修复成功 ${fixed}，仍失败 ${stillBad}`);
if (bad.length) console.log('仍失败：' + bad.join(','));
