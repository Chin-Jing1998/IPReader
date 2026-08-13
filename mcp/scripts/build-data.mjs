// build-data.mjs —— MCP 数据包生成器：site/data + site/public/content → dist/kb-data.json.gz
//
// 输入（均为只读，与 quartz 生成器同源）：
//   site/data/nodes.json              2044 节点（7 部书 1193 + 术语 851）
//   site/data/node-bodies.json        每节点 ownText（本节净文本）/ fullText（含子树）
//   site/data/edges.json              7998 边，8 种类型
//   site/data/laws.json               123 条法条 → 引用它的节点列表（find_law 正向索引）
//   site/data/law-citations.json      1453 条节点 → 法条引用（反向索引）
//   site/public/content/{id}.json     章节详情（related/lawRefs/brief）与词条详情
//                                     （definition/occurrences/laws/relatedTerms）
//   quartz-kb/public/static/contentIndex.json  仅用于校验 slug 重建结果，不入包
//
// 输出：dist/kb-data.json.gz（gzip level 9，实测约 1.7MB，解压约 65ms）
//
// 设计要点：
//   1. slug 映射在构建期算定并入包，运行时零计算，也不必分发 contentIndex.json。
//      重建规则复刻 site/scripts/build-quartz-md.mjs:140-172，并逐条与 contentIndex 的
//      既成 slug 对照——规则若被上游改动，此处立即抛错而非静默错位。
//   2. 布局字段（x/y/size/community/colorGroup/degree 等）是图谱渲染专用，MCP 不需要，全部剔除。
//   3. 词条详情用 site/public/content/term-*.json 而非 data/terms-merged.json：前者含
//      definition/occurrences（带 breadcrumb 与 evidence）/relatedTerms，是完整口径。
//
// 用法：node scripts/build-data.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { KNOWN_DOMAINS } from '../../site/scripts/lib/domains.mjs';
import { cn2num } from '../../site/scripts/lib/cn-num.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(SCRIPT_DIR, '..');
const REPO_DIR = join(MCP_DIR, '..');
const DATA_DIR = join(REPO_DIR, 'site', 'data');
const CONTENT_JSON_DIR = join(REPO_DIR, 'site', 'public', 'content');
const CONTENT_INDEX = join(REPO_DIR, 'quartz-kb', 'public', 'static', 'contentIndex.json');
const OUT_DIR = join(MCP_DIR, 'dist');
const OUT_FILE = join(OUT_DIR, 'kb-data.json.gz');

// 定版数（与 README 口径一致）：偏离即说明上游数据已变，须复核后同步本文件与文档
const EXPECTED_NODES = 2044;
const EXPECTED_DOC_NODES = 1193;
const EXPECTED_TERM_NODES = 851;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ============ 一、书目登记：域 → 顶层目录（与 build-quartz-md.mjs:55-63 逐字一致） ============
const BOOKS = [
  { order: 1, domain: 'patent-law', dir: '1-专利法' },
  { order: 2, domain: 'implementation-rules', dir: '2-专利法实施细则' },
  { order: 3, domain: 'examination-guideline', dir: '3-专利审查指南' },
  { order: 4, domain: 'infringement-guide', dir: '4-侵权判定指南' },
  { order: 5, domain: 'mechanical-drafting-rules', dir: '5-机械撰写规范' },
  { order: 6, domain: 'chemistry-drafting-rules', dir: '6-化学撰写规范' },
  { order: 7, domain: 'oa-response-guide', dir: '7-答复审查意见指南' },
];
const BOOK_BY_DOMAIN = new Map(BOOKS.map((b) => [b.domain, b]));
const DOMAIN_META = new Map(KNOWN_DOMAINS.map((d) => [d.key, d]));

// ============ 二、载入 ============
const nodes = readJson(join(DATA_DIR, 'nodes.json'));
const edges = readJson(join(DATA_DIR, 'edges.json'));
const bodies = readJson(join(DATA_DIR, 'node-bodies.json'));
const laws = readJson(join(DATA_DIR, 'laws.json'));
const lawCitations = readJson(join(DATA_DIR, 'law-citations.json'));

if (nodes.length !== EXPECTED_NODES) {
  throw new Error(`节点数 ${nodes.length} ≠ 定版 ${EXPECTED_NODES}——上游数据已变，请复核后同步本脚本与 README`);
}

const byId = new Map(nodes.map((n) => [n.id, n]));
const parentOf = new Map();
const childrenOf = new Map();
for (const e of edges) {
  if (e.type !== 'hierarchy') continue;
  parentOf.set(e.target, e.source);
  if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
  childrenOf.get(e.source).push(e.target);
}
const idCompare = (a, b) => a.localeCompare(b, 'en', { numeric: true });
for (const arr of childrenOf.values()) arr.sort(idCompare);

// ============ 三、slug 重建（复刻 build-quartz-md.mjs:92-97 / 128-134 / 140-172） ============
// 净化规则须与生成器逐字一致，否则重建出的路径与磁盘实际产物错位
function sanitizeName(s) {
  return s
    .replace(/[\s/\\:*?"<>|#%&{}$!'@+`=;,.]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || '未命名';
}

function folderDirName(node) {
  const ordinal = node.level === 'part' ? node.partNum : node.chapterNum;
  const name = node.label
    .replace(/^第[一二三四五六七八九十百零]+[章节部分]\s*/, '')
    .replace(/^[一二三四五六七八九十]+、\s*/, '');
  return `${ordinal}-${sanitizeName(name)}`;
}

const isFolderNode = (n) => n.level === 'part' || n.level === 'chapter';

// 既成产物的 slug 全集：重建结果须逐条落在其中
const siteSlugs = new Set(Object.keys(readJson(CONTENT_INDEX)));
// 叶子与术语页按「slug 末段 = 节点 id」直接反查（build-quartz-md.mjs:14 的约定）
const slugByTail = new Map();
for (const s of siteSlugs) {
  const tail = s.split('/').pop();
  if (!slugByTail.has(tail)) slugByTail.set(tail, s);
}

const slugs = {};
const slugMisses = [];
for (const n of nodes) {
  if (n.level === 'term' || !isFolderNode(n)) {
    const s = slugByTail.get(n.id);
    if (s) slugs[n.id] = s;
    else slugMisses.push(`${n.id}（叶子页未在 contentIndex 中找到）`);
    continue;
  }
  // part/chapter：目录 + index.md，祖先链自根向下拼接
  const chain = [];
  let cur = n.id;
  while (parentOf.has(cur)) {
    cur = parentOf.get(cur);
    chain.unshift(byId.get(cur));
  }
  const book = BOOK_BY_DOMAIN.get(n.domain);
  if (!book) throw new Error(`未知域：${n.domain}`);
  const dirs = [book.dir, ...chain.filter(isFolderNode).map(folderDirName), folderDirName(n)];
  const s = `${dirs.join('/')}/index`;
  if (siteSlugs.has(s)) slugs[n.id] = s;
  else slugMisses.push(`${n.id}（重建落空：${s}）`);
}
if (slugMisses.length) {
  throw new Error(`slug 重建失败 ${slugMisses.length} 项，生成器命名规则可能已变：\n  ${slugMisses.slice(0, 8).join('\n  ')}`);
}
{
  const rev = new Map();
  for (const [id, s] of Object.entries(slugs)) {
    if (rev.has(s)) throw new Error(`slug 冲突：${s} ← ${rev.get(s)} 与 ${id}`);
    rev.set(s, id);
  }
}

// ============ 四、字段裁剪 ============
// 保留检索、导航与呈现所需；剔除图谱布局专用字段（x/y/size/community/domainCommunity/
// colorGroup/degree/hasOwnText/kind），后者只服务 quartz 侧的力导向渲染
const NODE_KEEP = [
  'id', 'level', 'label', 'domain', 'breadcrumb', 'summary', 'charLen',
  'partNum', 'chapterNum', 'sectionNum', 'subNum', 'num',
  'laws', 'topics', 'aliases', 'topicKey', 'tier',
];
const leanNodes = nodes.map((n) => {
  const o = {};
  for (const k of NODE_KEEP) {
    const v = n[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (v === '') continue;
    o[k] = v;
  }
  return o;
});

const leanBodies = {};
for (const [id, b] of Object.entries(bodies)) {
  const own = (b.ownText || '').trim();
  const full = (b.fullText || '').trim();
  const o = {};
  if (own) o.own = own;
  // full 与 own 相同时不重复存储（叶子节点常见），运行时回落到 own
  if (full && full !== own) o.full = full;
  if (Object.keys(o).length) leanBodies[id] = o;
}

const leanEdges = edges.map((e) => ({ s: e.source, t: e.target, ty: e.type }));

// ============ 五、详情 JSON（related / lawRefs / 词条释义） ============
const termDetails = {};
const docDetails = {};
let detailFiles = 0;
for (const f of readdirSync(CONTENT_JSON_DIR)) {
  if (!f.endsWith('.json')) continue;
  const d = readJson(join(CONTENT_JSON_DIR, f));
  if (!d || !d.id) continue;
  detailFiles++;
  if (d.id.startsWith('term-')) {
    const o = {};
    if (d.definition) o.definition = d.definition;
    if (d.occurrences && Object.keys(d.occurrences).length) o.occurrences = d.occurrences;
    if (d.laws && d.laws.length) o.laws = d.laws;
    if (d.relatedTerms && d.relatedTerms.length) o.relatedTerms = d.relatedTerms;
    if (Object.keys(o).length) termDetails[d.id] = o;
  } else {
    const o = {};
    if (d.brief) o.brief = d.brief;
    // related 的 reason 是人可读的关系名（上级/下属/法条依据/指南交叉引用/相关/共引同一法条）
    if (d.related && d.related.length) {
      o.related = d.related.map((r) => ({ id: r.id, label: r.label, reason: r.reason }));
    }
    if (d.lawRefs && d.lawRefs.length) o.lawRefs = d.lawRefs;
    if (Object.keys(o).length) docDetails[d.id] = o;
  }
}

// ============ 六、法条正文索引：「专利法第22条」→ 条文节点 id ============
// laws.json 只登记「被引用过」的 123 条，而两部法律实际有 82 + 149 = 231 条正文节点；
// find_law 须能直达任一条，故在此按 num 字段（中文条号）为全部条文节点建映射。
const lawArticles = {};
for (const n of nodes) {
  const meta = DOMAIN_META.get(n.domain);
  if (!meta || !meta.lawName || n.level !== 'section' || !n.num) continue;
  const m = String(n.num).match(/^第([一二三四五六七八九十百零]+)条$/);
  if (!m) continue;
  const num = cn2num(m[1]);
  if (!Number.isFinite(num)) continue;
  const key = `${meta.lawName}第${num}条`;
  if (lawArticles[key]) throw new Error(`法条键冲突：${key} ← ${lawArticles[key]} 与 ${n.id}`);
  lawArticles[key] = n.id;
}
{
  // laws.json 的每个键都应能在正文索引中找到对应条文，否则 find_law 会给出「有引用无原文」的残缺结果
  const orphan = laws.map((l) => l.law).filter((k) => !lawArticles[k]);
  if (orphan.length) {
    throw new Error(`laws.json 中 ${orphan.length} 个法条键无对应条文节点：${orphan.slice(0, 5).join('、')}`);
  }
}

// ============ 七、书目清单 ============
const docNodeCount = nodes.filter((n) => n.level !== 'term').length;
const termNodeCount = nodes.length - docNodeCount;
if (docNodeCount !== EXPECTED_DOC_NODES || termNodeCount !== EXPECTED_TERM_NODES) {
  throw new Error(`节点构成 ${docNodeCount} 文档 / ${termNodeCount} 术语 ≠ 定版 ${EXPECTED_DOC_NODES} / ${EXPECTED_TERM_NODES}`);
}

const books = BOOKS.map((b) => {
  const meta = DOMAIN_META.get(b.domain);
  const own = nodes.filter((n) => n.domain === b.domain);
  const chars = own.reduce((a, n) => a + ((bodies[n.id] && bodies[n.id].ownText) || '').length, 0);
  return {
    domain: b.domain,
    order: b.order,
    title: meta ? meta.title : b.domain,
    short: meta ? meta.short : b.domain,
    lawName: meta && meta.lawName ? meta.lawName : undefined,
    nodeCount: own.length,
    chars,
  };
});

// ============ 八、装配与落盘 ============
const pack = {
  meta: {
    schemaVersion: 1,
    nodeCount: nodes.length,
    docNodeCount,
    termNodeCount,
    edgeCount: edges.length,
    lawCount: laws.length,
    lawArticleCount: Object.keys(lawArticles).length,
    detailFiles,
  },
  books,
  nodes: leanNodes,
  bodies: leanBodies,
  edges: leanEdges,
  slugs,
  laws,
  lawArticles,
  lawCitations,
  termDetails,
  docDetails,
};

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const json = JSON.stringify(pack);
const gz = gzipSync(json, { level: 9 });
writeFileSync(OUT_FILE, gz);

const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
console.log('MCP 数据包已生成：' + OUT_FILE);
console.log(`  节点 ${nodes.length}（文档 ${docNodeCount} / 术语 ${termNodeCount}）· 边 ${edges.length} · 详情 ${detailFiles}`);
console.log(`  法条正文索引 ${Object.keys(lawArticles).length} 条（其中 ${laws.length} 条有被引用记录）`);
console.log(`  正文 ${Object.keys(leanBodies).length} 篇 · slug 映射 ${Object.keys(slugs).length} 条（已逐条对照 contentIndex）`);
console.log(`  体积 ${mb(Buffer.byteLength(json))} → gzip ${mb(gz.length)}`);
