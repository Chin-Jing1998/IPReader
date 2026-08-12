// export-term-index.mjs —— 词表蒸馏导出器（知识库术语图谱 → skills 市场 term-index）
//
// 定位：**只读消费者**。不写任何既有产物（data/、public/、quartz-kb/ 一律不碰），
//   全部输出落 --out 指定目录下的 term-index/ 子目录，共 25 个 markdown 文件。
//
// 输入（除切片树外均相对 site/，全部只读）：
//   data/terms-merged.json        851 词条：termKey/canonical/aliases/topicKey/sources/lawKeys
//   data/nodes.json               2044 节点：章节 1193（含 231 个带 lawKey 的法条节点）+ 术语 851
//   data/edges.json               7998 边，本脚本取三类：
//                                   xref    章节↔章节交叉参见
//                                   lawref  章节→法条节点
//                                   termrel 术语↔术语
//   public/content/term-*.json    851 词条详情：definition/occurrences/laws/relatedTerms
//   scripts/lib/topics.mjs        TERM_TOPIC_GROUPS（22 组，组序即目录编号 01…22）
//   ../../<book>/_chunks/         外层仓七书切片树——**指针存在性判定的唯一依据**，只读
//
// 输出 <out>/term-index/：
//   README.md                     23 组总览表 + 指针语义 + grep 检索建议 + 数据来源
//   01-novelty.md … 22-fee.md     22 个主题分组词条文件（NN = TERM_TOPIC_GROUPS 声明序）
//   99-misc.md                    topicKey 为空或未落任何组 members 的词条
//   cross-references.md           ① xref 双向表 ② lawref 按法条聚合 ③ 法条指针速查
//
// 为何有 ③：术语条目的「相关法条」按模板只写中文 label 不带指针，而 ② 只覆盖被 lawref
//   引用到的 123 条法条；术语侧实际引用 196 条 lawKey，其中 74 条不在 ② 内。③ 全量登记
//   231 个法条节点的 lawKey → label → 指针，保证任一法条都能一跳拿到切片路径。
//
// 指针规则（已对七书切片树实证，见 slicePointer）：
//   nodeId 前缀定书 → 去前缀后按 `-` 切段 → 第 1 段补 2 位、第 2 段补 3 位、第 3 段起各补 2 位
//   → 拼 <book>/_chunks/<段>/…；是目录写尾斜杠（容器），有同名 .md 写叶文件，两者皆无即硬失败。
//
// 用法：node scripts/export-term-index.mjs --out /tmp/term-index-out
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERM_TOPIC_GROUPS } from './lib/topics.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(SCRIPT_DIR, '..');
const DATA_DIR = join(SITE_DIR, 'data');
const CONTENT_DIR = join(SITE_DIR, 'public', 'content');
// site → patent-kb → 专利知识库（外层仓根，七书切片目录所在）
const KB_ROOT = join(SITE_DIR, '..', '..');

// ============ 一、定版常量 ============

const EXPECTED_TERM_TOTAL = 851; // 词表定版规模（2026-08-12 删词后）
const MISC_NO = 99; // 综合组编号
const MISC_NAME = '综合';
const MISC_SLUG = 'misc';
const DEF_MAX_CHARS = 200; // 释义截断长度
const BREADCRUMB_SEP = ' › ';
const ALIAS_SEP = ' ／ ';
const ITEM_SEP = '；';

// nodeId 前缀 → 书目录。无前缀（纯数字开头）落审查指南。
const BOOK_BY_PREFIX = [
  ['law-', 'patent-law'],
  ['rule-', 'implementation-rules'],
  ['infr-', 'infringement-guide'],
  ['mech-', 'mechanical-drafting-rules'],
  ['chem-', 'chemistry-drafting-rules'],
  ['oa-', 'oa-response-guide'],
];
const DEFAULT_BOOK = 'examination-guideline';

// 书目呈现顺序 = 法律层级（与 build-quartz-md.mjs 的 BOOKS 同序），书名取各书 _index.md 的 H1。
const BOOKS = [
  { dir: 'patent-law', name: '中华人民共和国专利法' },
  { dir: 'implementation-rules', name: '中华人民共和国专利法实施细则' },
  { dir: 'examination-guideline', name: '专利审查指南' },
  { dir: 'infringement-guide', name: '专利侵权判定指南' },
  { dir: 'mechanical-drafting-rules', name: '机械案件撰写规范' },
  { dir: 'chemistry-drafting-rules', name: '化学案件撰写规范' },
  { dir: 'oa-response-guide', name: '审意答复指引' },
];
const BOOK_NAME = new Map(BOOKS.map((b) => [b.dir, b.name]));
const BOOK_ORDER = new Map(BOOKS.map((b, i) => [b.dir, i]));

// 第 2 段补 3 位、其余补 2 位——七书切片树的既有编号宽度
const segWidth = (i) => (i === 1 ? 3 : 2);

// ============ 二、CLI ============

function parseArgs(argv) {
  const i = argv.indexOf('--out');
  if (i < 0 || !argv[i + 1]) {
    console.error('用法：node scripts/export-term-index.mjs --out <目录>');
    process.exit(1);
  }
  return { outDir: resolve(argv[i + 1]) };
}

// ============ 三、指针映射 ============

const pointerCache = new Map();
const emittedPointers = new Set(); // 收集全部落盘指针，供末尾存在率复核

/** nodeId → skills-package 内相对切片指针；映射不到磁盘实体即硬失败退出。 */
function slicePointer(nodeId) {
  if (pointerCache.has(nodeId)) {
    const hit = pointerCache.get(nodeId);
    emittedPointers.add(hit);
    return hit;
  }
  let book = DEFAULT_BOOK;
  let rest = nodeId;
  for (const [prefix, dir] of BOOK_BY_PREFIX) {
    if (nodeId.startsWith(prefix)) {
      book = dir;
      rest = nodeId.slice(prefix.length);
      break;
    }
  }
  if (book === DEFAULT_BOOK && !/^\d/.test(rest)) {
    console.error(`✗ 指针映射失败：nodeId「${nodeId}」既无已知前缀、也非纯数字开头`);
    process.exit(1);
  }
  const segs = rest.split('-').map((s, i) => s.padStart(segWidth(i), '0'));
  const rel = `${book}/_chunks/${segs.join('/')}`;
  const abs = join(KB_ROOT, rel);

  let pointer = null;
  if (existsSync(abs) && statSync(abs).isDirectory()) pointer = `${rel}/`;
  else if (existsSync(`${abs}.md`)) pointer = `${rel}.md`;

  if (!pointer) {
    console.error(`✗ 指针映射失败：nodeId「${nodeId}」→ 期望 ${rel}/ 或 ${rel}.md，两者皆不存在`);
    process.exit(1);
  }
  pointerCache.set(nodeId, pointer);
  emittedPointers.add(pointer);
  return pointer;
}

/** nodeId → 所属书目录（仅用于排序/分组，不触盘） */
function bookOf(nodeId) {
  for (const [prefix, dir] of BOOK_BY_PREFIX) if (nodeId.startsWith(prefix)) return dir;
  return DEFAULT_BOOK;
}

// ============ 四、装载 ============

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const terms = readJson(join(DATA_DIR, 'terms-merged.json'));
const nodes = readJson(join(DATA_DIR, 'nodes.json'));
const edges = readJson(join(DATA_DIR, 'edges.json'));

const nodeById = new Map(nodes.map((n) => [n.id, n]));
const termNodes = nodes.filter((n) => n.id.startsWith('term-'));
const termIdByCanonical = new Map(termNodes.map((n) => [n.label, n.id]));
// lawKey → 法条节点（专利法 law-XX-YY / 实施细则 rule-XX-YY）
const lawNodeByKey = new Map(nodes.filter((n) => n.lawKey).map((n) => [n.lawKey, n]));

const label = (id) => nodeById.get(id)?.label ?? id;
const crumbs = (id) => nodeById.get(id)?.breadcrumb ?? [];
/** 「label（面包屑 › 连接）」；面包屑为空时只出 label */
const withCrumb = (lbl, bc) => (bc && bc.length ? `${lbl}（${bc.join(BREADCRUMB_SEP)}）` : lbl);
const nodeWithCrumb = (id) => withCrumb(label(id), crumbs(id));

// ============ 五、分组体系 ============

const groupSlug = (key) =>
  key.replace(/^g/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const GROUPS = TERM_TOPIC_GROUPS.map((g, i) => ({
  key: g.key,
  name: g.name,
  no: i + 1,
  slug: groupSlug(g.key),
  file: `${String(i + 1).padStart(2, '0')}-${groupSlug(g.key)}.md`,
  members: g.members,
  terms: [],
}));
const MISC = {
  key: '__misc__',
  name: MISC_NAME,
  no: MISC_NO,
  slug: MISC_SLUG,
  file: `${MISC_NO}-${MISC_SLUG}.md`,
  members: [],
  terms: [],
};
const ALL_GROUPS = [...GROUPS, MISC];

// 细粒度 topicKey → 分组
const groupByTopicKey = new Map();
for (const g of GROUPS) for (const m of g.members) groupByTopicKey.set(m, g);

// ============ 六、词条建模 ============

const unknownTopicKeys = new Map(); // 未落任何组的非空 topicKey → 词条数

/** 词条 canonical → 所属分组（供相关术语跨组标注） */
const groupOfTerm = new Map();

const records = terms.map((t) => {
  const termId = termIdByCanonical.get(t.canonical);
  if (!termId) {
    console.error(`✗ 词条「${t.canonical}」在 nodes.json 中无对应术语节点，无法定位详情文件`);
    process.exit(1);
  }
  const detailPath = join(CONTENT_DIR, `${termId}.json`);
  if (!existsSync(detailPath)) {
    console.error(`✗ 词条详情缺失：${detailPath}`);
    process.exit(1);
  }
  const detail = readJson(detailPath);

  // —— 出处：content.occurrences ∪ terms-merged.sources，按 nodeId 去重 ——
  const occMap = new Map();
  for (const list of Object.values(detail.occurrences || {})) {
    for (const o of list) {
      if (!occMap.has(o.nodeId)) {
        occMap.set(o.nodeId, {
          nodeId: o.nodeId,
          label: o.nodeLabel || label(o.nodeId),
          breadcrumb: o.breadcrumb?.length ? o.breadcrumb : crumbs(o.nodeId),
        });
      }
    }
  }
  for (const list of Object.values(t.sources || {})) {
    for (const nodeId of list) {
      if (!occMap.has(nodeId)) {
        occMap.set(nodeId, { nodeId, label: label(nodeId), breadcrumb: crumbs(nodeId) });
      }
    }
  }
  const occurrences = [...occMap.values()].sort(
    (a, b) =>
      BOOK_ORDER.get(bookOf(a.nodeId)) - BOOK_ORDER.get(bookOf(b.nodeId)) ||
      a.nodeId.localeCompare(b.nodeId),
  );

  // —— 相关法条：terms-merged.lawKeys ∪ content.laws，按 lawKey 去重 ——
  const lawKeys = new Set(t.lawKeys || []);
  for (const l of detail.laws || []) if (l.lawKey) lawKeys.add(l.lawKey);

  // —— 相关术语：content.relatedTerms ∪ termrel 边（无向），按术语节点 id 去重 ——
  const relatedIds = new Set((detail.relatedTerms || []).map((r) => r.id));

  // 定义：content.definition 优先，缺则回落术语节点 summary
  const definition = (detail.definition || nodeById.get(termId)?.summary || '').trim();

  const group = t.topicKey ? groupByTopicKey.get(t.topicKey) : null;
  if (t.topicKey && !group) {
    unknownTopicKeys.set(t.topicKey, (unknownTopicKeys.get(t.topicKey) || 0) + 1);
  }
  const target = group || MISC;

  const rec = {
    termId,
    canonical: t.canonical,
    aliases: t.aliases || [],
    topicKey: t.topicKey || '',
    definition,
    occurrences,
    lawKeys,
    relatedIds,
    group: target,
  };
  target.terms.push(rec);
  groupOfTerm.set(termId, target);
  return rec;
});

// termrel 边并入相关术语（双向）
const recById = new Map(records.map((r) => [r.termId, r]));
let termrelCount = 0;
for (const e of edges) {
  if (e.type !== 'termrel') continue;
  termrelCount += 1;
  recById.get(e.source)?.relatedIds.add(e.target);
  recById.get(e.target)?.relatedIds.add(e.source);
}
for (const r of records) r.relatedIds.delete(r.termId); // 防自环

// ============ 七、渲染：词条条目 ============

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function renderLaw(lawKey) {
  const n = lawNodeByKey.get(lawKey);
  return n ? `${lawKey}（${n.label}）` : lawKey;
}

// 相关术语引用计数：总数与跨组标注数（跨组才标文件名，同组不标）
const relatedStat = { total: 0, cross: 0 };

function renderRelated(rec) {
  const items = [...rec.relatedIds]
    .map((id) => ({ id, name: label(id), grp: groupOfTerm.get(id) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return items.map((it) => {
    relatedStat.total += 1;
    if (!it.grp || it.grp === rec.group) return it.name;
    relatedStat.cross += 1;
    return `${it.name}（→ ${it.grp.file}）`;
  });
}

function renderTerm(rec) {
  const out = [`## ${rec.canonical}`, ''];
  if (rec.aliases.length) out.push(`- 别名：${rec.aliases.join(ALIAS_SEP)}`);
  if (rec.definition) out.push(`- 释义：${truncate(rec.definition, DEF_MAX_CHARS)}`);
  for (const o of rec.occurrences) {
    out.push(`- 出处：${withCrumb(o.label, o.breadcrumb)} → \`${slicePointer(o.nodeId)}\``);
  }
  if (rec.lawKeys.size) {
    const laws = [...rec.lawKeys].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    out.push(`- 相关法条：${laws.map(renderLaw).join(ITEM_SEP)}`);
  }
  const related = renderRelated(rec);
  if (related.length) out.push(`- 相关术语：${related.join(ITEM_SEP)}`);
  out.push('');
  return out.join('\n');
}

function renderGroupFile(g) {
  const sorted = [...g.terms].sort((a, b) => a.canonical.localeCompare(b.canonical, 'zh-CN'));
  const head = [
    `# ${String(g.no).padStart(2, '0')} ${g.name}`,
    '',
    `本组收录 **${sorted.length}** 个词条，按词条名排序。`,
    g === MISC
      ? '本组为兜底组：词条无主题归类（topicKey 为空），或其 topicKey 未被任何主题分组收编。'
      : `主题分组 key：\`${g.key}\`；收编细粒度主题：${g.members.map((m) => `\`${m}\``).join('、')}。`,
    '',
    '指针语义：`…/` 结尾为容器目录（内含 `_preamble.md` 与下级叶片），`.md` 为最小节切片。',
    '',
    '---',
    '',
    '',
  ];
  return head.join('\n') + sorted.map(renderTerm).join('\n');
}

// ============ 八、渲染：交叉参见 ============

function renderCrossRefs() {
  const xrefs = edges.filter((e) => e.type === 'xref');
  const lawrefs = edges.filter((e) => e.type === 'lawref');

  const out = [
    '# 交叉参见与法条引用总表',
    '',
    '本文件汇总知识库图谱中的**章节↔章节交叉参见**与**章节→法条引用**两类关系，',
    '并附全部法条节点的切片指针速查表。指针语义：`…/` 结尾为容器目录，`.md` 为最小节切片。',
    '',
    '---',
    '',
    '## 一、章节交叉参见（xref）',
    '',
    `共 ${xrefs.length} 条交叉参见边，**双向展开**为 ${xrefs.length * 2} 行（每条边在两端章节各登记一次），`,
    '按左侧章节所属书分组。行末指针指向**对端**章节。',
    '',
  ];

  // 双向展开：每条边生成两行，各自归入其左侧章节所属书
  const rows = [];
  for (const e of xrefs) {
    rows.push({ from: e.source, to: e.target });
    rows.push({ from: e.target, to: e.source });
  }
  for (const b of BOOKS) {
    const mine = rows
      .filter((r) => bookOf(r.from) === b.dir)
      .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
    if (!mine.length) continue;
    out.push(`### 《${b.name}》（${mine.length} 行）`, '');
    for (const r of mine) {
      out.push(`- ${nodeWithCrumb(r.from)} → ${nodeWithCrumb(r.to)} · \`${slicePointer(r.to)}\``);
    }
    out.push('');
  }

  // ② lawref 按 target 法条聚合
  out.push('---', '', '## 二、法条引用（lawref）', '');
  const byLaw = new Map();
  for (const e of lawrefs) {
    if (!byLaw.has(e.target)) byLaw.set(e.target, []);
    byLaw.get(e.target).push(e.source);
  }
  out.push(
    `共 ${lawrefs.length} 条引用边，聚合到 ${byLaw.size} 个法条节点。每节为一条法条，`,
    '其下列出引用该法条的章节及其切片指针。',
    '',
  );
  for (const lawId of [...byLaw.keys()].sort()) {
    const n = nodeById.get(lawId);
    const key = n?.lawKey ? `${n.lawKey} · ` : '';
    out.push(`### ${key}${label(lawId)} · \`${slicePointer(lawId)}\``, '');
    const citers = [...new Set(byLaw.get(lawId))].sort(
      (a, b) => BOOK_ORDER.get(bookOf(a)) - BOOK_ORDER.get(bookOf(b)) || a.localeCompare(b),
    );
    for (const c of citers) out.push(`- ${nodeWithCrumb(c)} → \`${slicePointer(c)}\``);
    out.push('');
  }

  // ③ 法条指针速查（全量法条节点）
  out.push('---', '', '## 三、法条指针速查', '');
  const lawNodes = [...lawNodeByKey.values()].sort((a, b) => a.id.localeCompare(b.id));
  out.push(
    `全部 ${lawNodes.length} 个法条节点的 lawKey → 条名 → 切片指针。`,
    '各主题分组文件中「相关法条」只写 lawKey 与中文条名，其切片路径在此表一跳可得。',
    '',
    '| lawKey | 条名 | 切片指针 |',
    '| --- | --- | --- |',
  );
  for (const n of lawNodes) {
    out.push(`| ${n.lawKey} | ${n.label} | \`${slicePointer(n.id)}\` |`);
  }
  out.push('');
  return out.join('\n');
}

// ============ 九、渲染：README ============

function renderReadme(stamp) {
  const rows = ALL_GROUPS.map(
    (g) => `| \`${g.file}\` | ${g.name} | ${g.terms.length} |`,
  );
  return [
    '# 专利知识库 · 关键词索引（term-index）',
    '',
    `本目录是专利知识库术语图谱的**蒸馏索引**：${EXPECTED_TERM_TOTAL} 个词条按 23 组主题分档，`,
    '每个词条给出别名、释义、出处章节与**切片指针**、相关法条、相关术语。',
    '索引本身不含法条与指南正文——正文在七书切片树中，本索引负责把问题落到具体切片路径。',
    '',
    '## 一、总览',
    '',
    '| 文件 | 主题分组 | 词条数 |',
    '| --- | --- | --- |',
    ...rows,
    `| **合计** | — | **${ALL_GROUPS.reduce((s, g) => s + g.terms.length, 0)}** |`,
    '',
    '另有 `cross-references.md`：① 章节交叉参见（xref）双向表；② 法条引用（lawref）按法条聚合；',
    '③ 法条指针速查（全量法条节点 lawKey → 条名 → 指针）。',
    '',
    '## 二、指针语义',
    '',
    '词条「出处」与交叉参见行末的反引号内容即**切片指针**，为 skills-package 内相对路径，',
    '首段是书目录，`_chunks/` 之后是该书的层级编号：',
    '',
    '- 以 `/` 结尾（如 `examination-guideline/_chunks/02/008/05/02/`）——**容器目录**。',
    '  目录内含 `_preamble.md`（本级导语）与下级叶片；需要通读该节时读目录，需要精确条文时下钻。',
    '- 以 `.md` 结尾（如 `patent-law/_chunks/03/008.md`）——**最小节切片**，可直接读取，',
    '  文件头带 KEYPOINTS 分点块。',
    '',
    '编号宽度固定：第 1 段 2 位、第 2 段 3 位、第 3 段起各 2 位。',
    '',
    '## 三、检索建议',
    '',
    '推荐两步走：**先在本索引锁定出处指针，再按指针读切片**，不要一上来全库 grep 正文。',
    '',
    '```bash',
    '# 1) 按术语名/别名定位词条与其出处指针（词条标题为二级标题）',
    'grep -n "等同原则" term-index/*.md',
    '',
    '# 2) 浏览某一主题下的全部词条',
    'grep -n "^## " term-index/20-infringement.md',
    '',
    '# 3) 反查某条法条被哪些章节引用、以及它自己的切片路径',
    'grep -n "专利法第26条" term-index/cross-references.md',
    '```',
    '',
    '拿到指针后，把它原样拼到 skills-package 根下读取——',
    '指针以 `/` 结尾时先读其中的 `_preamble.md`，以 `.md` 结尾时直接读该文件。',
    '',
    '## 四、数据来源',
    '',
    `- 生成自专利知识库术语图谱：${EXPECTED_TERM_TOTAL} 个词条、七书 ${nodes.length - EXPECTED_TERM_TOTAL} 个章节/法条节点。`,
    '- 主题分档依据 `site/scripts/lib/topics.mjs` 的 `TERM_TOPIC_GROUPS`（22 组），',
    '  未落组者归 `99-misc.md`。',
    '- 交叉参见与法条引用取自图谱 `edges.json` 的 `xref` / `lawref` / `termrel` 三类边。',
    '- 全部切片指针在生成时对七书切片树逐条校验存在性，存在率 100%。',
    `- 生成脚本：\`site/scripts/export-term-index.mjs\`；生成日期：${stamp}。`,
    '',
  ].join('\n');
}

// ============ 十、落盘与自检 ============

function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const target = join(outDir, 'term-index');
  mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);

  const files = [];
  for (const g of ALL_GROUPS) files.push([g.file, renderGroupFile(g)]);
  files.push(['cross-references.md', renderCrossRefs()]);
  // README 末位生成：总览计数依赖各组已装载，指针全部已经过 slicePointer 校验
  files.push(['README.md', renderReadme(stamp)]);

  for (const [name, text] of files) writeFileSync(join(target, name), text, 'utf8');

  // —— 断言 1：词条总数 ——
  if (records.length !== EXPECTED_TERM_TOTAL) {
    console.error(`✗ 断言失败：词条总数 ${records.length} ≠ ${EXPECTED_TERM_TOTAL}`);
    process.exit(1);
  }

  // —— 断言 2：23 组分计求和 = 851，且各组文件头计数 = 实际条目数 ——
  const sum = ALL_GROUPS.reduce((s, g) => s + g.terms.length, 0);
  if (sum !== EXPECTED_TERM_TOTAL) {
    console.error(`✗ 断言失败：23 组分计求和 ${sum} ≠ ${EXPECTED_TERM_TOTAL}`);
    process.exit(1);
  }
  if (ALL_GROUPS.length !== 23) {
    console.error(`✗ 断言失败：分组数 ${ALL_GROUPS.length} ≠ 23`);
    process.exit(1);
  }
  for (const g of ALL_GROUPS) {
    const text = readFileSync(join(target, g.file), 'utf8');
    const declared = Number(/本组收录 \*\*(\d+)\*\* 个词条/.exec(text)?.[1] ?? -1);
    const actual = (text.match(/^## /gm) || []).length;
    if (declared !== g.terms.length || actual !== g.terms.length) {
      console.error(
        `✗ 断言失败：${g.file} 文件头计数 ${declared} / 实际条目 ${actual} / 内存 ${g.terms.length} 三者不一致`,
      );
      process.exit(1);
    }
  }

  // —— 断言 3：全部切片指针 fs 存在率 100%（对照外层七书切片树复核）——
  const missing = [...emittedPointers].filter((p) => !existsSync(join(KB_ROOT, p)));
  if (missing.length) {
    console.error(`✗ 断言失败：${missing.length} 个切片指针在磁盘不存在，例如 ${missing.slice(0, 5).join(', ')}`);
    process.exit(1);
  }

  // —— 断言 4：未知 topicKey 清单（应为空；若非空，其词条已全部落 99-misc）——
  if (unknownTopicKeys.size) {
    console.warn(`⚠ 未落组的 topicKey ${unknownTopicKeys.size} 个（词条已归入 ${MISC.file}）：`);
    for (const [k, n] of unknownTopicKeys) console.warn(`   ${k}（${n} 词）`);
  }

  // —— 汇报 ——
  const dirPtr = [...emittedPointers].filter((p) => p.endsWith('/')).length;
  console.log(`✓ 输出目录：${target}`);
  console.log(`✓ 文件数：${files.length}（22 组 + 99-misc + cross-references + README）`);
  console.log(`✓ 词条总数：${records.length}；23 组分计求和：${sum}`);
  console.log(`✓ 切片指针：${emittedPointers.size} 个去重指针全部存在（容器 ${dirPtr} / 叶片 ${emittedPointers.size - dirPtr}）`);
  console.log(`✓ 未知 topicKey：${unknownTopicKeys.size} 个`);
  console.log(
    `✓ 相关术语引用：${relatedStat.total} 处，其中跨组标注 ${relatedStat.cross} 处` +
      `（现数据 termrel 关系全部落在组内，故跨组标注为 0 属数据事实）`,
  );
  console.log(
    `✓ 边用量：xref ${edges.filter((e) => e.type === 'xref').length} / ` +
      `lawref ${edges.filter((e) => e.type === 'lawref').length} / termrel ${termrelCount}`,
  );
  console.log('\n分组词条数：');
  for (const g of ALL_GROUPS) console.log(`  ${g.file.padEnd(28)} ${g.name.padEnd(12)} ${g.terms.length}`);
}

main();
