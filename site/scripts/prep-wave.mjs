// 精构波次准备：为某前缀（部/章）下的节点导出 per-node 原文 + 轻量 meta
//   用法：node scripts/prep-wave.mjs 02-04        （第二部分第四章 创造性）
//        node scripts/prep-wave.mjs 02            （整个第二部分）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const SRC_DIR = join(D, 'wave-src');
mkdirSync(SRC_DIR, { recursive: true });

const prefix = process.argv[2];
if (!prefix) {
  console.error('用法: node scripts/prep-wave.mjs <id前缀，如 02-04>');
  process.exit(1);
}
const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));

const inScope = nodes.filter((n) => n.id === prefix || n.id.startsWith(prefix + '-'));
const meta = [];
for (const n of inScope) {
  const childPrefix = n.id + '-';
  const childLen = n.id.split('-').length + 1;
  const children = nodes
    .filter((m) => m.id.startsWith(childPrefix) && m.id.split('-').length === childLen)
    .map((m) => m.label);
  const hasChildren = children.length > 0;
  const body = bodies[n.id];
  // 纲目型（含下属）只用本级导语 ownText（不灌整棵子树），叶子才用 fullText
  let source = hasChildren ? body.ownText || '' : body.fullText;
  if (!source.trim()) {
    source = `（本级为纲目，无独立导语正文。下属要点：${children.join('、')}）`;
  }
  const srcPath = join(SRC_DIR, `${n.id}.md`);
  writeFileSync(srcPath, source);
  meta.push({
    id: n.id,
    level: n.level,
    label: n.label,
    breadcrumb: n.breadcrumb,
    laws: n.laws,
    children,
    hasChildren,
    srcPath,
    srcChars: (source || '').replace(/\s/g, '').length,
  });
}
const metaPath = join(D, `wave-${prefix}.json`);
writeFileSync(metaPath, JSON.stringify(meta));
console.log(`✓ 波次 ${prefix}：${meta.length} 个节点`);
console.log(`  meta → ${metaPath}`);
console.log(`  原文 → ${SRC_DIR}/<id>.md`);
console.log(`  字符量级：min=${Math.min(...meta.map((m) => m.srcChars))} max=${Math.max(...meta.map((m) => m.srcChars))} 总=${meta.reduce((a, m) => a + m.srcChars, 0)}`);
console.log(`  层级分布：` + JSON.stringify(meta.reduce((a, m) => ((a[m.level] = (a[m.level] || 0) + 1), a), {})));
