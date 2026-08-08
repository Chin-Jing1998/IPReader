// 内容骨架生成：把原文切成详情页可用的 content/{id}.json（narrative 占位=原文段落）
//   产物存 public/content/{id}.json，供详情卡按需懒加载。阶段四再用精构内容覆盖。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const OUT = join(__dirname, '..', 'public', 'content');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));
const edges = JSON.parse(readFileSync(join(D, 'edges.json'), 'utf8'));
const byId = new Map(nodes.map((n) => [n.id, n]));

// 邻接表（带类型）
const adj = new Map();
for (const e of edges) {
  (adj.get(e.source) || adj.set(e.source, []).get(e.source)).push({ id: e.target, type: e.type });
  (adj.get(e.target) || adj.set(e.target, []).get(e.target)).push({ id: e.source, type: e.type });
}

const REASON = {
  hierarchyUp: '上级', hierarchyDown: '下属', xref: '指南交叉引用', colaw: '共引同一法条', concept: '相关概念', lawref: '法条依据',
};

// 把原文正文切成 narrative 段落数组
function toNarrative(text) {
  const out = [];
  let buf = [];
  const flush = () => {
    if (buf.length) { out.push({ type: 'p', text: buf.join('') }); buf = []; }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^>\s*〔/.test(line)) continue; // 面包屑
    if (!line.trim()) { flush(); continue; }
    const h = line.match(/^(#{1,6})\s*(.+)$/);
    if (h) {
      flush();
      out.push({ type: 'subhead', text: h[2].replace(/^[\d.]+\s*/, '').trim(), num: (h[2].match(/^[\d.]+/) || [''])[0] });
      continue;
    }
    buf.push(line.trim());
  }
  flush();
  return out;
}

// 抽取“例如/例：”所在段落作为示例候选（阶段四会改写为正/反例）
function extractExamples(narr) {
  const ex = [];
  for (const p of narr) {
    if (p.type === 'p' && /(例如|例：|举例|【例】|案例)/.test(p.text) && p.text.length > 12) {
      ex.push({ type: 'neutral', title: '原文示例', text: p.text });
    }
  }
  return ex.slice(0, 4);
}

let count = 0;
for (const n of nodes) {
  if (n.kind === 'term') continue; // term 节点无正文 body，详情由 build-term-content.mjs 另行生成
  const body = bodies[n.id];
  // 叶子（子节/无子节的节）用 fullText；容器（部/章/有子节的节）用 ownText 作导语
  const childPrefix = n.id + '-';
  const hasChildren = nodes.some((m) => m.id.startsWith(childPrefix) && m.id !== n.id);
  const src = hasChildren ? body.ownText : body.fullText;
  const narrative = toNarrative(src || body.fullText || '');

  // 相关知识：邻居按类型优先级排序
  const seen = new Set();
  const related = [];
  const prio = { xref: 0, concept: 1, lawref: 2, colaw: 4 };
  const nbrs = (adj.get(n.id) || []).slice();
  // 子节点优先纳入（便于从容器导航进下属）
  for (const m of nodes) if (m.id.startsWith(childPrefix) && m.id.split('-').length === n.id.split('-').length + 1) nbrs.push({ id: m.id, type: 'child' });
  nbrs.sort((a, b) => (prio[a.type] ?? 2) - (prio[b.type] ?? 2));
  for (const nb of nbrs) {
    if (seen.has(nb.id) || nb.id === n.id) continue;
    const tn = byId.get(nb.id);
    if (!tn) continue;
    seen.add(nb.id);
    let reason;
    if (nb.type === 'child') reason = REASON.hierarchyDown;
    else if (nb.type === 'hierarchy') reason = tn.id.length < n.id.length ? REASON.hierarchyUp : REASON.hierarchyDown;
    else reason = REASON[nb.type] || '相关';
    related.push({ id: nb.id, label: tn.label, reason, part: tn.partNum });
    if (related.length >= 12) break;
  }

  // 原版详细内容：该节点完整原文（markdown 源），供"查看原文"面板 HTML 渲染。剥离可能的首行上下文面包屑。
  const original = (body.fullText || body.ownText || '')
    .split('\n')
    .filter((ln) => !/^>\s*〔/.test(ln.trim()))
    .join('\n')
    .trim();

  const content = {
    id: n.id,
    level: n.level,
    domain: n.domain,
    label: n.label,
    breadcrumb: n.breadcrumb,
    partNum: n.partNum,
    sourceRef: { line: body.line, chars: n.charLen },
    brief: n.summary,
    narrative,
    infographics: [], // 阶段四填充
    examples: extractExamples(narrative),
    related,
    lawRefs: n.laws,
    original,
    fidelity: { verified: true, method: 'shell-verbatim' }, // 骨架=逐字原文，天然忠实
    shell: true,
  };
  writeFileSync(join(OUT, `${n.id}.json`), JSON.stringify(content));
  count++;
}
console.log(`✓ 生成 ${count} 个 content 骨架 → public/content/`);
