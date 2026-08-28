// smoke.mjs —— MCP 服务端到端冒烟
//
// 以真实的 MCP 客户端经 stdio 起子进程连接被测服务，逐项断言协议与七个工具的行为，
// 并在子进程内挂载离线护栏（offline-guard.cjs），断言外部访问次数恒为 0。
//
// 默认测打包产物 dist/server.mjs（用户实际运行的那一份）；传 --src 改测源码 src/server.mjs。
//   node smoke.mjs
//   node smoke.mjs --src
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const useSrc = process.argv.includes('--src');
const TARGET = join(HERE, useSrc ? 'src/server.mjs' : 'dist/server.mjs');
const GUARD = join(HERE, 'offline-guard.cjs');
const REPORT = join(tmpdir(), `ipreader-mcp-offline-${process.pid}.json`);

let passed = 0;
const failures = [];
const step = (name, fn) => ({ name, fn });

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`);
  } else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 取工具返回的结构化数据（协议要求同时给 text，两者都断言存在） */
function dataOf(res, label) {
  ok(`${label} 返回文本形态`, Array.isArray(res.content) && res.content.length > 0 && typeof res.content[0].text === 'string');
  ok(`${label} 返回结构化数据`, res.structuredContent && typeof res.structuredContent === 'object');
  return res.structuredContent || {};
}

async function connect(env = {}) {
  const client = new Client({ name: 'ipreader-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TARGET],
    cwd: HERE,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${GUARD}`,
      IPREADER_OFFLINE_REPORT: REPORT,
      ...env,
    },
    stderr: 'pipe',
  });
  const t0 = Date.now();
  await client.connect(transport);
  return { client, transport, bootMs: Date.now() - t0 };
}

async function main() {
  if (!existsSync(TARGET)) {
    console.error(`被测目标不存在：${TARGET}\n请先运行 npm run build`);
    process.exit(1);
  }
  if (existsSync(REPORT)) rmSync(REPORT);

  console.log(`IPReader MCP 冒烟 · 目标 ${useSrc ? 'src/server.mjs（源码）' : 'dist/server.mjs（打包产物）'}\n`);

  // ============ 一、连接与工具清单 ============
  console.log('一、连接与协议');
  const { client, transport, bootMs } = await connect();
  ok('stdio 连接建立', true, `${bootMs}ms`);
  ok('冷启动在 3s 以内', bootMs < 3000, `${bootMs}ms`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ['browse_toc', 'find_law', 'list_books', 'lookup_term', 'read_node', 'related_nodes', 'search_kb'];
  ok('工具清单为七项', names.length === 7 && expected.every((n) => names.includes(n)), names.join('、'));
  ok('每个工具都有描述与入参 schema', tools.every((t) => t.description && t.inputSchema));

  const { resourceTemplates } = await client.listResourceTemplates();
  ok('登记了节点资源模板', (resourceTemplates || []).some((r) => r.uriTemplate.includes('patentkb://node/')));

  // ============ 二、list_books ============
  console.log('\n二、list_books');
  const books = dataOf(await client.callTool({ name: 'list_books', arguments: {} }), 'list_books');
  // 2026-08-22 入库批次一「04 司法解释」25 件 + 批次二「01 法律与行政法规」15 件
  //   + 批次三「02 部门规章与规范性文件」25 件：
  //   + 批次四（收尾）15 件——四批 80 件全量入库收官：
  //   书目 7 → 32 → 47 → 72 → 87，节点 2044 → 2774 → 3637 → 4585 → 5306（文档 4455 + 术语 851）
  //   2026-08-23 阶段5波A：修复 cppl 伪第十三条与 tmeg 误升标题各 −1 节点，5306 → 5304（文档 4453 + 术语 851）
  //   2026-08-23 阶段5波C：商标术语链路接通（关键词速查 68 行 + 109 片证据片入词表），
  //     术语 851 → 1035，文档 4453 不变，5304 → 5488
  //   2026-08-23 阶段5.1（商标审查审理指南四级树重建）：tmeg 空壳编标题溶解，文档 4453 → 4452，
  //     术语 1035 不变，5488 → 5487
  //   2026-08-24 阶段5.2（tmeg 深层两级切分 + 质量评价指南入库）：批次 W-1 将 tmeg 四级树 104 → 813
  //     节点（+709）；批次 Q-1 将《专利质量评价指南》第 88 部入库 214 节点（书目 87 → 88）。
  //     两批合计：文档 4452 → 5375，术语 1035 不变，5487 → 6410
  //   2026-08-24～2026-08-25 阶段5.3（W1～W8 多批次并行改造，详见 mcp/scripts/build-data.mjs 头注）：
  //     文档 5375 → 6247，术语 1035 不变，6410 → 7282；书目仍恒 88 部
  //     （本行由批次 W9 同步更新，其余数据相关断言——如法条正文 2521 条、各具体检索/术语结果——
  //     未在 grep「5375/6410/公布与施行」范围内，是否需要同步由后续统一验证批次核实）。
  ok('八十八部书目全开', books.books.length === 88, books.books.map((b) => b.short).join('、'));
  ok('节点总数 7282', books.totalNodes === 7282, String(books.totalNodes));
  ok('术语 1035 条', books.termCount === 1035, String(books.termCount));
  // 2026-08-22 阶段3批②「lawName 登记」：69 部规范授 lawName 后 lawArticles 从 231 键增至 2496 键
  //   （设计方案 PatentReader-2026-设计方案-阶段3法条键跨法域改造 §四「全链路影响预判」）。
  //   2026-08-23 阶段5波A：cppl 缺陷修复后补授 lawName（第 70 域），2496 → 2521 键。
  ok('法条正文 2521 条', books.lawArticleCount === 2521, String(books.lawArticleCount));

  // ============ 三、search_kb ============
  console.log('\n三、search_kb');
  const s1 = dataOf(await client.callTool({ name: 'search_kb', arguments: { query: '创造性判断' } }), 'search_kb');
  ok('「创造性判断」有命中', s1.results.length > 0, `${s1.results.length} 条`);
  ok('命中 02-04 系列（创造性章）', s1.results.some((r) => r.id.startsWith('02-04')), s1.results[0] && s1.results[0].id);
  ok('每条含路径与 slug', s1.results.every((r) => r.path && r.slug), '');
  ok('每条含命中片段', s1.results.every((r) => r.excerpt && r.excerpt.length > 0));

  const s2 = dataOf(await client.callTool({ name: 'search_kb', arguments: { query: '等同侵权', limit: 3 } }), 'search_kb');
  ok('「等同侵权」首条为侵权判定指南对应节', s2.results[0] && s2.results[0].id === 'infr-02-03', s2.results[0] && `${s2.results[0].id} ${s2.results[0].title}`);
  ok('limit 生效', s2.results.length <= 3, `${s2.results.length} 条`);

  const s3 = dataOf(await client.callTool({ name: 'search_kb', arguments: { query: '创造性', books: ['patent-law'] } }), 'search_kb');
  ok('books 过滤生效（仅专利法与术语）', s3.results.every((r) => r.book === '专利法' || r.book === '关键词索引'), s3.results.map((r) => r.book).join('、'));

  const s4 = dataOf(await client.callTool({ name: 'search_kb', arguments: { query: '量子纠缠区块链' } }), 'search_kb');
  ok('库中不存在的词返回空而非噪音', s4.results.length === 0, `${s4.results.length} 条`);

  // ============ 四、read_node ============
  console.log('\n四、read_node');
  const r1 = dataOf(await client.callTool({ name: 'read_node', arguments: { id: '02-04-05' } }), 'read_node');
  ok('正文非空', r1.text && r1.text.length > 0, `${r1.total} 字`);
  ok('breadcrumb 正确', r1.path === '实质审查 › 创造性 › 判断发明创造性时需考虑的其他因素', r1.path);
  ok('slug 指向站内页面', r1.slug === '3-专利审查指南/2-实质审查/4-创造性/02-04-05', r1.slug);

  const r2 = dataOf(await client.callTool({ name: 'read_node', arguments: { id: '02', mode: 'full', limit: 2000 } }), 'read_node');
  ok('超长节点单次返回受 limit 约束', r2.returned <= 2000, `${r2.returned} / ${r2.total} 字`);
  ok('分页游标给出', r2.hasMore === true && r2.nextOffset === r2.returned, `nextOffset=${r2.nextOffset}`);
  const r3 = dataOf(await client.callTool({ name: 'read_node', arguments: { id: '02', mode: 'full', offset: r2.nextOffset, limit: 2000 } }), 'read_node');
  ok('续读接续无重叠', r3.offset === r2.nextOffset && r3.text !== r2.text, `offset=${r3.offset}`);

  const r4 = dataOf(await client.callTool({ name: 'read_node', arguments: { id: '不存在的节点' } }), 'read_node');
  ok('未知节点返回错误而非崩溃', typeof r4.error === 'string', r4.error);

  // ============ 五、lookup_term ============
  console.log('\n五、lookup_term');
  const t1 = dataOf(await client.callTool({ name: 'lookup_term', arguments: { term: '客体审查' } }), 'lookup_term');
  ok('命中术语 term-0001', t1.id === 'term-0001', t1.id);
  ok('正名匹配', t1.matchedVia === 'canonical', t1.matchedVia);
  ok('出处为四处', t1.occurrenceCount === 4, `${t1.occurrenceCount} 处`);
  ok('出处含所在书目与路径', t1.occurrences.every((o) => o.book && o.path && o.nodeId));

  const t2 = dataOf(await client.callTool({ name: 'lookup_term', arguments: { term: '这不是术语' } }), 'lookup_term');
  ok('未收录术语给出提示', typeof t2.error === 'string' && Array.isArray(t2.suggestions), t2.error);

  // ============ 六、find_law ============
  console.log('\n六、find_law');
  const l1 = dataOf(await client.callTool({ name: 'find_law', arguments: { article: '专利法第22条' } }), 'find_law');
  ok('条文原文非空', l1.text && l1.text.includes('新颖性'), `${(l1.text || '').length} 字`);
  ok('列出引用该条的章节', l1.citedByCount > 0, `${l1.citedByCount} 处`);
  const l2 = dataOf(await client.callTool({ name: 'find_law', arguments: { article: '专利法第二十二条' } }), 'find_law');
  ok('中文条号等价', l2.id === l1.id, `${l2.id} = ${l1.id}`);
  const l3 = dataOf(await client.callTool({ name: 'find_law', arguments: { article: '细则22' } }), 'find_law');
  ok('细则简写解析正确', l3.article === '专利法实施细则第22条', l3.article);
  const l4 = dataOf(await client.callTool({ name: 'find_law', arguments: { article: '专利法第999条' } }), 'find_law');
  ok('不存在的条号返回错误', typeof l4.error === 'string', l4.error);

  // ============ 七、browse_toc 与 related_nodes ============
  console.log('\n七、browse_toc 与 related_nodes');
  const b1 = dataOf(await client.callTool({ name: 'browse_toc', arguments: {} }), 'browse_toc');
  ok('缺省列出八十八部书', b1.books.length === 88);
  const b2 = dataOf(await client.callTool({ name: 'browse_toc', arguments: { root: '02-04', depth: 1 } }), 'browse_toc');
  ok('按节点展开子结构', b2.children.length > 0, `${b2.children.length} 个子节点`);
  ok('depth 生效（不递归下一层）', b2.children.every((c) => c.children === undefined));

  const n1 = dataOf(await client.callTool({ name: 'related_nodes', arguments: { id: '02-04-05' } }), 'related_nodes');
  ok('返回分组关联', n1.groups.length > 0, n1.groups.map((g) => `${g.label}(${g.count})`).join('、'));
  const n2 = dataOf(await client.callTool({ name: 'related_nodes', arguments: { id: '02-04-05', types: ['hierarchy'] } }), 'related_nodes');
  ok('types 过滤生效', n2.groups.every((g) => g.type === 'hierarchy'), n2.groups.map((g) => g.type).join('、'));

  // ============ 八、Resources ============
  console.log('\n八、Resources');
  const res = await client.readResource({ uri: 'patentkb://node/02-04-05' });
  ok('节点资源可读', res.contents[0].text.includes('创造性'), res.contents[0].text.slice(0, 40).replace(/\n/g, ' '));

  await client.close();
  await transport.close();

  // ============ 九、离线护栏 ============
  console.log('\n九、离线护栏');
  await new Promise((r) => setTimeout(r, 300)); // 等子进程 exit 钩子落盘
  if (existsSync(REPORT)) {
    const rep = JSON.parse(readFileSync(REPORT, 'utf8'));
    ok('外部网络访问次数为 0', rep.externalAttempts === 0, `${rep.externalAttempts} 次${rep.attempts.length ? '：' + rep.attempts.join('；') : ''}`);
    rmSync(REPORT);
  } else {
    ok('离线报告已生成', false, `未找到 ${REPORT}`);
  }

  // ============ 十、域白名单 ============
  console.log('\n十、域白名单（IPREADER_MCP_DOMAINS）');
  const { client: c2, transport: tr2 } = await connect({ IPREADER_MCP_DOMAINS: 'patent-law' });
  const d1 = dataOf(await c2.callTool({ name: 'list_books', arguments: {} }), 'list_books');
  ok('仅开放一部书', d1.books.length === 1 && d1.books[0].domain === 'patent-law', d1.books.map((b) => b.short).join('、'));
  ok('其余八十七部标记为已关闭', d1.closedBooks.length === 87, d1.closedBooks.map((b) => b.title).join('、'));
  const d2 = dataOf(await c2.callTool({ name: 'read_node', arguments: { id: '02-04-05' } }), 'read_node');
  ok('已关闭书目的节点不可读', typeof d2.error === 'string', d2.error);
  const d3 = dataOf(await c2.callTool({ name: 'search_kb', arguments: { query: '创造性判断' } }), 'search_kb');
  ok('已关闭书目不参与检索', d3.results.every((r) => r.book === '专利法' || r.book === '关键词索引'), d3.results.map((r) => r.book).join('、') || '（空）');
  await c2.close();
  await tr2.close();

  // ============ 汇总 ============
  console.log(`\n${'—'.repeat(52)}`);
  if (failures.length) {
    console.log(`${passed} 项通过，${failures.length} 项失败：`);
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
  console.log(`全部 ${passed} 项断言通过 · 外部网络访问 0 次`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n冒烟异常终止：', err && err.stack ? err.stack : err);
  process.exit(1);
});
