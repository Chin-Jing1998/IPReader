// 归一化 content/*.json 的信息图结构：type→kind、解包被包一层的 steps/stat/table/compare
//   用法：node scripts/normalize-content.mjs [前缀]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', 'public', 'content');
const prefix = process.argv[2] || '';

function fixIg(ig) {
  const out = { ...ig };
  if (!out.kind && out.type) out.kind = out.type;
  delete out.type;
  const k = (out.kind || '').toLowerCase();
  out.kind = k;
  let spec = out.spec;
  if (k === 'steps' && spec && !Array.isArray(spec)) spec = spec.steps || spec.items || spec.data || spec;
  if (k === 'stat' && spec && !Array.isArray(spec)) spec = spec.stats || spec.items || spec.data || spec;
  if (k === 'table' && spec && spec.table) spec = spec.table;
  if (k === 'compare' && spec && spec.compare) spec = spec.compare;
  if (k === 'mermaid' && typeof spec !== 'string') spec = String(spec?.code || spec?.spec || '');
  if (k === 'echarts' && typeof spec === 'string') {
    try { spec = JSON.parse(spec); } catch {}
  }
  out.spec = spec;
  return out;
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f.startsWith(prefix));
let changed = 0;
for (const f of files) {
  const p = join(DIR, f);
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
  if (!Array.isArray(doc.infographics) || !doc.infographics.length) continue;
  const before = JSON.stringify(doc.infographics);
  doc.infographics = doc.infographics.map(fixIg).filter((ig) => ig.kind);
  if (JSON.stringify(doc.infographics) !== before) {
    writeFileSync(p, JSON.stringify(doc));
    changed++;
  }
}
console.log(`归一化完成：扫描 ${files.length}，修正 ${changed} 个文件`);
