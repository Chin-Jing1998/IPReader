// 探查脚本：对齐 _chunks 面包屑与 _index.md 大纲的层级计数，确认如何精确得到 6/38/259/523
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', '..', 'examination-guideline-2025');
const CHUNKS = join(SRC, '_chunks');
const INDEX = join(SRC, '_index.md');

// ---- 1. 遍历 _chunks，抽取每个文件首行面包屑 ----
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.md')) acc.push(p);
  }
  return acc;
}
const files = walk(CHUNKS).sort();
const SEP = '｜';
function breadcrumbOf(file) {
  const first = readFileSync(file, 'utf8').split('\n')[0];
  // 形如  > 〔《专利审查指南（2025）》 ｜ 第X部分 名 ｜ 第Y章名 ｜ N.节 ｜ N.M子节〕
  const m = first.match(/〔(.+)〕/);
  if (!m) return null;
  return m[1].split(SEP).map(s => s.trim());
}

const parts = new Set(), chapters = new Set(), sections = new Set(), subsections = new Set();
let noCrumb = 0;
const segCountHist = {};
for (const f of files) {
  const segs = breadcrumbOf(f);
  if (!segs) { noCrumb++; continue; }
  // segs[0] = 书名《…》；其后为 部/章/节/子节
  const after = segs.slice(1);
  segCountHist[after.length] = (segCountHist[after.length] || 0) + 1;
  if (after[0]) parts.add(after[0]);
  if (after[1]) chapters.add(after[0] + '>' + after[1]);
  if (after[2]) sections.add(after[0] + '>' + after[1] + '>' + after[2]);
  if (after[3]) subsections.add(after[0] + '>' + after[1] + '>' + after[2] + '>' + after[3]);
}
console.log('=== 来自 _chunks 文件面包屑（仅文件级，非完整树）===');
console.log('文件总数:', files.length, ' 无面包屑:', noCrumb);
console.log('面包屑段数分布(部=1/章=2/节=3/子节=4):', segCountHist);
console.log('distinct 部:', parts.size, ' 章:', chapters.size, ' 节(出现在面包屑):', sections.size, ' 子节(文件级):', subsections.size);

// ---- 2. 解析 _index.md 大纲 ----
const idx = readFileSync(INDEX, 'utf8').split('\n');
let iParts = 0, iChapters = 0;
const secTok = new Set(), subTok = new Set(), subsubTok = new Set();
let curPart = '', curChap = '';
for (const line of idx) {
  const pm = line.match(/^##\s+第([一二三四五六七八九十]+)部分\s+(.+?)(\s*→.*)?$/);
  if (pm) { iParts++; curPart = pm[1]; continue; }
  const cm = line.match(/^###\s+第([一二三四五六七八九十]+)章\s*(.+)$/);
  if (cm) { iChapters++; curChap = curPart + '-' + cm[1]; continue; }
  // 加粗编号条目： - **N. 标题** / **N.M 标题** / **N.M.K 标题**
  const bm = line.match(/^(\s*)-\s+\*\*([\d.]+)\s*([^*]*?)\*\*/);
  if (bm) {
    const tok = bm[2].replace(/\.$/, ''); // 去掉末尾点："1." -> "1"
    const dots = (tok.match(/\./g) || []).length;
    const key = curChap + '|' + tok;
    if (dots === 0) secTok.add(key);
    else if (dots === 1) subTok.add(key);
    else if (dots === 2) subsubTok.add(key);
  }
}
console.log('\n=== 来自 _index.md 大纲 ===');
console.log('部:', iParts, ' 章:', iChapters);
console.log('节(**N.**):', secTok.size, ' 子节(**N.M**):', subTok.size, ' 子子节(**N.M.K**):', subsubTok.size);
console.log('节+子节:', secTok.size + subTok.size, ' | 部+章+节+子节:', iParts + iChapters + secTok.size + subTok.size);

// ---- 3. 检查 chunk 正文里的 #### 子节标题（内联子节）数量 ----
let inlineSub = 0, inlineSubsub = 0;
for (const f of files) {
  const txt = readFileSync(f, 'utf8');
  for (const line of txt.split('\n')) {
    const h4 = line.match(/^####\s+([\d.]+)/);
    if (h4) {
      const dots = (h4[1].replace(/\.$/, '').match(/\./g) || []).length;
      if (dots === 1) inlineSub++;
      else if (dots === 2) inlineSubsub++;
    }
  }
}
console.log('\n=== chunk 正文内联 #### 标题 ===');
console.log('内联 #### N.M:', inlineSub, ' 内联 #### N.M.K:', inlineSubsub);
