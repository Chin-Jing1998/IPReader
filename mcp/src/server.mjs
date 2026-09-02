// server.mjs —— IPReader MCP 服务入口（stdio 传输）
//
// 让任意支持 MCP 的 agent（Claude Code / Codex / WorkBuddy 等）检索、精读并溯源
// 76 部知识产权法规与实务文献。全程离线：本地文件 + 父子进程管道，不开端口、不发请求。
//
// 三条纪律：
//   1. stdout 是 JSON-RPC 通道，任何日志一律走 stderr——往 stdout 写一个字节即破坏协议。
//   2. 数据在 serveStdio 的工厂函数之外加载。工厂可能被调用多次（协议时代协商），
//      在工厂内加载会重复解压建索引。
//   3. 返回体量自律由本文件与 tools.mjs 分担：tools.mjs 按语义边界做增量预算（主力），
//      本文件的 reply() 做最终兜底（保险丝）。宿主只消费 structuredContent，
//      故一切限流都以它的 JSON 序列化体量为准——推导与取证见 tools.mjs 头注。
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { loadKb, nodeBrief, breadcrumbPath } from './data.mjs';
import { buildIndex } from './search.mjs';
import {
  searchKb, readNode, browseToc, lookupTerm, findLaw, relatedNodes, listBooks,
  listArticles, compareArticles, batchRead, filterBooks, findCitingSections, getBrief,
  EDGE_LABEL, estimateTokens, safeOutputTokens,
} from './tools.mjs';

const VERSION = '1.7.1';

// ============ 一、启动：加载数据；检索索引惰性构建 ============
//
// 阶段5.13b 启动优化。实测（7 轮中位）冷启动 336 ms 的构成是：
//   node 进程启动约 34 ms + bundle 求值约 38 ms + loadKb 约 112 ms + buildIndex 约 158 ms。
// buildIndex（FlexSearch 全量建索引）独占近半，而十三个工具里只有 search_kb 用得上它——
// 其余十二个只查 Map 与数组。故改为惰性：启动不建，首次 search_kb 才建。
//
// 另一候选是索引持久化（构建期 index.export() 落盘、运行时 import()）：实测省 113.7 ms，
// 但分发包要多 1.72 MB（现 4.03 MB，涨 43%），而该包还要随 Electron 应用一起分发。
// 惰性方案省得更多（158 ms）且分发包零增长，故取惰性、不取持久化，对照实测见提交说明。
//
// 惰性的代价是首次 search_kb 多付约 158 ms。用握手后的空闲窗口预热抵消：延时故意设为
// 800 ms 而非 0——Node 事件循环的 timers 阶段先于 poll 阶段，0 ms 定时器会抢在读取
// stdin 之前同步阻塞 158 ms，把省下的启动时间原样还回去。unref 使预热不阻止进程退出。
const t0 = Date.now();
const kb = loadKb();
let indexCache = null;
const getIndex = () => (indexCache ??= buildIndex(kb));
const ctx = { kb, get index() { return getIndex(); } };
const bootMs = Date.now() - t0;

const WARMUP_DELAY_MS = 800;
const warmup = setTimeout(() => { try { getIndex(); } catch { /* 预热失败不影响按需构建 */ } }, WARMUP_DELAY_MS);
if (typeof warmup.unref === 'function') warmup.unref();

for (const w of kb.warnings) process.stderr.write(`[IPReader MCP] ${w}\n`);
process.stderr.write(
  `[IPReader MCP] 就绪 ${bootMs}ms · 节点 ${kb.nodes.length} · 书目 ${kb.books.length}/${kb.allBooks.length}` +
  `${kb.isFullOpen ? '' : '（域白名单生效）'} · 检索索引惰性构建\n`,
);

// ============ 二、返回包装：structuredContent + 可读文本 + 体量兜底 ============

/**
 * 工具返回统一形态。
 *
 * 双轨的实际计量（阶段5.13b 本机取证）：Claude Code 一类宿主在 structuredContent 存在时
 * 只取它的 JSON 交给模型，content[0].text 被整体丢弃。故 text 不占模型上下文，它服务的是
 * 「不支持 structuredContent 的客户端」与人工排障——保留但只写摘要，不与结构化数据比长短。
 *
 * 兜底：tools.mjs 的增量预算已把各工具的最大形态压到安全阈值内，本层再校一次实际序列化
 * 体量。正常不触发；一旦触发（如将来新增工具漏加预算），返回可读的摘要与自救指引，
 * 而不是把一个必被宿主截断的巨型返回体推出去——那等于让调用方白等一轮。
 */
const reply = (data, text) => {
  const isError = data && data.error ? true : undefined;
  const cap = safeOutputTokens();
  const tokens = estimateTokens(data);
  if (!isError && tokens > cap) {
    const fallback = {
      error: `返回体量 ${tokens} token 超出本服务的输出安全阈值 ${cap}，已拦截`,
      hint: '请缩小查询范围（调小 limit/depth/charsPer* 等参数），或改用带分页的工具分次取。'
        + '阈值可用环境变量 IPREADER_MAX_OUTPUT_TOKENS 调整。',
      estimatedTokens: tokens,
      safeOutputTokens: cap,
    };
    return {
      content: [{ type: 'text', text: `${fallback.error}。${fallback.hint}` }],
      structuredContent: fallback,
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError,
  };
};

const line = (...parts) => parts.filter(Boolean).join(' · ');

// 法条节点 label 形如「第二十二条 · 发明/实用新型授权条件」，分隔符后半段即条旨
const LAW_TITLE_SEP = ' · ';
function lawTitleOf(nodeId) {
  const label = nodeId ? kb.byId.get(nodeId)?.label : '';
  if (!label) return '';
  const i = label.indexOf(LAW_TITLE_SEP);
  return i >= 0 ? label.slice(i + LAW_TITLE_SEP.length) : label;
}

/**
 * 关联法条的可读渲染（lookup_term 文本分支专用）。
 *
 * 词条详情里的 laws 是 `{ lawKey, fullCite, nodeId }` 对象（site/scripts/build-term-content.mjs
 * 产出），原实现写作 `l.law || l`——对象没有 law 字段，短路后落到对象本身，模板字符串
 * 把它渲染成 `[object Object]`（词表 lawKeys 越多，乱码越长：「驰名商标」连出 8 个）。
 * structuredContent 侧一直是完整对象、不受影响，只有给模型读的文本被污染。
 *
 * 现按「法名+条号（条旨）」渲染：引用形态优先取 fullCite（如「专利法第22条第2款」），
 * 缺失时退回法条键 lawKey；条旨取该法条节点 label 的分隔符后半段，取不到就只出引用形态。
 * 兼容字符串元素（词表侧 lawKeys 原本就是字符串数组），便于将来两种形态并存。
 */
function lawLabel(l) {
  if (typeof l === 'string') return l;
  if (!l || typeof l !== 'object') return String(l ?? '');
  const cite = l.fullCite || l.lawKey || l.law || '';
  const title = lawTitleOf(l.nodeId);
  if (!cite) return title || l.nodeId || '';
  return title ? `${cite}（${title}）` : cite;
}

// ============ 三、出参契约（outputSchema） ============
//
// 声明后有两道校验：服务端 SDK 用 zod 校 structuredContent（isError 为真时跳过），
// 客户端再用 AJV 校 tools/list 里那份 JSON Schema。两道的宽严度并不一致——
// zod 的 z.object 在运行时放行未声明的键，但转成 JSON Schema 时会写死
// additionalProperties:false，客户端据此把任何多出的字段判为违约（实测：list_books 的
// books[] 因多出 field/docType/statusCode 被客户端拒收）。故此处一律用 z.looseObject，
// 使两侧同为「声明的必须对，未声明的放行」。
//
// 由此定契约写法：「必填项恒在、其余一律 optional、对象一律 loose」——
// 把可选项写成必填，一个边界分支就能让整个工具报错。
// 未声明字段不会被裁剪（SDK 的 projectCallToolResult 对「对象根 schema + 对象值」是恒等投影，已核实）。
//
// 另一条取舍：schema 会随 tools/list 进入调用方上下文，且每轮请求都带着。故 item 层只声明
// 最能定位的少数字段，不做逐字段穷举——契约的价值在「有没有」，不在「全不全」。
const S = {
  str: z.string(),
  num: z.number(),
  bool: z.boolean(),
};
const obj = (shape) => z.looseObject(shape);
/** 节点条目的共用最小形态：够调用方据以续查（read_node / related_nodes 都吃 id） */
const nodeItem = obj({
  id: S.str,
  title: S.str.optional(),
  book: S.str.optional(),
});
/** 各工具通用的尾部字段：截断标记与自救提示 */
const tailFields = {
  truncated: S.bool.optional(),
  budgetTruncated: S.bool.optional(),
  hint: S.str.optional(),
  estimatedTokens: S.num.optional(),
};
/**
 * 法条类工具通用的效力著录字段（阶段5.13b 补丁）。
 * effectiveDate 照录数据包中的中文日期串（如「2027年1月1日」），不做格式转换——
 * 归一日期格式是上游著录侧的事，此处擅自改写反而制造第二套口径。
 * effectivityWarning 只在 statusCode 为 not-yet-effective / repealed 时出现。
 */
const effectivityFields = {
  effectiveDate: S.str.optional(),
  statusCode: S.str.optional(),
  effectivityWarning: S.str.optional(),
};

const OUT = {
  search_kb: obj({
    query: S.str,
    total: S.num,
    results: z.array(nodeItem.extend({
      path: S.str.optional(), excerpt: S.str.optional(), matchedIn: S.str.optional(),
    })),
    notes: z.array(S.str),
    ...tailFields,
  }),
  read_node: obj({
    id: S.str,
    title: S.str,
    mode: S.str,
    text: S.str,
    offset: S.num,
    returned: S.num,
    total: S.num,
    hasMore: S.bool,
    nextOffset: S.num.nullable().optional(),
    children: z.array(nodeItem).optional(),
    lawCites: z.array(obj({ lawKey: S.str, fullCite: S.str.optional(), count: S.num.optional() })).optional(),
    ...tailFields,
  }),
  browse_toc: obj({
    // 三种形态（书目摘要／跨书展开／单点展开）共用一个 schema，故除 depth 外皆 optional
    depth: S.num,
    mode: S.str.optional(),
    root: z.unknown().optional(),
    books: z.array(obj({ domain: S.str, short: S.str.optional(), nodeCount: S.num.optional() })).optional(),
    children: z.array(nodeItem).optional(),
    grouped: z.array(z.unknown()).optional(),
    ...tailFields,
  }),
  lookup_term: obj({
    id: S.str,
    term: S.str,
    matchedVia: S.str,
    definition: S.str,
    aliases: z.array(S.str).optional(),
    laws: z.array(z.unknown()).optional(),
    relatedTerms: z.array(obj({ id: S.str, term: S.str })).optional(),
    occurrenceCount: S.num,
    occurrences: z.array(obj({ nodeId: S.str, title: S.str.optional(), book: S.str.optional() })),
    ...tailFields,
  }),
  find_law: obj({
    // 正常命中与「裸条号多义」两种形态共用；后者不设 error（多义是正常结果，不是失败）
    article: S.str,
    id: S.str,
    title: S.str,
    text: S.str,
    citedByCount: S.num,
    citedBy: z.array(nodeItem).optional(),
    ...effectivityFields,
    ambiguous: S.bool.optional(),
    candidates: z.array(obj({ article: S.str, lawName: S.str.optional(), id: S.str.optional() })).optional(),
    ...tailFields,
  }),
  related_nodes: obj({
    id: S.str,
    title: S.str,
    groups: z.array(obj({
      type: S.str, label: S.str, count: S.num, nodes: z.array(nodeItem), truncated: S.bool.optional(),
    })),
    curated: z.array(obj({ id: S.str, title: S.str.optional(), reason: S.str.optional() })).optional(),
    ...tailFields,
  }),
  list_books: obj({
    totalNodes: S.num,
    termCount: S.num,
    lawArticleCount: S.num,
    detail: S.str,
    bookCount: S.num,
    offset: S.num,
    returned: S.num,
    books: z.array(obj({ domain: S.str, short: S.str, nodeCount: S.num })),
    hasMore: S.bool,
    nextOffset: S.num.nullable().optional(),
    closedBooks: z.array(obj({ domain: S.str, title: S.str })),
    note: S.str,
    groups: z.array(z.unknown()),
    ...tailFields,
  }),
  list_articles: obj({
    lawName: S.str,
    domain: S.str.optional(),
    ...effectivityFields,
    total: S.num,
    matched: S.num,
    offset: S.num,
    returned: S.num,
    articles: z.array(obj({ article: S.str, num: S.num, title: S.str, id: S.str, chars: S.num.optional() })),
    hasMore: S.bool,
    nextOffset: S.num.nullable().optional(),
    ...tailFields,
  }),
  compare_articles: obj({
    requested: S.num,
    returned: S.num,
    charsPerArticle: S.num.optional(),
    articles: z.array(obj({
      query: S.str, article: S.str, id: S.str, title: S.str.optional(), text: S.str, ...effectivityFields,
    })),
    effectivityWarnings: z.array(obj({ article: S.str, statusCode: S.str, warning: S.str })).optional(),
    notFound: z.array(obj({ query: S.str, reason: S.str })),
    overflow: S.num.optional(),
    ...tailFields,
  }),
  batch_read: obj({
    mode: S.str,
    requested: S.num,
    returned: S.num,
    charsPerNode: S.num.optional(),
    nodes: z.array(nodeItem.extend({ text: S.str, path: S.str.optional() })),
    notFound: z.array(S.str),
    overflow: S.num.optional(),
    ...tailFields,
  }),
  filter_books: obj({
    criteria: z.unknown(),
    total: S.num,
    offset: S.num,
    returned: S.num,
    detail: S.str,
    books: z.array(obj({ domain: S.str, short: S.str, nodeCount: S.num.optional() })),
    hasMore: S.bool,
    nextOffset: S.num.nullable().optional(),
    facets: z.unknown(),
    nodeCount: S.num.optional(),
    ...tailFields,
  }),
  find_citing_sections: obj({
    criteria: z.unknown().optional(),
    effectivity: z.array(obj({ domain: S.str, lawName: S.str.optional(), ...effectivityFields })).optional(),
    articleCount: S.num,
    citedArticleCount: S.num,
    totalCitations: S.num,
    offset: S.num,
    returned: S.num,
    items: z.array(obj({
      article: S.str, id: S.str.optional(), title: S.str.optional(),
      citingCount: S.num, bookCount: S.num.optional(), citing: z.array(nodeItem),
    })),
    notFound: z.array(obj({ query: S.str, reason: S.str })),
    notes: z.array(S.str).optional(),
    hasMore: S.bool,
    nextOffset: S.num.nullable().optional(),
    ...tailFields,
  }),
  get_brief: obj({
    source: S.str,
    root: S.str.optional(),
    total: S.num,
    returned: S.num,
    items: z.array(obj({ id: S.str, title: S.str, level: S.str.optional(), brief: S.str })),
    notFound: z.array(S.str),
    ...tailFields,
  }),
};

/**
 * 十三个工具的行为标注。全部是纯本地只读查询：不写文件、不改状态、同参必同果、不触外网。
 * readOnlyHint 使宿主可将其识别为只读工具（据以自动放行、可安全并发）；
 * openWorldHint=false 声明结果域封闭于本地数据包，宿主因此知道重试不会拿到不同答案。
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// ============ 四、十三个工具 ============
//
// 入参 schema 的一条体量纪律：76 个书目域键的 z.enum 展开后约 2 200 B，而 tools/list
// 会随每一轮请求进入调用方上下文。故只在 search_kb 的 books 参数上保留该枚举
//（既有行为，且那是最常用的范围限定入口，逐值校验确有价值）；新增工具的域键参数
// 一律收为 z.string()，取值指引写进 description，无效值由各自实现给出可见的提示。
// 实测：三处枚举合计 8 400 B，收为一处后 tools/list 由 29 919 B 降至约 25 000 B。
const DOMAIN_ENUM = kb.allBooks.map((b) => b.domain);
const FIELD_ENUM = ['专利', '商标', '著作权', '竞争法', '品种布图', '综合程序'];
const DOC_TYPE_ENUM = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const STATUS_ENUM = ['in-force', 'not-yet-effective', 'unknown'];

function registerTools(server) {
  server.registerTool(
    'search_kb',
    {
      title: '全文检索',
      description:
        '在 76 部知识产权法规与实务文献中做全文检索，返回命中页面的标题、所属书目、层级路径与命中片段。'
        + '检索为本地索引，中文按字切分并叠加术语表精确匹配。适合「某个概念在哪里规定」这类问题。',
      inputSchema: z.object({
        query: z.string().min(1).describe('检索词，如「创造性判断」「等同侵权」「说明书充分公开」'),
        books: z.array(z.enum(DOMAIN_ENUM)).optional()
          .describe('限定书目域，缺省检索全部；可用 list_books 查看域键'),
        limit: z.number().int().optional().describe('返回条数，默认 8，上限 30'),
        contextChars: z.number().int().optional().describe('每条命中片段的字数，默认 200，上限 600'),
        includeTerms: z.boolean().optional().describe('是否包含术语词条页，默认 true'),
      }),
      outputSchema: OUT.search_kb,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = searchKb(ctx, args);
      // 书目范围失效属错误而非无命中，须先于无命中分支返回，否则原因被「无命中」文案掩盖
      if (r.error) return reply(r, r.error);
      if (!r.results.length) {
        return reply(r, `「${r.query}」无命中。可换用更短的检索词，或用 lookup_term 查术语、browse_toc 浏览目录。`);
      }
      const text = [
        `「${r.query}」命中 ${r.total} 条：`,
        ...r.results.map((x, i) => `${i + 1}. ${x.title}（${x.book}）\n   路径：${x.path}\n   id：${x.id}\n   ${x.excerpt}`),
        ...r.notes,
      ].join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'read_node',
    {
      title: '读取原文',
      description:
        '按节点 id 读取正文原文。mode=own 只读本节（默认），mode=full 连同全部子节点。'
        + '长文本分页返回，用 nextOffset 续读；单次上限 8000 字（超出部分翻页取，不会丢失）。'
        + '节点 id 由 search_kb / browse_toc / find_law 等给出。要一次读多个节点用 batch_read。'
        + '另附 lawCites 字段：本节正文引用的法条清单（按引用次数排序），无引用时省略该字段。',
      inputSchema: z.object({
        id: z.string().min(1).describe('节点 id，如 02-04-05、law-02-01、term-0035'),
        mode: z.enum(['own', 'full']).optional().describe('own=仅本节正文（默认），full=含子节点全文'),
        offset: z.number().int().optional().describe('起始字符位置，续读时填上一次的 nextOffset'),
        limit: z.number().int().optional().describe('本次最多返回的字数，默认 4000，上限 8000'),
      }),
      outputSchema: OUT.read_node,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = readNode(ctx, args);
      if (r.error) return reply(r, r.error);
      const head = line(r.title, r.book, `id：${r.id}`);
      const tail = r.hasMore
        ? `\n\n——已返回 ${r.offset}–${r.offset + r.returned} 字（共 ${r.total}），续读请用 offset=${r.nextOffset}`
        : '';
      const kids = r.children.length && !r.text
        ? `\n\n子节点：${r.children.map((c) => `${c.title}（${c.id}）`).join('、')}`
        : '';
      return reply(r, `${head}\n路径：${r.path}\n\n${r.text || r.empty || ''}${kids}${tail}`);
    },
  );

  server.registerTool(
    'browse_toc',
    {
      title: '浏览目录',
      description:
        '按层级浏览目录树。不传 root 时返回 76 部书的书目级摘要（域键、短名、节点数、字数、顶层节点数），'
        + '不展开子树——这是缺省档，用来先看清「有哪些书、往哪部里钻」。'
        + '要展开某部书传 root=<域键>（如 examination-guideline），要展开某一节传 root=<节点 id>，'
        + 'depth 控制层数（默认 2，上限 8）。不传 root 时也可加 depth≥1 跨全部书目展开顶层结构，'
        + '但返回体大得多，超出输出体量上限的部分会被截断并在 hint 中说明。'
        + '不传 root 时可另加 groupBy=taxonomy，附一份按国家／法域（field）／文献类型（docType，D1–D6）分层的 grouped 视图。',
      inputSchema: z.object({
        root: z.string().optional().describe('书目域键或节点 id；缺省返回书目级摘要（不展开子树）'),
        depth: z.number().int().optional()
          .describe('展开层数，上限 8。传了 root 时默认 2；不传 root 时默认 0（仅摘要），需展开须显式指定'),
        groupBy: z.enum(['taxonomy']).optional()
          .describe('仅接受 "taxonomy"；缺省 root 时返回体另附按国家/法域/文献类型分层的 grouped 视图，传了 root 时无效'),
      }),
      outputSchema: OUT.browse_toc,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = browseToc(ctx, args);
      if (r.error) return reply(r, r.error);
      const render = (nodes, indent = '') => nodes.flatMap((n) => [
        `${indent}${n.title}（${n.id}${n.childCount ? `，${n.childCount} 子节点` : ''}）`,
        ...(n.children ? render(n.children, indent + '  ') : []),
      ]);
      const text = r.books
        ? [
          ...r.books.map((b) => `【${b.short}】${b.domain} · ${b.nodeCount} 节点 / ${b.chars} 字`
            + (b.topCount ? ` · 顶层 ${b.topCount} 节` : '')
            + (b.children ? `\n${render(b.children, '  ').join('\n')}` : '')),
          r.hint || '',
        ].filter(Boolean).join('\n')
        : [`【${r.root.title || r.root.domain}】`, ...render(r.children, '  '), r.hint || ''].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'lookup_term',
    {
      title: '查术语',
      description:
        '查询 1743 条知识产权术语词条，覆盖专利、商标、著作权、竞争法、品种布图、综合程序六个法域：'
        + '释义、在各书中的出处（含所在章节与原文摘录）、关联法条与相关术语。'
        + '支持正名与别名。未命中时返回相近词条供选择。',
      inputSchema: z.object({
        term: z.string().min(1).describe('术语名，如「创造性」「等同侵权」「客体审查」'),
        includeEvidence: z.boolean().optional().describe('是否附带各出处的原文摘录，默认 false'),
      }),
      outputSchema: OUT.lookup_term,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = lookupTerm(ctx, args);
      if (r.error) {
        return reply(r, `${r.error}。${r.suggestions.length ? `相近词条：${r.suggestions.join('、')}` : r.hint}`);
      }
      const text = [
        line(r.term, r.topic && `主题：${r.topic}`, r.aliases.length && `别名：${r.aliases.join('、')}`),
        r.definition && `\n${r.definition}`,
        r.laws.length ? `\n关联法条：${r.laws.map(lawLabel).filter(Boolean).join('、')}` : '',
        r.relatedTerms.length ? `相关术语：${r.relatedTerms.map((t) => t.term).join('、')}` : '',
        r.occurrenceCount ? `\n出处 ${r.occurrenceCount} 处：\n${r.occurrences.map((o) => `  · ${o.path}（${o.book}，${o.nodeId}）`).join('\n')}` : '',
        r.hint || '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'find_law',
    {
      title: '查法条',
      description:
        '按条号直达法条原文（覆盖 65 部有条文的规范），并列出审查指南等书中引用该条的全部章节。'
        + '条号写法宽松：「专利法第22条」「专利法第二十二条」「细则22」「商标法第八条」均可；'
        + '未写明法名的裸条号会返回跨法域候选清单，不代为择一。'
        + '要通览一部法的条号-条旨全表用 list_articles，要并列对照多条用 compare_articles，'
        + '要按法批量反查被引情况用 find_citing_sections。',
      inputSchema: z.object({
        article: z.string().min(1).describe('法条，如「专利法第22条」「细则22」，或条文节点 id（law-02-01）'),
        withCitations: z.boolean().optional().describe('是否列出引用该条的章节，默认 true'),
        limit: z.number().int().optional().describe('引用章节的返回上限，默认 60，上限 200'),
      }),
      outputSchema: OUT.find_law,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = findLaw(ctx, args);
      if (r.error) return reply(r, `${r.error}。${r.hint || ''}`);
      const cites = r.citedBy && r.citedBy.length
        ? `\n\n引用该条的章节共 ${r.citedByCount} 处${r.truncated ? `（下列 ${r.citedBy.length} 处）` : ''}：\n`
          + r.citedBy.map((c) => `  · ${c.path}（${c.book}，${c.id}）`).join('\n')
        : '\n\n（无其他章节引用该条的记录）';
      // 版本提示置于条文正文之前：读到条文时就该知道它是不是现行有效的，
      // 放在末尾等于让人先按错的版本理解完再被纠正
      const warn = r.effectivityWarning ? `${r.effectivityWarning}\n\n` : '';
      return reply(r, `${r.article}　${r.title}\nid：${r.id}\n\n${warn}${r.text}${cites}`);
    },
  );

  server.registerTool(
    'related_nodes',
    {
      title: '关联节点',
      description:
        '取某节点在知识图谱中的关联，按边类型分组：层级、交叉引用、法条依据、共引同一法条、'
        + '术语出现、术语关联法条、术语相关、术语共现。另附数据层预解析的人可读关系。',
      inputSchema: z.object({
        id: z.string().min(1).describe('节点 id'),
        types: z.array(z.enum(Object.keys(EDGE_LABEL))).optional().describe('限定边类型，缺省返回全部'),
        limit: z.number().int().optional().describe('每组返回上限，默认 20，上限 100'),
      }),
      outputSchema: OUT.related_nodes,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = relatedNodes(ctx, args);
      if (r.error) return reply(r, r.error);
      const text = [
        `${r.title}（${r.book}，${r.id}）`,
        r.curated.length ? `\n关联：${r.curated.map((c) => `${c.title}［${c.reason}］`).join('、')}` : '',
        ...r.groups.map((g) => `\n${g.label}（${g.count}）：\n`
          + g.nodes.map((n) => `  · ${n.title}（${n.book}，${n.id}）`).join('\n')),
        r.hint || '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'list_books',
    {
      title: '内容清单',
      description:
        '列出当前开放的书目、各自的节点数与字数，以及被域白名单关闭的书目。先调它可建立全局认知。'
        + '缺省为精简档（域键、短名、规模、法域 field、文献类型 docType、效力枚举 statusCode），一次给全 76 部；'
        + '传 detail="full" 另出书目全称、国家、文号、通过与施行日期、效力说明与法名，'
        + '该档因单部体量大而分页返回（缺省 40 部，续取按 nextOffset）。'
        + '另附 groups 摘要：按国家→法域→文献类型三级聚合的书目分布统计（不受分页影响，恒覆盖全部书目）。'
        + '要按条件筛选而非拉全量，用 filter_books——它能一次返回符合条件的全部书目的完整著录。',
      inputSchema: z.object({
        detail: z.enum(['brief', 'full']).optional()
          .describe('brief=精简档（默认，仅决策所需字段，一次给全）；full=完整著录信息（分页）'),
        offset: z.number().int().optional().describe('起始序号，续取时填上一次的 nextOffset'),
        limit: z.number().int().optional().describe('本页书目数，brief 默认全部／full 默认 40'),
      }),
      outputSchema: OUT.list_books,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = listBooks(ctx, args || {});
      const text = [
        `共 ${r.totalNodes} 节点（含术语 ${r.termCount} 条）· 法条正文 ${r.lawArticleCount} 条`,
        ...r.books.map((b) => `  ${b.short}（${b.domain}）：${b.nodeCount} 节点 / ${b.chars} 字`),
        r.note,
        r.hint || '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  // ———— 以下六项为阶段5.13b 新增 ————

  server.registerTool(
    'list_articles',
    {
      title: '条文目录',
      description:
        '列出某部法的全部条号与条旨（条文目录）。一次拿到「第N条 + 条旨 + 节点 id + 正文字数」的全表，'
        + '用于通览一部法的条文骨架、核对条号引用是否存在、或据条旨快速锁定要读的条。'
        + '法名写全称或常用简称均可（「专利法」「细则」「商标法」），也可改传 domain 域键。'
        + '条号区间用 from/to 限定，结果分页（offset/limit），续取按返回的 nextOffset。'
        + '取单条原文用 find_law，并列对照多条用 compare_articles。',
      inputSchema: z.object({
        lawName: z.string().optional().describe('法名全称或简称，如「专利法」「专利法实施细则」「细则」「商标法」'),
        domain: z.string().optional().describe('书目域键（如 patent-law、implementation-rules），与 lawName 二选一；全部域键用 list_books 或 filter_books 查询'),
        from: z.number().int().optional().describe('起始条号（含），如 22'),
        to: z.number().int().optional().describe('结束条号（含），如 30'),
        limit: z.number().int().optional().describe('本页条数，默认 200，上限 400'),
        offset: z.number().int().optional().describe('起始序号，续取时填上一次的 nextOffset'),
      }),
      outputSchema: OUT.list_articles,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = listArticles(ctx, args);
      if (r.error) return reply(r, `${r.error}。${r.hint || ''}`);
      const text = [
        r.effectivityWarning || '',
        `《${r.lawName}》共 ${r.total} 条${r.matched !== r.total ? `，区间内 ${r.matched} 条` : ''}，`
        + `本页 ${r.returned} 条：`,
        ...r.articles.map((a) => `  第${a.num}条　${a.title}（${a.id}，${a.chars} 字）`),
        r.hint || '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'compare_articles',
    {
      title: '条文对照',
      description:
        '并列取回多条法条的正文，供逐条对照。适合同法连续条号的比对（专利法第22、23条）'
        + '与跨法同主题条文的横向比对（专利法第33条 与 商标法第30条）。'
        + '单次最多 10 条，每条正文按 charsPerArticle 截断（默认 1500 字，上限 4000）。'
        + '无法解析、跨法域多义或该法无此条者一律列入 notFound 并说明原因，不静默丢弃。',
      inputSchema: z.object({
        articles: z.array(z.string()).describe('法条数组，如 ["专利法第22条","专利法第23条"]，单次最多 10 条'),
        withCitations: z.boolean().optional().describe('是否附带各条被引用的前 10 个章节，默认 false'),
        charsPerArticle: z.number().int().optional().describe('每条正文的返回字数，默认 1500，上限 4000'),
      }),
      outputSchema: OUT.compare_articles,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = compareArticles(ctx, args);
      if (r.error) return reply(r, `${r.error}。${r.hint || ''}`);
      // 跨法对照时提示置顶：并列比对最怕「一条现行、一条尚未施行」而读者不知情
      const warns = (r.effectivityWarnings || []).map((w) => w.warning);
      // 逐条标注只在非现行有效时出现，现行条目不加噪音
      const mark = (a) => (a.statusCode === 'not-yet-effective'
        ? `，${a.effectiveDate || ''}起施行`
        : a.statusCode === 'repealed' ? '，已废止' : '');
      const text = [
        ...warns,
        `${warns.length ? '\n' : ''}对照 ${r.returned}/${r.requested} 条：`,
        ...r.articles.map((a) => `\n【${a.article}】${a.title}（${a.id}，共 ${a.chars} 字${a.textTruncated ? '，已截断' : ''}${mark(a)}）\n${a.text}`),
        r.notFound.length ? `\n未取到 ${r.notFound.length} 条：${r.notFound.map((x) => `${x.query}（${x.reason}）`).join('；')}` : '',
        r.hint || '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'batch_read',
    {
      title: '批量读取',
      description:
        '一次读取多个节点的摘要或正文节选，省去逐个 read_node 的多轮往返。'
        + 'mode="brief"（默认）只出一句话摘要，用于对检索或目录结果做「值不值得精读」的筛查；'
        + 'mode="own" 出正文节选。单次最多 20 个节点，每个按 charsPerNode 截断。'
        + '要读某个节点的完整正文（含分页续读）仍用 read_node；只要摘要且节点很多用 get_brief。',
      inputSchema: z.object({
        ids: z.array(z.string()).describe('节点 id 数组，如 ["02-04-05","law-02-01"]，单次最多 20 个'),
        mode: z.enum(['brief', 'own']).optional().describe('brief=一句话摘要（默认），own=本节正文节选'),
        charsPerNode: z.number().int().optional().describe('每个节点的返回字数，brief 默认 400／own 默认 1200，上限 4000'),
      }),
      outputSchema: OUT.batch_read,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = batchRead(ctx, args);
      if (r.error) return reply(r, `${r.error}。${r.hint || ''}`);
      const text = [
        `读取 ${r.returned}/${r.requested} 个节点（${r.mode === 'own' ? '正文节选' : '摘要'}）：`,
        ...r.nodes.map((n) => `\n【${n.title}】${n.book} · ${n.id}\n路径：${n.path}\n${n.text || n.empty || ''}`),
        r.notFound.length ? `\n未找到：${r.notFound.join('、')}` : '',
        r.hint || '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'filter_books',
    {
      title: '筛选书目',
      description:
        '按国家、法域、文献类型、效力状态筛选书目，返回符合条件的域键清单与命中集的分布摘要（facets）。'
        + 'field 取 专利／商标／著作权／竞争法／品种布图／综合程序；'
        + 'docType 取 D1 法律／D2 行政法规／D3 部门规章与规范性文件／D4 司法解释与裁判规则／D5 审查与实务指引／D6 政策文件与标准索引；'
        + 'statusCode 取 in-force 现行有效／not-yet-effective 尚未施行／unknown 未标注；'
        + 'hasLawName 限定「有无条文级法名」（true 者才可用 find_law / list_articles 按条号直查）。'
        + '典型用法：先用它拿到域键清单，再把域键喂给 search_kb 的 books 参数缩小检索范围。',
      inputSchema: z.object({
        country: z.string().optional().describe('国家/法域来源，如「中国」'),
        field: z.enum(FIELD_ENUM).optional().describe('六标签法域'),
        docType: z.enum(DOC_TYPE_ENUM).optional().describe('文献类型 D1–D6'),
        statusCode: z.enum(STATUS_ENUM).optional().describe('效力状态枚举'),
        hasLawName: z.boolean().optional().describe('true=仅有条文级法名者；false=仅无者'),
        query: z.string().optional().describe('书名/域键/法名的子串匹配，如「商标」「解释」'),
        detail: z.enum(['brief', 'full']).optional().describe('brief=精简档（默认）；full=完整著录信息'),
        offset: z.number().int().optional().describe('起始序号，续取时填上一次的 nextOffset'),
        limit: z.number().int().optional().describe('本页书目数，默认 200（即不额外限制，仅受输出体量约束）'),
      }),
      outputSchema: OUT.filter_books,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = filterBooks(ctx, args || {});
      const text = [
        `命中 ${r.total} 部书目（合计 ${r.nodeCount} 节点），本页 ${r.returned} 部：`,
        ...r.books.map((b) => `  ${b.short}（${b.domain}）：${b.nodeCount} 节点`
          + (b.field ? ` · ${b.field}` : '') + (b.docType ? `/${b.docType}` : '')),
        r.hint || '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'find_citing_sections',
    {
      title: '引用链反查',
      description:
        '反查「哪些章节引用了某法某条」，支持按条批量（articles）与按法全量（lawName）两种入口。'
        + '结果按被引次数降序，每条给出引用它的章节清单与跨书目数（bookCount），可用 books 限定只看某几部书。'
        + '典型用法：查专利法第22条在审查指南、侵权判定指南等书中的全部落点，'
        + '或一次拿到专利法全部条文的被引热度分布以定位重点条款。'
        + '数据依据是「条文→引用章节」反向索引（512 键、2649 条引用关系），'
        + '跨书关联由法条引用承担而非交叉引用边——后者全库仅 375 条且跨书只有 2 条。'
        + '结果分页（offset/limit），续取按返回的 nextOffset。',
      inputSchema: z.object({
        lawName: z.string().optional().describe('法名全称或简称，取该法全部条文的被引情况，如「专利法」'),
        articles: z.array(z.string()).optional().describe('法条数组，逐条反查，如 ["专利法第22条","专利法第26条"]'),
        books: z.array(z.string()).optional()
          .describe('书目域键数组（如 ["examination-guideline"]），只统计这些书目中的引用；缺省统计全库。域键用 list_books 或 filter_books 查询，给错会在 notes 中指出'),
        limit: z.number().int().optional().describe('本页条文数，默认 40，上限 200'),
        offset: z.number().int().optional().describe('起始序号，续取时填上一次的 nextOffset'),
        citingPerArticle: z.number().int().optional().describe('每条法条列出的引用章节数，默认 10，上限 60'),
      }),
      outputSchema: OUT.find_citing_sections,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = findCitingSections(ctx, args || {});
      if (r.error) return reply(r, `${r.error}。${r.hint || ''}`);
      const text = [
        ...(r.effectivity || []).map((e) => e.effectivityWarning).filter(Boolean),
        `查 ${r.articleCount} 条，其中 ${r.citedArticleCount} 条有被引记录（合计 ${r.totalCitations} 处），本页 ${r.returned} 条：`,
        ...r.items.map((it) => `\n【${it.article}】${it.title} —— 被引 ${it.citingCount} 处，跨 ${it.bookCount} 部书\n`
          + it.citing.map((c) => `  · ${c.path}（${c.book}，${c.id}）`).join('\n')),
        r.notFound.length ? `\n未解析：${r.notFound.map((x) => `${x.query}（${x.reason}）`).join('；')}` : '',
        ...(r.notes || []),
        r.hint || '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'get_brief',
    {
      title: '节点摘要',
      description:
        '批量取节点的一句话摘要，供「先判断再决定是否精读」。两种入口：给 ids 数组按 id 取，'
        + '或给 root（书目域键或节点 id）配 depth 取该范围内的全部后代。单次最多 100 个节点。'
        + '与 batch_read(mode="brief") 的差别：本工具不出正文、路径与 slug，单条成本约为其三分之一，'
        + '因此适合对整页检索结果或整章目录做一遍粗筛；确定要读哪几个之后再用 read_node / batch_read。',
      inputSchema: z.object({
        ids: z.array(z.string()).optional().describe('节点 id 数组；与 root 二选一，单次最多 100 个'),
        root: z.string().optional().describe('书目域键或节点 id，取其后代的摘要'),
        depth: z.number().int().optional().describe('root 模式下的层数，默认 2，上限 8'),
        limit: z.number().int().optional().describe('返回条数上限，默认 100'),
      }),
      outputSchema: OUT.get_brief,
      annotations: READ_ONLY,
    },
    async (args) => {
      const r = getBrief(ctx, args || {});
      if (r.error) return reply(r, `${r.error}。${r.hint || ''}`);
      const text = [
        `${r.returned}/${r.total} 个节点的摘要：`,
        ...r.items.map((it) => `  · ${it.title}（${it.id}）：${it.brief || '（无摘要）'}`),
        r.notFound.length ? `未找到：${r.notFound.join('、')}` : '',
        r.hint || '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );
}

// ============ 五、Resources：节点可被客户端直接引用 ============
function registerResources(server) {
  server.registerResource(
    'node',
    new ResourceTemplate('patentkb://node/{id}', {
      // 7706 个节点全量列出会淹没客户端的资源面板，故只登记模板不做枚举，
      // 节点发现走 search_kb / browse_toc
      list: undefined,
    }),
    {
      title: '知识库节点',
      description: '按节点 id 读取正文，如 patentkb://node/02-04-05',
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      const node = kb.byId.get(id);
      if (!node) {
        return { contents: [{ uri: uri.href, text: `节点不存在或所属书目未开放：${id}` }] };
      }
      const b = nodeBrief(kb, id);
      const body = kb.bodies[id] || {};
      const text = `${b.title}（${b.book}）\n路径：${breadcrumbPath(kb, id)}\n\n${body.own || node.summary || '（无独立正文）'}`;
      return { contents: [{ uri: uri.href, text, mimeType: 'text/plain' }] };
    },
  );
}

// ============ 六、启动 stdio 服务 ============
serveStdio(() => {
  const server = new McpServer(
    { name: 'ipreader', version: VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'IPReader 知识产权知识库：专利、商标、著作权（含软著）、竞争法、植物新品种与集成电路布图设计六大法域 '
        + '76 部法律法规、审查指南、司法解释与实务文献。所有内容均为本地离线数据，不联网。\n'
        + '常用路径：先用 search_kb 定位，再用 read_node 读原文；查条文用 find_law，查术语用 lookup_term，'
        + '看目录用 browse_toc（缺省只给书目摘要，展开某部书传 root=<域键>）。\n'
        + '批量与专项：通览一部法的条号-条旨用 list_articles；并列对照多条条文用 compare_articles；'
        + '一次读多个节点用 batch_read，只要摘要且节点多用 get_brief；'
        + '按法域/文献类型/效力状态挑书目用 filter_books（其域键可直接喂给 search_kb 的 books 参数缩小范围）；'
        + '反查某法某条被哪些章节引用用 find_citing_sections。\n'
        + '返回体量：各工具均设有输出上限，超限时会截断并在 hint 字段说明如何分页或收窄参数——'
        + '看到 truncated/budgetTruncated 为 true 时按 hint 调参续取，不必重复原样调用。',
    },
  );
  registerTools(server);
  registerResources(server);
  return server;
}, {
  onerror: (err) => process.stderr.write(`[IPReader MCP] ${err && err.message ? err.message : err}\n`),
});
