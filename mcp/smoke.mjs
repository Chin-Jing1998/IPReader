// smoke.mjs —— MCP 服务端到端冒烟
//
// 以真实的 MCP 客户端经 stdio 起子进程连接被测服务，逐项断言协议与十三个工具的行为，
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

// ============ 输出体量防回归（阶段5.13b） ============
//
// 宿主（Claude Code v2.1.247 实测）只把 structuredContent 的 JSON 交给模型，
// content[0].text 被丢弃；默认硬上限 25 000 token，免检快速路径的边界是其一半 12 500。
// 服务侧安全阈值取 12 000（推导见 src/tools.mjs 头注），本节对每个工具的最大输出形态
// 逐一实调并断言不超阈——这是防止「输出治理被后续改动悄悄退回」的回归闸。
const SAFE_TOKENS = 12000;
/**
 * batch_read 的最坏形态入参：全库 own 正文最长的 20 个节点（20894–5921 字）。
 * 取固定清单而非运行时挑选，使该项断言的输入在数据未变时逐次可复现；
 * 上游语料重排后这些 id 若失效，batch_read 会把它们计入 notFound，届时断言仍成立
 * 但失去「最坏形态」的意义——故此处另设一条清单在位性断言把关。
 */
const BATCH_IDS = [
  'padm-05-01-01', 'chem-02-03-03', 'padm-05-01-02', 'tmeg-07', 'chem-01-04-06',
  '02-09-06-02', '06-02-06-03', 'padm-06', 'padm-05-01-03', 'padm-05-02-02',
  'mech-02-03-05', 'padm-04-01-02', 'mech-02-02', 'padm-02-02-02', 'padm-04-02-01',
  'chem-01-03-01', 'padm-05-02-01', 'oa-02-07', 'padm-02-02-03', 'padm-05-02-03',
];
/**
 * token 估算：CJK 与全角区一字一 token，其余四字符一 token。
 * 与 src/tools.mjs 的 estimateTokens 同口径，但此处独立实现而非 import——
 * 冒烟默认测的是 dist 产物，用被测方自己的估算器当判据等于自证，必须另立一把尺。
 */
function estTokens(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  return Math.round(cjk + (s.length - cjk) / 4);
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
  // 阶段5.13b：7 → 13。新增 list_articles / compare_articles / batch_read /
  //   filter_books / find_citing_sections / get_brief 六项，原七项名称与语义不变。
  const expected = [
    'batch_read', 'browse_toc', 'compare_articles', 'filter_books', 'find_citing_sections',
    'find_law', 'get_brief', 'list_articles', 'list_books', 'lookup_term', 'read_node',
    'related_nodes', 'search_kb',
  ];
  ok('工具清单为十三项', names.length === 13 && expected.every((n) => names.includes(n)), names.join('、'));
  ok('每个工具都有描述与入参 schema', tools.every((t) => t.description && t.inputSchema));
  // 阶段5.13b 协议面补齐：出参契约与行为标注
  const noSchema = tools.filter((t) => !t.outputSchema).map((t) => t.name);
  ok('每个工具都有出参 schema', noSchema.length === 0, noSchema.join('、') || '13/13');
  const badAnno = tools.filter((t) => !t.annotations || t.annotations.readOnlyHint !== true
    || t.annotations.openWorldHint !== false).map((t) => t.name);
  ok('每个工具标注为只读且非开放世界', badAnno.length === 0, badAnno.join('、') || '13/13');
  ok('工具描述为中文说明书体（均不短于 60 字）',
    tools.every((t) => t.description.length >= 60),
    `最短 ${Math.min(...tools.map((t) => t.description.length))} 字`);
  // tools/list 随每一轮请求进入调用方上下文，是固定成本而非单次成本，故一并设闸。
  // 阈值 10000 tok：现值约 8550（13 工具含出参契约），留约 15% 余量给后续描述微调；
  // 再涨就该复核是否又把长枚举写进了入参 schema（76 个域键展开一次即约 550 tok）。
  const listTok = estTokens({ tools });
  ok('工具清单的上下文占用不超 10000 tok', listTok <= 10000, `${listTok} tok / ${JSON.stringify({ tools }).length} B`);

  // 阶段5.13b：MCP 组件版本与应用版本同步为 1.7.0
  const info = client.getServerVersion();
  ok('serverInfo 名称为 ipreader', info && info.name === 'ipreader', info && info.name);
  ok('serverInfo 版本为 1.7.0', info && info.version === '1.7.0', info && info.version);

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
  //   2026-08-30 阶段5.9 波4（施工批次：阶段5.11 波G）：术语索引扩充批全量重建——商标审查审理指南
  //     全量重提取（109 → 895 片）＋著作权/竞争法/品种布图/综合程序四法域 8 部法律法规首次纳入
  //     （384 片），术语 1035 → 1743；文档 6247 不变（本批不改语料切分），7282 → 7990；书目仍恒 88 部。
  //   2026-08-30 阶段5.11 波O（书目归档下线）：12 部低检索价值文献（编号 51/53/63/72/74/75/77/
  //     79/82/87/89/90）语料归档、三处登记表注释摘除，书目 88 → 76；文档 6247 → 5963（−284），
  //     术语 1743 不变（该 12 部零术语引用，施工前实测命中 0），7990 → 7706；
  //     法条正文 2521 → 2409 键（下线书中 5 部有 lawName）。
  ok('七十六部书目全开', books.books.length === 76, books.books.map((b) => b.short).join('、'));
  ok('节点总数 7706', books.totalNodes === 7706, String(books.totalNodes));
  ok('术语 1743 条', books.termCount === 1743, String(books.termCount));
  // 阶段5.13b 输出瘦身：缺省为精简档（治理前恒返回全字段，实测 10 239 tok，占宿主配额 41%）
  ok('缺省为精简档', books.detail === 'brief', books.detail);
  ok('精简档不含长书名与文号', books.books.every((b) => b.title === undefined && b.documentNo === undefined));
  ok('精简档含法域与效力枚举', books.books.every((b) => b.field && b.statusCode), `如 ${books.books[0].field}/${books.books[0].statusCode}`);
  ok('精简档一次给全七十六部（不分页）', books.hasMore === false && books.returned === 76, `returned=${books.returned}`);
  const booksFull = dataOf(await client.callTool({ name: 'list_books', arguments: { detail: 'full' } }), 'list_books');
  ok('full 档补出书目全称与效力著录', booksFull.detail === 'full'
    && booksFull.books.every((b) => typeof b.title === 'string')
    && booksFull.books.some((b) => b.documentNo), booksFull.books[0].title);
  ok('full 档分页并给出续取游标',
    booksFull.hasMore === true && booksFull.nextOffset === booksFull.returned && /offset=/.test(booksFull.hint || ''),
    `本页 ${booksFull.returned}/${booksFull.bookCount} 部，nextOffset=${booksFull.nextOffset}`);
  const booksFull2 = dataOf(await client.callTool({ name: 'list_books', arguments: { detail: 'full', offset: booksFull.nextOffset } }), 'list_books');
  ok('full 档续页接续无重叠',
    booksFull2.offset === booksFull.nextOffset
    && !booksFull2.books.some((b) => booksFull.books.some((x) => x.domain === b.domain)),
    `第 ${booksFull2.offset + 1}–${booksFull2.offset + booksFull2.returned} 部`);
  // 阶段5.13b 数据一致性：books.status 原混入一条 99 字说明文本，现拆为 status/statusCode/statusNote。
  //   全 76 部的完整著录经 filter_books 取（它不带 groups，全量 full 档仍在预算内）。
  const allFull = [];
  let fbOffset = 0;
  let fbPages = 0;
  for (;;) {
    const page = (await client.callTool({ name: 'filter_books', arguments: { detail: 'full', offset: fbOffset } })).structuredContent;
    allFull.push(...page.books);
    fbPages++;
    if (!page.hasMore || fbPages > 5) break;
    fbOffset = page.nextOffset;
  }
  ok('filter_books 翻页可取全七十六部完整著录', allFull.length === 76, `${fbPages} 页共 ${allFull.length} 部`);
  ok('status 已归一为短文本（不超 24 字）',
    allFull.every((b) => (b.status || '').length <= 24),
    `最长 ${Math.max(...allFull.map((b) => (b.status || '').length))} 字（治理前 99 字）`);
  ok('statusCode 取值收敛为三个枚举',
    allFull.every((b) => ['in-force', 'not-yet-effective', 'unknown'].includes(b.statusCode)),
    JSON.stringify(allFull.reduce((a, b) => ({ ...a, [b.statusCode]: (a[b.statusCode] || 0) + 1 }), {})));
  ok('被摘出的效力说明一字不落留存于 statusNote',
    allFull.some((b) => (b.statusNote || '').includes('局令第81号')
      && b.statusNote.length >= 90 && b.status === '现行有效'),
    (allFull.find((b) => b.statusNote) || {}).domain);
  // 2026-08-22 阶段3批②「lawName 登记」：69 部规范授 lawName 后 lawArticles 从 231 键增至 2496 键
  //   （设计方案 PatentReader-2026-设计方案-阶段3法条键跨法域改造 §四「全链路影响预判」）。
  //   2026-08-23 阶段5波A：cppl 缺陷修复后补授 lawName（第 70 域），2496 → 2521 键。
  //   2026-08-30 阶段5.11 波O：12 部下线书中 5 部有 lawName（51 作品自愿登记／53 商标印制管理
  //     办法／63 规范性文件制定管理办法／77 使用文字作品支付报酬／87 规章制定程序规定），
  //     2521 → 2409 键。
  ok('法条正文 2409 条', books.lawArticleCount === 2409, String(books.lawArticleCount));

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

  // 关联法条的文本渲染（2026-08-30 阶段5.11 波H 修复的回归闸）：词条详情的 laws 是
  //   { lawKey, fullCite, nodeId } 对象，旧实现 `l.law || l` 短路到对象本身，文本分支被渲染成
  //   [object Object]（「驰名商标」有 8 条关联法条即连出 8 个）。取词条中关联法条最多者做断言。
  const t3text = (await client.callTool({ name: 'lookup_term', arguments: { term: '驰名商标' } })).content?.[0]?.text || '';
  const t3lawLine = t3text.split('\n').find((s) => s.startsWith('关联法条：')) || '（无关联法条行）';
  ok(
    '关联法条文本可读（无 [object Object]）',
    !t3text.includes('[object Object]') && /^关联法条：.*商标法第/.test(t3lawLine),
    t3lawLine,
  );

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
  ok('缺省列出七十六部书', b1.books.length === 76);
  // 阶段5.13b 输出治理主项：缺省档由「展开两层子树」（实测 40 199 tok，必被宿主截断）
  //   改为书目级摘要（不展开），并给出如何展开的显式指引
  ok('缺省档为书目级摘要', b1.mode === 'summary' && b1.depth === 0, `mode=${b1.mode} depth=${b1.depth}`);
  ok('缺省档不展开任何子树', b1.books.every((b) => b.children === undefined));
  ok('缺省档给出顶层节点数与展开指引',
    b1.books.every((b) => typeof b.topCount === 'number') && /root=/.test(b1.hint || ''),
    `顶层合计 ${b1.books.reduce((a, b) => a + b.topCount, 0)} 节`);
  const b1d = dataOf(await client.callTool({ name: 'browse_toc', arguments: { depth: 1 } }), 'browse_toc');
  ok('显式 depth 才跨书展开', b1d.mode === 'expanded' && b1d.books.some((b) => Array.isArray(b.children)), `mode=${b1d.mode}`);
  const b2 = dataOf(await client.callTool({ name: 'browse_toc', arguments: { root: '02-04', depth: 1 } }), 'browse_toc');
  ok('按节点展开子结构', b2.children.length > 0, `${b2.children.length} 个子节点`);
  ok('depth 生效（不递归下一层）', b2.children.every((c) => c.children === undefined));
  const b3 = dataOf(await client.callTool({ name: 'browse_toc', arguments: { depth: 8 } }), 'browse_toc');
  ok('超深展开被预算截断而非放行', b3.truncated === true && /截断/.test(b3.hint || ''), `hint：${(b3.hint || '').slice(0, 30)}…`);

  const n1 = dataOf(await client.callTool({ name: 'related_nodes', arguments: { id: '02-04-05' } }), 'related_nodes');
  ok('返回分组关联', n1.groups.length > 0, n1.groups.map((g) => `${g.label}(${g.count})`).join('、'));
  const n2 = dataOf(await client.callTool({ name: 'related_nodes', arguments: { id: '02-04-05', types: ['hierarchy'] } }), 'related_nodes');
  ok('types 过滤生效', n2.groups.every((g) => g.type === 'hierarchy'), n2.groups.map((g) => g.type).join('、'));

  // ============ 八、list_articles（阶段5.13b 新增） ============
  console.log('\n八、list_articles');
  const a1 = dataOf(await client.callTool({ name: 'list_articles', arguments: { lawName: '专利法' } }), 'list_articles');
  ok('专利法条文全表 82 条', a1.total === 82 && a1.lawName === '专利法', `${a1.total} 条 / ${a1.lawName}`);
  ok('条目含条号、条旨与节点 id', a1.articles.every((x) => Number.isInteger(x.num) && x.title && x.id), a1.articles[0] && `第${a1.articles[0].num}条 ${a1.articles[0].title}`);
  ok('第22条条旨为新颖性创造性实用性口径',
    /新颖性|创造性|授权条件/.test((a1.articles.find((x) => x.num === 22) || {}).title || ''),
    (a1.articles.find((x) => x.num === 22) || {}).title);
  const a2 = dataOf(await client.callTool({ name: 'list_articles', arguments: { lawName: '细则', from: 20, to: 25 } }), 'list_articles');
  ok('简称解析 + 条号区间生效',
    a2.lawName === '专利法实施细则' && a2.articles.every((x) => x.num >= 20 && x.num <= 25),
    `${a2.lawName} 第 ${a2.articles.map((x) => x.num).join('/')} 条`);
  const a3 = dataOf(await client.callTool({ name: 'list_articles', arguments: { lawName: '这不是一部法' } }), 'list_articles');
  ok('未知法名返回错误而非空表', typeof a3.error === 'string', a3.error);

  // ============ 九、compare_articles（阶段5.13b 新增） ============
  console.log('\n九、compare_articles');
  const cmp1 = dataOf(await client.callTool({ name: 'compare_articles', arguments: { articles: ['专利法第22条', '专利法第23条'] } }), 'compare_articles');
  ok('并列取回两条条文', cmp1.returned === 2 && cmp1.articles.length === 2, cmp1.articles.map((x) => x.article).join('、'));
  ok('第22条正文含新颖性、第23条正文含外观设计',
    /新颖性/.test(cmp1.articles[0].text) && /外观设计/.test(cmp1.articles[1].text),
    `${cmp1.articles[0].text.slice(0, 12)}… / ${cmp1.articles[1].text.slice(0, 12)}…`);
  const cmp2 = dataOf(await client.callTool({ name: 'compare_articles', arguments: { articles: ['专利法第33条', '商标法第30条', '专利法第999条'] } }), 'compare_articles');
  ok('跨法对照成立', cmp2.articles.length === 2
    && cmp2.articles.some((x) => x.article === '专利法第33条')
    && cmp2.articles.some((x) => x.article.startsWith('中华人民共和国商标法第30条') || x.article.endsWith('商标法第30条')),
  cmp2.articles.map((x) => x.article).join('、'));
  ok('取不到的条列入 notFound 并说明原因',
    cmp2.notFound.length === 1 && /无第999条/.test(cmp2.notFound[0].reason),
    JSON.stringify(cmp2.notFound[0]));
  const cmp3 = dataOf(await client.callTool({ name: 'compare_articles', arguments: { articles: ['专利法第22条'], charsPerArticle: 100 } }), 'compare_articles');
  ok('charsPerArticle 生效', cmp3.articles[0].text.length <= 100 && cmp3.articles[0].textTruncated === true, `${cmp3.articles[0].text.length}/${cmp3.articles[0].chars} 字`);

  // ============ 十、batch_read（阶段5.13b 新增） ============
  console.log('\n十、batch_read');
  const br1 = dataOf(await client.callTool({ name: 'batch_read', arguments: { ids: ['02-04-05', 'law-02-01', '不存在的节点'] } }), 'batch_read');
  ok('一次读回两个节点、一个记入 notFound',
    br1.returned === 2 && br1.notFound.length === 1 && br1.notFound[0] === '不存在的节点',
    br1.nodes.map((n) => n.id).join('、'));
  ok('缺省 brief 档出摘要不出全文', br1.mode === 'brief' && br1.nodes.every((n) => n.text.length <= 400));
  ok('每个节点含书目与路径', br1.nodes.every((n) => n.book && n.path), br1.nodes[0].path);
  const br2 = dataOf(await client.callTool({ name: 'batch_read', arguments: { ids: ['02-04-05'], mode: 'own', charsPerNode: 300 } }), 'batch_read');
  ok('own 档出正文且 charsPerNode 生效',
    br2.mode === 'own' && br2.nodes[0].text.length <= 300 && br2.nodes[0].text.length > 0,
    `${br2.nodes[0].text.length}/${br2.nodes[0].chars} 字`);
  // 体量防回归用的固定清单须仍在位，否则该项「最坏形态」名存实亡
  const br3 = dataOf(await client.callTool({ name: 'batch_read', arguments: { ids: BATCH_IDS, mode: 'own', charsPerNode: 200 } }), 'batch_read');
  ok('最坏形态清单二十个 id 全部在位',
    br3.notFound.length === 0 && br3.nodes.every((n) => n.chars >= 5000),
    `最短正文 ${Math.min(...br3.nodes.map((n) => n.chars))} 字`);

  // ============ 十一、filter_books（阶段5.13b 新增） ============
  console.log('\n十一、filter_books');
  const fb1 = dataOf(await client.callTool({ name: 'filter_books', arguments: { field: '专利', docType: 'D4' } }), 'filter_books');
  ok('专利法域的司法解释可筛出', fb1.total > 0 && fb1.books.length === fb1.total && fb1.hasMore === false, `${fb1.total} 部`);
  ok('筛出的书目字段与条件一致', fb1.books.every((b) => b.field === '专利' && b.docType === 'D4'));
  const fb2 = dataOf(await client.callTool({ name: 'filter_books', arguments: { statusCode: 'not-yet-effective' } }), 'filter_books');
  ok('尚未施行的书目为三部', fb2.total === 3, fb2.books.map((b) => b.short).join('、'));
  const fb3 = dataOf(await client.callTool({ name: 'filter_books', arguments: { hasLawName: true } }), 'filter_books');
  ok('有条文级法名者六十五部', fb3.total === 65, `${fb3.total} 部`);
  ok('facets 给出命中集分布', fb3.facets && fb3.facets.field && Object.keys(fb3.facets.field).length > 0, JSON.stringify(fb3.facets.docType));

  // ============ 十二、find_citing_sections（阶段5.13b 新增） ============
  console.log('\n十二、find_citing_sections');
  const fc1 = dataOf(await client.callTool({ name: 'find_citing_sections', arguments: { articles: ['专利法第22条'] } }), 'find_citing_sections');
  ok('专利法第22条被引 70 处', fc1.items[0] && fc1.items[0].citingCount === 70, `${fc1.items[0] && fc1.items[0].citingCount} 处`);
  ok('反查结果跨多部书', fc1.items[0].bookCount > 1, `跨 ${fc1.items[0].bookCount} 部书`);
  ok('每条引用给出节点 id 与路径', fc1.items[0].citing.every((c) => c.id && c.path), fc1.items[0].citing[0].path);
  const fc2 = dataOf(await client.callTool({ name: 'find_citing_sections', arguments: { lawName: '专利法' } }), 'find_citing_sections');
  ok('按法全量反查：82 条中 65 条有被引记录',
    fc2.articleCount === 82 && fc2.citedArticleCount === 65, `${fc2.articleCount}/${fc2.citedArticleCount}`);
  ok('按被引数降序排列', fc2.items.every((it, i) => i === 0 || fc2.items[i - 1].citingCount >= it.citingCount),
    fc2.items.slice(0, 3).map((x) => `${x.article}=${x.citingCount}`).join('、'));
  const fc3 = dataOf(await client.callTool({ name: 'find_citing_sections', arguments: { articles: ['专利法第22条'], books: ['examination-guideline'] } }), 'find_citing_sections');
  ok('books 限定生效（仅审查指南）',
    fc3.items[0].citing.every((c) => c.book === '审查指南') && fc3.items[0].citingCount < 70,
    `${fc3.items[0].citingCount} 处（全库 70 处）`);
  // 域键不做 schema 级枚举校验（入参体量纪律），故无效值须在返回体中显式可见
  const fc4 = dataOf(await client.callTool({ name: 'find_citing_sections', arguments: { articles: ['专利法第22条'], books: ['examination-guideline', '不存在的域'] } }), 'find_citing_sections');
  ok('无效域键被显式回报而非静默忽略',
    (fc4.notes || []).some((n) => n.includes('不存在的域')), (fc4.notes || [])[0]);
  const fc5 = dataOf(await client.callTool({ name: 'find_citing_sections', arguments: { articles: ['专利法第22条'], books: ['全都不存在'] } }), 'find_citing_sections');
  ok('域键全部无效时返回错误而非全库结果', typeof fc5.error === 'string', fc5.error);

  // ============ 十三、get_brief（阶段5.13b 新增） ============
  console.log('\n十三、get_brief');
  const gb1 = dataOf(await client.callTool({ name: 'get_brief', arguments: { ids: ['02-04-05', '02-04-06'] } }), 'get_brief');
  ok('按 id 取摘要', gb1.source === 'ids' && gb1.returned === 2, gb1.items.map((x) => x.id).join('、'));
  ok('摘要非空且不含正文路径字段', gb1.items.every((x) => x.brief && x.path === undefined), `${gb1.items[0].brief.slice(0, 24)}…`);
  const gb2 = dataOf(await client.callTool({ name: 'get_brief', arguments: { root: '02-04', depth: 1 } }), 'get_brief');
  ok('按 root 取后代摘要', gb2.source === 'root' && gb2.returned > 0, `${gb2.returned} 个节点`);
  const gb3 = dataOf(await client.callTool({ name: 'get_brief', arguments: {} }), 'get_brief');
  ok('缺入参返回错误而非空结果', typeof gb3.error === 'string', gb3.error);

  // ============ 十四、输出体量防回归（阶段5.13b） ============
  //
  // 逐工具实调其「最大输出形态」，断言 structuredContent 的估算 token 不超安全阈值。
  // 治理前的对照值写在各行注释里——这些形态当时全部超出宿主 25 000 硬上限或逼近其半数配额。
  console.log('\n十四、输出体量防回归（安全阈值 ' + SAFE_TOKENS + ' tok）');
  const budgetCases = [
    ['browse_toc 缺省', {}, 'browse_toc', 40199],
    ['browse_toc depth=3', { depth: 3 }, 'browse_toc', 125267],
    ['browse_toc depth=8', { depth: 8 }, 'browse_toc', null],
    ['browse_toc groupBy=taxonomy', { groupBy: 'taxonomy' }, 'browse_toc', 43603],
    ['browse_toc 指南 depth=8', { root: 'examination-guideline', depth: 8 }, 'browse_toc', 44583],
    ['browse_toc 商标指南 depth=8', { root: 'trademark-exam-guide-2021', depth: 8 }, 'browse_toc', 45759],
    ['list_books full', { detail: 'full' }, 'list_books', 10239],
    ['search_kb 最坏形态', { query: '说明书', limit: 30, contextChars: 600 }, 'search_kb', 16146],
    ['read_node 最长正文', { id: '02', mode: 'full', limit: 20000 }, 'read_node', 19593],
    ['lookup_term 最坏形态', { term: '近似商标', includeEvidence: true }, 'lookup_term', 8687],
    ['find_law 最坏形态', { article: '专利法第25条', limit: 200 }, 'find_law', 7428],
    ['related_nodes 最坏形态', { id: 'law-02-04', limit: 100 }, 'related_nodes', 13836],
    ['list_articles 最大部', { lawName: '专利法实施细则', limit: 400 }, 'list_articles', null],
    ['compare_articles 10×4000', {
      articles: ['专利法第22条', '专利法第26条', '专利法第2条', '专利法第9条', '专利法第23条',
        '专利法第25条', '专利法第33条', '专利法第45条', '专利法第59条', '专利法第64条'],
      charsPerArticle: 4000, withCitations: true,
    }, 'compare_articles', null],
    ['batch_read 20×4000', { ids: BATCH_IDS, mode: 'own', charsPerNode: 4000 }, 'batch_read', null],
    ['filter_books 全量 full', { detail: 'full' }, 'filter_books', null],
    ['find_citing 专利法 per=60', { lawName: '专利法', citingPerArticle: 60, limit: 200 }, 'find_citing_sections', null],
    ['get_brief 指南 depth=8', { root: 'examination-guideline', depth: 8 }, 'get_brief', null],
  ];
  let maxSeen = 0;
  for (const [label, args, tool, before] of budgetCases) {
    const r = await client.callTool({ name: tool, arguments: args });
    const tok = estTokens(r.structuredContent);
    if (tok > maxSeen) maxSeen = tok;
    ok(`${label} 不超阈`, tok <= SAFE_TOKENS,
      `${tok} tok${before ? `（治理前 ${before}，降 ${Math.round((1 - tok / before) * 100)}%）` : ''}`);
  }
  ok('全部最大形态的峰值仍留有余量', maxSeen <= SAFE_TOKENS, `峰值 ${maxSeen} / 阈值 ${SAFE_TOKENS}`);

  // ============ 十五、Resources ============
  console.log('\n十五、Resources');
  const res = await client.readResource({ uri: 'patentkb://node/02-04-05' });
  ok('节点资源可读', res.contents[0].text.includes('创造性'), res.contents[0].text.slice(0, 40).replace(/\n/g, ' '));

  await client.close();
  await transport.close();

  // ============ 十六、离线护栏 ============
  console.log('\n十六、离线护栏');
  await new Promise((r) => setTimeout(r, 300)); // 等子进程 exit 钩子落盘
  if (existsSync(REPORT)) {
    const rep = JSON.parse(readFileSync(REPORT, 'utf8'));
    ok('外部网络访问次数为 0', rep.externalAttempts === 0, `${rep.externalAttempts} 次${rep.attempts.length ? '：' + rep.attempts.join('；') : ''}`);
    rmSync(REPORT);
  } else {
    ok('离线报告已生成', false, `未找到 ${REPORT}`);
  }

  // ============ 十七、域白名单 ============
  console.log('\n十七、域白名单（IPREADER_MCP_DOMAINS）');
  const { client: c2, transport: tr2 } = await connect({ IPREADER_MCP_DOMAINS: 'patent-law' });
  const d1 = dataOf(await c2.callTool({ name: 'list_books', arguments: {} }), 'list_books');
  ok('仅开放一部书', d1.books.length === 1 && d1.books[0].domain === 'patent-law', d1.books.map((b) => b.short).join('、'));
  ok('其余七十五部标记为已关闭', d1.closedBooks.length === 75, d1.closedBooks.map((b) => b.title).join('、'));
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
