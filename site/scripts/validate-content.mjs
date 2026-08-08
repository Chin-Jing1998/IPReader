// 校验 content/*.json：可解析、字段齐全、信息图 spec 类型与 kind 匹配
//   用法：node scripts/validate-content.mjs [id前缀]   （省略=全部）
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', 'public', 'content');
const prefix = process.argv[2] || '';

const SPEC_TYPE = {
  steps: 'array', stat: 'array',
  table: 'object', compare: 'object', echarts: 'object',
  mermaid: 'string',
};
function specOk(kind, spec) {
  const t = SPEC_TYPE[kind];
  if (!t) return false;
  if (t === 'array') return Array.isArray(spec);
  if (t === 'string') return typeof spec === 'string' && spec.trim().length > 0;
  if (t === 'object') return spec && typeof spec === 'object' && !Array.isArray(spec);
  return false;
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f.startsWith(prefix));
let enriched = 0, shell = 0;
const problems = [];
for (const f of files) {
  const id = f.replace('.json', '');
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
  } catch (e) {
    problems.push(`${id}: JSON 解析失败 ${e.message}`);
    continue;
  }
  for (const k of ['id', 'label', 'breadcrumb', 'narrative', 'infographics', 'examples', 'related']) {
    if (!(k in doc)) problems.push(`${id}: 缺字段 ${k}`);
  }
  if (doc.shell === false) enriched++;
  else shell++;
  if (!Array.isArray(doc.narrative) || doc.narrative.length === 0) problems.push(`${id}: narrative 空`);
  for (const ig of doc.infographics || []) {
    if (!specOk(ig.kind, ig.spec)) problems.push(`${id}: 信息图 kind=${ig.kind} 的 spec 类型不符（应为 ${SPEC_TYPE[ig.kind] || '未知kind'}）`);
  }
}
console.log(`扫描 ${files.length} 个文件（前缀「${prefix || '全部'}」）：精构 ${enriched}，骨架 ${shell}`);
if (problems.length) {
  console.log(`\n⚠ ${problems.length} 处问题：`);
  problems.slice(0, 40).forEach((p) => console.log('  - ' + p));
  process.exit(1);
} else {
  console.log('✓ 全部通过');
}
