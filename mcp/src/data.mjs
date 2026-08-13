// data.mjs —— 数据包加载与域过滤
//
// 数据包 kb-data.json.gz 由 scripts/build-data.mjs 生成，与打包产物 server.mjs 同目录。
// 加载全程无网络、无外部进程：读本地文件 → gunzip → JSON.parse → 建 Map 索引。
// 实测冷启动（解压 65ms + 解析 + 建索引）约 200ms，故不做懒加载。
//
// 域过滤（环境变量 PATENTREADER_MCP_DOMAINS）在此层生效而非返回层：被关闭的书
// 既不入检索索引，也无法经 read_node / related_nodes 等任何路径取到，
// 且指向它的引用（术语出处、关联节点、法条引用）一并剔除，不留悬空指针。
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const DATA_FILE = 'kb-data.json.gz';

/**
 * 数据包定位：打包后 server.mjs 与数据包同在 dist/；开发时源码在 src/，数据包在 ../dist/。
 * 两处依次探测，使同一份源码在两种形态下都能直接运行。
 */
function resolveDataFile() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, DATA_FILE), join(here, '..', 'dist', DATA_FILE)]) {
    if (existsSync(p)) return p;
  }
  throw new Error(`未找到数据包 ${DATA_FILE}——请先执行 node scripts/build-data.mjs`);
}
// 术语不属于任何一部书，是横跨全库的索引层，不受域开关影响
const TERM_DOMAIN = 'terms';

/**
 * 解析域白名单。
 * @param {string|undefined} raw 环境变量原值，逗号分隔的 domain 键
 * @param {string[]} allDomains 数据包中登记的全部书目域
 * @returns {{ allowed: Set<string>, warnings: string[] }}
 */
export function parseDomainFilter(raw, allDomains) {
  const warnings = [];
  const all = new Set(allDomains);
  if (!raw || !raw.trim()) return { allowed: all, warnings };

  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const allowed = new Set();
  for (const key of requested) {
    if (all.has(key)) allowed.add(key);
    else warnings.push(`未知域键「${key}」已忽略（可选：${allDomains.join('、')}）`);
  }
  if (!allowed.size) {
    warnings.push('域白名单为空，回落为全部开放');
    return { allowed: all, warnings };
  }
  return { allowed, warnings };
}

/**
 * 加载数据包并建立运行时索引。
 * @param {{ dataFile?: string, domains?: string }} [options]
 *   dataFile 数据包路径（默认与本模块同目录）；domains 域白名单（默认取环境变量）
 * @returns 运行时知识库对象
 */
export function loadKb(options = {}) {
  const file = options.dataFile || resolveDataFile();
  const pack = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));

  const allDomains = pack.books.map((b) => b.domain);
  const rawFilter = options.domains !== undefined ? options.domains : process.env.PATENTREADER_MCP_DOMAINS;
  const { allowed, warnings } = parseDomainFilter(rawFilter, allDomains);
  const isFullOpen = allowed.size === allDomains.length;

  // —— 节点：书目域受白名单约束，术语层恒保留 ——
  const nodes = pack.nodes.filter((n) => n.domain === TERM_DOMAIN || allowed.has(n.domain));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const has = (id) => byId.has(id);

  // —— 层级关系 ——
  const parentOf = new Map();
  const childrenOf = new Map();
  const edges = [];
  for (const e of pack.edges) {
    if (!has(e.s) || !has(e.t)) continue; // 任一端被过滤即整条边剔除
    edges.push(e);
    if (e.ty !== 'hierarchy') continue;
    parentOf.set(e.t, e.s);
    if (!childrenOf.has(e.s)) childrenOf.set(e.s, []);
    childrenOf.get(e.s).push(e.t);
  }
  const idCompare = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  for (const arr of childrenOf.values()) arr.sort(idCompare);

  // 邻接表：related_nodes 按边类型分组时直接取用
  const neighborsOf = new Map();
  for (const e of edges) {
    if (!neighborsOf.has(e.s)) neighborsOf.set(e.s, []);
    neighborsOf.get(e.s).push({ id: e.t, type: e.ty, dir: 'out' });
    if (!neighborsOf.has(e.t)) neighborsOf.set(e.t, []);
    neighborsOf.get(e.t).push({ id: e.s, type: e.ty, dir: 'in' });
  }

  // —— 正文与详情 ——
  const bodies = {};
  for (const [id, b] of Object.entries(pack.bodies)) if (has(id)) bodies[id] = b;

  const docDetails = {};
  for (const [id, d] of Object.entries(pack.docDetails)) {
    if (!has(id)) continue;
    const o = { ...d };
    if (o.related) o.related = o.related.filter((r) => has(r.id));
    docDetails[id] = o;
  }

  const termDetails = {};
  for (const [id, d] of Object.entries(pack.termDetails)) {
    if (!has(id)) continue;
    const o = { ...d };
    if (o.occurrences && !isFullOpen) {
      const kept = {};
      for (const [domain, list] of Object.entries(o.occurrences)) {
        if (!allowed.has(domain)) continue;
        const items = list.filter((x) => has(x.nodeId));
        if (items.length) kept[domain] = items;
      }
      o.occurrences = kept;
    }
    if (o.relatedTerms) o.relatedTerms = o.relatedTerms.filter((t) => has(t.id || t));
    termDetails[id] = o;
  }

  // —— 术语查找：canonical 与 aliases 双向归一 ——
  // 两轮建表，canonical 先落位：同一名字若既是某词的正名、又是另一词的别名，正名优先。
  // 别名另行标记——它们的匹配置信度低于正名（如「外观设计」是词条「发明创造定义」的别名，
  // 该词条讲的是专利法第二条对三类专利的定义，命中它不等于命中外观设计本身）。
  const termByName = new Map();
  for (const n of nodes) {
    if (n.level !== 'term') continue;
    const key = normalizeTermKey(n.label);
    if (key && !termByName.has(key)) termByName.set(key, { id: n.id, canonical: true });
  }
  for (const n of nodes) {
    if (n.level !== 'term') continue;
    for (const alias of n.aliases || []) {
      const key = normalizeTermKey(alias);
      if (key && !termByName.has(key)) termByName.set(key, { id: n.id, canonical: false });
    }
  }

  // —— 法条：正文节点索引 + 被引用记录 ——
  const lawArticles = new Map();
  for (const [key, nodeId] of Object.entries(pack.lawArticles)) {
    if (has(nodeId)) lawArticles.set(key, nodeId);
  }
  const lawCitedBy = new Map();
  for (const l of pack.laws) {
    const cited = l.nodes.filter(has);
    if (cited.length) lawCitedBy.set(l.law, cited);
  }

  const books = pack.books.filter((b) => allowed.has(b.domain));

  return {
    meta: pack.meta,
    books,
    allBooks: pack.books,
    allowedDomains: allowed,
    isFullOpen,
    warnings,
    nodes,
    byId,
    parentOf,
    childrenOf,
    neighborsOf,
    bodies,
    docDetails,
    termDetails,
    termByName,
    lawArticles,
    lawCitedBy,
    slugs: pack.slugs,
  };
}

/** 术语名归一：忽略大小写、空白与常见分隔符，使「客体审查」「客体 审查」等价 */
export function normalizeTermKey(s) {
  return String(s || '').toLowerCase().replace(/[\s·・\-—_、,，.。]/g, '');
}

/**
 * 节点的对外摘要形态：所有工具返回节点时统一经此，保证字段一致。
 * @param {object} kb 运行时知识库
 * @param {string} id 节点 id
 */
export function nodeBrief(kb, id) {
  const n = kb.byId.get(id);
  if (!n) return null;
  const book = kb.allBooks.find((b) => b.domain === n.domain);
  return {
    id: n.id,
    title: n.label,
    level: n.level,
    domain: n.domain,
    book: book ? book.short : n.domain === TERM_DOMAIN ? '关键词索引' : n.domain,
    breadcrumb: n.breadcrumb || [],
    slug: kb.slugs[n.id] || null,
    chars: n.charLen || 0,
  };
}

/** 面包屑的可读路径，如「实质审查 › 创造性 › 判断发明创造性时需考虑的其他因素」 */
export function breadcrumbPath(kb, id) {
  const n = kb.byId.get(id);
  if (!n) return '';
  return [...(n.breadcrumb || []), n.label].join(' › ');
}
