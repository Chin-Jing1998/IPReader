// 导出"待 Opus 复核"的跨域弱关联边（concept 全部 + 跨域 colaw），连同两端节点真实正文，切批自包含。
//   供 Opus 4.8 子 agent 逐条读正文判定"内容是否真相关"。只读，不改任何数据。
//   运行：node scripts/export-review-batches.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS, TOPIC_NAME } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const OUT = join(__dirname, '..', 'audit', 'review');
mkdirSync(OUT, { recursive: true });

// ⚠ 2026-08-23 修复：旧键 'examination-guideline-2025' 随域改名同步为 'examination-guideline'；补登此前未登记的 trademark-exam-guide-2021。
const DOMAIN_CN = {
  'examination-guideline': '审查指南',
  'patent-law': '专利法',
  'implementation-rules': '实施细则',
  'infringement-guide': '侵权判定',
  'mechanical-drafting-rules': '机械撰写',
  'chemistry-drafting-rules': '化学撰写',
  'oa-response-guide': '答复指引',
  'trademark-exam-guide-2021': '商标审查指南',
};
const dcn = (d) => DOMAIN_CN[d] || d;
const HUB_RE = /其他文件|相关手续|相关规定|实质审查/;
const HUB_TOPIC_N = 8;
const OWN_LEN = 2000; // 自身正文截断
const FULL_LEN = 1600; // 容器节点用 fullText 预览截断

const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const edges = JSON.parse(readFileSync(join(D, 'edges.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));
const byId = new Map(nodes.map((n) => [n.id, n]));

function isJunkHub(n) {
  if (!n) return false;
  if (n.lawKey) return false;
  if (HUB_RE.test(n.label)) return true;
  if ((n.topics?.length ?? 0) >= HUB_TOPIC_N) return true;
  return false;
}

// 节点画像（含真实正文，供 agent 判断）
function nodeBrief(n) {
  const b = bodies[n.id] || {};
  const own = (b.ownText || '').trim();
  let text, textNote;
  if (own) {
    text = own.slice(0, OWN_LEN);
    textNote = '自身正文';
  } else if (b.fullText) {
    text = (b.fullText || '').slice(0, FULL_LEN);
    textNote = '容器节点：自身无独立正文，以下为其涵盖范围预览（含下级标题）';
  } else {
    text = n.summary || '';
    textNote = '仅摘要';
  }
  return {
    id: n.id,
    label: n.label,
    path: (n.breadcrumb || []).join(' / '),
    domain: dcn(n.domain),
    topics: (n.topics || []).map((k) => TOPIC_NAME[k] || k),
    topicCount: (n.topics || []).length,
    ownTextLen: own.length,
    isContainer: !own,
    textNote,
    text,
  };
}

const inter = (a = [], b = []) => a.filter((x) => b.includes(x));

// 收集待复核边
const conceptEdges = [];
const colawEdges = [];
for (const e of edges) {
  const s = byId.get(e.source);
  const t = byId.get(e.target);
  if (!s || !t) continue;
  const shared = inter(s.topics, t.topics).map((k) => TOPIC_NAME[k] || k);
  if (e.type === 'concept') conceptEdges.push({ type: 'concept', s, t, shared });
  else if (e.type === 'colaw' && s.domain !== t.domain) colawEdges.push({ type: 'colaw', s, t, shared });
}

// concept 分 5 批，跨域 colaw 单独 1 批
function dumpBatch(file, list, startNo) {
  const items = list.map((re, i) => ({
    no: startNo + i,
    edgeType: re.type,
    sharedTopics: re.shared,
    source: nodeBrief(re.s),
    target: nodeBrief(re.t),
  }));
  writeFileSync(join(OUT, file), JSON.stringify(items, null, 2));
  return items.length;
}

const CONCEPT_BATCHES = 5;
const per = Math.ceil(conceptEdges.length / CONCEPT_BATCHES);
let no = 1;
const manifest = [];
for (let b = 0; b < CONCEPT_BATCHES; b++) {
  const slice = conceptEdges.slice(b * per, (b + 1) * per);
  if (!slice.length) continue;
  const file = `batch-${String(b + 1).padStart(2, '0')}.json`;
  const cnt = dumpBatch(file, slice, no);
  manifest.push({ file, count: cnt, type: 'concept' });
  no += cnt;
}
if (colawEdges.length) {
  const file = `batch-06.json`;
  const cnt = dumpBatch(file, colawEdges, no);
  manifest.push({ file, count: cnt, type: 'colaw(跨域)' });
  no += cnt;
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ total: no - 1, batches: manifest }, null, 2));
console.log(`导出 ${no - 1} 条待复核边（concept ${conceptEdges.length} + 跨域colaw ${colawEdges.length}）`);
console.log('批次：', manifest.map((m) => `${m.file}(${m.count}/${m.type})`).join('  '));
console.log(`→ audit/review/`);
