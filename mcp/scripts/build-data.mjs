// build-data.mjs —— MCP 数据包生成器：site/data + site/public/content → dist/kb-data.json.gz
//
// 输入（均为只读，与 quartz 生成器同源）：
//   site/data/nodes.json              5306 节点（87 域文档 4455 + 术语 851）
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
import { resolveDomainTitles } from '../../site/scripts/lib/domains.mjs';
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
//   2026-08-22 入库批次一「04 司法解释」：26 件清洗语料中 25 件入库（法释〔2020〕19 号「修改十八件决定」
//   经裁决剔除，属修正案元文档、内容重复）。文档节点 1193 → 1923（+730），总数 2044 → 2774。
//   2026-08-22 入库批次二「01 法律与行政法规」15 件全部入库：文档节点 1923 → 2786（+863），总数 2774 → 3637。
//   2026-08-22 入库批次三「02 部门规章与规范性文件」25 件全部入库：文档节点 2786 → 3734（+948），总数 3637 → 4585。
//   2026-08-22 入库批次四（收尾）15 件全部入库：文档节点 3734 → 4455（+721），总数 4585 → 5306。
//   至此四批 80 件全量入库收官：7 部原书 + 25 司法解释 + 15 法律法规 + 25 部门规章 + 15 收尾 = 87 域。
//   术语 851 始终不变（词表冻结，四批均不重跑取词）。
//   2026-08-23 阶段5波A（条旨落库）语料清理：cppl 伪「第十三条」删除、tmeg OFFENSIVE 段降级为普通文本，
//   合计减 2 个文档节点。文档节点 4455 → 4453，总数 5306 → 5304；术语 851 仍不变。
//   2026-08-23 阶段5波C（商标术语链路接通）：商标审查审理指南接入种子词表（关键词速查 68 行）与
//   109 片证据片入词表，术语 851 → 1035（+184，新 id term-0983…term-1166）；文档节点 4453 不变，
//   总数 5304 → 5488。
//   2026-08-23 阶段5.1（商标审查审理指南四级树重建）：tmeg 空壳编标题溶解，文档节点 4453 → 4452（−1），
//   总数 5488 → 5487；术语 1035 不变（词表恒定、词 id 不回收）。
//   2026-08-24 阶段5.2（tmeg 深层两级切分 + 质量评价指南入库）：批次 W-1 将 tmeg 正文一级/二级数字编号段
//   升节点，四级树 104 → 813 节点（+709，语义深度上限提至 6 级）；批次 Q-1 将《专利质量评价指南》
//   第 88 部入库 214 节点（books.length 87 → 88，order 91，无 lawName）。两批合计：文档节点
//   4452 → 5375（+923），总数 5487 → 6410；术语 1035 仍不变（词表冻结，本阶段未新增取词）。
//   2026-08-24～2026-08-25 阶段5.3：多批次并行改造（W1 摘除「公布与施行」前置节点、W2 深层解析、
//   W3 书名年份后缀、W4 节点 id 重映射、W5 版式调整、W6 重切分、W8 效力字段接入等），本文件的
//   定版数更新与下方 books[] 效力四字段（effectiveDate/adoptedDate/documentNo/status）接入属
//   批次 W9。各子批次的逐项变更量由各自改动记录承载，此处只记录 MCP 侧消费的定版净值：
//   文档节点 5375 → 6247，总数 6410 → 7282；术语 1035 仍不变（词表冻结，本阶段未新增取词）；
//   书目仍恒 88 部。
//   2026-08-30 阶段5.9 波4（施工批次：阶段5.11 波G）：术语索引扩充批全量重建。《商标审查审理指南》
//   由 109 片旧提取全量重提取为 895 片，另首次纳入著作权法及其实施条例、反不正当竞争法、反垄断法、
//   植物新品种保护条例、集成电路布图设计保护条例、知识产权海关保护条例、知识产权民事诉讼证据规定
//   共 8 部法律法规的 384 片提取，词表 1035 → 1743（入图术语节点同数）。
//   文档节点 6247 不变（本批不改语料切分，只加术语层）；总数 7282 → 7990；书目仍恒 88 部。
//   2026-08-30 阶段5.11 波O（书目归档下线）：12 部低检索价值文献（编号 51/53/63/72/74/
//   75/77/79/82/87/89/90）语料归档至 PatentReader/_archive/，三处登记表同批注释摘除，
//   书目 88 → 76。文档节点 6247 → 5963（−284）；术语 1743 不变（该 12 部零术语引用，
//   波O 施工前已实测：1743 个 term-*.json 的 occurrences 与 laws 对这 12 部命中 0）；
//   总数 7990 → 7706。同批法条键 528 → 512、法条正文索引 2521 → 2409 条
//   （下线书中 5 部有 lawName）、法条引用反向索引 3014 → 2983 条、
//   图谱边 19322 → 19099 条。
//   已知并接受的连带降级：69《商标一般违法判断标准》原有 12 处指向 53《商标印制管理办法》
//   的 lawref 随 53 下线而不再成链（退化为纯文本，非悬空），经用户拍板接受。
const EXPECTED_NODES = 7706;
const EXPECTED_DOC_NODES = 5963;
const EXPECTED_TERM_NODES = 1743;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ============ 一、书目登记：域 → 顶层目录（与 build-quartz-md.mjs:55-63 逐字一致） ============
// 沿革（2026-08-30 阶段5.11 波O · 书目归档下线）：12 部低检索价值文献（order
//   51/53/63/72/74/75/77/79/82/87/89/90）经用户勾选定案下线，书目 88 → 76。摘除形态为
//   **注释保留而非物理删行**，恢复时取消注释即可；本表须与另一处 BOOKS 逐条一致
//   （site/scripts/build-quartz-md.mjs ↔ mcp/scripts/build-data.mjs，P7 惯例，
//   条目数由 mcp/scripts/check-taxonomy.mjs 与 domains.mjs KNOWN_DOMAINS 比对把关）。
//   语料源文件同步归档至 PatentReader/_archive/，恢复方法见该目录 _说明.md。
//   ⚠ 摘条目必须与 rm quartz-kb/content/NN-*/ 同批完成：下方 managedTop 只清理在册
//   BOOKS 的目录，先摘条目而不删目录会留下无人管理的孤儿目录（仍被 quartz 建站）。
const BOOKS = [
  { order: 1, domain: 'patent-law', dir: '1-专利法' },
  { order: 2, domain: 'implementation-rules', dir: '2-专利法实施细则' },
  { order: 3, domain: 'examination-guideline', dir: '3-专利审查指南' },
  { order: 4, domain: 'infringement-guide', dir: '4-侵权判定指南' },
  { order: 5, domain: 'mechanical-drafting-rules', dir: '5-机械撰写规范' },
  { order: 6, domain: 'chemistry-drafting-rules', dir: '6-化学撰写规范' },
  { order: 7, domain: 'oa-response-guide', dir: '7-答复审查意见指南' },
  // ---- 入库批次一「04 司法解释」26 件（2026-08-22）：order/dir 自 10 起连续，避开 0-图谱总览 / 1..7 各书 / 9-关键词索引 ----
  { order: 10, domain: 'plant-variety-interp-2001', dir: '10-植物新品种纠纷解释' },
  { order: 11, domain: 'patent-dispute-rules', dir: '11-专利纠纷案件规定' },
  { order: 12, domain: 'tm-jurisdiction-interp', dir: '12-商标案件管辖解释' },
  { order: 13, domain: 'tm-civil-interp', dir: '13-商标民事纠纷解释' },
  { order: 14, domain: 'copyright-civil-interp', dir: '14-著作权民事纠纷解释' },
  { order: 15, domain: 'plant-variety-rules-1', dir: '15-植物新品种权规定一' },
  { order: 16, domain: 'wellknown-tm-interp', dir: '16-驰名商标保护解释' },
  { order: 17, domain: 'patent-infringe-interp-1', dir: '17-专利侵权解释一' },
  { order: 18, domain: 'tm-amend-jurisdiction-interp', dir: '18-商标法修改管辖解释' },
  { order: 19, domain: 'ip-court-jurisdiction-2014', dir: '19-北上广知产法院管辖' },
  { order: 20, domain: 'patent-infringe-interp-2', dir: '20-专利侵权解释二' },
  { order: 21, domain: 'tm-grant-validity-rules', dir: '21-商标授权确权规定' },
  { order: 22, domain: 'ip-injunction-rules-2018', dir: '22-知产行为保全规定' },
  { order: 23, domain: 'ip-tribunal-rules-2018', dir: '23-知识产权法庭规定' },
  { order: 24, domain: 'tech-investigator-rules-2019', dir: '24-技术调查官规定' },
  { order: 25, domain: 'trade-secret-civil-rules-2020', dir: '25-侵犯商业秘密规定' },
  { order: 26, domain: 'patent-grant-validity-rules-1', dir: '26-专利授权确权规定一' },
  { order: 27, domain: 'ip-evidence-rules-2020', dir: '27-知产民事诉讼证据规定' },
  // 28 号已剔除留空（ip-interps-amendment-2020「修改十八件决定」属修正案元文档，内容重复）；后续编号不重排，以免 7 个域的 slug 连锁变更
  { order: 29, domain: 'plant-variety-rules-2', dir: '29-植物新品种权规定二' },
  { order: 30, domain: 'unfair-competition-interp-2022', dir: '30-反不正当竞争法解释' },
  { order: 31, domain: 'ipc-digest-2022', dir: '31-知产法庭裁判要旨2022' },
  { order: 32, domain: 'antitrust-civil-interp-2024', dir: '32-垄断民事纠纷解释' },
  { order: 33, domain: 'ipc-digest-2023', dir: '33-知产法庭裁判要旨2023' },
  { order: 34, domain: 'ip-criminal-interp-2025', dir: '34-侵犯知产刑事案件解释' },
  { order: 35, domain: 'punitive-damages-interp', dir: '35-惩罚性赔偿解释' },
  // ---- 入库批次二「01 法律与行政法规」15 件（2026-08-22）：order/dir 自 36 起连续（28 号空缺照旧不补） ----
  { order: 36, domain: 'ic-layout-rules-2001', dir: '36-集成电路布图设计细则' },
  { order: 37, domain: 'defense-patent-regulations-2004', dir: '37-国防专利条例' },
  { order: 38, domain: 'network-dissemination-regulations-2013', dir: '38-信息网络传播权条例' },
  { order: 39, domain: 'copyright-law-rules-2013', dir: '39-著作权法实施条例' },
  { order: 40, domain: 'software-protection-regulations-2013', dir: '40-计算机软件保护条例' },
  { order: 41, domain: 'copyright-collective-mgmt-2013', dir: '41-著作权集体管理条例' },
  { order: 42, domain: 'trademark-law-rules-2014', dir: '42-商标法实施条例' },
  { order: 43, domain: 'customs-ip-protection-2018', dir: '43-知识产权海关保护条例' },
  { order: 44, domain: 'patent-agency-regulations-2018', dir: '44-专利代理条例' },
  { order: 45, domain: 'copyright-law-2020', dir: '45-著作权法' },
  { order: 46, domain: 'anti-monopoly-law-2022', dir: '46-反垄断法' },
  { order: 47, domain: 'plant-variety-regulations-2025', dir: '47-植物新品种保护条例' },
  { order: 48, domain: 'anti-unfair-competition-2025', dir: '48-反不正当竞争法' },
  { order: 49, domain: 'trademark-law-2026', dir: '49-商标法' },
  { order: 50, domain: 'ic-layout-regulations-2026', dir: '50-集成电路布图设计条例' },
  // ---- 入库批次三「02 部门规章与规范性文件」25 件（2026-08-22）：order/dir 自 51 起连续 ----
  // 〔波O 下线〕{ order: 51, domain: 'work-registration-1994', dir: '51-作品自愿登记试行办法' },
  { order: 52, domain: 'software-copyright-registration-2002', dir: '52-计算机软件著作权登记办法' },
  // 〔波O 下线〕{ order: 53, domain: 'trademark-printing-2004', dir: '53-商标印制管理办法' },
  { order: 54, domain: 'customs-ip-measures-2009', dir: '54-知识产权海关保护实施办法' },
  { order: 55, domain: 'copyright-penalty-2009', dir: '55-著作权行政处罚实施办法' },
  { order: 56, domain: 'patent-marking-2012', dir: '56-专利标识标注办法' },
  { order: 57, domain: 'compulsory-license-2012', dir: '57-专利实施强制许可办法' },
  { order: 58, domain: 'trademark-review-rules-2014', dir: '58-商标评审规则' },
  { order: 59, domain: 'wellknown-tm-recognition-2014', dir: '59-驰名商标认定和保护规定' },
  { order: 60, domain: 'biomaterial-deposit-2015', dir: '60-生物材料保藏办法' },
  { order: 61, domain: 'patent-enforcement-2015', dir: '61-专利行政执法办法' },
  { order: 62, domain: 'fee-reduction-2016', dir: '62-专利收费减缴办法' },
  // 〔波O 下线〕{ order: 63, domain: 'cnipa-normative-docs-2016', dir: '63-规范性文件制定管理办法' },
  { order: 64, domain: 'patent-agency-admin-2019', dir: '64-专利代理管理办法' },
  { order: 65, domain: 'patent-attorney-exam-2019', dir: '65-专利代理师资格考试办法' },
  { order: 66, domain: 'trademark-filing-conduct-2019', dir: '66-规范商标申请注册行为规定' },
  { order: 67, domain: 'trademark-infringement-standard-2020', dir: '67-商标侵权判断标准' },
  { order: 68, domain: 'major-patent-adjudication-2021', dir: '68-重大专利侵权行政裁决办法' },
  { order: 69, domain: 'trademark-violation-standard-2021', dir: '69-商标一般违法判断标准' },
  { order: 70, domain: 'trademark-agency-supervision-2022', dir: '70-商标代理监督管理规定' },
  { order: 71, domain: 'ip-abuse-competition-2023', dir: '71-禁止滥用知识产权竞争规定' },
  // 〔波O 下线〕{ order: 72, domain: 'fee-adjustment-notice-2024', dir: '72-专利收费调整公告' },
  { order: 73, domain: 'priority-examination-2026', dir: '73-专利优先审查管理办法' },
  // 〔波O 下线〕{ order: 74, domain: 'patent-payment-guide-2026', dir: '74-专利缴费操作指引' },
  // 〔波O 下线〕{ order: 75, domain: 'patent-ic-fee-manual-2026', dir: '75-专利和集成电路缴费服务指南' },
  // ---- 入库批次四（收尾）15 件（2026-08-22）：order/dir 76–90，全量入库收官 ----
  { order: 76, domain: 'copyright-pledge-registration-2011', dir: '76-著作权质权登记办法' },
  // 〔波O 下线〕{ order: 77, domain: 'text-work-remuneration-2014', dir: '77-使用文字作品支付报酬办法' },
  { order: 78, domain: 'patent-adjudication-manual-2019', dir: '78-专利侵权纠纷行政裁决办案指南' },
  // 〔波O 下线〕{ order: 79, domain: 'ip-power-outline-2021', dir: '79-知识产权强国建设纲要' },
  { order: 80, domain: 'trademark-exam-guide-2021', dir: '80-商标审查审理指南' },
  { order: 81, domain: 'patent-filing-conduct-2023', dir: '81-规范申请专利行为的规定' },
  // 〔波O 下线〕{ order: 82, domain: 'exam-guideline-decree-2023', dir: '82-专利审查指南发布令' },
  { order: 83, domain: 'collective-cert-trademark-2023', dir: '83-集体商标证明商标注册管理规定' },
  { order: 84, domain: 'gi-product-protection-2023', dir: '84-地理标志产品保护办法' },
  { order: 85, domain: 'patent-adjudication-mediation-2024', dir: '85-专利纠纷行政裁决和调解办法' },
  { order: 86, domain: 'admin-reconsideration-2024', dir: '86-国家知识产权局行政复议规程' },
  // 〔波O 下线〕{ order: 87, domain: 'rulemaking-procedure-2024', dir: '87-国家知识产权局规章制定程序规定' },
  { order: 88, domain: 'ipc-digest-2024', dir: '88-知产法庭裁判要旨2024' },
  // 〔波O 下线〕{ order: 89, domain: 'ip-plan-15th-2026', dir: '89-知识产权保护和运用十五五规划' },
  // 〔波O 下线〕{ order: 90, domain: 'gb-standards-index', dir: '90-GB国家标准清单' },
  // ---- 入库批次五（召回）1 件（2026-08-24 阶段5.2 批次 Q-1）：order 91 顺延，避开既有 8/9 与 28 号空洞语义 ----
  { order: 91, domain: 'quality-evaluation', dir: '91-专利质量评价指南' },
];
const BOOK_BY_DOMAIN = new Map(BOOKS.map((b) => [b.domain, b]));

// ============ 二、载入 ============
const nodes = readJson(join(DATA_DIR, 'nodes.json'));
const edges = readJson(join(DATA_DIR, 'edges.json'));
const bodies = readJson(join(DATA_DIR, 'node-bodies.json'));
const laws = readJson(join(DATA_DIR, 'laws.json'));
const lawCitations = readJson(join(DATA_DIR, 'law-citations.json'));
// DOMAIN_META 改由 resolveDomainTitles 构造（阶段5.3 批次 W3），与 site/scripts/build-quartz-md.mjs
//   同源同式（同一份 data/book-meta.json、同一函数、均用默认第二参 KNOWN_DOMAINS）：
//   本文件下游消费的 meta.title（书目清单 books[].title、lawArticles 报错文案等）与
//   quartz 侧页面 frontmatter 标题、nodes.json 的 breadcrumb[0] 三处的书名文本恒等。
//   meta.lawName / meta.lawAlias / meta.short / meta.field / meta.docType 等字段
//   逐字未变（resolveDomainTitles 只新增 officialTitle 并可能改写 title），故本文件下方
//   的 lawName 全局唯一性断言、条号序列自洽校验等逻辑不受影响。
const bookMeta = readJson(join(DATA_DIR, 'book-meta.json'));
const DOMAIN_META = new Map(resolveDomainTitles(bookMeta).map((d) => [d.key, d]));

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
// laws.json 只登记「被引用过」的条，而 69 部规范实际有 2496 条正文节点；
// find_law 须能直达任一条，故在此按 num 字段（中文条号）为全部条文节点建映射。
//
// 选取判据不看节点层级——层级由标题嵌套深度推导，与法律文本的编排方式绑定：
// 「章→条」的条落在 section（商标法），「章→节→条」落在 subsection（著作权法后半），
// 扁平无章的落在 chapter（司法解释）。以 level==='section' 为判据会漏掉 25 个域、570 条。
// 改以「该域条号集合构成 1..N 连续无重复序列」为判据：既覆盖全部编排形态，
// 又能自动排除解读性文本（商标审查审理指南按商标法条文分节，条号重复 17、缺号 59）。

// —— 先做 lawName 全局唯一性断言：键的无冲突性由此性质保证，不靠命名空间前缀 ——
{
  const seen = new Map();
  for (const [key, meta] of DOMAIN_META) {
    if (!meta.lawName) continue;
    if (seen.has(meta.lawName)) {
      throw new Error(`lawName 重复：「${meta.lawName}」← ${seen.get(meta.lawName)} 与 ${key}`);
    }
    seen.set(meta.lawName, key);
  }
}

// —— 逐域收集条号，校验自洽后再入索引 ——
const artByDomain = new Map(); // domain → Map<条号, nodeId>
for (const n of nodes) {
  const meta = DOMAIN_META.get(n.domain);
  if (!meta || !meta.lawName || !n.num) continue;
  const m = String(n.num).match(/^第([一二三四五六七八九十百零]+)条$/);
  if (!m) continue;
  const num = cn2num(m[1]);
  if (!Number.isFinite(num)) continue;
  if (!artByDomain.has(n.domain)) artByDomain.set(n.domain, new Map());
  const bucket = artByDomain.get(n.domain);
  if (bucket.has(num)) {
    throw new Error(`条号重复：${meta.lawName}第${num}条 ← ${bucket.get(num)} 与 ${n.id}`
      + `（该域条号序列不自洽，不应设 lawName；若为语料瑕疵请先修语料）`);
  }
  bucket.set(num, n.id);
}

const lawArticles = {};
for (const [domain, bucket] of artByDomain) {
  const meta = DOMAIN_META.get(domain);
  const nums = [...bucket.keys()].sort((a, b) => a - b);
  const max = nums[nums.length - 1];
  if (nums.length !== max) {
    const missing = [];
    for (let i = 1; i <= max; i++) if (!bucket.has(i)) missing.push(i);
    throw new Error(`${meta.lawName}（${domain}）条号序列不连续：共 ${nums.length} 条但最大条号 ${max}，`
      + `缺 ${missing.length} 个（首 ${missing.slice(0, 5).join('、')}）——该域疑为解读他法条文的文本，不应设 lawName`);
  }
  for (const [num, id] of bucket) lawArticles[`${meta.lawName}第${num}条`] = id;
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
  // bookMeta（data/book-meta.json）按域 key 直接索引，与 DOMAIN_META 是两份不同源数据：
  // 前者是 resolveDomainTitles 的产物（书名/法名等，供跨域路由与呈现），后者是 W8-effectivity
  // 批次沉淀的沿革原始值，二者字段不重叠，此处按域各自取值、互不影响。
  const bm = bookMeta[b.domain] || {};
  const own = nodes.filter((n) => n.domain === b.domain);
  const chars = own.reduce((a, n) => a + ((bodies[n.id] && bodies[n.id].ownText) || '').length, 0);
  return {
    domain: b.domain,
    order: b.order,
    title: meta ? meta.title : b.domain,
    short: meta ? meta.short : b.domain,
    lawName: meta && meta.lawName ? meta.lawName : undefined,
    // lawAlias 为 domains.mjs 侧的显式法名别名（如 copyright-civil-interp 的「著作权解释」），
    // 阶段 3 批③在 search.mjs 的 lawRegistry 已写好消费逻辑（b.lawAlias || b.short），
    // 但本文件此前未透传该字段，实测恒回落 short——此处补齐透传，消除该缺口。
    lawAlias: meta && meta.lawAlias ? meta.lawAlias : undefined,
    // country/field/docType 为阶段5 波C 新增的分组元数据（domains.mjs 单一事实源），
    // 与 lawAlias 同法透传：87 域现均已赋值，此处仍按 meta 存在性兜底，风格与上两行一致。
    country: meta ? meta.country : undefined,
    field: meta ? meta.field : undefined,
    docType: meta ? meta.docType : undefined,
    // 效力四字段（阶段5.3 批次 W9 新增）：原始值逐字取自 book-meta.json，空串照传而非省略——
    // 该字段的「空」本身是有信息量的状态（考证未及/不适用等），与 lawName 等字段用 undefined
    // 表示「本无此概念」的省略语义不同，故不比照 country/field/docType 的存在性兜底写法。
    // 不透传 promulgationText：正文体量大（数百至数千字），调用方需要时应走 read_node 按需读取，
    // 不应塞进书目清单这种一次性拉取全量的轻量结构。
    effectiveDate: bm.effectiveDate || '',
    adoptedDate: bm.adoptedDate || '',
    documentNo: bm.documentNo || '',
    status: bm.status || '',
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
