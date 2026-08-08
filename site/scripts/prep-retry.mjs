// 重试准备：扫描 public/content，挑出指定前缀下「尚未精构(shell!==false 或文件缺失)」的节点，
//   重建其 wave meta 与原文 src（沿用 prep-wave 规则），输出 wave-retry-<prefix>.json
//   用法：node scripts/prep-retry.mjs 02        node scripts/prep-retry.mjs ''(全部)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const CONTENT = join(__dirname, '..', 'public', 'content');
const SRC_DIR = join(D, 'wave-src');
mkdirSync(SRC_DIR, { recursive: true });

const prefix = process.argv[2] || '';
const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));

function isEnriched(id) {
  const p = join(CONTENT, `${id}.json`);
  if (!existsSync(p)) return false;
  try {
    return JSON.parse(readFileSync(p, 'utf8')).shell === false;
  } catch {
    return false;
  }
}

const inScope = nodes.filter((n) => (prefix ? n.id === prefix || n.id.startsWith(prefix + '-') : true));
const todo = inScope.filter((n) => !isEnriched(n.id));
const meta = [];
for (const n of todo) {
  const childLen = n.id.split('-').length + 1;
  const children = nodes.filter((m) => m.id.startsWith(n.id + '-') && m.id.split('-').length === childLen).map((m) => m.label);
  const hasChildren = children.length > 0;
  const body = bodies[n.id];
  let source = hasChildren ? body.ownText || '' : body.fullText;
  if (!source.trim()) source = `（本级为纲目，无独立导语正文。下属要点：${children.join('、')}）`;
  const srcPath = join(SRC_DIR, `${n.id}.md`);
  writeFileSync(srcPath, source);
  meta.push({ id: n.id, level: n.level, label: n.label, breadcrumb: n.breadcrumb, laws: n.laws, children, hasChildren, srcPath });
}
const out = join(D, `wave-retry-${prefix || 'all'}.json`);
writeFileSync(out, JSON.stringify(meta));
console.log(`前缀「${prefix || '全部'}」：范围 ${inScope.length}，已精构 ${inScope.length - todo.length}，待精构 ${todo.length}`);
console.log(`  → ${out}`);
console.log(`  层级：` + JSON.stringify(meta.reduce((a, m) => ((a[m.level] = (a[m.level] || 0) + 1), a), {})));
