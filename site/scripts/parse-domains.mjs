// 数据管线 1/3（多源版）：把项目根目录下发现的每部规范的主 md 解析为节点树，合并成一张星图数据。
//   - guideline（《专利审查指南》）走特例：# 部 / ## 章 / ### 节 / #### 子节 四层真标题 826 节点，
//     阶段5.3 批次 W2 再把正文中的三级裸编号（`4.1.1发明名称`，394 处）与四级自链接编号
//     （`[4.1.3.1](4.1.3.1)申请人是本国人`，168 处）＋1 处畸形伪链接还原（4.2.1.2）升为节点，
//     合计 1389 节点（6/38/259/1086）；原 826 个 id 与其 fullText 派生字段逐字保持，向后兼容。
//   - tmeg（《商标审查审理指南》）走语义特例：源 md「编/部分/章」同为 H1，按标题文字判类重建
//     part/chapter/section/subsection 树 = 1200 节点（7/44/206/943，语义深度上限 7）。
//     阶段5.1 批次 T-1 先立四级树 104 节点（8/44/48/4）；阶段5.2 批次 W-1 再把章/条正文中的
//     一级、二级数字编号段升为节点（净增 709），使其与《专利审查指南》的节/子节两层同构；
//     阶段5.3 批次 W1 再摘除「公布与施行」part（813→812，part 8→7）；
//     同阶段批次 W2 把三级及更深编号段（388 处＝三级 300/四级 71/五级 17）一并升为节点（812→1200）。
//   - 两书的深层识别实现与 slice-tools（rules.mjs / lib/tmeg.mjs / lib/tree.mjs）**逐字同源**，
//     语义权威在本文件；任一处改动须两处同改，否则节点边界与切片边界脱钩。
//   - 其余各域走通用"标题深度建树"：深度 1→chapter / 2→section / ≥3→subsection；id 加域前缀（law- / infr- …）。
//   - 三解析器共用域级前置摘除 stripPromulgation（阶段5.3 批次 W1）：主 md 首个「# 公布与施行」
//     不再成节点，其正文改由 data/book-meta.json 承载（详见该函数注释块）。
//   产物：data/nodes.json、data/node-bodies.json、data/laws.json、data/book-meta.json。
//   每节点新增字段：domain（域 key）、colorGroup（配色分组）、domainCommunity（星系序号）、community（域内子簇）、
//     lawKey（仅 patent-law / implementation-rules 的"第X条"节点，供跨域 lawref 锚定）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIndexFrontmatter } from './lib/book-meta.mjs';
import { cn2num } from './lib/cn-num.mjs';
import { discoverDomains, projectRoot, resolveDomainTitles } from './lib/domains.mjs';
import { extractLawKeys } from './lib/law-cite.mjs';
import { parseLawTitles, parseTmegGroupedTitles } from './lib/law-titles.mjs';
import { tagTopics } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(__dirname);
const OUT = join(__dirname, '..', 'data');
mkdirSync(OUT, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');

// ---- 法条抽取：见 lib/law-cite.mjs。2026-08-23（阶段 5 波B）起改用注册表引擎 extractLawKeys，
//      覆盖 domains.mjs 全部 70 部有条文规范（原 extractLaws 只认专利法／专利法实施细则两名，已降级为文档化遗留）。
//      返回形状不变：按出现顺序去重的 lawKey 串数组，nodes.laws / laws.json / lawref 边的数据形状零变更。----
function leadSummary(text) {
  const clean = text.replace(/^>.*$/gm, '').replace(/^#{1,6}.*$/gm, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const m = clean.match(/^[^。；！？]*[。；！？]?/);
  let s = (m ? m[0] : clean).trim();
  if (s.length > 70) s = s.slice(0, 68) + '…';
  return s;
}

// ---- 通用：定位标题行 / 取正文跨度（接受具体文件的 lines+headings）----
function findHeadings(lines) {
  const headings = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,4})\s+(.*\S)\s*$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i });
  });
  return headings;
}
// 某标题到下一个 level<=自身 的标题之间为 fullText；到下一个任意标题为 ownText
function spanText(lines, headings, idx, sameOrHigher) {
  const h = headings[idx];
  const start = h.line + 1;
  let end = lines.length;
  for (let j = idx + 1; j < headings.length; j++) {
    if (sameOrHigher ? headings[j].level <= h.level : true) {
      end = headings[j].line;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

// ---- 域级前置摘除：「公布与施行」H1（阶段5.3 批次 W1／D1）----
// 背景（2026-08-25 全库实测；数值经 2026-08-30 阶段5.11 波O 书目下线后重测更新）：
//   76 域中 68 域的主 md 首个标题为「# 公布与施行」，承载公布令、
//   修订沿革、施行日期等**书前元信息**而非正文层级，却被三解析器一律建成域内首个顶层节点
//   （78 chapter + tmeg 1 part），在星图与目录里与实体章节混排。本函数在 heading 流进入
//   解析器主循环／位次计数器**之前**把它摘掉，其正文改由 data/book-meta.json 承载。
// 摘除判据与实测事实：
//   ① 只认本域**第一个** level===1 且 cleanLabel 后严格等于「公布与施行」的标题。
//      实测：68 域各恰 1 处、且均落在 heading 下标 0（无一例外）；全库无非 H1 的同名标题。
//      其余 8 域无此标题（examination-guideline / patent-law / implementation-rules /
//      infringement-guide / mechanical-drafting-rules / chemistry-drafting-rules /
//      oa-response-guide / quality-evaluation），本函数原样返回。
//      〔波O〕原第 9 域 gb-standards-index 已随书目下线，故该清单由 9 域减为 8 域。
//   ② promulgationText 取该标题的 **ownText**（到下一个**任意层级**标题为止），非 fullText。
//      58 域该 H1 之下无任何子标题，两者恒等；余 10 域（下方「树根域」）该 H1 之下直挂全域
//      条文 H2，按 fullText 取文会把整部法规正文塞进元数据字段（实测 copyright-law-rules-2013
//      将由 485 字暴涨至 3886 字），故一律取 ownText。
//   ③ 摘除范围＝该标题到下一个 level<=1 标题之间；范围内其余标题 level 整体减 1（上提一级）。
//      命中 10 个「树根域」共 260 条 H2 条文因此升为顶层 chapter，与其余 58 域体例一致：
//      copyright-law-rules-2013 38 / trademark-infringement-standard-2020 38 /
//      trademark-violation-standard-2021 35 / ip-abuse-competition-2023 33 /
//      network-dissemination-regulations-2013 27 / major-patent-adjudication-2021 27 /
//      wellknown-tm-recognition-2014 21 / trademark-filing-conduct-2019 19 /
//      fee-reduction-2016 12 / patent-marking-2012 10。
//      10 域范围内均为纯 H2、无更深层级（实测 deeper=0）。
//      〔波O〕原树根域中的 work-registration-1994（17 条）与 trademark-printing-2004
//      （16 条）已随书目下线，故树根域 12 → 10、H2 条文 293 → 260（2026-08-30 重测）。
//      tmeg 的正文合成条目（带 itemLevel、level 恒 9 仅作排序占位）不参与上提——其 level
//      非层级语义；实测 tmeg 摘除范围内零合成条目，该守卫为防御性。
//   ④ 摘除发生在位次计数**之前**，故后续兄弟节点 id 自然从 01 起算，无需事后补偿。
// 回退开关：STRIP_PROMULGATION 置 false 即整体停用，三解析器退回旧行为、
//   book-meta 的 promulgationText/promulgationLabel 恒为空串。
const STRIP_PROMULGATION = true;
const PROMULGATION_LABEL = '公布与施行';
// 摘除照做、但 promulgationText 置空串的两域：
//   patent-adjudication-manual-2019：该节 4696 字全部是书前目录的「章节名 …… 页码」行
//     （原书 PDF 目录页转档残留），既非公布令也非沿革，入 book-meta 只会污染元数据；
//   trademark-exam-guide-2021：该节仅 9 字空壳「国家知识产权局 制定」，信息已由 book-meta 的
//     documentNo（国家知识产权局公告第462号）与 effectiveDate 完整覆盖。
const PROMULGATION_DROP = new Set(['patent-adjudication-manual-2019', 'trademark-exam-guide-2021']);

// 合成条目判据（阶段5.3 批次 W2 抽出为共用谓词）：tmeg 的正文编号段（itemLevel）与
//   指南的深层裸编号段（nakedDepth）都不是真标题，其 level 字段仅作排序/跨度占位、无层级语义，
//   故一律不参与 stripPromulgation 的「首个 H1」判定与范围内 level 上提。W1 原以 `!h.itemLevel`
//   表达同一意图（当时只有 tmeg 有合成条目），此处仅把指南的合成条目并入同一谓词，语义不变。
const isSynthHeading = (h) => Boolean(h.itemLevel || h.nakedDepth);

function stripPromulgation(lines, headings, domKey) {
  const untouched = { headings, promulgationText: '', promulgationLabel: '' };
  if (!STRIP_PROMULGATION) return untouched;
  const at = headings.findIndex((h) => !isSynthHeading(h) && h.level === 1 && cleanLabel(h.text) === PROMULGATION_LABEL);
  if (at < 0) return untouched;

  const ownEnd = at + 1 < headings.length ? headings[at + 1].line : lines.length;
  const ownText = lines.slice(headings[at].line + 1, ownEnd).join('\n').trim();

  let stop = headings.length; // 摘除范围右界：下一个 level<=1 标题的下标
  for (let j = at + 1; j < headings.length; j++) {
    if (!isSynthHeading(headings[j]) && headings[j].level <= 1) { stop = j; break; }
  }

  const out = [];
  for (let j = 0; j < headings.length; j++) {
    if (j === at) continue;
    const lift = j > at && j < stop && !isSynthHeading(headings[j]);
    out.push(lift ? { ...headings[j], level: headings[j].level - 1 } : headings[j]);
  }
  return {
    headings: out,
    promulgationText: PROMULGATION_DROP.has(domKey) ? '' : ownText,
    promulgationLabel: PROMULGATION_LABEL,
  };
}

// ---- 合并产物累加器 ----
const allNodes = [];
const bodies = {};
const lawIndex = {};
const byId = new Map(); // id -> node（面包屑标签回查）

function pushNode(node, body) {
  allNodes.push(node);
  byId.set(node.id, node);
  bodies[node.id] = body;
  for (const k of node.laws) (lawIndex[k] ||= []).push(node.id);
}

// ============ guideline 特例解析（真标题四层 + 深层裸编号两层）============
// ---- 阶段5.3 批次 W2：三级 / 四级深层编号升节点 ----
// 源文形态（2026-08-25 全书实测，与 slice-tools 的 562+1 片实测同源）：
//   三级 = **裸行首点分三段编号**，编号与标题文字之间空白可有可无
//     （`4.2.1退款的原则` md:10189 / `6.2.1 要求外国优先权` md:12277）。全书 395 行命中，
//     其中 394 处为真三级节，1 处为伪候选（md:13195 书末索引续行
//     「4.7.2；Ⅱ.Ⅸ－5.1；Ⅱ.Ⅹ－3；Ⅱ.Ⅹ－9.2」），由下方前缀门槛剔除。
//   四级 = **markdown 自链接形**（mineru 为四级标题生成的锚点）`[4.1.3.1](4.1.3.1)申请人是本国人`，
//     左右编号以反向引用 \1 强制一致，全书 168 行命中、全部为真。
//   畸形伪链接 = 四级的转换器故障变体，全库唯一 1 例 md:10213
//     `[4.2.1.](4.2.1.3)2不予退款的情形`：显示文本被截为 `4.2.1.`、末段数字 `2` 挤到右括号之后，
//     链接目标 `4.2.1.3` 是转换器另行写入的锚点 id（该书并无 4.2.1.3 节）、**不参与还原**；
//     还原走拼接「显示文本 + 尾随数字」= `4.2.1.2`，其父 `4.2.1`（md:10189）确实存在。
//   全书无五级编号（最深即四级）。
// 识别顺序 NAKED4 → NAKED3 → NAKED4_SPLIT：SPLIT 只接管前两者均未命中的行，避免把正常自链接
//   与裸三级误走还原分支。三条正则与 slice-tools/rules.mjs 的 NAKED3 / NAKED4 / NAKED4_SPLIT 逐字同源。
// 伪编号排除**只用前缀门槛、禁用任何数值阈值**：本书三级编号分量上限 15、四级上限 17，
//   套用 tmeg 的 TMEG_ITEM_MAX(14) 会误杀真编号（tmeg 侧同类教训见 slice-tools/rules.mjs:87-89）。
const G_NAKED3 = /^(\d+(?:\.\d+){2})(?![.\d])\s*(\S.*)$/;
const G_NAKED4 = /^\[(\d+(?:\.\d+){3})\]\(\1\)\s*(\S.*)$/;
const G_NAKED4_SPLIT = /^\[(\d+(?:\.\d+)*\.)\]\((\d+(?:\.\d+)*)\)(\d+)\s*(\S.*)$/;

// 审计台账（供主流程打印与强校验；每次运行覆写）
const glAudit = { naked3: 0, naked4: 0, recovered: 0, rejected: [] };

// 从正文行合成「伪标题」，与 findHeadings 的真标题按源行归并后共用建树主循环。
//   `^#` 行一律跳过 —— 真标题由 findHeadings 承接，正文切分不得重复识别。
//   level 5 = 三级、level 6 = 四级：这两级高于真标题的 1..4，故 spanText 取 fullText 时
//   （条件 headings[j].level <= h.level）不会截断任何真标题的跨度 —— 既有 826 个节点的
//   fullText 及其派生字段（charLen / laws / topics / lawScope）逐字保持。
function guidelineSynthHeadings(lines) {
  const synth = [];
  glAudit.naked3 = 0; glAudit.naked4 = 0; glAudit.recovered = 0;
  lines.forEach((raw, i) => {
    if (/^#/.test(raw)) return;
    let m = G_NAKED4.exec(raw);
    if (m) {
      synth.push({ level: 6, text: `${m[1]} ${m[2].trim()}`, line: i, nakedNum: m[1], nakedDepth: 4 });
      glAudit.naked4++; return;
    }
    m = G_NAKED3.exec(raw);
    if (m) {
      synth.push({ level: 5, text: `${m[1]} ${m[2].trim()}`, line: i, nakedNum: m[1], nakedDepth: 3 });
      glAudit.naked3++; return;
    }
    m = G_NAKED4_SPLIT.exec(raw);
    if (m) {
      const num = `${m[1]}${m[3]}`; // '4.2.1.' + '2' → '4.2.1.2'
      const depth = num.split('.').length;
      synth.push({ level: 2 + depth, text: `${num} ${m[4].trim()}`, line: i, nakedNum: num, nakedDepth: depth, recovered: true });
      glAudit.recovered++;
    }
  });
  return synth;
}

// 前缀门槛（prefixAssert，对应 slice-tools/lib/tree.mjs::scanUnits 的采信门槛）：
//   合成条目须「编号前缀与最近祖先一致 **且恰深一级**」才采信 ——
//     三级 X.Y.Z 的最近 #### 祖先编号须恰为 X.Y；四级 X.Y.Z.W 的最近三级祖先编号须恰为 X.Y.Z
//     （畸形伪链接还原后的编号同此门槛，其父 4.2.1 存在故采信）。
//   门槛在**建树之前**执行：不采信者连同其行一并移出 headings，既不出节点、也不截断父节点的
//   ownText（否则被剔除处之后的正文会脱离节点树，破坏全书字符守恒）。
//   剔除项记入 glAudit.rejected，由主流程逐条打印行号与原文，**不静默丢弃**。
//   实测（2026-08-25）恰剔除 1 处：md:13195 书末索引续行「4.7.2；Ⅱ.Ⅸ－5.1…」——
//   其所在的索引区无 #### 祖先，curSub 为 null，门槛不通过。
function gateGuidelineNaked(headings) {
  const out = [];
  glAudit.rejected = [];
  let curSub = null; // 最近 #### 的编号「X.Y」
  let curN3 = null; // 最近采信的三级编号「X.Y.Z」
  for (const h of headings) {
    if (!h.nakedDepth) {
      if (h.level <= 3) { curSub = null; curN3 = null; }
      else { const m = h.text.match(/^(\d+)\.(\d+)(?![.\d])/); curSub = m ? `${m[1]}.${m[2]}` : null; curN3 = null; }
      out.push(h); continue;
    }
    const anc = h.nakedDepth === 3 ? curSub : curN3;
    const want = h.nakedNum.slice(0, h.nakedNum.lastIndexOf('.'));
    if (anc === null || anc !== want) {
      glAudit.rejected.push({ line: h.line + 1, num: h.nakedNum, want, got: anc, text: h.text.slice(0, 60) });
      continue;
    }
    if (h.nakedDepth === 3) curN3 = h.nakedNum;
    out.push(h);
  }
  return out;
}

// id 内容驱动（沿 parseGuideline 既有口径：节 id 取标题内的「N」、子节取「X.Y」，非兄弟位次）：
//   节        `{部}-{章}-{N}`            3 段
//   子节      `{部}-{章}-{X}-{Y}`        4 段
//   三级(新)  `{部}-{章}-{X}-{Y}-{Z}`    5 段
//   四级(新)  `{部}-{章}-{X}-{Y}-{Z}-{W}` 6 段
//   段数与深度一一对应，故新 id 与既有 id 天然不撞；两位 pad 足够（分量实测上限 17）。
function parseGuideline(dom, domCommunity) {
  const lines = readFileSync(dom.mainMd, 'utf8').split('\n');
  // 本域无「公布与施行」标题（实测零命中），摘除逻辑照走以保持三解析器行为一致；
  //   零命中时 headings 原样返回同一数组引用，真标题层与各字段逐字节零变化。
  const merged = [...findHeadings(lines), ...guidelineSynthHeadings(lines)].sort((a, b) => a.line - b.line);
  const strip = stripPromulgation(lines, merged, dom.key);
  const { promulgationText, promulgationLabel } = strip;
  const headings = gateGuidelineNaked(strip.headings);
  let curPart = null, curChap = null, curSec = null, curSub = null, curN3 = null;

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    let id, level, label, partNum, chapterNum = null, sectionNum = null, subNum = null;
    const depth = h.level; // 真标题 1..4 与合成条目 5..6 的声明深度即语义深度（本书不跳级）
    const ownText = spanText(lines, headings, i, false);
    const fullText = spanText(lines, headings, i, true);

    if (h.level === 1) {
      const m = h.text.match(/^第([一二三四五六七八九十]+)部分\s*(.+)$/);
      partNum = cn2num(m[1]); label = m[2].trim();
      id = pad(partNum); level = 'part';
      curPart = { id, partNum }; curChap = null; curSec = null; curSub = null; curN3 = null;
    } else if (h.level === 2) {
      const m = h.text.match(/^第([一二三四五六七八九十]+)章\s*(.+)$/);
      chapterNum = cn2num(m[1]); label = m[2].trim();
      partNum = curPart.partNum;
      id = `${pad(partNum)}-${pad(chapterNum)}`; level = 'chapter';
      curChap = { id, chapterNum }; curSec = null; curSub = null; curN3 = null;
    } else if (h.level === 3) {
      const m = h.text.match(/^(\d+)\.?\s*(.+)$/);
      sectionNum = parseInt(m[1], 10); label = m[2].trim();
      partNum = curPart.partNum; chapterNum = curChap.chapterNum;
      id = `${curChap.id}-${pad(sectionNum)}`; level = 'section';
      curSec = { id, sectionNum }; curSub = null; curN3 = null;
    } else if (h.level === 4) {
      const m = h.text.match(/^(\d+)\.(\d+)\.?\s*(.+)$/);
      const sN = parseInt(m[1], 10), uN = parseInt(m[2], 10); label = m[3].trim();
      partNum = curPart.partNum; chapterNum = curChap.chapterNum; sectionNum = sN; subNum = uN;
      id = `${curChap.id}-${pad(sN)}-${pad(uN)}`; level = 'subsection';
      curSub = { id }; curN3 = null;
    } else {
      // 深层裸编号（三级 level 5 / 四级 level 6）：id 由编号各分量直接拼出，与真标题层同一口径。
      //   sectionNum / subNum 记其**祖先**节、子节序号（与 tmeg 深层节点同体例），
      //   level 复用 'subsection'（GENERIC_LEVELS 先例，不新造类型）。
      const parts = h.nakedNum.split('.').map((v) => parseInt(v, 10));
      label = h.text.slice(h.nakedNum.length).trim();
      partNum = curPart.partNum; chapterNum = curChap.chapterNum;
      sectionNum = parts[0]; subNum = parts[1];
      id = [curChap.id, ...parts.map(pad)].join('-'); level = 'subsection';
      if (h.nakedDepth === 3) curN3 = { id };
    }

    const lawScope = level === 'subsection' || level === 'section' ? fullText : ownText;
    const laws = extractLawKeys(lawScope, dom.key);
    const topics = tagTopics(`${label} ${lawScope}`);

    // 面包屑：逐级祖先 label（本域不含域名前缀，与单源版一致）
    const breadcrumb = [];
    if (depth >= 2 && curPart) breadcrumb.push(byId.get(curPart.id)?.label);
    if (depth >= 3 && curChap) breadcrumb.push(byId.get(curChap.id)?.label);
    if (depth >= 4 && curSec) breadcrumb.push(byId.get(curSec.id)?.label);
    if (depth >= 5 && curSub) breadcrumb.push(byId.get(curSub.id)?.label);
    if (depth >= 6 && curN3) breadcrumb.push(byId.get(curN3.id)?.label);

    pushNode(
      {
        id, level, partNum, chapterNum, sectionNum, subNum,
        num: h.text.match(/^[\d.]+/) ? h.text.match(/^[\d.]+/)[0].replace(/\.$/, '') : null,
        label,
        breadcrumb: breadcrumb.filter(Boolean),
        laws,
        topics,
        charLen: fullText.replace(/\s/g, '').length,
        summary: leadSummary(ownText || fullText),
        community: partNum, // 域内子簇（六部）
        domainCommunity: domCommunity,
        domain: dom.key,
        colorGroup: `g${partNum}`,
        hasOwnText: ownText.replace(/\s/g, '').length > 0,
      },
      { line: h.line + 1, ownText, fullText },
    );
  }
  return { promulgationText, promulgationLabel };
}

// ============ tmeg 特例解析（《商标审查审理指南》语义四级树）============
// 背景：本域源 md 的「编 / 部分 / 章」全部被拍平为 H1（mineru 转档所致，源文不改），通用解析
//   因此产出 53 个同层 chapter 的三级平铺树。本解析器改为**语义驱动**：不看 # 深度，按标题文字
//   判类，重建与《专利审查指南》同构的 part / chapter / section / subsection 四级树。
//
// 判类规则（TMEG_KIND）：
//   'part'    第N部分 …… ；以及既非编/部分/章的 H1（前言「公布与施行」、书末「《…》的说明」）
//   'chapter' 第N章 ……
//   'book'    以「编」收尾的 H1（上编「形式审查和事务工作编」、下编「商标审查审理编」）
//   'item'    其余（第X条 / 数字条目 18.3.2 等），按通用解析的跳级折算语义定 section / subsection
//
// 「编」的处置（数据驱动，不硬编码）：编下若直接含「部分」则该编溶解为其各部分 label 的前缀
//   （上编·第N部分 ××，U+00B7 间隔号），编自身不成节点；编下若无「部分」（下编）则该编自身
//   升为 part（label「下编·商标审查审理编」），其各章直接挂此 part。
//   （2026-08-24 阶段5.1 批次 T-2：编名与其后成分的分隔符统一为 U+00B7 间隔号，原「下编 」半角
//    空格与「上编·」体例不一致，致 label 前缀判定须兼容两种写法。两处现均为 U+00B7。）
//   编序 → 编名由 _index.md 与书末说明佐证：第 1 编＝上编、第 2 编＝下编。
const TMEG_LEVELS = ['part', 'chapter', 'section', 'subsection']; // 语义深度 1..4；≥5 复用 subsection（GENERIC_LEVELS 先例），上限 7
const TMEG_BOOK_WORDS = ['上编', '下编'];
const RE_TMEG_PART = /^第[一二三四五六七八九十百]+部分/;
const RE_TMEG_CHAPTER = /^第[一二三四五六七八九十百]+章/;

// ---- 阶段5.2 批次 W-1：正文数字编号段升节点；阶段5.3 批次 W2：三级及更深一并升节点 ----
// 源 md 的章/条正文里，一级「1法律依据」与二级「2.1书面审查原则」是**纯正文行**（无 # 前缀，
//   mineru 转档未识别为标题），重构前全部沉在父节点 ownText 内，致上编 25 章平均每章一个巨块、
//   下编「第X条」节点动辄上千字不可检索。W-1 先把这两层升为节点，与《专利审查指南》的
//   节/子节两层同构；三级 x.y.z 及更深（全书 388 处＝三级 300／四级 71／五级 17）当时仍留正文。
//   阶段5.3 批次 W2 把这 388 处一并升为节点（812→1200），与《专利审查指南》同批的三级/四级
//   升节点对齐，两书自此在深层编号上体例一致。
//
// 切分正则与伪编号过滤（阈值由全书实测定版，勿凭直觉调整）：
//   一级 RE_TMEG_ITEM1：编号紧贴文字，全书 242 处命中；二级 RE_TMEG_ITEM2：483 处命中。
//   ① 任一分量 > TMEG_ITEM_MAX(14) 判伪 —— 实测一级真值上限 14（L3629「14撤回申请」）、
//      二级上限 12.11，超出者全为商标示例（990418 / 95557 / 13055 / 123一二三 / 360贷款 /
//      365DAY / 22世纪 / 19 R）或案例叙述年份（2019年4月23日… / 2017年，国外某公司…）。
//      注：初版探查曾把「22世纪」误认作合法一级并把阈值定在 30，经第五章序列断裂暴露后修正为 14。
//   ② 数字后紧邻拉丁字母（空白可选）判伪 —— 1 de MENDOZA / 1 Donghai Road / 3M / 3D 时代 / 5P6。
//      空白必须可选：3M、3D 时代、5P6 三例无空格，早期「数字+空格+拉丁」写法会漏判。
//      不误伤真编号：真编号后接汉字或中文引号（如 L9865「4 “在先使用”的判定」带空格但接中文引号）。
//   ③ 数字后紧跟度量单位判伪 —— 仅 L6814「5.5度」1 处（烧酒酒精度示例）。
//   过滤合计 16 处（15 处一级 + 1 处二级），保留 709 处（227 一级 + 482 二级）。
//   正确性兜底见主流程「序列连续性断言」：章内一级、章内同父二级须自 1 起逐一递增，
//   零断裂零跳号。伪编号若漏过滤会插入序列、真编号若被误杀会留下跳号，两侧均被该断言拦截。
const RE_TMEG_ITEM1 = /^(\d+)(?![\d.])/;
const RE_TMEG_ITEM2 = /^(\d+)\.(\d+)(?![\d.])/;
// 三级及更深（阶段5.3 批次 W2 新增；与 slice-tools/rules.mjs::TMEG_ITEM3P 逐字同源）。
//   ⚠️ **不套 TMEG_ITEM_MAX** —— 该阈值是为一/二级的商标示例（990418 / 95557 / 22世纪 …）而定，
//   到三级会误杀 5 处真编号（3.3.15 节日名称 md:7048 / 3.3.16 格言警句 md:7054 /
//   5.1.15 md:7883 / 5.1.16 md:7917 / 5.1.17 md:7937 —— 三级第三段真值上限 17）。
//   教训见 slice-tools/rules.mjs:87-89。三级及更深的正确性改由「前缀一致 + 恰深一级」门槛
//   （下方 tmegPrefixAssert，实测 388/388 通过、0 violation）与序列连续性断言双向把关，
//   本处只保留「数字紧邻拉丁」「数字+单位」两道形态过滤（实测两道对深层零命中）。
const RE_TMEG_ITEM3P = /^(\d+(?:\.\d+){2,})(?![\d.])/;
const TMEG_ITEM_MAX = 14;
const RE_TMEG_FAKE_LATIN = /^[\d.]+\s*[A-Za-z]/;
const RE_TMEG_FAKE_UNIT = /^(?:度|℃|%|％|米|厘米|毫米|千米|公里|克|千克|吨|升|毫升|元|万|亿|倍|岁|天|小时|分钟|秒|年|月|日)/;

// 审计台账（供主流程打印；每次运行覆写）
const tmegAudit = { filtered: [], item1: 0, item2: 0, deep: 0, deepByDepth: {}, prefixBad: [] };
// 参与序列连续性断言的节点 id（解析期按前缀门槛登记，判据见 parseTmegGuideline 前置 2）
const tmegSeqIds = new Set();

// 从正文行合成「伪标题」，与 findHeadings 的真标题合并后共用一套建树逻辑。
//   `^#` 行一律跳过 —— 真标题（含书末 2 个维也纳码 H3「18.3.2」「7.11.1」）由 findHeadings 承接，
//   正文切分规则不得误碰它们（否则 18.3.2 会被 ①>14 判伪而丢节点）。
function tmegSynthHeadings(lines) {
  const synth = [];
  tmegAudit.filtered = [];
  lines.forEach((raw, i) => {
    if (/^#/.test(raw)) return;
    let m = raw.match(RE_TMEG_ITEM1);
    let itemLevel = 1;
    if (!m) { m = raw.match(RE_TMEG_ITEM2); itemLevel = 2; }
    if (m) {
      const rest = raw.slice(m[0].length);
      const rec = (why) => tmegAudit.filtered.push({ line: i + 1, itemLevel, why, text: raw.slice(0, 44) });
      if (m[0].split('.').map(Number).some((v) => v > TMEG_ITEM_MAX)) return rec(`分量>${TMEG_ITEM_MAX}`);
      if (RE_TMEG_FAKE_LATIN.test(raw)) return rec('数字紧邻拉丁');
      if (RE_TMEG_FAKE_UNIT.test(rest)) return rec('数字+单位');
      synth.push({ level: 9, text: raw.trim(), line: i, itemLevel });
      return;
    }
    // 三级及更深（阶段5.3 批次 W2）：itemLevel 直接取编号点分段数（3/4/5），
    //   与一/二级的 itemLevel 语义一致（＝编号深度），供 tmegItemDecl 统一折算。
    const d = raw.match(RE_TMEG_ITEM3P);
    if (!d) return;
    const numDepth = d[1].split('.').length;
    const rest = raw.slice(d[0].length);
    const rec = (why) => tmegAudit.filtered.push({ line: i + 1, itemLevel: numDepth, why, text: raw.slice(0, 44) });
    if (RE_TMEG_FAKE_LATIN.test(raw)) return rec('数字紧邻拉丁');
    if (RE_TMEG_FAKE_UNIT.test(rest)) return rec('数字+单位');
    synth.push({ level: 9, text: raw.trim(), line: i, itemLevel: numDepth, itemNum: d[1] });
  });
  tmegAudit.item1 = synth.filter((s) => s.itemLevel === 1).length;
  tmegAudit.item2 = synth.filter((s) => s.itemLevel === 2).length;
  const deep = synth.filter((s) => s.itemLevel >= 3);
  tmegAudit.deep = deep.length;
  tmegAudit.deepByDepth = deep.reduce((a, s) => ((a[s.itemLevel] = (a[s.itemLevel] || 0) + 1), a), {});
  return synth;
}

function tmegKind(h) {
  if (h.itemLevel) return 'item'; // 正文合成条目
  if (RE_TMEG_PART.test(h.text)) return 'part';
  if (RE_TMEG_CHAPTER.test(h.text)) return 'chapter';
  if (h.level === 1 && /编$/.test(h.text)) return 'book';
  if (h.level === 1) return 'part'; // 前言 / 书末说明等无编号的顶层件
  return 'item';
}

// item 的嵌套判据（declDepth：仅供祖先栈比较，非语义深度本身）：
//   真 H1/H2 标题（下编「第X条」）→ 2；正文编号段 → **编号深度 + 2**（一级 3 / 二级 4 /
//     三级 5 / 四级 6 / 五级 7）；真 H3 标题（7 个既有历史节点）→ 同式，按其编号点数折算
//     （x→3、x.y→4、x.y.z→5）。
//   阶段5.3 批次 W2 前，两个分支分别写死为「一级3/二级4」与「seg>=3?5:seg===2?4:3」；
//     现统一为 seg+2。在既有语料上取值逐一等价——实测 7 个真 H3 的编号段数只有 2 与 3
//     （4.1 / 4.2 → 4；2.5.2 / 3.9.5 / 3.2.2 / 18.3.2 / 7.11.1 → 5），旧式的 `seg>=3` 封顶
//     从未在 seg≥4 上触发；合成条目侧 1→3、2→4 亦与旧式相同。统一后三级及更深的合成条目
//     （W2 新增）才能与真 H3 在同一祖先栈上正确咬合。
//   该折算使既有 H3 节点与新合成层无缝咬合：4.1/4.2 成为「4适用要件」之子；
//   2.5.2 / 3.9.5 / 3.2.2 成为各自二级父（2.5 / 3.9 / 3.2）之子；
//   维也纳码 18.3.2 / 7.11.1（源 L2198/L2200）按三级折算，挂到其所在的二级「3.2」之下。
function tmegItemDecl(h) {
  if (h.itemLevel) return h.itemLevel + 2;
  if (h.level <= 2) return 2;
  const m = h.text.match(/^(\d+(?:\.\d+)*)/);
  if (m) return m[1].split('.').length + 2;
  return 3;
}

// 编号取值（供前缀门槛用）：合成条目取其识别到的编号；真标题取行首点分数字（「第X条」等无编号者 null）。
function tmegNum(h) {
  if (h.itemNum) return h.itemNum;
  const m = h.text.match(/^(\d+(?:\.\d+)*)(?![\d.])/);
  return m ? m[1] : null;
}

// 语义深度版跨度取文：与 spanText 同形，但用语义深度数组 sem[] 取代标题声明深度。
//   ownText（sameOrHigher=false）到下一个任意标题为止 —— 与通用解析逐字一致；
//   fullText（sameOrHigher=true）到下一个语义深度 ≤ 自身的标题为止 —— 使 part 覆盖其整部内容。
//   被溶解的「编」标题不出节点，但在 sem[] 中记 1，仍作为顶层边界参与截断。
function spanTextSem(lines, headings, sem, idx, sameOrHigher) {
  const start = headings[idx].line + 1;
  let end = lines.length;
  for (let j = idx + 1; j < headings.length; j++) {
    if (sameOrHigher ? sem[j] <= sem[idx] : true) {
      end = headings[j].line;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function parseTmegGuideline(dom, domCommunity) {
  const lines = readFileSync(dom.mainMd, 'utf8').split('\n');
  // 真标题 + 正文合成条目，按源行归并为一条建树序列（阶段5.2 批次 W-1）
  const merged = [...findHeadings(lines), ...tmegSynthHeadings(lines)].sort((a, b) => a.line - b.line);
  tmegSeqIds.clear();
  // 「公布与施行」前置摘除（阶段5.3 批次 W1）：本域该 H1 判类为 part（旧 tmeg-01，9 字空壳），
  //   摘后 part 8→7、总数 813→812，tmeg-01 改指原「上编·第一部分 商标申请形式审查」。
  //   摘除在 kinds/sem 计算之前，故三者下标始终对齐。
  const { headings, promulgationText, promulgationLabel } = stripPromulgation(lines, merged, dom.key);
  // 条旨：本域改走「下编章序:条号」复合键（阶段5.1 批次 T-4，理由见 lib/law-titles.mjs 头注与下方取旨处）
  const titles = parseTmegGroupedTitles(join(dom.dir, '_index.md'));
  const kinds = headings.map(tmegKind);

  // ---- 前置 1：编的序号与「是否直接含部分」----
  const bookIdx = headings.map((_, i) => i).filter((i) => kinds[i] === 'book');
  if (bookIdx.length !== TMEG_BOOK_WORDS.length) {
    throw new Error(`tmeg：期望 ${TMEG_BOOK_WORDS.length} 个「编」，实得 ${bookIdx.length}（${bookIdx.map((i) => headings[i].text).join('、')}）`);
  }
  const bookWordAt = new Map(); // 编标题下标 → 上编/下编
  const bookDissolved = new Map(); // 编标题下标 → 是否溶解为其部分的 label 前缀
  bookIdx.forEach((bi, k) => {
    bookWordAt.set(bi, TMEG_BOOK_WORDS[k]);
    const stop = bookIdx[k + 1] ?? headings.length;
    // 只认「第N部分」体例的部分；书末「《…》的说明」虽也判为 part，但不是编的下辖部分，不参与判定
    let hasPart = false;
    for (let j = bi + 1; j < stop; j++) if (kinds[j] === 'part' && RE_TMEG_PART.test(headings[j].text)) { hasPart = true; break; }
    bookDissolved.set(bi, hasPart);
  });

  // ---- 前置 2：逐标题算语义深度（item 用与通用解析同款的跳级折算，相对「章」封顶）----
  //   封顶 2→4（阶段5.2 批次 W-1）、4→5（阶段5.3 批次 W2）：语义深度上限 4→6→7，
  //   以容纳三级及更深的正文编号段。
  //   上编：章(2) → 一级(3) → 二级(4) → 三级(5) → 四级(6) → 五级(7)；既有三级 H3 同落 5。
  //   下编：章(2) → 第X条(3) → 一级(4) → 二级(5) → 三级(6) → 四级(7)。
  //   下编各章「1法律依据」在首个「第X条」H2 之前出现，declDepth 3 > 第X条的 2，故按源文顺序
  //   落在 sem 3、与「第X条」平级挂章直属（用户拍板口径）；实测 21 处（18 章各 1 处「1法律依据」，
  //   加下编第一章「概述」全章无「第X条」、其 3 个一级段悉数章直属）。
  //
  //   前缀门槛（prefixAssert，与 slice-tools/lib/tmeg.mjs::buildTmegRecords 同款、升为常驻断言）：
  //   点分编号须以最近**有编号祖先**的编号 + '.' 为前缀且**恰深一级**（单段编号如「1法律依据」
  //   无此约束，恒视为通过）。该门槛两处用：
  //     ① 硬断言 —— 只对三级及更深的**正文合成条目**（itemLevel≥3，W2 新增 388 处）生效，
  //        这是替代 TMEG_ITEM_MAX 的把关手段（阈值到三级会误杀 5 处真编号，见 RE_TMEG_ITEM3P
  //        头注）。实测 388/388 通过、0 violation；违反者记账后由主流程打印行号与原文并 exit 1。
  //     ② 序列参与判据 —— 通过者登记进 tmegSeqIds，参与下方主流程的序列连续性断言。
  //        全域 1104 个有点分编号的节点中恰 2 个不通过、被排除：md:2199「18.3.2」与 md:2201
  //        「7.11.1」是**商标图形要素维也纳分类号**（真 H3 标题），挂在二级「3.2」之下、
  //        编号与父不同源，本非章内顺序编号，纳入序列必然误报。其余 2 个真 H3 三级
  //        （2.5.2 / 3.2.2）与 3.9.5 / 4.1 / 4.2 前缀均与父一致，照常参与——它们与 W2 新增的
  //        合成条目在同一条源文序列上（如 2.5.1 合成、2.5.2 真 H3、2.5.3 合成），
  //        若按「只认合成条目」划范围反而会在这两处制造假断裂。
  const sem = new Array(headings.length).fill(1);
  const seqEligible = new Array(headings.length).fill(false);
  tmegAudit.prefixBad = [];
  {
    let itemStack = []; // [{ declDepth, num }]，仅章内条目
    for (let i = 0; i < headings.length; i++) {
      if (kinds[i] === 'book' || kinds[i] === 'part') { sem[i] = 1; itemStack = []; continue; }
      if (kinds[i] === 'chapter') { sem[i] = 2; itemStack = []; continue; }
      const declDepth = tmegItemDecl(headings[i]);
      while (itemStack.length && itemStack[itemStack.length - 1].declDepth >= declDepth) itemStack.pop();
      sem[i] = 2 + Math.min(itemStack.length + 1, 5); // 3=section / 4..7=subsection
      const num = tmegNum(headings[i]);
      const anc = [...itemStack].reverse().find((s) => s.num);
      const prefixOk = Boolean(num) && (num.indexOf('.') < 0 || (
        Boolean(anc) && num.startsWith(`${anc.num}.`)
        && num.split('.').length === anc.num.split('.').length + 1
      ));
      seqEligible[i] = prefixOk;
      if (headings[i].itemLevel >= 3 && !prefixOk) {
        tmegAudit.prefixBad.push({
          line: headings[i].line + 1, num, ancestor: anc ? anc.num : null, text: headings[i].text.slice(0, 60),
        });
      }
      itemStack.push({ declDepth, num });
    }
  }

  // ---- 主循环：出节点 ----
  const counters = [0, 0, 0, 0, 0, 0, 0, 0]; // 语义深度 1..7 各自的兄弟序号（8 位留一位余量）
  let curBook = null; // { word, dissolved }
  let curPartLabel = null; // 面包屑用（part 层用其复合 label）
  let curChapRaw = null; // 面包屑用（章用源标题原文，与通用解析一致、不带条旨）
  let itemStack = []; // [{ declDepth, raw }]，面包屑用
  let inLowerBook = false; // 当前 part 是否为「下编」——条旨复合键的章序仅在下编内有效

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const kind = kinds[i];

    if (kind === 'book') {
      curBook = { word: bookWordAt.get(i), dissolved: bookDissolved.get(i) };
      if (curBook.dissolved) continue; // 溶解：不出节点，仅作 label 前缀与顶层边界
    }

    const depth = sem[i];
    const level = TMEG_LEVELS[Math.min(depth, 4) - 1]; // 深度 ≥5 复用 subsection，不新造类型
    counters[depth - 1]++;
    for (let d = depth; d < counters.length; d++) counters[d] = 0;
    const segs = [];
    for (let d = 0; d < depth; d++) segs.push(pad(counters[d] || 1));
    const id = [dom.prefix, ...segs].join('-');
    if (seqEligible[i]) tmegSeqIds.add(id); // 过前缀门槛者登记，供序列连续性断言划范围

    // ---- label ----
    let label = cleanLabel(h.text);
    if (kind === 'book') label = `${curBook.word}·${label}`; // 下编·商标审查审理编（U+00B7，与「上编·」同体例）
    else if (kind === 'part' && RE_TMEG_PART.test(h.text) && curBook) label = `${curBook.word}·${label}`; // 上编·第一部分 ××
    // 条旨（阶段5.1 批次 T-4：本域改按「下编章序:条号」复合键取旨，不再用全局条号单值 Map）
    //   下编 19 章解读的 45 个「第X条」跨《商标法》《商标法实施条例》《规范商标申请注册行为若干规定》
    //   三部法源，同号异法（如第二章「第三条」引《规范…若干规定》、第十章「第三条」引《条例》），
    //   单值 Map 只保留首见值会误按《商标法》取义。查无该复合键即不拼条旨——**不退回全局条号 Map**，
    //   宁可缺条旨也不错配。上编无「第X条」节点，故键中不含编维度、仅在下编内生效。
    const lm = h.text.match(/^第([一二三四五六七八九十百零〇两]+)条/);
    if (lm && inLowerBook) {
      const tt = titles.get(`${counters[1]}:${lm[0]}`);
      if (tt) label = `${label} · ${tt}`;
    }
    // dom.lawName 为空 → 本域不产 lawKey（与通用解析一致，商标法条号非本域自身条文）

    // ---- 层级上下文 ----
    if (depth === 1) { curPartLabel = label; curChapRaw = null; itemStack = []; inLowerBook = kind === 'book' && curBook?.word === '下编'; }
    else if (depth === 2) {
      if (!curPartLabel) throw new Error(`tmeg：章「${h.text}」出现在任何「部分/编」之前，无 part 可挂载`);
      curChapRaw = cleanLabel(h.text); itemStack = [];
    } else {
      const declDepth = tmegItemDecl(h);
      while (itemStack.length && itemStack[itemStack.length - 1].declDepth >= declDepth) itemStack.pop();
    }

    const breadcrumb = [dom.title];
    if (depth >= 2) breadcrumb.push(curPartLabel);
    if (depth >= 3) breadcrumb.push(curChapRaw);
    if (depth >= 4) breadcrumb.push(...itemStack.map((s) => s.raw));

    const ownText = spanTextSem(lines, headings, sem, i, false);
    const fullText = spanTextSem(lines, headings, sem, i, true);
    const hasChild = i + 1 < headings.length && sem[i + 1] > depth;
    const lawScope = hasChild ? ownText : fullText; // 与通用解析同口径，避免 part 吞并全部法条
    const laws = extractLawKeys(lawScope, dom.key);
    const topics = tagTopics(`${label} ${lawScope}`);

    pushNode(
      {
        id, level,
        partNum: counters[0],
        chapterNum: depth >= 2 ? counters[1] || null : null,
        sectionNum: depth >= 3 ? counters[2] || null : null,
        subNum: depth >= 4 ? counters[3] || null : null,
        num: numFromHeading(h.text),
        label,
        breadcrumb: breadcrumb.filter(Boolean),
        laws,
        topics,
        charLen: fullText.replace(/\s/g, '').length,
        summary: leadSummary(ownText || fullText),
        community: domCommunity, // 与通用域一致：整域一团（不按部再分子簇，避免动图谱配色/布局）
        domainCommunity: domCommunity,
        domain: dom.key,
        colorGroup: dom.key,
        hasOwnText: ownText.replace(/\s/g, '').length > 0,
      },
      { line: h.line + 1, ownText, fullText },
    );

    if (depth >= 3) itemStack.push({ declDepth: tmegItemDecl(h), raw: cleanLabel(h.text) });
  }
  return { promulgationText, promulgationLabel };
}

// ============ 通用解析（专利法 / 侵权判定 / 撰写规范 / 答复指引 等）============
const GENERIC_LEVELS = ['chapter', 'section', 'subsection', 'subsection']; // 深度 1..4

// ---- 标题文本归一：markdown 转义反解 + 空白折叠（阶段5.3 批次 W1／D7 增补转义反解）----
// 反解范围＝CommonMark 允许被反斜杠转义的 ASCII 标点全集
//   !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~（含反斜杠自身）；其余反斜杠原样保留（如 `\n` 字面）。
// 顺序：先反解、后折叠空白 —— 反解可能产出空白（如 `\ ` 不在集合内故不会，但 `\_` 等
//   反解后仍需与前后文一同折叠），先折叠会让 `\` 与其后标点被空白切开而漏解。
// 全库实测（2026-08-25）：仅《商标审查审理指南》2 处 label 受影响 ——
//   tmeg-04「上编·第三部分 其他商标业务审查\*」（源 md L2260 真 H1）与
//   tmeg-07-06-05-01「2释义\*」（源 md L8096 正文合成条目），连带 83 处 breadcrumb 引用；
//   两处的 `\*` 均系 mineru 转档为保护正文星号而加的转义，非原书内容。
//   其余 86 域的全部标题行零反斜杠，无合法反斜杠 label 会被误伤。
// 核实结论（2026-08-25 复核）：parseGuideline 不经 cleanLabel（其 label 由条/章/节正则捕获组
//   直接产出），且《专利审查指南》源 md 的**标题行**零转义序列——全文仅 2 处转义（L6335 正文
//   遗传算法示例中的 `\[` 与 `\]`），均在正文、不进任何 label，故本次改动对该域零影响。
const RE_MD_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
function cleanLabel(text) {
  return text.replace(RE_MD_ESCAPE, '$1').replace(/\s+/g, ' ').trim();
}
function numFromHeading(text) {
  const m = text.match(/^(第[一二三四五六七八九十百零]+条|第[一二三四五六七八九十]+[章节]|[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

function parseGeneric(dom, domCommunity) {
  const lines = readFileSync(dom.mainMd, 'utf8').split('\n');
  // 「公布与施行」前置摘除（阶段5.3 批次 W1）：本解析器辖下 86 域中 78 域命中。
  //   66 域为纯前言（摘后该域节点数 −1，兄弟位次整体前移）；12 域为「树根域」，其 293 条 H2
  //   条文经 level−1 上提为顶层 —— 下方祖先栈按声明深度判嵌套，上提后栈空、depth=1，
  //   自然产出 chapter 级顶层节点，无需为此另加分支（实测验证，见批次自证清单第 5 项）。
  const { headings, promulgationText, promulgationLabel } = stripPromulgation(lines, findHeadings(lines), dom.key);
  const titles = parseLawTitles(join(dom.dir, '_index.md')); // 条号→小标题（无索引/无条旨行时为空 Map）
  const counters = [0, 0, 0, 0];
  // 祖先栈：{ declDepth（标题声明深度，用于判定嵌套）, label（面包屑用）}
  //   栈内元素声明深度严格递增，故弹栈后 stack.length 即当前节点的真实祖先数。
  const stack = [];

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const declDepth = Math.min(h.level, 4); // 标题声明深度

    // ---- 跳级折算（2026-08-22）----
    // 嵌套关系按声明深度判定：弹出所有声明深度 ≥ 当前的祖先，剩余栈即真实祖先链。
    // 有效深度 = min(声明深度, 真实父深度 + 1) = 真实祖先数 + 1（因祖先声明深度严格递增，
    // 祖先数 ≤ 声明深度 − 1，故该式恒 ≤ 声明深度，min 自动成立）。
    // 语义即「### 在无 ## 父时按二级处理」，对任意跳级组合通用。
    // 修复前用声明深度直接生成 id，并以 pad(counters[d] || 1) 为缺失层级补幻影段 `01`，
    // 致《著作权法》4 个无节的章下共 33 条条文的隐含父（cpl-02-01 等）不存在、层级断链。
    while (stack.length && stack[stack.length - 1].declDepth >= declDepth) stack.pop();
    const depth = Math.min(stack.length + 1, 4); // 有效深度

    counters[depth - 1]++;
    for (let d = depth; d < 4; d++) counters[d] = 0;

    const segs = [];
    for (let d = 0; d < depth; d++) segs.push(pad(counters[d] || 1));
    const id = [dom.prefix, ...segs].join('-');
    const level = GENERIC_LEVELS[depth - 1];

    const ownText = spanText(lines, headings, i, false);
    const fullText = spanText(lines, headings, i, true);
    // hasChild 用声明深度比较：因 next.declDepth > cur.declDepth ⟺ next.depth > cur.depth，二者等价
    const hasChild = i + 1 < headings.length && headings[i + 1].level > h.level;
    const lawScope = hasChild ? ownText : fullText;
    const laws = extractLawKeys(lawScope, dom.key);

    // 面包屑：域名 + 各级祖先标题（栈已在上方按声明深度弹好）
    const breadcrumb = [dom.title, ...stack.map((s) => s.label)];

    let label = cleanLabel(h.text);

    // lawKey + 小标题（2026-08-23 波A：条旨查表与 lawName 门控解耦）
    //   条旨：凡走通用解析的域，只要 _index.md 登记了「第X条（小标题）」即把"第X条"升级为"第X条 · 小标题"，
    //         不再要求该域设有 lawName（如《商标审查审理指南》按商标法条文解读，无 lawName 但有条旨）。
    //   lawKey：语义与解耦前完全一致 —— 仍仅对设了 lawName 的域产出，供跨域 lawref 锚定。
    let lawKey = null;
    const lm = h.text.match(/^第([一二三四五六七八九十百零〇两]+)条/);
    if (lm) {
      const art = cn2num(lm[1]);
      if (Number.isFinite(art)) {
        if (dom.lawName) lawKey = `${dom.lawName}第${art}条`;
        const tt = titles.get(art);
        if (tt) label = `${label} · ${tt}`;
      }
    }

    const topics = tagTopics(`${label} ${lawScope}`);

    const node = {
      id, level,
      partNum: 0, // 新域无"部"
      chapterNum: counters[0] || null,
      sectionNum: depth >= 2 ? counters[1] || null : null,
      subNum: depth >= 3 ? counters[2] || null : null,
      num: numFromHeading(h.text),
      label,
      breadcrumb,
      laws,
      topics,
      charLen: fullText.replace(/\s/g, '').length,
      summary: leadSummary(ownText || fullText),
      community: domCommunity, // 通用域不再细分子簇，整域为一团
      domainCommunity: domCommunity,
      domain: dom.key,
      colorGroup: dom.key,
      hasOwnText: ownText.replace(/\s/g, '').length > 0,
    };
    if (lawKey) node.lawKey = lawKey;

    pushNode(node, { line: h.line + 1, ownText, fullText });
    stack.push({ declDepth, label: cleanLabel(h.text) });
  }
  return { promulgationText, promulgationLabel };
}

// ============ 主流程 ============
const domains = discoverDomains(ROOT);
if (!domains.length) {
  console.error('✗ 未在项目根目录发现任何规范域（需含 _index.md + 主 md）。请确认目录结构。');
  process.exit(1);
}

// 书目元信息先行聚合（阶段5.3 批次 W3）：resolveDomainTitles 派生书名年份后缀需要全量
//   _index.md frontmatter（effectiveDate / issuedYear），故改「先统一读 88 域 frontmatter、
//   再进解析循环」——此前是边解析边聚合（bookMeta[dom.key] 在该域解析完之后才写入），
//   彼时若解析器要用到派生后的书名（parseGeneric／parseTmegGuideline 的 breadcrumb[0]），
//   会遇到"用到自己都还没写入的当前域数据"这一时序问题；改为先聚合即消除该问题。
//   promulgationText / promulgationLabel 不受影响、仍在下方解析循环中回填——其值来自主 md
//   解析期摘除的「公布与施行」标题正文，并非 _index.md front matter，此处无法一并取得。
const frontmatterByKey = {};
for (const dom of domains) frontmatterByKey[dom.key] = readIndexFrontmatter(join(dom.dir, '_index.md'));
// resolveDomainTitles 返回新数组（不改 domains/KNOWN_DOMAINS 原对象）：每域在原字段基础上
//   新增 officialTitle（官方全称原样）与派生后的 title（可能带"（YYYY年施行/发布）"后缀）。
//   下游 parseGeneric／parseTmegGuideline 的 breadcrumb[0] 取 dom.title，自此带年份后缀；
//   parseGuideline 不引用 dom.title（该域面包屑不含书名，见其内部注释），故不受影响。
const resolvedDomains = resolveDomainTitles(frontmatterByKey, domains);

let domCommunity = 0;
const perDomainCount = {};
// 书目元信息聚合（阶段5.3 批次 W1／D2）：键序＝domains 顺序＝KNOWN_DOMAINS 顺序（88 域全部已登记，
//   discoverDomains 的「追加未登记目录」分支本库零命中）；每域值＝_index.md front matter 全字段
//   （camelCase）＋ 摘除下来的 promulgationText / promulgationLabel。
//   注意：此处刻意存 frontmatterByKey 的原始 frontmatter（不含 officialTitle/派生 title），
//   book-meta.json 是"原始事实"层，年份后缀属"派生展示"层，两者不混——下游消费方
//   （build-quartz-md.mjs／mcp/scripts/build-data.mjs）各自按需对同一份 book-meta.json
//   再次调用 resolveDomainTitles，与本文件的派生结果同源同式，不会不一致。
const bookMeta = {};
for (const dom of resolvedDomains) {
  domCommunity++;
  const before = allNodes.length;
  let promulgation;
  if (dom.special === 'guideline') promulgation = parseGuideline(dom, domCommunity);
  else if (dom.special === 'tmeg-guideline') promulgation = parseTmegGuideline(dom, domCommunity);
  else promulgation = parseGeneric(dom, domCommunity);
  perDomainCount[dom.key] = allNodes.length - before;
  bookMeta[dom.key] = {
    ...frontmatterByKey[dom.key],
    promulgationText: promulgation.promulgationText,
    promulgationLabel: promulgation.promulgationLabel,
  };
}

// ---- 校验 ----
console.log('发现规范域:', domains.map((d) => `${d.key}(${perDomainCount[d.key]})`).join(', '));

// ---- guideline 结构强校验（沿革：单源版 826＝6/38/259/523；阶段5.3 批次 W2 定版
//      1389＝6/38/259/1086）----
//   1086 subsection ＝ 真 #### 子节 523 ＋ 三级 394 ＋ 四级 168 ＋ 畸形伪链接还原 1。
//   真标题三层（part 6 / chapter 38 / section 259）与 523 个 #### 子节的 id、fullText 及其派生
//   字段（charLen / laws / topics）逐字保持——合成条目 level 5/6 高于全部真标题，
//   spanText 的 fullText 截断条件 `level <= 自身` 不受其影响。
const gl = allNodes.filter((n) => n.domain === 'examination-guideline');
let ok = true;
if (gl.length) {
  const cnt = gl.reduce((a, n) => ((a[n.level] = (a[n.level] || 0) + 1), a), {});
  const expect = { part: 6, chapter: 38, section: 259, subsection: 1086 };
  if (gl.length !== 1389) { ok = false; console.error(`✗ guideline 期望 1389，实得 ${gl.length}`); }
  for (const k in expect) if (cnt[k] !== expect[k]) { ok = false; console.error(`✗ guideline ${k} 期望${expect[k]} 实得${cnt[k]}`); }
  // 识别器分项账（数值为 2026-08-25 全书实测定版，与 slice-tools 的 naked562+recovered1 对账一致）
  const glExpect = { naked3: 394, naked4: 168, recovered: 1 };
  const glGot = { naked3: glAudit.naked3 - glAudit.rejected.length, naked4: glAudit.naked4, recovered: glAudit.recovered };
  for (const k in glExpect) {
    if (glGot[k] !== glExpect[k]) { ok = false; console.error(`✗ guideline ${k} 采信期望${glExpect[k]} 实得${glGot[k]}`); }
  }
  if (glAudit.rejected.length !== 1) { ok = false; console.error(`✗ guideline 前缀门槛剔除期望 1 处，实得 ${glAudit.rejected.length}`); }
  for (const r of glAudit.rejected) {
    console.log(`  · guideline 前缀门槛剔除 md:${r.line} 编号${r.num}（需祖先「${r.want}」，实得「${r.got ?? '无'}」）：${r.text}`);
  }
  console.log(`guideline 深层编号：三级采信 ${glGot.naked3}／四级 ${glGot.naked4}／畸形伪链接还原 ${glGot.recovered}，门槛剔除 ${glAudit.rejected.length}`);
}

// ---- tmeg 结构强校验（沿革：阶段5.1 批次 T-1 定版 104＝8/44/48/4；阶段5.2 批次 W-1 定版
//      813＝8/44/206/555；阶段5.3 批次 W1 定版 812＝7/44/206/555；同阶段批次 W2 定版
//      1200＝7/44/206/943）----
//   W2 相对 W1 净增 388＝三级 300 + 四级 71 + 五级 17（正文编号段升节点，与 slice-tools
//     slice-manifest.json 的 388 个 deep 片编号集合逐一相等）。
//   语义深度分布 1:7 / 2:44 / 3:206 / 4:421 / 5:291 / 6:168 / 7:63（合计 1200）；
//     相对 W1（1:7 / 2:44 / 3:206 / 4:421 / 5:132 / 6:2）增量落在深度 5(+159)、6(+166)、7(+63)。
//   943 subsection ＝ 深度 4..7 之和 421+291+168+63。
//   ⚠️ 深叶片参与兄弟位次计数（与 slice-tools 另起 `dNN` 命名空间的做法不同）：既有节点中
//     恰 3 个「同父下既有 node 级子、且该父新增了在其之前的深层子」的节点 id 后移一位，
//     由 W4 的 id 映射表承接（其余 809 个 W1 节点 id 逐字保持）。
//   以下为 W1 定版口径的分层来源说明，仍适用于其对应层级：
//   7 part＝上编 5 部分＋下编 1＋书末说明 1（阶段5.3 批次 W1：原第 8 个 part「公布与施行」
//     由 stripPromulgation 前置摘除，9 字空壳正文按 PROMULGATION_DROP 弃置、不入 book-meta；
//     tmeg-01 自此指向原「上编·第一部分 商标申请形式审查」，全域 part 序整体前移 1。
//     part 序前移不影响下方序列连续性断言——其分组键取「部序:章序」二元组、只做组内连续性
//     判定，不写死任何部序常量，整体平移后分组划分与组内序列逐一保持）。
//     更早：相对 105 个平铺节点减 1，去向为「形式审查和事务工作编」——编标题溶解为「上编·」
//     前缀，其自身正文为空、无内容损失。
//   44 chapter＝上编 25＋下编 19。
//   206 section（语义深度 3）＝上编一级 140 ＋ 下编章直属一级 21 ＋ 下编「第X条」45。
//   555 subsection（语义深度 4..6，深度 ≥5 复用 subsection 类型）：
//     深度4 = 421：上编二级 336 ＋ 下编条内一级 66 ＋ 下编二级（挂章直属一级之下）19
//     深度5 = 132：下编二级（挂条内一级之下）127 ＋ 上编既有 H3 三级 3（18.3.2 / 7.11.1 / 2.5.2）
//                  ＋ 下编既有 H3 二级 2（4.1 / 4.2）
//     深度6 =   2：下编既有 H3 三级 2（3.9.5 / 3.2.2）
//   分类小计：一级 227＝140+21+66；二级 482＝336+19+127；既有 H3 7＝3+2+2；「第X条」45。
//   相对 104 净增 709＝227 一级 + 482 二级；7 个既有 H3 与 45 个「第X条」全部原位保留、
//   无重复无丢失（正文切分跳过 `^#` 行，与 H3 天然去重，无需额外合并逻辑）。
const tmeg = allNodes.filter((n) => n.domain === 'trademark-exam-guide-2021');
if (tmeg.length) {
  const cnt = tmeg.reduce((a, n) => ((a[n.level] = (a[n.level] || 0) + 1), a), {});
  // 期望值随 STRIP_PROMULGATION 开关切换，使回退开关一拨即得全绿运行（差额恒为「公布与施行」1 个 part）
  const expectTotal = STRIP_PROMULGATION ? 1200 : 1201;
  const expect = { part: STRIP_PROMULGATION ? 7 : 8, chapter: 44, section: 206, subsection: 943 };
  if (tmeg.length !== expectTotal) { ok = false; console.error(`✗ tmeg 期望 ${expectTotal}，实得 ${tmeg.length}`); }
  for (const k in expect) if (cnt[k] !== expect[k]) { ok = false; console.error(`✗ tmeg ${k} 期望${expect[k]} 实得${cnt[k]}`); }
  // 语义深度分布（id 段数 − 1 即语义深度；part 数随开关联动，其余层恒定）
  const depthCnt = tmeg.reduce((a, n) => { const d = n.id.split('-').length - 1; a[d] = (a[d] || 0) + 1; return a; }, {});
  const depthExpect = { 1: STRIP_PROMULGATION ? 7 : 8, 2: 44, 3: 206, 4: 421, 5: 291, 6: 168, 7: 63 };
  for (const d in depthExpect) {
    if (depthCnt[d] !== depthExpect[d]) { ok = false; console.error(`✗ tmeg 语义深度${d} 期望${depthExpect[d]} 实得${depthCnt[d] || 0}`); }
  }
  if (tmegAudit.item1 !== 227 || tmegAudit.item2 !== 482) {
    ok = false; console.error(`✗ tmeg 正文编号段期望 一级227/二级482，实得 ${tmegAudit.item1}/${tmegAudit.item2}`);
  }
  // 深层编号段（阶段5.3 批次 W2）：388＝三级 300 / 四级 71 / 五级 17，与 slice-tools 的 deep 片数同源
  const deepExpect = { 3: 300, 4: 71, 5: 17 };
  if (tmegAudit.deep !== 388) { ok = false; console.error(`✗ tmeg 深层编号段期望 388，实得 ${tmegAudit.deep}`); }
  for (const d in deepExpect) {
    if (tmegAudit.deepByDepth[d] !== deepExpect[d]) {
      ok = false; console.error(`✗ tmeg 深层编号 ${d} 级期望${deepExpect[d]} 实得${tmegAudit.deepByDepth[d] || 0}`);
    }
  }
  if (tmegAudit.filtered.length !== 16) { ok = false; console.error(`✗ tmeg 伪编号过滤期望 16 处，实得 ${tmegAudit.filtered.length}`); }
  // 前缀门槛常驻断言（阶段5.3 批次 W2）：三级及更深须「前缀一致 + 恰深一级」，实测 388/388 通过。
  //   违反者不静默丢弃——逐条打印行号与原文并令整跑失败，交人工复核后再决定改规则还是改语料。
  for (const b of tmegAudit.prefixBad) {
    ok = false;
    console.error(`✗ tmeg 前缀门槛违反 md:${b.line} 编号${b.num}（最近有编号祖先「${b.ancestor ?? '无'}」）：${b.text}`);
  }

  // 序列连续性断言（阶段5.2 批次 W-1 常驻兜底，非过滤器；阶段5.3 批次 W2 扩至任意深度）：
  //   源文数字编号在**章内**连续编排——章内一级须 1,2,3,…；章内同一父号前缀下的更深级须
  //   x.1,x.2,… / x.y.1,x.y.2,… 逐一递增。下编「1法律依据」虽挂章直属、其后同章一级挂在
  //   「第X条」之下，源文编号仍是章内一条序列，故分组键取「部序:章序:父编号前缀」而非父节点 id。
  //   「第X条」（num 为汉字条号）不参与。
  //   双向拦截：伪编号漏过滤 → 插入序列致跳号；真编号被误杀 → 序列断裂。三级及更深不设数值
  //   阈值（见 RE_TMEG_ITEM3P 头注），本断言与前缀门槛共同承担其正确性。
  //   参与范围＝解析期过前缀门槛的节点（tmegSeqIds，判据见 parseTmegGuideline 前置 2）：
  //   全域 1104 个有点分编号的节点中 1102 个参与，排除的 2 个是维也纳分类号 18.3.2 / 7.11.1。
  //   若此断言在源 md 或切分规则变动后报警，先核对 TMEG_ITEM_MAX 与三条伪编号正则，勿直接改期望值。
  const seq = new Map();
  for (const n of tmeg) {
    if (!tmegSeqIds.has(n.id)) continue;
    const m = /^(\d+(?:\.\d+)*)$/.exec(n.num || '');
    if (!m) continue;
    const segs = m[1].split('.');
    const prefix = segs.slice(0, -1).join('.');
    const key = `${segs.length}级 第${n.partNum}部-第${n.chapterNum}章${prefix ? `-${prefix}.x` : ''}`;
    if (!seq.has(key)) seq.set(key, []);
    seq.get(key).push({ v: Number(segs[segs.length - 1]), id: n.id, label: n.label.slice(0, 26) });
  }
  let seqBad = 0;
  for (const [key, arr] of seq) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].v !== i + 1) {
        seqBad++; ok = false;
        console.error(`✗ tmeg 序列断裂 ${key}：位次${i + 1} 实得编号${arr[i].v}（${arr[i].id} ${arr[i].label}）`);
        break;
      }
    }
  }
  console.log(`tmeg 序列连续性：${seq.size} 组，断裂 ${seqBad} 组；伪编号过滤 ${tmegAudit.filtered.length} 处；深层编号 ${tmegAudit.deep} 处（前缀门槛违反 ${tmegAudit.prefixBad.length}）`);
}

// ---- 「公布与施行」摘除 + book-meta 校验（阶段5.3 批次 W1）----
//   68／76 域命中摘除（其余 8 域源 md 本无此标题）；其中 2 域（PROMULGATION_DROP）正文弃置，
//   故 promulgationText 非空者 66 域。数值原为 2026-08-25 全库 88 域态实测定版
//   （79／88 摘除、77 域有正文），2026-08-30 阶段5.11 波O 归档下线 12 部书后重测更新：
//   12 部中 11 部本有该 H1（gb-standards-index 属本无此标题的一类），故 79 → 68、77 → 66。
//   若源语料再有增删导致此处报警，先核对各域主 md 首个 H1，勿直接改期望值。
const PROMULGATION_STRIPPED_EXPECTED = 68;
const bmKeys = Object.keys(bookMeta);
if (bmKeys.length !== domains.length) { ok = false; console.error(`✗ book-meta 期望 ${domains.length} 域，实得 ${bmKeys.length}`); }
if (STRIP_PROMULGATION) {
  const stray = allNodes.filter((n) => n.label === PROMULGATION_LABEL);
  if (stray.length) { ok = false; console.error(`✗ 仍有「${PROMULGATION_LABEL}」节点 ${stray.length} 个：${stray.slice(0, 5).map((n) => n.id).join('、')}`); }
  const stripped = bmKeys.filter((k) => bookMeta[k].promulgationLabel);
  const withText = bmKeys.filter((k) => bookMeta[k].promulgationText);
  if (stripped.length !== PROMULGATION_STRIPPED_EXPECTED) {
    ok = false; console.error(`✗ 「${PROMULGATION_LABEL}」摘除期望 ${PROMULGATION_STRIPPED_EXPECTED} 域，实得 ${stripped.length}`);
  }
  if (withText.length !== PROMULGATION_STRIPPED_EXPECTED - PROMULGATION_DROP.size) {
    ok = false; console.error(`✗ promulgationText 非空期望 ${PROMULGATION_STRIPPED_EXPECTED - PROMULGATION_DROP.size} 域，实得 ${withText.length}`);
  }
  console.log(`book-meta: ${bmKeys.length} 域；「${PROMULGATION_LABEL}」摘除 ${stripped.length} 域，正文入库 ${withText.length} 域（DROP ${PROMULGATION_DROP.size}）`);
}

// id 全局唯一
const ids = new Set(allNodes.map((n) => n.id));
if (ids.size !== allNodes.length) { ok = false; console.error('✗ id 不唯一，冲突数:', allNodes.length - ids.size); }

console.log('节点合计:', allNodes.length);

writeFileSync(join(OUT, 'nodes.json'), JSON.stringify(allNodes, null, 0));
writeFileSync(join(OUT, 'node-bodies.json'), JSON.stringify(bodies, null, 0));
const laws = Object.entries(lawIndex)
  .map(([k, v]) => ({ law: k, nodes: [...new Set(v)] }))
  .sort((a, b) => b.nodes.length - a.nodes.length);
writeFileSync(join(OUT, 'laws.json'), JSON.stringify(laws, null, 0));
// book-meta.json 走「2 空格缩进 + 尾换行」的可读风格（与 tmeg-id-map-phase52.json 等
//   人读型产物一致）：本文件是 88 条书目元信息、供人工核对与下游直读，非 MB 级图数据，
//   不套 nodes/node-bodies/laws 的零缩进压缩风格。
writeFileSync(join(OUT, 'book-meta.json'), `${JSON.stringify(bookMeta, null, 2)}\n`);
console.log('法条数:', laws.length, ' Top5:', laws.slice(0, 5).map((l) => `${l.law}(${l.nodes.length})`).join(', '));
console.log(ok ? '✓ 校验通过' : '✗ 校验未通过');
if (!ok) process.exit(1);
