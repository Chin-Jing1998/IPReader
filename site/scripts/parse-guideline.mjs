// 数据管线 1/3：顺序解析主文件 examination-guideline-2025.md 的标题树
//   # 部(6) / ## 章(38) / ### 节(259) / #### 子节(523) = 826 节点
// 产物：data/nodes.json（轻量节点）、data/node-bodies.json（每节点原文正文，供详情/精构）、data/laws.json（法条→引用节点）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cn2num } from './lib/cn-num.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', '..', 'examination-guideline-2025', 'examination-guideline-2025.md');
const OUT = join(__dirname, '..', 'data');
mkdirSync(OUT, { recursive: true });

// 中文数字 → 阿拉伯：见 ./lib/cn-num.mjs（支持 1..999，供管线与单测共用）
const pad = (n) => String(n).padStart(2, '0');

// ---- 读主文件，定位所有标题行 ----
let lines;
try {
  lines = readFileSync(SRC, 'utf8').split('\n');
} catch (err) {
  console.error(`✗ 无法读取源文件：${SRC}\n  ${err.message}\n  请确认 examination-guideline-2025/ 源文件存在。`);
  process.exit(1);
}
const headings = [];
lines.forEach((line, i) => {
  const m = line.match(/^(#{1,4})\s+(.*\S)\s*$/);
  if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i });
});

// ---- 法条抽取 ----
const LAW_RE = /(专利法实施细则|专利法|实施细则)第([一二三四五六七八九十百零]+)条(之([一二三四五六七八九十]+))?(第([一二三四五六七八九十]+)款)?/g;
function extractLaws(text) {
  const refs = new Set();
  let m;
  LAW_RE.lastIndex = 0;
  while ((m = LAW_RE.exec(text))) {
    const law = m[1] === '实施细则' ? '专利法实施细则' : m[1];
    const art = cn2num(m[2]);
    if (!Number.isFinite(art)) continue;
    const zhi = m[4] ? `之${cn2num(m[4])}` : '';
    refs.add(`${law}第${art}条${zhi}`); // 归一到“法+条”，忽略款用于聚类
  }
  return [...refs];
}

// ---- 正文跨度：某标题到下一个 level<=自身 的标题之间为 fullText；到下一个任意标题为 ownText ----
function spanText(idx, sameOrHigher) {
  const h = headings[idx];
  const start = h.line + 1;
  let end = lines.length;
  for (let j = idx + 1; j < headings.length; j++) {
    if (sameOrHigher ? headings[j].level <= h.level : true) { end = headings[j].line; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}
function leadSummary(text) {
  const clean = text.replace(/^>.*$/gm, '').replace(/^#{1,6}.*$/gm, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const m = clean.match(/^[^。；！？]*[。；！？]?/);
  let s = (m ? m[0] : clean).trim();
  if (s.length > 70) s = s.slice(0, 68) + '…';
  return s;
}

// ---- 栈式遍历构树 ----
const nodes = [];
const bodies = {};
const lawIndex = {}; // lawKey -> [nodeId...]
let curPart = null, curChap = null, curSec = null;
let chapCountInPart = 0;

for (let i = 0; i < headings.length; i++) {
  const h = headings[i];
  let id, level, label, partNum, chapterNum = null, sectionNum = null, subNum = null;
  const ownText = spanText(i, false);
  const fullText = spanText(i, true);

  if (h.level === 1) {
    const m = h.text.match(/^第([一二三四五六七八九十]+)部分\s*(.+)$/);
    partNum = cn2num(m[1]); label = m[2].trim();
    id = pad(partNum); level = 'part';
    curPart = { id, partNum }; curChap = null; curSec = null;
  } else if (h.level === 2) {
    const m = h.text.match(/^第([一二三四五六七八九十]+)章\s*(.+)$/);
    chapterNum = cn2num(m[1]); label = m[2].trim();
    partNum = curPart.partNum;
    id = `${pad(partNum)}-${pad(chapterNum)}`; level = 'chapter';
    curChap = { id, chapterNum }; curSec = null;
  } else if (h.level === 3) {
    const m = h.text.match(/^(\d+)\.?\s*(.+)$/);
    sectionNum = parseInt(m[1], 10); label = m[2].trim();
    partNum = curPart.partNum; chapterNum = curChap.chapterNum;
    id = `${curChap.id}-${pad(sectionNum)}`; level = 'section';
    curSec = { id, sectionNum };
  } else {
    const m = h.text.match(/^(\d+)\.(\d+)\.?\s*(.+)$/);
    const sN = parseInt(m[1], 10), uN = parseInt(m[2], 10); label = m[3].trim();
    partNum = curPart.partNum; chapterNum = curChap.chapterNum; sectionNum = sN; subNum = uN;
    id = `${curChap.id}-${pad(sN)}-${pad(uN)}`; level = 'subsection';
  }

  const laws = extractLaws(level === 'subsection' || (level === 'section') ? fullText : ownText);
  for (const k of laws) (lawIndex[k] ||= []).push(id);

  const breadcrumb = [];
  if (curPart && level !== 'part') breadcrumb.push(nodes.find(n => n.id === curPart.id)?.label);
  if (curChap && (level === 'section' || level === 'subsection')) breadcrumb.push(nodes.find(n => n.id === curChap.id)?.label);
  if (curSec && level === 'subsection') breadcrumb.push(nodes.find(n => n.id === curSec.id)?.label);

  nodes.push({
    id, level, partNum, chapterNum, sectionNum, subNum,
    num: h.text.match(/^[\d.]+/) ? h.text.match(/^[\d.]+/)[0].replace(/\.$/, '') : null,
    label,
    breadcrumb: breadcrumb.filter(Boolean),
    laws,
    charLen: fullText.replace(/\s/g, '').length,
    summary: leadSummary(ownText || fullText),
    community: partNum,
    hasOwnText: ownText.replace(/\s/g, '').length > 0,
  });
  bodies[id] = { line: h.line + 1, ownText, fullText };
}

// ---- 校验 ----
const cnt = nodes.reduce((a, n) => ((a[n.level] = (a[n.level] || 0) + 1), a), {});
console.log('节点计数:', cnt, ' 合计:', nodes.length);
const expect = { part: 6, chapter: 38, section: 259, subsection: 523 };
let ok = nodes.length === 826;
for (const k in expect) if (cnt[k] !== expect[k]) { ok = false; console.error(`✗ ${k} 期望${expect[k]} 实得${cnt[k]}`); }
// id 唯一性
const ids = new Set(nodes.map(n => n.id));
if (ids.size !== nodes.length) { ok = false; console.error('✗ id 不唯一', nodes.length - ids.size); }

writeFileSync(join(OUT, 'nodes.json'), JSON.stringify(nodes, null, 0));
writeFileSync(join(OUT, 'node-bodies.json'), JSON.stringify(bodies, null, 0));
const laws = Object.entries(lawIndex)
  .map(([k, v]) => ({ law: k, nodes: [...new Set(v)] }))
  .sort((a, b) => b.nodes.length - a.nodes.length);
writeFileSync(join(OUT, 'laws.json'), JSON.stringify(laws, null, 0));
console.log('法条数:', laws.length, ' Top5:', laws.slice(0, 5).map(l => `${l.law}(${l.nodes.length})`).join(', '));
console.log(ok ? '✓ 校验通过' : '✗ 校验未通过');
