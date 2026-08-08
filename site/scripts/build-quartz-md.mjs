// build-quartz-md.mjs —— 专利知识库 → quartz 内容站 markdown 生成器（Q2 阶段）
//
// 输入（均为只读）：
//   data/nodes.json        2175 节点（7 部书 1193 + 术语 982）
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
import { KNOWN_DOMAINS } from './lib/domains.mjs';
import { extractCitations } from './lib/law-cite.mjs';
import { buildTermMatcher, linkTerms } from './lib/term-link.mjs';
import { TOPICS, TOPIC_NAME } from './lib/topics.mjs';
import { cn2num } from './lib/cn-num.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(SCRIPT_DIR, '..');
const DATA_DIR = join(SITE_DIR, 'data');
const CONTENT_JSON_DIR = join(SITE_DIR, 'public', 'content');
const OUT_DIR = join(SCRIPT_DIR, '..', '..', 'quartz-kb', 'content');
// 原文附图资产（import-book-images.mjs 从桌面源导入，git 跟踪）：
// 正文 ![](images/x) 引用改写为 content 根相对路径并随生成落盘到 content/<书目录>/images/
const ASSETS_IMG_DIR = join(SITE_DIR, 'assets', 'book-images');
const EXPECTED_EMBEDDED_IMAGES = 88; // 七书正文实际引用的附图总数（manifest 定版）
const imagesToEmit = new Map(); // content 相对路径 → 资产绝对路径

// ============ 一、书目登记：域 → 顶层目录（顺序 = 法律层级） ============
const BOOKS = [
  { order: 1, domain: 'patent-law', dir: '1-专利法' },
  { order: 2, domain: 'implementation-rules', dir: '2-专利法实施细则' },
  { order: 3, domain: 'examination-guideline-2025', dir: '3-专利审查指南2025' },
  { order: 4, domain: 'infringement-guide', dir: '4-侵权判定指南' },
  { order: 5, domain: 'mechanical-drafting-rules', dir: '5-机械撰写规范' },
  { order: 6, domain: 'chemistry-drafting-rules', dir: '6-化学撰写规范' },
  { order: 7, domain: 'oa-response-guide', dir: '7-答复审查意见指南' },
];
const TERM_ROOT = '9-关键词索引';
const BOOK_BY_DOMAIN = new Map(BOOKS.map((b) => [b.domain, b]));
const DOMAIN_META = new Map(KNOWN_DOMAINS.map((d) => [d.key, d]));

// ============ 二、载入数据 ============
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const nodes = readJson(join(DATA_DIR, 'nodes.json'));
const edges = readJson(join(DATA_DIR, 'edges.json'));
const bodies = readJson(join(DATA_DIR, 'node-bodies.json'));

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
  if (domain === 'examination-guideline-2025') return num ? `${num} ${label}` : label;
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

// 术语：9-关键词索引/<NN-主题>/term-XXXX.md（topicKey 按 TOPICS 表序编号，无主题进 99-综合）
function topicDirName(topicKey) {
  const idx = TOPICS.findIndex((t) => t.key === topicKey);
  if (topicKey && idx >= 0) {
    return `${String(idx + 1).padStart(2, '0')}-${sanitizeName(TOPIC_NAME[topicKey].replace(/\//g, '与'))}`;
  }
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
    const t = ['关键词索引'];
    if (node.topicKey && TOPIC_NAME[node.topicKey]) t.push(tagName(TOPIC_NAME[node.topicKey]));
    return t;
  }
  const meta = DOMAIN_META.get(node.domain);
  const t = meta ? [meta.short] : [];
  for (const key of node.topics || []) if (TOPIC_NAME[key]) t.push(tagName(TOPIC_NAME[key]));
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
    // 行内 # 会被 ObsidianFlavoredMarkdown 解析为行内 tag（正文出现"###"等即产生空 tag 死链），统一转义
    .map((p) => p.replace(/</g, '\\<').replace(/#/g, '\\#'))
    .filter((p) => p.trim());
}

// 法条引用就地 wikilink 化：同一条文（lawKey）一段内只链首次出现；
// 仅处理含"第X条"的命中（款/项级续接不单独成链）；范围展开取首条为链接目标。
const lawKeyToNode = new Map();
for (const n of nodes) if (n.lawKey) lawKeyToNode.set(n.lawKey, n.id);

function linkLawCites(para, domain, selfId) {
  const trace = [];
  extractCitations(para, domain, { trace });
  if (!trace.length) return para;
  // 按命中位置聚合（范围展开的多个 lawKey 共享同一 index，取首个作为链接目标）
  const hits = new Map();
  for (const t of trace) if (!hits.has(t.index)) hits.set(t.index, t);
  const linked = new Set();
  // 自右向左替换，保持左侧偏移不失效
  const ordered = [...hits.values()].sort((a, b) => b.index - a.index);
  const applied = [];
  for (const h of ordered) {
    if (!/第.+条/.test(h.raw)) continue; // 款/项级续接命中不成链
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
    // 示例文本与正文同源，需做同样的遗留链接清洗与行内 tag/HTML 转义
    const text = resolveInlineRefs(String(ex.text || ''), node)
      .replace(/</g, '\\<')
      .replace(/#/g, '\\#');
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
    // 章节页：正文（先清洗遗留链接，再做法条引用就地成链，最后术语就地成链）→ 关联 → 示例
    const skipTermLink = !TERM_LINK_ENABLED || TERM_LINK_PAGE_EXCLUDE.has(n.id);
    let linkedTerms = new Set();
    for (const para of mdParagraphs(resolveInlineRefs(own, n))) {
      const withLaw = linkLawCites(para, n.domain, n.id);
      if (skipTermLink) {
        parts.push(withLaw, '');
        continue;
      }
      const r = linkTerms(withLaw, termMatcher, { linkedIds: linkedTerms, selfId: n.id, linkTo });
      linkedTerms = r.linkedIds;
      stats.termLinks += r.added;
      parts.push(r.text, '');
    }
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
      const escaped = overview.replace(/</g, '\\<').replace(/#/g, '\\#');
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
    const escaped = def.replace(/</g, '\\<').replace(/#/g, '\\#');
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
        const ev = (o.evidence || '').trim().replace(/[*#]/g, '').replace(/\n/g, ' ');
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
  // 列表标题统一为「## 子节点」（v7 需求4）：与其余目录页同体例，
  // 使全站目录页的下钻入口只有这一种形态
  const parts = [fm, '', `《${meta.title}》共 ${nodeCount} 个章节节点。`, '', '## 子节点', ''];
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
      // 导语精简为一句（v7 需求3）：本页首屏应当是图谱本身，节点规模等统计
      // 信息在图例与工具条上已可见。原文案称"双击节点可前往文档页"与实现不符
      // ——代码中无 dblclick 处理，前往文档页的入口是侧栏底部按钮，据实订正。
      '点击图中任一节点，在右侧阅读该知识点的正文；侧栏底部按钮可前往其文档页。',
      '',
      '> 本页由专用图谱组件渲染；若下方未出现交互图谱，请确认站点构建时已启用该组件。',
      '',
    ].join('\n'),
  );
  addPage('图谱总览页');
}

// —— 8.8 首页 content/index.md ——
{
  const fm = frontmatter({ title: '专利知识库' });
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
      '以 7 部专利工具书的章节体系为主体、以关键词索引为补充检索入口的中文专利知识库。全部内容离线可用；章节间通过法条引用、交叉参见与共引关系互联，可经右侧关系图与页底反链游走。',
      '',
      '## 七部工具书',
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
      '4. 左侧目录树按 7 部书的法律层级排序，术语区固定在最下方的「关键词索引」。',
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
  术语正文内成链: stats.termLinks,
  跨书前缀链接: stats.crossBookPrefixed || 0,
  小节编号引用成链: stats.numRefLinks || 0,
  小节编号退化纯文本: stats.numRefPlain || 0,
  图片嵌入: stats.imgEmbedded || 0,
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
// 页数断言：节点页 2175 + 书根 7 + 术语总目录 1 + 主题索引 ~33 + 首页 1 ≈ 2217。
// 任务书预估 2350±80 系把 174 个容器索引页在 2175 个节点页之外重复计入（2175+174=2349），
// 实际每个容器就是一个节点页，不另生成；故此处按真实构成断言，区间放宽下限。
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
if (totalPages < 2150 || totalPages > 2430) {
  console.error(`断言失败：页面总数 ${totalPages} 超出 [2150, 2430]`);
  process.exit(1);
}
// 术语链接量断言：随 TERM_LINK_TIERS 口径定版。
//   全量（982 词）      实测 8352 —— 2026-08 行内链接复核定版（本期口径）
//   仅 seed（424 词）   实测 3125 —— 曾短暂启用，因术语覆盖面损失过大而撤回
// 区间容忍正文/清单微调；灾难性偏离（匹配器失效→骤降，禁区失效→骤增）在此拦截。
// 改 TERM_LINK_TIERS 时必须同步改本区间，否则断言会挡下预期内的口径切换。
if (TERM_LINK_ENABLED && (stats.termLinks < 7900 || stats.termLinks > 8800)) {
  console.error(`断言失败：术语正文内成链 ${stats.termLinks} 超出 [7900, 8800]`);
  process.exit(1);
}
// 附图嵌入断言：上游正文引用与已导入资产的定版数量（上游新增附图时须重跑 import-book-images.mjs 并更新此值）
if ((stats.imgEmbedded || 0) !== EXPECTED_EMBEDDED_IMAGES) {
  console.error(`断言失败：附图嵌入 ${stats.imgEmbedded || 0} ≠ ${EXPECTED_EMBEDDED_IMAGES}`);
  process.exit(1);
}
console.log(`✅ 生成完成：${totalPages} 页，wikilink ${scanned} 条全部可达，输出目录 ${OUT_DIR}`);
