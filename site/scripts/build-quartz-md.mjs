// build-quartz-md.mjs —— IPReader 数据层 → quartz 内容站 markdown 生成器（Q2 阶段）
//
// 输入（均为只读）：
//   data/nodes.json        5306 节点（87 域文档 4455 + 术语 851）
//   data/edges.json        仅取 hierarchy 边构建父子链
//   data/node-bodies.json  每节点 ownText 净文本（正文唯一来源，避免父子子树重复）
//   public/content/{id}.json        章节详情（related[] 预解析出链、examples）
//   public/content/term-XXXX.json   词条详情（definition/occurrences/laws/relatedTerms）
//
// 输出：../../quartz-kb/content/ 下的全部 markdown（幂等：先清空生成器管理的目录再重建）
//
// 与 quartz 侧已就位约定的对应关系（不得改 quartz-kb 的 quartz/ 源码与配置）：
//   1. 顶层书目录带数字前缀 1-~7-，术语区固定 9-关键词索引/（Explorer 排序与 Graph 域色板依赖）。
//   2. 叶子文件名（slug 末段）= 节点 id，wikilink 用 [[id|显示名]]（markdownLinkResolution:
//      shortest 按唯一文件名解析——已核对 quartz/util/path.ts transformLink 的实现）。
//   3. part/chapter 级容器 = 目录 + index.md：ContentPage 跳过 */index（contentPage.tsx:87），
//      由 FolderPage 用 index.md 内容渲染并在正文下自动附子文件列表；指向容器的链接
//      统一用全路径形式 [[<路径>/index|显示名]]（shortest 匹配不到 index 末段时回退为根绝对路径，
//      恰好落到 FolderPage 的产物上，Graph/Backlinks 均按 simplifySlug 归一、不受影响）。
//   4. Explorer sortFn 已冻结（文件夹在前 → slug 首数字 → displayName localeCompare(zh-CN, numeric)）：
//      目录名用"局部序号-名称"；同章内文件名首数字恒并列，故靠 title 决胜——
//      审查指南节/小节 title 前置 num（"3.1 xxx"），法条条号中文转阿拉伯（"第26条 · xxx"），
//      侵权判定"（一）"转"（1）"；机械/化学/答复的 label 自带阿拉伯序号，原样即可。
//
// 用法：node scripts/build-quartz-md.mjs
import { readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { DOC_TYPES, resolveDomainTitles } from './lib/domains.mjs';
import { extractCitations } from './lib/law-cite.mjs';
import { efficacySection } from './lib/book-efficacy.mjs';
import { buildTermMatcher, linkTerms } from './lib/term-link.mjs';
import { TOPIC_NAME, termGroupOf } from './lib/topics.mjs';
import { cn2num } from './lib/cn-num.mjs';
import { normalizeProse, splitTableSegments, renderTableBlock } from './lib/rich-text.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(SCRIPT_DIR, '..');
const DATA_DIR = join(SITE_DIR, 'data');
const CONTENT_JSON_DIR = join(SITE_DIR, 'public', 'content');
const OUT_DIR = join(SCRIPT_DIR, '..', '..', 'quartz-kb', 'content');
// 原文附图资产（import-book-images.mjs 从桌面源导入，git 跟踪）：
// 正文 ![](images/x) 引用改写为 content 根相对路径并随生成落盘到 content/<书目录>/images/
const ASSETS_IMG_DIR = join(SITE_DIR, 'assets', 'book-images');
// 2026-08-24 阶段5.2 批次 W-R：批次 Q-1 入库的《专利质量评价指南》补导附图 13 张
// （其语料原引用写作 ![](文件名) 无 images/ 前缀，已在语料层规范化为与其余三域同构），
// 附图总数 88 → 101。属 W-5 定版数批次的漏更新项，经主会话裁决补记。
const EXPECTED_EMBEDDED_IMAGES = 101; // 四书正文实际引用的附图总数（manifest 定版）
// PDF 抽取正文的富文本定版数（详见第七节 contentBlocks 与 lib/rich-text.mjs）：
//   内嵌 HTML 表格全库 48 张（2026-08-22 入库批次四后）——29 转 GFM 管道表格、19 回退 raw HTML：
//     《专利侵权纠纷行政裁决办案指南》30 张（批次四，办案文书空白表单）：20 转 GFM
//       （表 1-8、14-18、21-24、26、28、29），10 回退 raw（表 9-13、19、20、25、27、30），
//       回退原因全为合并单元格——colspan=2 ×5、colspan=3 ×2、colspan=4 ×1、colspan=5 ×1、rowspan=2 ×1；
//     以下为批次三及以前既有 18 张：
//     《化学撰写规范》8 张：7 转 GFM，1 张（chem-02-03-03 表1，rowspan/colspan 合并表头）回退 raw；
//     《专利和集成电路布图设计缴费服务指南》10 张（单行 HTML，TABLE_BLOCK_RE 的 [\s\S]*? 正常命中）：
//       2 转 GFM（表4 恢复权利请求费、表10 费用标准），8 回退 raw，回退原因均为合并单元格——
//       colspan=6 ×1、colspan=3 ×1、rowspan=2 ×2、rowspan=3 ×3、rowspan=4 ×1。
//   行内 LaTeX 公式实测 125 处（ownText）在正文链路完成降解，取 120 为下限留余量。
const EXPECTED_GFM_TABLES = 29;
const EXPECTED_RAW_TABLES = 19;
const EXPECTED_MATH_MIN = 120;
const imagesToEmit = new Map(); // content 相对路径 → 资产绝对路径

// ============ 一、书目登记：域 → 顶层目录（顺序 = 法律层级） ============
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
  { order: 51, domain: 'work-registration-1994', dir: '51-作品自愿登记试行办法' },
  { order: 52, domain: 'software-copyright-registration-2002', dir: '52-计算机软件著作权登记办法' },
  { order: 53, domain: 'trademark-printing-2004', dir: '53-商标印制管理办法' },
  { order: 54, domain: 'customs-ip-measures-2009', dir: '54-知识产权海关保护实施办法' },
  { order: 55, domain: 'copyright-penalty-2009', dir: '55-著作权行政处罚实施办法' },
  { order: 56, domain: 'patent-marking-2012', dir: '56-专利标识标注办法' },
  { order: 57, domain: 'compulsory-license-2012', dir: '57-专利实施强制许可办法' },
  { order: 58, domain: 'trademark-review-rules-2014', dir: '58-商标评审规则' },
  { order: 59, domain: 'wellknown-tm-recognition-2014', dir: '59-驰名商标认定和保护规定' },
  { order: 60, domain: 'biomaterial-deposit-2015', dir: '60-生物材料保藏办法' },
  { order: 61, domain: 'patent-enforcement-2015', dir: '61-专利行政执法办法' },
  { order: 62, domain: 'fee-reduction-2016', dir: '62-专利收费减缴办法' },
  { order: 63, domain: 'cnipa-normative-docs-2016', dir: '63-规范性文件制定管理办法' },
  { order: 64, domain: 'patent-agency-admin-2019', dir: '64-专利代理管理办法' },
  { order: 65, domain: 'patent-attorney-exam-2019', dir: '65-专利代理师资格考试办法' },
  { order: 66, domain: 'trademark-filing-conduct-2019', dir: '66-规范商标申请注册行为规定' },
  { order: 67, domain: 'trademark-infringement-standard-2020', dir: '67-商标侵权判断标准' },
  { order: 68, domain: 'major-patent-adjudication-2021', dir: '68-重大专利侵权行政裁决办法' },
  { order: 69, domain: 'trademark-violation-standard-2021', dir: '69-商标一般违法判断标准' },
  { order: 70, domain: 'trademark-agency-supervision-2022', dir: '70-商标代理监督管理规定' },
  { order: 71, domain: 'ip-abuse-competition-2023', dir: '71-禁止滥用知识产权竞争规定' },
  { order: 72, domain: 'fee-adjustment-notice-2024', dir: '72-专利收费调整公告' },
  { order: 73, domain: 'priority-examination-2026', dir: '73-专利优先审查管理办法' },
  { order: 74, domain: 'patent-payment-guide-2026', dir: '74-专利缴费操作指引' },
  { order: 75, domain: 'patent-ic-fee-manual-2026', dir: '75-专利和集成电路缴费服务指南' },
  // ---- 入库批次四（收尾）15 件（2026-08-22）：order/dir 76–90，全量入库收官 ----
  { order: 76, domain: 'copyright-pledge-registration-2011', dir: '76-著作权质权登记办法' },
  { order: 77, domain: 'text-work-remuneration-2014', dir: '77-使用文字作品支付报酬办法' },
  { order: 78, domain: 'patent-adjudication-manual-2019', dir: '78-专利侵权纠纷行政裁决办案指南' },
  { order: 79, domain: 'ip-power-outline-2021', dir: '79-知识产权强国建设纲要' },
  { order: 80, domain: 'trademark-exam-guide-2021', dir: '80-商标审查审理指南' },
  { order: 81, domain: 'patent-filing-conduct-2023', dir: '81-规范申请专利行为的规定' },
  { order: 82, domain: 'exam-guideline-decree-2023', dir: '82-专利审查指南发布令' },
  { order: 83, domain: 'collective-cert-trademark-2023', dir: '83-集体商标证明商标注册管理规定' },
  { order: 84, domain: 'gi-product-protection-2023', dir: '84-地理标志产品保护办法' },
  { order: 85, domain: 'patent-adjudication-mediation-2024', dir: '85-专利纠纷行政裁决和调解办法' },
  { order: 86, domain: 'admin-reconsideration-2024', dir: '86-国家知识产权局行政复议规程' },
  { order: 87, domain: 'rulemaking-procedure-2024', dir: '87-国家知识产权局规章制定程序规定' },
  { order: 88, domain: 'ipc-digest-2024', dir: '88-知产法庭裁判要旨2024' },
  { order: 89, domain: 'ip-plan-15th-2026', dir: '89-知识产权保护和运用十五五规划' },
  { order: 90, domain: 'gb-standards-index', dir: '90-GB国家标准清单' },
  // ---- 入库批次五（召回）1 件（2026-08-24 阶段5.2 批次 Q-1）：order 91 顺延，避开既有 8/9 与 28 号空洞语义 ----
  { order: 91, domain: 'quality-evaluation', dir: '91-专利质量评价指南' },
];
const TERM_ROOT = '9-关键词索引';
const BOOK_BY_DOMAIN = new Map(BOOKS.map((b) => [b.domain, b]));

// ============ 二、载入数据 ============
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const nodes = readJson(join(DATA_DIR, 'nodes.json'));
const edges = readJson(join(DATA_DIR, 'edges.json'));
const bodies = readJson(join(DATA_DIR, 'node-bodies.json'));
// DOMAIN_META 改由 resolveDomainTitles 构造（阶段5.3 批次 W3）：与 parse-domains.mjs 生成
//   nodes.json 时 breadcrumb[0] 的派生方式同源（同一份 data/book-meta.json、同一函数），
//   故本文件后续消费 meta.title 之处（breadcrumbLine 的书名链接、词条页出处的 crumbs 过滤
//   `c !== meta.title`、frontmatter title 等）与 nodes.json 里的 breadcrumb[0] 文本恒等，
//   crumbs 过滤逻辑不会因两侧派生不同步而失效。KNOWN_DOMAINS 本身字面量不变，
//   resolveDomainTitles 默认第二参即为 KNOWN_DOMAINS，此处沿用默认、只传 bookMeta。
const bookMeta = readJson(join(DATA_DIR, 'book-meta.json'));
const DOMAIN_META = new Map(resolveDomainTitles(bookMeta).map((d) => [d.key, d]));

const byId = new Map(nodes.map((n) => [n.id, n]));
const parentOf = new Map();
const childrenOf = new Map();
for (const e of edges) {
  if (e.type !== 'hierarchy') continue;
  parentOf.set(e.target, e.source);
  if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
  childrenOf.get(e.source).push(e.target);
}
// 子节点按 id 自然序（零填充 id 与 law-xx-yy 均可按数字分段比较）
const idCompare = (a, b) => a.localeCompare(b, 'en', { numeric: true });
for (const arr of childrenOf.values()) arr.sort(idCompare);

const ownTextOf = (id) => ((bodies[id] && bodies[id].ownText) || '').trim();

// ============ 三、命名与标题规则 ============
// 目录/文件名净化：去掉文件系统与 quartz sluggify 敏感字符（空格、/\:*?"<>|#%& 等），
// 保留中文标点（、·（）—），截断到 40 字符，保证磁盘名 === slug（sluggify 不再改写）。
function sanitizeName(s) {
  return s
    .replace(/[\s/\\:*?"<>|#%&{}$!'@+`=;,.]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || '未命名';
}

// 中文条号 → 阿拉伯：仅转换 label 开头的"第X条/（X）"，用于 Explorer 内文件按文档序排列
function arabicizeLabel(label, domain) {
  if (domain === 'patent-law' || domain === 'implementation-rules') {
    const m = label.match(/^第([一二三四五六七八九十百零]+)条(之[一二三四五六七八九十]+)?/);
    if (m) {
      const n = cn2num(m[1]);
      if (Number.isFinite(n)) return `第${n}条${m[2] || ''}` + label.slice(m[0].length);
    }
  }
  if (domain === 'infringement-guide') {
    const m = label.match(/^（([一二三四五六七八九十]+)）/);
    if (m) {
      const n = cn2num(m[1]);
      if (Number.isFinite(n)) return `（${n}）` + label.slice(m[0].length);
    }
  }
  return label;
}

// 页面标题：在 label 基础上做最小改写，保证同目录内 title 的 numeric localeCompare = 文档序
function titleOf(node) {
  const { domain, level, label, num } = node;
  if (level === 'term') return label;
  if (level === 'part' || level === 'chapter') return label; // 目录级靠目录名排序，title 保持原 label
  if (domain === 'examination-guideline') return num ? `${num} ${label}` : label;
  return arabicizeLabel(label, domain);
}

// 目录级容器的目录名：局部序号 + 去掉编号前缀后的 label
function folderDirName(node) {
  const ordinal = node.level === 'part' ? node.partNum : node.chapterNum;
  let name = node.label
    .replace(/^第[一二三四五六七八九十百零]+[章节部分]\s*/, '')
    .replace(/^[一二三四五六七八九十]+、\s*/, '');
  return `${ordinal}-${sanitizeName(name)}`;
}

// ============ 四、节点 → 输出路径规划 ============
// folder 节点（part/chapter 一律成目录，childless 章亦然，避免书目录下文件/目录混排乱序）
const isFolderNode = (n) => n.level === 'part' || n.level === 'chapter';

// nodePath：id → { kind:'folder', dirPath } | { kind:'file', filePath }（相对 content/ 根）
const nodePath = new Map();
for (const n of nodes) {
  if (n.level === 'term') continue;
  const book = BOOK_BY_DOMAIN.get(n.domain);
  if (!book) throw new Error(`未知域：${n.domain}`);
  // 祖先目录链：自根向下（book → [part] → [chapter]）
  const chain = [];
  let cur = n.id;
  while (parentOf.has(cur)) {
    cur = parentOf.get(cur);
    chain.unshift(byId.get(cur));
  }
  const dirs = [book.dir, ...chain.filter(isFolderNode).map(folderDirName)];
  if (isFolderNode(n)) {
    nodePath.set(n.id, { kind: 'folder', dirPath: [...dirs, folderDirName(n)].join('/') });
  } else {
    nodePath.set(n.id, { kind: 'file', filePath: `${dirs.join('/')}/${n.id}.md` });
  }
}

// 术语：9-关键词索引/<NN-主题分组>/term-XXXX.md
//   编号取 lib/topics.mjs::TERM_TOPIC_GROUPS 的组序（2026-08-12 起：36 细粒度主题归并为 19 组），
//   无 topicKey 或未收编者进 99-综合。细粒度 topicKey 本身不变，仅目录呈现按分组收口。
function topicDirName(topicKey) {
  const g = termGroupOf(topicKey);
  if (g) return `${String(g.no).padStart(2, '0')}-${sanitizeName(g.name.replace(/\//g, '与'))}`;
  return '99-综合';
}
for (const n of nodes) {
  if (n.level !== 'term') continue;
  nodePath.set(n.id, { kind: 'file', filePath: `${TERM_ROOT}/${topicDirName(n.topicKey)}/${n.id}.md` });
}

// 路径冲突自检
{
  const seen = new Map();
  for (const [id, p] of nodePath) {
    const key = p.kind === 'file' ? p.filePath : p.dirPath + '/index.md';
    if (seen.has(key)) throw new Error(`路径冲突：${key} ← ${id} 与 ${seen.get(key)}`);
    seen.set(key, id);
  }
}

// ============ 五、wikilink 助手（所有出链统一经此，供死链自校验） ============
const stats = { wikilinks: 0, lawLinks: 0, termLinks: 0, pages: {}, chars: 0, aliasSkipDup: 0, aliasSkipBad: 0 };
function addPage(type) { stats.pages[type] = (stats.pages[type] || 0) + 1; }

// 富文本归一化计数器（lib/rich-text.mjs 的 sink）：公式降解成败、表格转换路线，供末尾断言与汇报
const richStats = { converted: 0, kept: 0, keptList: [], gfmTables: 0, rawTables: 0, rawTableReasons: [] };

// 清洗 wikilink 显示文本（| 与 ]] 会破坏语法）
const cleanDisplay = (s) => String(s).replace(/[|[\]]/g, '').replace(/\n/g, ' ').trim();

function linkTo(id, display) {
  const p = nodePath.get(id);
  if (!p) throw new Error(`wikilink 目标不存在：${id}`);
  stats.wikilinks++;
  const text = cleanDisplay(display ?? (byId.has(id) ? titleOf(byId.get(id)) : id));
  if (p.kind === 'folder') return `[[${p.dirPath}/index|${text}]]`;
  return `[[${id}|${text}]]`;
}
// 链接到书根/术语根等"非节点目录"的 index 页
function linkToDir(dirPath, display) {
  stats.wikilinks++;
  return `[[${dirPath}/index|${cleanDisplay(display)}]]`;
}

// 跨书 wikilink：目标节点与当前节点不同书（domain 不同）时，显示文本前加书名短前缀
//（沿用词条"出处"一节 `${meta.short} · ${path}` 的 short 名与分隔风格），
// 消除"关联"里多个裸「引言」并排无法区分的歧义；同书目标与术语（无书域）保持原显示不变。
function linkToWithBook(id, display, fromDomain) {
  const target = byId.get(id);
  const meta = target ? DOMAIN_META.get(target.domain) : null;
  if (meta && target.domain !== fromDomain) {
    stats.crossBookPrefixed = (stats.crossBookPrefixed || 0) + 1;
    return linkTo(id, `${meta.short} · ${cleanDisplay(display ?? titleOf(target))}`);
  }
  return linkTo(id, display);
}

// ============ 六、别名（aliases）全局查重 ============
// 策略：alias 候选 = 非术语节点的原 label + 术语节点的 aliases[]（术语 title 即 label，不再自指）。
// AliasRedirects 会把 alias 落到站点根部的 <alias>.html，因此必须全站唯一：
//   重名 label（172 组/443 节点）一律全部跳过 alias（不做"层级更深者胜出"的仲裁，保证确定性）；
//   含 / # ? 反斜杠 等路径敏感字符、或与任何页面 title 之外的保留名（index）相同的候选同样跳过。
const aliasCount = new Map();
const aliasCandidates = new Map(); // id → [alias...]
for (const n of nodes) {
  const cands = n.level === 'term' ? (n.aliases || []) : [n.label];
  const kept = [];
  for (const a of cands) {
    const v = String(a).trim();
    if (!v || v === 'index' || /[/\\#?]/.test(v)) { stats.aliasSkipBad++; continue; }
    kept.push(v);
    aliasCount.set(v, (aliasCount.get(v) || 0) + 1);
  }
  aliasCandidates.set(n.id, kept);
}
function aliasesOf(node) {
  const out = [];
  for (const a of aliasCandidates.get(node.id) || []) {
    if (aliasCount.get(a) > 1) { stats.aliasSkipDup++; continue; }
    if (a === titleOf(node)) continue; // 与 title 相同的 alias 无信息量，跳过
    out.push(a);
  }
  return out;
}

// ============ 七、frontmatter / 正文渲染 ============
const yamlStr = (s) => JSON.stringify(String(s)); // 以 JSON 字符串充当 YAML 标量，天然转义
function frontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}: [${v.map(yamlStr).join(', ')}]`);
    } else {
      lines.push(`${k}: ${yamlStr(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

const tagName = (s) => s.replace(/\//g, '-');
function tagsOf(node) {
  if (node.level === 'term') {
    // 词条页标签取主题分组名，与其所在目录（topicDirName）严格同名，避免标签与目录两套口径
    const t = ['关键词索引'];
    const g = termGroupOf(node.topicKey);
    if (g) t.push(tagName(g.name));
    return t;
  }
  // 章节页标签同样收口到主题分组名（与词条页、目录三者同一套口径）：
  //   归组后同组的多个细粒度主题会重名，交由下方 Set 去重（实测 2534 → 2220 个标签）。
  const meta = DOMAIN_META.get(node.domain);
  const t = meta ? [meta.short] : [];
  for (const key of node.topics || []) {
    const g = termGroupOf(key);
    if (g) t.push(tagName(g.name));
  }
  return [...new Set(t)];
}

// 面包屑行：上级：[[书]] › [[part]] › [[chapter]]（当前页自身不入链）
function breadcrumbLine(node) {
  const book = BOOK_BY_DOMAIN.get(node.domain);
  const meta = DOMAIN_META.get(node.domain);
  const parts = [linkToDir(book.dir, meta.title)];
  const chain = [];
  let cur = node.id;
  while (parentOf.has(cur)) {
    cur = parentOf.get(cur);
    chain.unshift(cur);
  }
  for (const aid of chain) parts.push(linkTo(aid, byId.get(aid).label));
  return `上级：${parts.join(' › ')}`;
}

// —— 正文遗留 markdown 链接的清洗 ——
// 上游 ownText 携带两类站内链接语法（共 292 处）：
//   a. ![](images/xxx.png|jpg) —— 88 处附图引用，改写为 content 根相对路径并登记落盘复制
//      （资产在 site/assets/book-images/<domain>/，由 import-book-images.mjs 自桌面源导入）；
//   b. [4.1.3.1](4.1.3.1) —— 指南小节编号引用，按"同章 → 同部 → 全书唯一"就近映射为节点 wikilink，
//      映射不到则退化为纯文本编号（不留死链）。
const numIndex = new Map(); // domain → Map<num, id[]>
for (const n of nodes) {
  if (n.level === 'term' || !n.num) continue;
  const key = String(n.num).replace(/\.+$/, '');
  if (!numIndex.has(n.domain)) numIndex.set(n.domain, new Map());
  const m = numIndex.get(n.domain);
  if (!m.has(key)) m.set(key, []);
  m.get(key).push(n.id);
}
function resolveNumRef(node, numRaw) {
  // 引用编号常深于节点粒度（节点 num 最深两段，如 "4.1"；引用可到 "4.1.3.1"）：
  // 自全编号起逐级去掉末段，映射到"最长存在前缀"的上级小节节点。
  const segsAll = String(numRaw).replace(/\.+$/, '').split('.').filter(Boolean);
  const seg = node.id.split('-');
  const chapterPrefix = seg.slice(0, 2).join('-') + '-';
  const partPrefix = seg[0] + '-';
  for (let len = segsAll.length; len >= 1; len--) {
    const key = segsAll.slice(0, len).join('.');
    const cands = (numIndex.get(node.domain) || new Map()).get(key) || [];
    if (!cands.length) continue;
    const inChapter = cands.filter((id) => id.startsWith(chapterPrefix));
    if (inChapter.length === 1) return inChapter[0];
    const inPart = cands.filter((id) => id.startsWith(partPrefix));
    if (inPart.length === 1) return inPart[0];
    if (cands.length === 1) return cands[0];
  }
  return null;
}
function resolveInlineRefs(text, node) {
  return text
    .replace(/!\[[^\]]*\]\(images\/([^)]+)\)/g, (_, file) => {
      // 附图嵌入：images/<文件名> → <书目录>/images/<文件名>（content 根相对路径，
      // CrawlLinks 按内容根解析），实体随第九节落盘复制；资产缺失即失败（不产占位）
      const book = BOOK_BY_DOMAIN.get(node.domain);
      if (!book) throw new Error(`图片引用所在节点 ${node.id}（域 ${node.domain}）无书目录映射`);
      const srcAbs = join(ASSETS_IMG_DIR, node.domain, file);
      if (!existsSync(srcAbs)) {
        throw new Error(`附图资产缺失：${srcAbs}（节点 ${node.id}；请先运行 scripts/import-book-images.mjs）`);
      }
      const relPath = `${book.dir}/images/${file}`;
      imagesToEmit.set(relPath, srcAbs);
      stats.imgEmbedded = (stats.imgEmbedded || 0) + 1;
      return `![](${relPath})`;
    })
    .replace(/\[([^\]]*)\]\(([0-9.]+)\)/g, (_, label, target) => {
      const id = resolveNumRef(node, target);
      if (id && id !== node.id) {
        stats.numRefLinks = (stats.numRefLinks || 0) + 1;
        return linkTo(id, label);
      }
      stats.numRefPlain = (stats.numRefPlain || 0) + 1;
      return label;
    });
}

// markdown 危险字符最小转义：正文里的 < 会被当成 HTML 起始标签；
// 行内 # 会被 ObsidianFlavoredMarkdown 解析为行内 tag（正文出现"###"等即产生空 tag 死链）。
// 该转义恒为正文处理链的最后一步——排在实体解码与公式降解之后，
// 保证降解结果里的 `<0.01` 一类字符同样被转义为字面量。
const escapeMd = (s) => String(s).replace(/</g, '\\<').replace(/#/g, '\\#');

// 正文段落化 + markdown 危险字符最小转义（正文含 < 或行首 > 的仅个位数节点）
function mdParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split('\n')
        .map((line) => line.replace(/^>/, '\\>'))
        .join('  \n'),
    )
    .map((p) => escapeMd(p))
    .filter((p) => p.trim());
}

// 正文块化（PDF 抽取产物的富文本归一化，实现见 lib/rich-text.mjs）：
//   1. 先切出内嵌 HTML 表格块——规则网格转 GFM 管道表格，含 rowspan/colspan 的
//      合并单元格表回退为不转义的 raw HTML（quartz 的 ofm.ts htmlPlugins 无条件挂载
//      rehype-raw，util/jsx.tsx 的 customComponents.table 会给两种来源的 table 套同一个
//      .table-container 滚动容器，样式与既有表格完全一致）；
//   2. 其余散文段落做 HTML 实体解码 + 行内 LaTeX 降解为 Unicode 纯文本，再按空行分段转义。
// 表格块**不参与**法条/术语的正文内成链：wikilink 语法 [[id|显示名]] 里的竖线
// 会击穿管道表格的列分隔，且表内多为纯数据，成链无阅读收益。
function contentBlocks(text) {
  const blocks = [];
  for (const seg of splitTableSegments(text)) {
    if (seg.kind === 'table') {
      blocks.push({ kind: 'table', text: renderTableBlock(seg.text, richStats).text });
      continue;
    }
    for (const p of mdParagraphs(normalizeProse(seg.text, richStats))) {
      blocks.push({ kind: 'prose', text: p });
    }
  }
  return blocks;
}

// 法条引用就地 wikilink 化：同一条文（lawKey）一段内只链首次出现；
// 仅处理含"第X条"的命中（款/项级续接不单独成链）；范围展开取首条为链接目标。
const lawKeyToNode = new Map();
for (const n of nodes) if (n.lawKey) lawKeyToNode.set(n.lawKey, n.id);

// 法条内链门控（波B，与下方 TERM_LINK_ENABLED 同属"回滚开关"风格）：
//   白名单域（examination-guideline、trademark-exam-guide-2021）放开全法域引用——
//   命中 lawKeyToNode 即链接，不再按法名过滤；非白名单域维持改造前既有行为——
//   仅链专利法系（lawKey 以"专利法"打头，覆盖专利法与专利法实施细则），其余法域
//   命中一律丢弃，确保现网既有的专利法内链不因本次改造而消失、也不因门控而新增。
//   快速降级开关：清空集合＝全站退回仅专利法内链（等同改造前逐字行为）。
const LAW_LINK_DOMAINS = new Set(['examination-guideline', 'trademark-exam-guide-2021']);

// opts.force：显式绕过上述域白名单，按"放开全法域引用"档处理本次调用（阶段5.3 批次 W8 引入）。
//   白名单的语义边界只辖**正文内链化**；书根「效力信息」的公布与施行原文属新增结构化区块，
//   经主会话 D2 裁决单独授权全域法条直达，故由调用方显式传 force、而非把域塞进白名单。
//   计数亦分列（stats.lawLinksPromulgation），不污染白名单域的正文口径统计。
function linkLawCites(para, domain, selfId, { force = false } = {}) {
  const trace = [];
  extractCitations(para, domain, { trace });
  if (!trace.length) return para;
  const allowAllLaws = force || LAW_LINK_DOMAINS.has(domain);
  // 按命中位置聚合（范围展开的多个 lawKey 共享同一 index，取首个作为链接目标）
  const hits = new Map();
  for (const t of trace) if (!hits.has(t.index)) hits.set(t.index, t);
  const linked = new Set();
  // 自右向左替换，保持左侧偏移不失效
  const ordered = [...hits.values()].sort((a, b) => b.index - a.index);
  const applied = [];
  for (const h of ordered) {
    if (!/第.+条/.test(h.raw)) continue; // 款/项级续接命中不成链
    // 非白名单域：仅保留专利法系命中，其余法域直接丢弃；两档均沿用同一套后续替换机制
    if (!allowAllLaws && !h.lawKey.startsWith('专利法')) continue;
    const target = lawKeyToNode.get(h.lawKey);
    if (!target || target === selfId) continue;
    applied.push({ ...h, target });
  }
  // 首次出现去重需按自左向右判定，再自右向左替换
  applied.sort((a, b) => a.index - b.index);
  const chosen = [];
  for (const h of applied) {
    if (linked.has(h.lawKey)) continue;
    linked.add(h.lawKey);
    chosen.push(h);
  }
  chosen.sort((a, b) => b.index - a.index);
  let out = para;
  for (const h of chosen) {
    // 续接命中的 raw 以枚举分隔符开头（、和及以及或者或），分隔符留在链接外
    const sep = (h.raw.match(/^(以及|或者|、|和|及|或)/) || [''])[0];
    const body = h.raw.slice(sep.length);
    out = out.slice(0, h.index) + sep + linkTo(h.target, body) + out.slice(h.index + h.raw.length);
    stats.lawLinks++;
    if (force) stats.lawLinksPromulgation = (stats.lawLinksPromulgation || 0) + 1;
    else if (allowAllLaws) stats.lawLinksWhitelist = (stats.lawLinksWhitelist || 0) + 1;
  }
  return out;
}

// 术语正文内就地 wikilink 化（D5）：页级首链（每页每词只链首次出现，跨段落去重），
// 必须在 linkLawCites 之后执行——法条链接产生的 [[...]] 是 term-link 的扫描禁区，
// 反序则 linkLawCites 基于原始偏移的替换全部错位。
// 排除清单 data/term-link-exclude.json 由行内链接化复核（term-linkaudit 批审）产出：
//   terms[]          不参与行内链接的词条 id（词条页/图谱/既有关联块不受影响）
//   pages[]          整页不做术语链接的节点（如上游切片误挂的索引附录页）
//   aliasAllowlist[] 允许参与匹配的别名白名单（{id, alias}；白名单制——
//     seed tier 别名系 splitVariants 表格硬切残渣，实测大面积误链，天然不进白名单）
const TERM_LINK_ENABLED = true; // 置 false 即整体停用（回滚层 2），产物精确回到停用前指纹
const termExcludePath = join(DATA_DIR, 'term-link-exclude.json');
if (!existsSync(termExcludePath)) {
  throw new Error(`缺少行内链接排除清单：${termExcludePath}（由复核环节产出，不可静默跳过）`);
}
const termExcludeCfg = readJson(termExcludePath);
const TERM_LINK_EXCLUDE = new Set((termExcludeCfg.terms || []).map((t) => t.id));
const TERM_LINK_PAGE_EXCLUDE = new Set((termExcludeCfg.pages || []).map((p) => p.nodeId));
for (const id of TERM_LINK_EXCLUDE) {
  const n = byId.get(id);
  if (!n || n.level !== 'term') throw new Error(`term-link-exclude.json terms 引用了不存在的术语：${id}`);
}
for (const pid of TERM_LINK_PAGE_EXCLUDE) {
  if (!byId.has(pid)) throw new Error(`term-link-exclude.json pages 引用了不存在的节点：${pid}`);
}
// 行内链接口径（按术语层级的可选闸门）：
//   null                 不过滤，全部 982 个术语参与正文成链（当前口径）
//   new Set(['seed'])    仅种子词表 424 个（实测正文行内链接降至约 2806 条，
//                        但正文覆盖的术语从 723 降到 201，其中 134 个词条页
//                        会失去全部正文入链——仅剩关键词索引目录与搜索可达）
//   new Set(['seed','mid'])  折中口径
// 与 term-link-exclude.json 是两个正交维度——后者记录人工逐条复核结论
// （audit: 204 单元 / 191 yes / 13 no），本常量按术语层级做整体收口，二者叠加生效。
// 改动本常量须同步下方的术语链接量断言区间，否则断言会挡下预期内的口径切换。
// 不受影响的三类链接：词条页互链（## 相关术语，由 termrel/termco 边生成）、
// 「关联」区块（结构化 related 字段）、关键词索引总目录——它们不经 termMatcher。
const TERM_LINK_TIERS = null;
const inLinkTier = (n) => TERM_LINK_TIERS === null || TERM_LINK_TIERS.has(n.tier);
const termSurfaceEntries = [];
for (const n of nodes) {
  if (n.level !== 'term') continue;
  if (!inLinkTier(n)) continue;
  termSurfaceEntries.push({ surface: n.label, id: n.id });
}
for (const a of termExcludeCfg.aliasAllowlist || []) {
  const n = byId.get(a.id);
  if (!n || !(n.aliases || []).includes(a.alias)) {
    throw new Error(`term-link-exclude.json aliasAllowlist 无效条目：${a.id} / ${a.alias}`);
  }
  // 别名随其术语本体的 tier 一同进出，杜绝「本体不链、别名却链」的口径撕裂
  if (!inLinkTier(n)) continue;
  termSurfaceEntries.push({ surface: a.alias, id: a.id });
}
const termMatcher = buildTermMatcher(termSurfaceEntries, { exclude: TERM_LINK_EXCLUDE });

// 页尾「引用法条」清单（波B，与下方 relatedSection 同构）：仅白名单域（LAW_LINK_DOMAINS）产出。
// 入参 lawCiteCounts 为该页正文全部块的法条引用累加（Map<lawKey, count>），由调用方在
// 正文块循环内对每块独立现算 extractCitations 后按 lawKey 聚合而成——不复用 linkLawCites
// 内部的 trace，因为该函数只返回替换后的正文字符串，不对外暴露命中明细。
function lawCitesSection(lawCiteCounts, node) {
  if (!lawCiteCounts || !lawCiteCounts.size) return '';
  const rows = [];
  for (const [lawKey, count] of lawCiteCounts) {
    const target = lawKeyToNode.get(lawKey);
    if (!target) { stats.lawCiteUnresolved = (stats.lawCiteUnresolved || 0) + 1; continue; } // 不可解析：仅计入统计，不渲染
    if (target === node.id) continue; // 自引用防御，与 linkLawCites 的 selfId 排除对齐（白名单域节点通常无 lawKey，实测不触发）
    rows.push({ lawKey, count, target });
  }
  if (!rows.length) return '';
  // 排序：出现次数降序；同次数按法名+条号升序（numeric 比较，避免"第10条"字典序排到"第2条"前）
  rows.sort((a, b) => b.count - a.count || a.lawKey.localeCompare(b.lawKey, 'zh-CN', { numeric: true }));
  const lines = ['## 引用法条', ''];
  for (const r of rows) lines.push(`- ${linkTo(r.target, r.lawKey)}（${r.count} 处）`);
  stats.lawCitesSectionEntries = (stats.lawCitesSectionEntries || 0) + rows.length;
  return lines.join('\n');
}

// 关联分组（预解析 related[] 的 reason 全集：上级/下属/法条依据/指南交叉引用/相关/共引同一法条）
// 所有分组统一经 linkToWithBook：跨书目标（实测出现在 法条依据/指南交叉引用/共引同一法条）
// 显示文本加书名短前缀，同书目标与术语目标不受影响。
const RELATED_ORDER = ['上级', '下属', '法条依据', '指南交叉引用', '相关', '共引同一法条'];
function relatedSection(related, node) {
  if (!related || !related.length) return '';
  const groups = new Map();
  for (const r of related) {
    if (!nodePath.has(r.id)) continue; // 容错：目标不存在则跳过
    if (!groups.has(r.reason)) groups.set(r.reason, []);
    groups.get(r.reason).push(r);
  }
  const lines = ['## 关联', ''];
  const keys = [...groups.keys()].sort(
    (a, b) => (RELATED_ORDER.indexOf(a) + 99) - (RELATED_ORDER.indexOf(b) + 99),
  );
  for (const key of keys) {
    const items = groups.get(key).map((r) => linkToWithBook(r.id, r.label, node.domain));
    lines.push(`- **${key}**：${items.join(' · ')}`);
  }
  return lines.length > 2 ? lines.join('\n') : '';
}

function examplesSection(examples, node, ownText) {
  if (!examples || !examples.length) return '';
  // 上游 examples 常为正文原文摘录：与正文重叠（归一化空白后被正文包含）的示例跳过，避免整页复读
  const norm = (s) => String(s).replace(/\s+/g, '');
  const ownNorm = norm(ownText || '');
  const kept = examples.filter((ex) => {
    const t = norm(ex.text || '');
    return t && !(ownNorm && ownNorm.includes(t));
  });
  if (!kept.length) return '';
  const lines = ['## 示例', ''];
  for (const ex of kept) {
    const title = cleanDisplay(ex.title || '示例');
    // 示例文本与正文同源，需做同样的遗留链接清洗、富文本归一化与行内 tag/HTML 转义
    // （示例块以 `> ` 引用形式呈现，管道表格在引用块内无法成立，故此处只做散文归一化；
    //  实测 public/content/*.json 的 examples 不含 <table>，与该取舍相符）
    const text = escapeMd(normalizeProse(resolveInlineRefs(String(ex.text || ''), node), richStats));
    const body = text.split('\n').map((l) => `> ${l}`).join('\n');
    lines.push(`> [!example] ${title}`, body, '');
  }
  return lines.join('\n');
}

// 读取详情 JSON（related/examples）；容器与叶子共用
function detailOf(id) {
  const p = join(CONTENT_JSON_DIR, `${id}.json`);
  if (!existsSync(p)) return { related: [], examples: [] };
  const d = readJson(p);
  return { related: d.related || [], examples: d.examples || [] };
}

// ============ 八、页面装配 ============
const outputs = new Map(); // 相对路径 → 内容

function emit(relPath, content) {
  if (outputs.has(relPath)) throw new Error(`输出重复：${relPath}`);
  outputs.set(relPath, content);
  stats.chars += content.length;
}

// —— 8.1 章节页（ownText 非空）与容器索引页（ownText 空） ——
for (const n of nodes) {
  if (n.level === 'term') continue;
  const p = nodePath.get(n.id);
  const relPath = p.kind === 'folder' ? `${p.dirPath}/index.md` : p.filePath;
  const own = ownTextOf(n.id);
  const { related, examples } = detailOf(n.id);
  const fm = frontmatter({
    title: titleOf(n),
    aliases: aliasesOf(n),
    tags: tagsOf(n),
    lawKey: n.lawKey || null,
  });
  const parts = [fm, '', breadcrumbLine(n), ''];

  if (own) {
    // 章节页：正文（先清洗遗留链接，再做法条引用就地成链，最后术语就地成链）→ 引用法条 → 关联 → 示例
    const skipTermLink = !TERM_LINK_ENABLED || TERM_LINK_PAGE_EXCLUDE.has(n.id);
    const collectLawCites = LAW_LINK_DOMAINS.has(n.domain); // 仅白名单域采集页尾「引用法条」清单数据
    const lawCiteCounts = collectLawCites ? new Map() : null;
    let linkedTerms = new Set();
    for (const blk of contentBlocks(resolveInlineRefs(own, n))) {
      if (blk.kind === 'table') {
        parts.push(blk.text, ''); // 表格块原样落盘：不做转义、不参与成链
        continue;
      }
      const withLaw = linkLawCites(blk.text, n.domain, n.id);
      if (lawCiteCounts) {
        // 页尾清单数据独立现算（不复用 linkLawCites 内部 trace）：以 lawKey 聚合、跨块累加出现次数
        for (const c of extractCitations(blk.text, n.domain)) {
          lawCiteCounts.set(c.lawKey, (lawCiteCounts.get(c.lawKey) || 0) + c.count);
        }
      }
      if (skipTermLink) {
        parts.push(withLaw, '');
        continue;
      }
      const r = linkTerms(withLaw, termMatcher, { linkedIds: linkedTerms, selfId: n.id, linkTo });
      linkedTerms = r.linkedIds;
      stats.termLinks += r.added;
      parts.push(r.text, '');
    }
    const lawCites = lawCiteCounts ? lawCitesSection(lawCiteCounts, n) : '';
    if (lawCites) parts.push(lawCites, '');
    const rel = relatedSection(related, n);
    if (rel) parts.push(rel, '');
    const ex = examplesSection(examples, n, own);
    if (ex) parts.push(ex, '');
    // 目录 index 页补子节点列表（v7 需求4）：本分支的页同时是目录与正文页，
    // 原先只有容器页分支产出「## 子节点」，导致这类页在站上没有任何下钻入口
    // ——只能靠 Quartz 组件的 page-listing 补位。现由生成器统一直出，
    // 组件侧的 page-listing 一并关闭，全站目录页只保留单一列表。
    if (p.kind === 'folder') {
      const kids = childrenOf.get(n.id) || [];
      if (kids.length) {
        parts.push('## 子节点', '');
        for (const kid of kids) parts.push(`- ${linkTo(kid)}`);
        parts.push('');
      }
    }
    addPage(p.kind === 'folder' ? '章节页(目录index)' : '章节页');
  } else {
    // 容器索引页：一句概览 + 子节点列表（不塞子树正文）
    const kids = childrenOf.get(n.id) || [];
    const overview = (n.summary || '').trim() || (kids.length ? '' : n.label);
    if (overview) {
      const escaped = escapeMd(normalizeProse(overview, richStats));
      if (TERM_LINK_ENABLED && !TERM_LINK_PAGE_EXCLUDE.has(n.id)) {
        const r = linkTerms(escaped, termMatcher, { linkedIds: new Set(), selfId: n.id, linkTo });
        stats.termLinks += r.added;
        parts.push(r.text, '');
      } else {
        parts.push(escaped, '');
      }
    }
    if (kids.length) {
      parts.push('## 子节点', '');
      for (const kid of kids) parts.push(`- ${linkTo(kid)}`);
      parts.push('');
    }
    addPage(p.kind === 'folder' ? '容器页(目录index)' : '容器页(文件)');
  }
  emit(relPath, parts.join('\n'));
}

// —— 8.2 词条页 ——
// 相关术语邻接（W1）：由 edges.json 的 termrel（人工上下位）+ termco（章节共现）合并构建，
// 不再读取 content JSON 的 relatedTerms（该字段长期为空，termrel/termco 是词间关系的权威来源）。
// termrel 有方向：source（组员/下位）→ target（组长/上位）；termco 无向，标注为"共现"。
const termTermNbr = new Map(); // termId → [{id, weight, rel}]
for (const e of edges) {
  if (e.type !== 'termrel' && e.type !== 'termco') continue;
  const push = (from, to, rel) => {
    if (!termTermNbr.has(from)) termTermNbr.set(from, []);
    termTermNbr.get(from).push({ id: to, weight: e.weight ?? 0, rel });
  };
  if (e.type === 'termrel') {
    push(e.source, e.target, '上位');
    push(e.target, e.source, '下位');
  } else {
    push(e.source, e.target, '共现');
    push(e.target, e.source, '共现');
  }
}
for (const n of nodes) {
  if (n.level !== 'term') continue;
  const p = nodePath.get(n.id);
  const detailPath = join(CONTENT_JSON_DIR, `${n.id}.json`);
  const d = existsSync(detailPath) ? readJson(detailPath) : {};
  const fm = frontmatter({ title: n.label, aliases: aliasesOf(n), tags: tagsOf(n) });
  const parts = [fm, ''];

  const def = (d.definition || '').trim();
  if (def) {
    // 词条定义段同样术语成链（织词条互链网），selfId 排除自链（定义句天然复述自身词面）
    const escaped = escapeMd(normalizeProse(def, richStats));
    if (TERM_LINK_ENABLED && !TERM_LINK_PAGE_EXCLUDE.has(n.id)) {
      const r = linkTerms(escaped, termMatcher, { linkedIds: new Set(), selfId: n.id, linkTo });
      stats.termLinks += r.added;
      parts.push(r.text, '');
    } else {
      parts.push(escaped, '');
    }
  }

  // 出处：按 7 书顺序分组，每条 [[nodeId|书短名 · 章节路径]] + evidence 摘句斜体
  const occ = d.occurrences || {};
  const occBooks = BOOKS.filter((b) => (occ[b.domain] || []).length);
  if (occBooks.length) {
    parts.push('## 出处', '');
    for (const b of occBooks) {
      const meta = DOMAIN_META.get(b.domain);
      parts.push(`**${meta.short}**`, '');
      for (const o of occ[b.domain]) {
        if (!nodePath.has(o.nodeId)) continue;
        // 章节路径 = 去掉书名的 breadcrumb + 节点标签（截断防超长）
        const crumbs = (o.breadcrumb || []).filter((c) => c !== meta.title);
        const label = o.nodeLabel.length > 36 ? o.nodeLabel.slice(0, 36) + '…' : o.nodeLabel;
        const path = [...crumbs, label].join(' › ');
        // 摘句同样是 PDF 抽取正文，需先做实体解码与公式降解，再去掉会破坏斜体的 * 与行内 tag 的 #
        const ev = normalizeProse((o.evidence || '').trim(), richStats)
          .replace(/[*#]/g, '')
          .replace(/\n/g, ' ');
        parts.push(`- ${linkTo(o.nodeId, `${meta.short} · ${path}`)}${ev ? ` — *${ev}*` : ''}`);
      }
      parts.push('');
    }
  }

  const laws = (d.laws || []).filter((l) => l.nodeId && nodePath.has(l.nodeId));
  if (laws.length) {
    parts.push('## 相关法条', '');
    for (const l of laws) {
      const extra = l.fullCite && l.fullCite !== l.lawKey ? `（${l.fullCite}）` : '';
      parts.push(`- ${linkTo(l.nodeId, l.lawKey)}${extra}`);
    }
    parts.push('');
  }

  // 相关术语：termrel + termco 合并，按 weight 降序取前 10（同邻居去重保留权重更高者；
  //   termrel 权重 0.8 > termco 最高 0.7，天然优先）；并列裁决按对端 id 升序，保证确定性。无则省略该节。
  {
    const raw = (termTermNbr.get(n.id) || [])
      .filter((t) => nodePath.has(t.id) && byId.has(t.id))
      .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
    const seenNbr = new Set();
    const relTerms = [];
    for (const t of raw) {
      if (seenNbr.has(t.id)) continue;
      seenNbr.add(t.id);
      relTerms.push(t);
      if (relTerms.length >= 10) break;
    }
    if (relTerms.length) {
      parts.push('## 相关术语', '');
      for (const t of relTerms) parts.push(`- ${linkTo(t.id, byId.get(t.id).label)}${t.rel ? `（${t.rel}）` : ''}`);
      parts.push('');
    }
  }

  emit(p.filePath, parts.join('\n'));
  addPage('词条页');
}

// —— 8.3 主题分组目录 index（9-关键词索引/<NN-主题>/index.md） ——
const termsByTopicDir = new Map();
for (const n of nodes) {
  if (n.level !== 'term') continue;
  const dir = topicDirName(n.topicKey);
  if (!termsByTopicDir.has(dir)) termsByTopicDir.set(dir, []);
  termsByTopicDir.get(dir).push(n);
}
for (const [dir, terms] of termsByTopicDir) {
  const topicName = dir === '99-综合' ? '综合' : dir.replace(/^\d+-/, '');
  const fm = frontmatter({ title: topicName, tags: ['关键词索引'] });
  // 词表直出（v7 需求4）：本页原先只有一句导语、列表全靠 Quartz 组件的
  // page-listing 补位，且导语称「按标题拼音序」与组件实际的文档序不符。
  // 现由生成器直出列表并按 df 降序（与总目录 8.4 同序），导语随之订正。
  const sorted = terms
    .slice()
    .sort((a, b) => (b.df || 0) - (a.df || 0) || a.label.localeCompare(b.label, 'zh-CN'));
  const parts = [
    fm,
    '',
    `「${topicName}」主题下共收录 ${terms.length} 个术语，按出现频次降序排列如下；亦可回到 ${linkToDir(TERM_ROOT, '关键词索引总目录')} 浏览全部主题。`,
    '',
    '## 子节点',
    '',
  ];
  for (const t of sorted) parts.push(`- ${linkTo(t.id, t.label)}（${t.df || 0}）`);
  parts.push('');
  emit(`${TERM_ROOT}/${dir}/index.md`, parts.join('\n'));
  addPage('主题索引页');
}

// —— 8.4 关键词索引总目录（9-关键词索引/index.md） ——
{
  const fm = frontmatter({ title: '关键词索引', tags: ['关键词索引'] });
  const parts = [
    fm,
    '',
    `全库共收录 ${nodes.filter((n) => n.level === 'term').length} 个术语，按主题分组如下；词后括号内为 df（该词在 7 部书中的出现文档数）。`,
    '',
  ];
  const dirs = [...termsByTopicDir.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const dir of dirs) {
    const topicName = dir === '99-综合' ? '综合' : dir.replace(/^\d+-/, '');
    const terms = termsByTopicDir.get(dir).slice().sort((a, b) => (b.df || 0) - (a.df || 0) || a.label.localeCompare(b.label, 'zh-CN'));
    parts.push(`## ${topicName}`, '');
    parts.push(terms.map((t) => `${linkTo(t.id, t.label)}（${t.df || 0}）`).join(' · '), '');
  }
  emit(`${TERM_ROOT}/index.md`, parts.join('\n'));
  addPage('术语总目录');
}

// —— 8.5 各书根 index（书简介 + 顶层子目录列表） ——
const domainRoots = new Map(); // domain → [根节点 id]
for (const n of nodes) {
  if (n.level === 'term' || parentOf.has(n.id)) continue;
  if (!domainRoots.has(n.domain)) domainRoots.set(n.domain, []);
  domainRoots.get(n.domain).push(n.id);
}
for (const arr of domainRoots.values()) arr.sort(idCompare);
for (const b of BOOKS) {
  const meta = DOMAIN_META.get(b.domain);
  const roots = domainRoots.get(b.domain) || [];
  const nodeCount = nodes.filter((n) => n.domain === b.domain).length;
  const fm = frontmatter({ title: meta.title, tags: [meta.short] });
  // 「效力信息」小节（阶段5.3 批次 W8）：取 data/book-meta.json 的原始字段与公布与施行原文，
  // 逐字渲染于首句与「## 子节点」之间；字段全空且无原文的域整节不出（渲染规则见 lib/book-efficacy.mjs）。
  // renderProse 注入的两步与正文链路同规格、同顺序：先 mdParagraphs（单换行转硬换行 + < # 最小转义），
  // 再 linkLawCites 就地成链；其中 force: true 系**阶段5.3 D2 裁决：效力原文段全域法条直达，
  // 白名单语义仅辖正文内链化**——LAW_LINK_DOMAINS 是正文内链化的范围门控，本区块为新增结构化区块，
  // 不受其约束，故显式绕过而不改动白名单本身。selfId 传 null：书根 index 非节点页、无自引用可言。
  const efficacy = efficacySection(bookMeta[b.domain], {
    renderProse: (p) => linkLawCites(mdParagraphs(p).join('\n\n'), b.domain, null, { force: true }),
  });
  // 列表标题统一为「## 子节点」（v7 需求4）：与其余目录页同体例，
  // 使全站目录页的下钻入口只有这一种形态
  const parts = [fm, '', `《${meta.title}》共 ${nodeCount} 个章节节点。`, ''];
  if (efficacy) parts.push(efficacy, '');
  parts.push('## 子节点', '');
  for (const rid of roots) parts.push(`- ${linkTo(rid, byId.get(rid).label)}`);
  parts.push('');
  emit(`${b.dir}/index.md`, parts.join('\n'));
  addPage('书根索引');
}

// —— 8.7 图谱总览页（0-图谱总览/index.md，W1） ——
// 目录名取 0- 前缀：Explorer 数字前缀排序下位于 7 部书之前，作为全库第一入口。
// 页面本身只承载存在与文案；全库知识图谱由 quartz 侧专用组件按 slug（"0-图谱总览/index"）注入渲染，
// 具体交互（点击节点侧栏阅读、双击/按钮前往文档页）由图谱专页组件实现，不在本生成器职责内。
{
  const fm = frontmatter({ title: '图谱总览' });
  emit(
    '0-图谱总览/index.md',
    [
      fm,
      '',
      // 导语已全部移除（UI 线 9d47ea1 裁决：本页首屏应当是图谱本身，任何文案都会
      // 把画布往下顶）。页面仅承载 frontmatter 存在性，交互说明由图谱组件自带 UI 承担。
      // 若在此处恢复任何正文，重跑生成器会回填并覆盖 UI 线的删除成果——勿加。
    ].join('\n'),
  );
  addPage('图谱总览页');
}

// —— 8.8 首页 content/index.md ——
{
  const fm = frontmatter({ title: 'IPReader' });
  const bookList = BOOKS.map((b) => {
    const meta = DOMAIN_META.get(b.domain);
    const count = nodes.filter((n) => n.domain === b.domain).length;
    return `- ${linkToDir(b.dir, `${b.order}. ${meta.title}`)} —— ${count} 节`;
  });
  const termCount = nodes.filter((n) => n.level === 'term').length;
  emit(
    'index.md',
    [
      fm,
      '',
      `以 ${BOOKS.length} 部知识产权工具书的章节体系为主体、以关键词索引为补充检索入口的中文知识产权知识库。全部内容离线可用；章节间通过法条引用、交叉参见与共引关系互联，可经右侧关系图与页底反链游走。`,
      '',
      `## 工具书目录（${BOOKS.length} 部）`,
      '',
      ...bookList,
      '',
      '## 检索入口',
      '',
      `- ${linkToDir('0-图谱总览', '🗺️ 图谱总览')} —— 全库知识图谱，点击节点侧栏阅读，双击前往文档页`,
      `- ${linkToDir(TERM_ROOT, '🔎 关键词索引')} —— ${termCount} 个术语按主题分组，附出处与相关法条`,
      '',
      '## 使用提示',
      '',
      '1. 使用左侧搜索框全文检索（如"新颖性"、"第二十六条"），支持标题与正文命中。',
      '2. 打开章节页右侧的关系图查看两跳邻居；点击右上角地球图标切换全局图。',
      '3. 法条页（如专利法第26条）底部的 Backlinks 汇总了全库引用该条文的章节。',
      `4. 左侧目录树按 ${BOOKS.length} 部书的法律层级排序，术语区固定在最下方的「关键词索引」。`,
      '',
    ].join('\n'),
  );
  addPage('首页');
}

// ============ 九、落盘（幂等：先清空生成器管理的目录） ============
const managedTop = [...BOOKS.map((b) => b.dir), TERM_ROOT, '0-图谱总览', 'index.md'];
if (existsSync(OUT_DIR)) {
  for (const name of readdirSync(OUT_DIR)) {
    if (managedTop.includes(name)) rmSync(join(OUT_DIR, name), { recursive: true, force: true });
  }
}
for (const [rel, content] of outputs) {
  const abs = join(OUT_DIR, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content + '\n', 'utf8');
}
// 附图实体随生成落盘（各书目录属受管清空范围，每次重建，幂等）
for (const [rel, srcAbs] of imagesToEmit) {
  const abs = join(OUT_DIR, rel);
  mkdirSync(dirname(abs), { recursive: true });
  copyFileSync(srcAbs, abs);
}

// ============ 十、自校验（wikilink 死链 + 页数断言） ============
// 对最终产物做全量扫描：id 形目标必须是已生成文件名；path/index 形目标必须有对应 index.md。
const fileIdSet = new Set();
const indexPathSet = new Set();
for (const rel of outputs.keys()) {
  const base = rel.split('/').pop().replace(/\.md$/, '');
  if (base === 'index') indexPathSet.add(rel.replace(/\/index\.md$/, '').replace(/^index\.md$/, ''));
  else fileIdSet.add(base);
}
let scanned = 0;
const broken = [];
const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
for (const [rel, content] of outputs) {
  let m;
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(content))) {
    scanned++;
    const target = m[1].trim();
    if (target.endsWith('/index')) {
      if (!indexPathSet.has(target.slice(0, -'/index'.length))) broken.push(`${rel} → ${target}`);
    } else if (!fileIdSet.has(target)) {
      broken.push(`${rel} → ${target}`);
    }
  }
}
// 图片引用自校验：产物中每个 ![](路径) 的目标必须在本次落盘的附图集合内
const IMG_EMBED_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
for (const [rel, content] of outputs) {
  let m;
  IMG_EMBED_RE.lastIndex = 0;
  while ((m = IMG_EMBED_RE.exec(content))) {
    if (!imagesToEmit.has(m[1])) broken.push(`${rel} → 图片 ${m[1]}`);
  }
}

const totalPages = outputs.size;
const summary = {
  页面总数: totalPages,
  分类: stats.pages,
  wikilink总数: stats.wikilinks,
  扫描到的wikilink: scanned,
  法条正文内成链: stats.lawLinks,
  法条正文内成链_白名单域: stats.lawLinksWhitelist || 0,
  法条成链_书根效力原文段: stats.lawLinksPromulgation || 0,
  引用法条清单: { 条目: stats.lawCitesSectionEntries || 0, 不可解析跳过: stats.lawCiteUnresolved || 0 },
  术语正文内成链: stats.termLinks,
  跨书前缀链接: stats.crossBookPrefixed || 0,
  小节编号引用成链: stats.numRefLinks || 0,
  小节编号退化纯文本: stats.numRefPlain || 0,
  图片嵌入: stats.imgEmbedded || 0,
  表格_GFM管道: richStats.gfmTables,
  表格_rawHTML回退: richStats.rawTables,
  公式降解成功: richStats.converted,
  公式保留原文: richStats.kept,
  正文总字符: stats.chars,
  alias跳过_重名: stats.aliasSkipDup,
  alias跳过_非法字符: stats.aliasSkipBad,
  死链: broken.length,
};
console.log(JSON.stringify(summary, null, 2));
if (broken.length) {
  console.error('死链明细（前 20 条）：\n' + broken.slice(0, 20).join('\n'));
  process.exit(1);
}
// 页数断言：页面总数 = 节点页（章节/容器页 + 词条页，恒等于 nodes.json 条数）
// ＋ 其他页 115（书根 88 + 主题索引 24 + 术语总目录 1 + 图谱总览 1 + 首页 1）。
// 先断言「节点页数 === 节点数」这一恒等式（与入库规模无关），再断言页面总数落在下方区间内。
// 历史注记：早期任务书预估 2350±80 系把 174 个容器索引页在 2175 个节点页之外重复计入
// （2175+174=2349），实际每个容器就是一个节点页、不另生成；故此处按真实构成断言。
const nodePages =
  (stats.pages['章节页'] || 0) +
  (stats.pages['章节页(目录index)'] || 0) +
  (stats.pages['容器页(目录index)'] || 0) +
  (stats.pages['容器页(文件)'] || 0) +
  (stats.pages['词条页'] || 0);
if (nodePages !== nodes.length) {
  console.error(`断言失败：节点页数 ${nodePages} ≠ 节点数 ${nodes.length}`);
  process.exit(1);
}
// 区间随入库规模调整：2026-08-25 阶段5.3 节点细化后，页面总数预期 7397
// （7282 节点页 + 115 其他；7282 = 章节/容器页 6247 + 词条页 1035）。
// 本期增量来自阶段5.3 前序批次的节点细化与重切片，节点页 6410 → 7282（+872），其他页 115 不变。
// ⚠ 上述 7282 / 6247 / 1035 三个数按批次 W8 落地时的预期账写入，**以 C1 全量重跑实测复核为准**
// （W8 只改代码不跑全量：上游 edges/layout/term 中间态未齐，词条页数尤须 C1 实测回填）。
// 区间按预期落点 7397 ±5% 向外取整取 [7030, 7770]，沿用历次「实测落点 ±5%」的同一口径。
// 历史口径：阶段5.2 两批语料扩容后实测 6525（5375 章节/容器页 + 1035 词条页 + 115 其他，
// 曾为 [6190, 6860]）；87 域态（tmeg 104 节点）实测 5419（曾为 [5140, 5690]）；
// 批次三 72 域态实测 4683（曾为 [4440, 4920]）；批次二 47 域态实测 3710（曾为 [3520, 3900]）；
// 批次一 32 域态实测 2832（曾为 [2690, 2980]）；含「修改十八件决定」的 26 件态曾实测 2852；
// 词表 968→851 删词后页面 2091（曾为 [1990, 2200]）；词表 907 时页面 2142（曾为 [2100, 2430]）。
// 2026-08-30 阶段5.11 波G（5.9 波4 全量重建）：词表 1035 → 1743（商标指南全量重提取 895 片
//   ＋ 著作权/竞争法/品种布图/综合程序四法域 8 部书 384 片首次入词表），词条页随之 1035 → 1743；
//   非 term 节点页 6247 恒、其他页由 115 → 119（主题分组 20 → 28 个目录 index）。
//   实测总数 8109（6247 + 1743 + 119），破旧上限 7770（+4.4%），按既有「实测 ±5% 向外取整到十位」
//   的报批惯例改写为 [7700, 8520]，旧区间降为沿革记录（见上表）。
if (totalPages < 7700 || totalPages > 8520) {
  console.error(`断言失败：页面总数 ${totalPages} 超出 [7700, 8520]`);
  process.exit(1);
}
// 术语链接量断言：随 TERM_LINK_TIERS 口径与入库规模定版。
//   全量（1035 词）+ 88 域 实测 19104 —— 2026-08-25 阶段5.3 批次 C1 管线全序重建实测
//                       （阶段5.3 节点细化：非 term 节点页 5375 → 6247、页面总数 6525 → 7397；
//                        词表 1035 恒。成链增幅 1.111 倍与页面增幅 1.134 倍同量级，
//                        每页成链密度 2.636 → 2.583 微降，非匹配器/禁区失效型骤增）
//                       区间按实测 ±5% 向外取整取 [18140, 20060]
//   全量（1035 词）+ 88 域 实测 17201 —— 2026-08-24 阶段5.2 两批语料扩容
//                       （W-1 tmeg 正文数字编号段升节点 +709、Q-1《专利质量评价指南》第 88 部
//                        入库 +214；词表 1035 恒，增幅 1.128 倍与页面增幅 1.168 倍同量级）
//                       （区间曾为 [16340, 18070]）
//   全量（1035 词）+ 87 域 实测 15245 —— 2026-08-23 阶段5波C 商标术语接入
//                       （商标审查审理指南关键词速查 68 行 + 109 片证据片入词表，词表 851→1035）
//                       （区间曾为 [14480, 16010]）
//   全量（851 词）+ 87 域  实测 12530 —— 2026-08-22 入库批次四（收尾）15 件后本期口径
//                       （商标审查审理指南 23.4 万字 + 办案指南 19.8 万字两大件贡献主要增幅 +1984）
//                       （区间曾为 [11900, 13160]）
//   全量（851 词）+ 72 域  实测 10546 —— 批次三 25 件态（区间曾为 [10010, 11080]）
//   全量（851 词）+ 47 域  实测 9673 —— 批次二 15 件态（区间曾为 [9180, 10160]）
//   全量（851 词）+ 32 域  实测 9138 —— 批次一 25 域态（区间曾为 [8680, 9600]）；
//                       含「修改十八件决定」的 26 件态曾实测 9247（区间曾为 [8780, 9710]）
//   全量（851 词）+ 7 书  实测 8142 —— 入库前口径（区间曾为 [7900, 8800]）
//   全量（968 词）      实测 8272 —— 删词前口径
//   仅 seed（424 词）   实测 3125 —— 曾短暂启用，因术语覆盖面损失过大而撤回
// 区间容忍正文/清单微调；灾难性偏离（匹配器失效→骤降，禁区失效→骤增）在此拦截。
// 改 TERM_LINK_TIERS 或增删域时必须同步改本区间，否则断言会挡下预期内的口径切换。
// 注记（阶段5.3 批次 W8 → C1 结案）：W8 预留「C1 首跑破区间时按实测 ±5% 报批」，
//   C1 首跑实测 19104 破旧上限 18070（+5.7%），落在报批宽带 [16340, 22600] 内，
//   经裁决按实测 ±5% 收紧改写为 [18140, 20060]，旧区间降为沿革记录（见上表）。
//   书根「效力信息」的公布与施行原文不经 termMatcher（只做法条内链化），对本计数零贡献。
//   全量（1743 词）+ 88 域 实测 28196 —— 2026-08-30 阶段5.11 波G（5.9 波4 全量重建）
//                       （词表 1035 → 1743，+68.4%；成链 19104 → 28196，+47.6%——增幅低于词量增幅，
//                        系新增词多为商标/四法域专名、其匹配面集中在本法域正文，属预期形态，
//                        非禁区失效型骤增。页面数同步 7397 → 8109，每页成链密度 2.583 → 3.477）
//                       区间按实测 ±5% 向外取整到十位取 [26780, 29610]
if (TERM_LINK_ENABLED && (stats.termLinks < 26780 || stats.termLinks > 29610)) {
  console.error(`断言失败：术语正文内成链 ${stats.termLinks} 超出 [26780, 29610]`);
  process.exit(1);
}
// 附图嵌入断言：上游正文引用与已导入资产的定版数量（上游新增附图时须重跑 import-book-images.mjs 并更新此值）
if ((stats.imgEmbedded || 0) !== EXPECTED_EMBEDDED_IMAGES) {
  console.error(`断言失败：附图嵌入 ${stats.imgEmbedded || 0} ≠ ${EXPECTED_EMBEDDED_IMAGES}`);
  process.exit(1);
}
// 内嵌 HTML 表格断言：全库 48 张，29 转 GFM 管道表格、19 回退 raw HTML（逐表去向见文件头 EXPECTED_* 注释）。
// 注：原生 markdown 管道表（如 GB 清单域）不经 TABLE_BLOCK_RE，不计入本断言。
// 数量下滑即说明表格识别或上游切片出了问题——它是「表格重新按纯文本平铺」的回归哨兵。
if (richStats.gfmTables !== EXPECTED_GFM_TABLES || richStats.rawTables !== EXPECTED_RAW_TABLES) {
  console.error(
    `断言失败：表格转换 GFM ${richStats.gfmTables}/${EXPECTED_GFM_TABLES}、` +
      `raw ${richStats.rawTables}/${EXPECTED_RAW_TABLES}（回退原因：${richStats.rawTableReasons.join('；') || '无'}）`,
  );
  process.exit(1);
}
// 公式降解断言：全库 96 种去重形态（142 处实例）实测 100% 可降解为 Unicode 纯文本。
// 一旦上游引入本降解器不认识的命令，该公式会保留 $…$ 原文并在此拦下，
// 避免"页面上又出现裸 LaTeX"这类缺陷静默复发。
if (richStats.kept !== 0) {
  console.error(
    `断言失败：${richStats.kept} 处公式无法降解为纯文本，保留了 $…$ 原文：\n` +
      richStats.keptList.slice(0, 20).map((k) => `  ${k.raw} —— ${k.reason}`).join('\n'),
  );
  process.exit(1);
}
if (richStats.converted < EXPECTED_MATH_MIN) {
  console.error(`断言失败：公式降解 ${richStats.converted} 处 < 下限 ${EXPECTED_MATH_MIN}`);
  process.exit(1);
}
console.log(`✅ 生成完成：${totalPages} 页，wikilink ${scanned} 条全部可达，输出目录 ${OUT_DIR}`);

// ============ 十一、taxonomy.json 发射（阶段5 波C 新增） ============
// 「顶层目录数字前缀 → 分组元数据」映射：供 Explorer 合成分组层（波C-3）与图谱标签图（波C-4）
// 消费，亦是 mcp/scripts/check-taxonomy.mjs（P9）比对 graphSections.ts 的另一侧数据源。
// 只依赖 BOOKS（顶层目录前缀登记）与 DOMAIN_META（阶段5.3 批次 W3 起经 resolveDomainTitles
// 派生自 KNOWN_DOMAINS + book-meta.json，title 字段可能带年份后缀，field/docType 等分类字段
// 逐字不变），故 0-图谱总览、
// 9-关键词索引两个非书前缀天然不入表（BOOKS 数组本就只登记 88 部书，不含二者）；
// 落盘目标是 quartz/static/（quartz 静态资产树，与本文件其余产物所在的 content/ 是两棵不同的树），
// 因此不经 emit()/outputs 收集，径直 writeFileSync。
function emitTaxonomy() {
  const table = {};
  for (const b of BOOKS) {
    const meta = DOMAIN_META.get(b.domain);
    if (!meta) throw new Error(`taxonomy 发射失败：未知域 ${b.domain}`);
    table[b.order] = {
      domain: b.domain,
      title: meta.title,
      short: meta.short,
      country: meta.country,
      field: meta.field,
      docType: meta.docType,
      docTypeName: DOC_TYPES[meta.docType],
    };
  }
  const outPath = join(SCRIPT_DIR, '..', '..', 'quartz-kb', 'quartz', 'static', 'taxonomy.json');
  writeFileSync(outPath, JSON.stringify(table, null, 2) + '\n', 'utf8');
  console.log(`taxonomy.json 已生成：${outPath}（${Object.keys(table).length} 键）`);
}
emitTaxonomy();
