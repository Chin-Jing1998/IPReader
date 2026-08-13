// server.mjs —— PatentReader MCP 服务入口（stdio 传输）
//
// 让任意支持 MCP 的 agent（Claude Code / Codex / WorkBuddy 等）检索、精读并溯源
// 七部专利法规与实务文献。全程离线：本地文件 + 父子进程管道，不开端口、不发请求。
//
// 两条纪律：
//   1. stdout 是 JSON-RPC 通道，任何日志一律走 stderr——往 stdout 写一个字节即破坏协议。
//   2. 数据在 serveStdio 的工厂函数之外加载。工厂可能被调用多次（协议时代协商），
//      在工厂内加载会重复解压建索引。
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { loadKb, nodeBrief, breadcrumbPath } from './data.mjs';
import { buildIndex } from './search.mjs';
import {
  searchKb, readNode, browseToc, lookupTerm, findLaw, relatedNodes, listBooks, EDGE_LABEL,
} from './tools.mjs';

const VERSION = '1.0.0';

// ============ 一、启动：加载数据并建索引（实测约 200ms） ============
const t0 = Date.now();
const kb = loadKb();
const index = buildIndex(kb);
const ctx = { kb, index };
const bootMs = Date.now() - t0;

for (const w of kb.warnings) process.stderr.write(`[PatentReader MCP] ${w}\n`);
process.stderr.write(
  `[PatentReader MCP] 就绪 ${bootMs}ms · 节点 ${kb.nodes.length} · 书目 ${kb.books.length}/${kb.allBooks.length}` +
  `${kb.isFullOpen ? '' : '（域白名单生效）'}\n`,
);

// ============ 二、返回包装：structuredContent + 可读文本 ============
/**
 * 工具返回统一形态。MCP 客户端里，结构化数据供程序取用，文本供模型直接阅读——
 * 二者都给，调用方无须先解析 JSON 再理解。
 */
const reply = (data, text) => ({
  content: [{ type: 'text', text: text ?? JSON.stringify(data, null, 2) }],
  structuredContent: data,
  isError: data && data.error ? true : undefined,
});

const line = (...parts) => parts.filter(Boolean).join(' · ');

// ============ 三、七个工具 ============
const DOMAIN_ENUM = kb.allBooks.map((b) => b.domain);

function registerTools(server) {
  server.registerTool(
    'search_kb',
    {
      title: '全文检索',
      description:
        '在七部专利法规与实务文献中做全文检索，返回命中页面的标题、所属书目、层级路径与命中片段。'
        + '检索为本地索引，中文按字切分并叠加术语表精确匹配。适合「某个概念在哪里规定」这类问题。',
      inputSchema: z.object({
        query: z.string().min(1).describe('检索词，如「创造性判断」「等同侵权」「说明书充分公开」'),
        books: z.array(z.enum(DOMAIN_ENUM)).optional()
          .describe('限定书目域，缺省检索全部；可用 list_books 查看域键'),
        limit: z.number().int().optional().describe('返回条数，默认 8，上限 30'),
        contextChars: z.number().int().optional().describe('每条命中片段的字数，默认 200，上限 600'),
        includeTerms: z.boolean().optional().describe('是否包含术语词条页，默认 true'),
      }),
    },
    async (args) => {
      const r = searchKb(ctx, args);
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
        + '长文本分页返回，用 nextOffset 续读。节点 id 由 search_kb / browse_toc / find_law 等给出。',
      inputSchema: z.object({
        id: z.string().min(1).describe('节点 id，如 02-04-05、law-02-01、term-0035'),
        mode: z.enum(['own', 'full']).optional().describe('own=仅本节正文（默认），full=含子节点全文'),
        offset: z.number().int().optional().describe('起始字符位置，续读时填上一次的 nextOffset'),
        limit: z.number().int().optional().describe('本次最多返回的字数，默认 4000，上限 20000'),
      }),
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
        '按层级浏览目录树。不传 root 时列出七部书的顶层结构；root 可给书目域键（如 examination-guideline）'
        + '或任一节点 id，用于展开该节点之下的子结构。',
      inputSchema: z.object({
        root: z.string().optional().describe('书目域键或节点 id；缺省列出全部书目'),
        depth: z.number().int().optional().describe('展开层数，默认 2，上限 5'),
      }),
    },
    async (args) => {
      const r = browseToc(ctx, args);
      if (r.error) return reply(r, r.error);
      const render = (nodes, indent = '') => nodes.flatMap((n) => [
        `${indent}${n.title}（${n.id}${n.childCount ? `，${n.childCount} 子节点` : ''}）`,
        ...(n.children ? render(n.children, indent + '  ') : []),
      ]);
      const text = r.books
        ? r.books.flatMap((b) => [`【${b.title}】${b.nodeCount} 节点 / ${b.chars} 字`, ...render(b.children, '  ')]).join('\n')
        : [`【${r.root.title || r.root.domain}】`, ...render(r.children, '  ')].join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'lookup_term',
    {
      title: '查术语',
      description:
        '查询 851 条专利术语词条：释义、在各书中的出处（含所在章节与原文摘录）、关联法条与相关术语。'
        + '支持正名与别名。未命中时返回相近词条供选择。',
      inputSchema: z.object({
        term: z.string().min(1).describe('术语名，如「创造性」「等同侵权」「客体审查」'),
        includeEvidence: z.boolean().optional().describe('是否附带各出处的原文摘录，默认 false'),
      }),
    },
    async (args) => {
      const r = lookupTerm(ctx, args);
      if (r.error) {
        return reply(r, `${r.error}。${r.suggestions.length ? `相近词条：${r.suggestions.join('、')}` : r.hint}`);
      }
      const text = [
        line(r.term, r.topic && `主题：${r.topic}`, r.aliases.length && `别名：${r.aliases.join('、')}`),
        r.definition && `\n${r.definition}`,
        r.laws.length ? `\n关联法条：${r.laws.map((l) => l.law || l).join('、')}` : '',
        r.relatedTerms.length ? `相关术语：${r.relatedTerms.map((t) => t.term).join('、')}` : '',
        r.occurrenceCount ? `\n出处 ${r.occurrenceCount} 处：\n${r.occurrences.map((o) => `  · ${o.path}（${o.book}，${o.nodeId}）`).join('\n')}` : '',
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'find_law',
    {
      title: '查法条',
      description:
        '按条号直达专利法或专利法实施细则的条文原文，并列出审查指南等书中引用该条的全部章节。'
        + '条号写法宽松：「专利法第22条」「专利法第二十二条」「细则22」均可。',
      inputSchema: z.object({
        article: z.string().min(1).describe('法条，如「专利法第22条」「细则22」，或条文节点 id（law-02-01）'),
        withCitations: z.boolean().optional().describe('是否列出引用该条的章节，默认 true'),
        limit: z.number().int().optional().describe('引用章节的返回上限，默认 60，上限 200'),
      }),
    },
    async (args) => {
      const r = findLaw(ctx, args);
      if (r.error) return reply(r, `${r.error}。${r.hint || ''}`);
      const cites = r.citedBy && r.citedBy.length
        ? `\n\n引用该条的章节共 ${r.citedByCount} 处${r.truncated ? `（下列 ${r.citedBy.length} 处）` : ''}：\n`
          + r.citedBy.map((c) => `  · ${c.path}（${c.book}，${c.id}）`).join('\n')
        : '\n\n（无其他章节引用该条的记录）';
      return reply(r, `${r.article}　${r.title}\nid：${r.id}\n\n${r.text}${cites}`);
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
    },
    async (args) => {
      const r = relatedNodes(ctx, args);
      if (r.error) return reply(r, r.error);
      const text = [
        `${r.title}（${r.book}，${r.id}）`,
        r.curated.length ? `\n关联：${r.curated.map((c) => `${c.title}［${c.reason}］`).join('、')}` : '',
        ...r.groups.map((g) => `\n${g.label}（${g.count}）：\n`
          + g.nodes.map((n) => `  · ${n.title}（${n.book}，${n.id}）`).join('\n')),
      ].filter(Boolean).join('\n');
      return reply(r, text);
    },
  );

  server.registerTool(
    'list_books',
    {
      title: '内容清单',
      description: '列出当前开放的书目、各自的节点数与字数，以及被域白名单关闭的书目。先调它可建立全局认知。',
      inputSchema: z.object({}),
    },
    async () => {
      const r = listBooks(ctx);
      const text = [
        `共 ${r.totalNodes} 节点（含术语 ${r.termCount} 条）· 法条正文 ${r.lawArticleCount} 条`,
        ...r.books.map((b) => `  ${b.title}（${b.domain}）：${b.nodeCount} 节点 / ${b.chars} 字`),
        r.note,
      ].join('\n');
      return reply(r, text);
    },
  );
}

// ============ 四、Resources：节点可被客户端直接引用 ============
function registerResources(server) {
  server.registerResource(
    'node',
    new ResourceTemplate('patentkb://node/{id}', {
      // 2044 个节点全量列出会淹没客户端的资源面板，故只登记模板不做枚举，
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

// ============ 五、启动 stdio 服务 ============
serveStdio(() => {
  const server = new McpServer(
    { name: 'patentreader', version: VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'PatentReader 专利知识库：专利法、实施细则、审查指南、侵权判定指南与三部撰写／答复实务文献。'
        + '建议先用 search_kb 定位，再用 read_node 读原文；查条文用 find_law，查术语用 lookup_term。'
        + '所有内容均为本地离线数据，不联网。',
    },
  );
  registerTools(server);
  registerResources(server);
  return server;
}, {
  onerror: (err) => process.stderr.write(`[PatentReader MCP] ${err && err.message ? err.message : err}\n`),
});
