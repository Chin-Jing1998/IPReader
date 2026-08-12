// 数据管线 1/3（多源版）：把项目根目录下发现的每部规范的主 md 解析为节点树，合并成一张星图数据。
//   - guideline（《专利审查指南》）走特例：保留 # 部 / ## 章 / ### 节 / #### 子节 = 826 节点、原 id、原字段，向后兼容。
//   - 其余各域走通用"标题深度建树"：深度 1→chapter / 2→section / ≥3→subsection；id 加域前缀（law- / infr- …）。
//   产物：data/nodes.json、data/node-bodies.json、data/laws.json。
//   每节点新增字段：domain（域 key）、colorGroup（配色分组）、domainCommunity（星系序号）、community（域内子簇）、
//     lawKey（仅 patent-law / implementation-rules 的"第X条"节点，供跨域 lawref 锚定）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cn2num } from './lib/cn-num.mjs';
import { discoverDomains, projectRoot } from './lib/domains.mjs';
import { extractLaws } from './lib/law-cite.mjs';
import { parseLawTitles } from './lib/law-titles.mjs';
import { tagTopics } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(__dirname);
const OUT = join(__dirname, '..', 'data');
mkdirSync(OUT, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');

// ---- 法条抽取：沿用单源版规则，已抽离至 lib/law-cite.mjs（extractLaws 行为不变）----
function leadSummary(text) {
  const clean = text.replace(/^>.*$/gm, '').replace(/^#{1,6}.*$/gm, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const m = clean.match(/^[^。；！？]*[。；！？]?/);
  let s = (m ? m[0] : clean).trim();
  if (s.length > 70) s = s.slice(0, 68) + '…';
  return s;
}

// ---- 通用：定位标题行 / 取正文跨度（接受具体文件的 lines+headings）----
function findHeadings(lines) {
  const headings = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,4})\s+(.*\S)\s*$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i });
  });
  return headings;
}
// 某标题到下一个 level<=自身 的标题之间为 fullText；到下一个任意标题为 ownText
function spanText(lines, headings, idx, sameOrHigher) {
  const h = headings[idx];
  const start = h.line + 1;
  let end = lines.length;
  for (let j = idx + 1; j < headings.length; j++) {
    if (sameOrHigher ? headings[j].level <= h.level : true) {
      end = headings[j].line;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

// ---- 合并产物累加器 ----
const allNodes = [];
const bodies = {};
const lawIndex = {};
const byId = new Map(); // id -> node（面包屑标签回查）

function pushNode(node, body) {
  allNodes.push(node);
  byId.set(node.id, node);
  bodies[node.id] = body;
  for (const k of node.laws) (lawIndex[k] ||= []).push(node.id);
}

// ============ guideline 特例解析（保持与单源版完全一致的 id/层级/字段）============
function parseGuideline(dom, domCommunity) {
  const lines = readFileSync(dom.mainMd, 'utf8').split('\n');
  const headings = findHeadings(lines);
  let curPart = null, curChap = null, curSec = null;

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    let id, level, label, partNum, chapterNum = null, sectionNum = null, subNum = null;
    const ownText = spanText(lines, headings, i, false);
    const fullText = spanText(lines, headings, i, true);

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

    const lawScope = level === 'subsection' || level === 'section' ? fullText : ownText;
    const laws = extractLaws(lawScope);
    const topics = tagTopics(`${label} ${lawScope}`);

    const breadcrumb = [];
    if (curPart && level !== 'part') breadcrumb.push(byId.get(curPart.id)?.label);
    if (curChap && (level === 'section' || level === 'subsection')) breadcrumb.push(byId.get(curChap.id)?.label);
    if (curSec && level === 'subsection') breadcrumb.push(byId.get(curSec.id)?.label);

    pushNode(
      {
        id, level, partNum, chapterNum, sectionNum, subNum,
        num: h.text.match(/^[\d.]+/) ? h.text.match(/^[\d.]+/)[0].replace(/\.$/, '') : null,
        label,
        breadcrumb: breadcrumb.filter(Boolean),
        laws,
        topics,
        charLen: fullText.replace(/\s/g, '').length,
        summary: leadSummary(ownText || fullText),
        community: partNum, // 域内子簇（六部）
        domainCommunity: domCommunity,
        domain: dom.key,
        colorGroup: `g${partNum}`,
        hasOwnText: ownText.replace(/\s/g, '').length > 0,
      },
      { line: h.line + 1, ownText, fullText },
    );
  }
}

// ============ 通用解析（专利法 / 侵权判定 / 撰写规范 / 答复指引 等）============
const GENERIC_LEVELS = ['chapter', 'section', 'subsection', 'subsection']; // 深度 1..4
function cleanLabel(text) {
  return text.replace(/\s+/g, ' ').trim();
}
function numFromHeading(text) {
  const m = text.match(/^(第[一二三四五六七八九十百零]+条|第[一二三四五六七八九十]+[章节]|[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

function parseGeneric(dom, domCommunity) {
  const lines = readFileSync(dom.mainMd, 'utf8').split('\n');
  const headings = findHeadings(lines);
  const titles = dom.lawName ? parseLawTitles(join(dom.dir, '_index.md')) : null; // 条号→小标题
  const counters = [0, 0, 0, 0];
  const stack = []; // {depth, label} 用于面包屑

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const depth = Math.min(h.level, 4);
    counters[depth - 1]++;
    for (let d = depth; d < 4; d++) counters[d] = 0;

    const segs = [];
    for (let d = 0; d < depth; d++) segs.push(pad(counters[d] || 1));
    const id = [dom.prefix, ...segs].join('-');
    const level = GENERIC_LEVELS[depth - 1];

    const ownText = spanText(lines, headings, i, false);
    const fullText = spanText(lines, headings, i, true);
    const hasChild = i + 1 < headings.length && headings[i + 1].level > h.level;
    const lawScope = hasChild ? ownText : fullText;
    const laws = extractLaws(lawScope);

    // 面包屑：域名 + 各级祖先标题
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const breadcrumb = [dom.title, ...stack.map((s) => s.label)];

    let label = cleanLabel(h.text);

    // lawKey + 小标题：法/细则的"第X条"节点 —— 供跨域引用锚定，并把"第X条"升级为"第X条 · 小标题"
    let lawKey = null;
    if (dom.lawName) {
      const lm = h.text.match(/^第([一二三四五六七八九十百零〇两]+)条/);
      if (lm) {
        const art = cn2num(lm[1]);
        if (Number.isFinite(art)) {
          lawKey = `${dom.lawName}第${art}条`;
          const tt = titles?.get(art);
          if (tt) label = `${label} · ${tt}`;
        }
      }
    }

    const topics = tagTopics(`${label} ${lawScope}`);

    const node = {
      id, level,
      partNum: 0, // 新域无"部"
      chapterNum: counters[0] || null,
      sectionNum: depth >= 2 ? counters[1] || null : null,
      subNum: depth >= 3 ? counters[2] || null : null,
      num: numFromHeading(h.text),
      label,
      breadcrumb,
      laws,
      topics,
      charLen: fullText.replace(/\s/g, '').length,
      summary: leadSummary(ownText || fullText),
      community: domCommunity, // 通用域不再细分子簇，整域为一团
      domainCommunity: domCommunity,
      domain: dom.key,
      colorGroup: dom.key,
      hasOwnText: ownText.replace(/\s/g, '').length > 0,
    };
    if (lawKey) node.lawKey = lawKey;

    pushNode(node, { line: h.line + 1, ownText, fullText });
    stack.push({ depth, label: cleanLabel(h.text) });
  }
}

// ============ 主流程 ============
const domains = discoverDomains(ROOT);
if (!domains.length) {
  console.error('✗ 未在项目根目录发现任何规范域（需含 _index.md + 主 md）。请确认目录结构。');
  process.exit(1);
}

let domCommunity = 0;
const perDomainCount = {};
for (const dom of domains) {
  domCommunity++;
  const before = allNodes.length;
  if (dom.special === 'guideline') parseGuideline(dom, domCommunity);
  else parseGeneric(dom, domCommunity);
  perDomainCount[dom.key] = allNodes.length - before;
}

// ---- 校验 ----
console.log('发现规范域:', domains.map((d) => `${d.key}(${perDomainCount[d.key]})`).join(', '));

// guideline 子集仍须 826（6/38/259/523），保证向后兼容
const gl = allNodes.filter((n) => n.domain === 'examination-guideline');
let ok = true;
if (gl.length) {
  const cnt = gl.reduce((a, n) => ((a[n.level] = (a[n.level] || 0) + 1), a), {});
  const expect = { part: 6, chapter: 38, section: 259, subsection: 523 };
  if (gl.length !== 826) { ok = false; console.error(`✗ guideline 期望 826，实得 ${gl.length}`); }
  for (const k in expect) if (cnt[k] !== expect[k]) { ok = false; console.error(`✗ guideline ${k} 期望${expect[k]} 实得${cnt[k]}`); }
}

// id 全局唯一
const ids = new Set(allNodes.map((n) => n.id));
if (ids.size !== allNodes.length) { ok = false; console.error('✗ id 不唯一，冲突数:', allNodes.length - ids.size); }

console.log('节点合计:', allNodes.length);

writeFileSync(join(OUT, 'nodes.json'), JSON.stringify(allNodes, null, 0));
writeFileSync(join(OUT, 'node-bodies.json'), JSON.stringify(bodies, null, 0));
const laws = Object.entries(lawIndex)
  .map(([k, v]) => ({ law: k, nodes: [...new Set(v)] }))
  .sort((a, b) => b.nodes.length - a.nodes.length);
writeFileSync(join(OUT, 'laws.json'), JSON.stringify(laws, null, 0));
console.log('法条数:', laws.length, ' Top5:', laws.slice(0, 5).map((l) => `${l.law}(${l.nodes.length})`).join(', '));
console.log(ok ? '✓ 校验通过' : '✗ 校验未通过');
if (!ok) process.exit(1);
