// check-taxonomy.mjs —— P9 不变量：图谱域分组（graphSections.ts）与分类元数据（domains.mjs）一致性校验
//
// 背景：76 部书按六标签（field）分类的单一事实源是 site/scripts/lib/domains.mjs；
// 图谱侧的分组显隐/配色单一事实源是 quartz-kb/quartz/util/graphSections.ts 的 SECTION_GROUPS
// （该文件因 esbuild 零依赖约束、不能 import domains.mjs，见其文件头注释）。两处各自维护、
// 却描述同一件事——「哪些顶层目录前缀属于哪个法域」，故需要一个独立脚本比对二者是否同构，
// 范式与既有 P7（BOOKS 双文件逐字节比对，mcp/scripts/build-data.mjs 与 site/scripts/build-quartz-md.mjs）一致：
// 本脚本不 import 任何一侧的"重"脚本（避免误跑其副作用——build-data.mjs 会写 dist/kb-data.json.gz，
// graphSections.ts 是 .ts 不能被 node 直接 import），而是解析其源码文本、安全求值出数据结构后比对。
//
// 比对链路：graphSections.ts 的 SECTION_GROUPS[].prefixes（顶层目录数字前缀）
//         → 经 build-data.mjs 的 BOOKS（order → domain）映射为域 key
//         → 经 domains.mjs 的 KNOWN_DOMAINS（domain → field/docType）取得该域的分类
//         → field 与该组号按折叠规则得出的「期望标签」比对；
//           docType 与该组自带的 SectionGroup.docType 比对（阶段5.11 波L 新增，
//           组内混文种即组划分错误——图例的文种子段会把同一个组塞进两个子段）。
//         逐条不一致即报错并 exit 1。
//
// 折叠规则（组号 → 期望 field；"9" 为术语层非书域，不参与比对）见下方 GROUP_ID_TO_FIELD。
//
// 用法：node scripts/check-taxonomy.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { KNOWN_DOMAINS, DOC_TYPES, FIELDS } from '../../site/scripts/lib/domains.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, '..', '..');
const BUILD_DATA_FILE = join(SCRIPT_DIR, 'build-data.mjs');
const GRAPH_SECTIONS_FILE = join(REPO_DIR, 'quartz-kb', 'quartz', 'util', 'graphSections.ts');

const errors = [];
const fail = (msg) => { errors.push(msg); };

// ============ 一、通用：括号平衡提取（跳过字符串与行注释，避免被文本中偶发的括号字符误判） ============
function extractBalanced(text, startIdx, openCh, closeCh, label) {
  let depth = 0;
  let inStr = null;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  throw new Error(`${label}：未找到与起点匹配的「${closeCh}」，源文件格式可能已变，请检查后更新本脚本的提取逻辑`);
}

// 安全求值：提取出的文本只应是纯数据字面量（字符串/数字/数组/对象，允许内嵌 // 注释），
// 不含函数调用或外部变量引用；用 Function 构造器在独立作用域内求值，不触及真实模块作用域。
function safeEvalArrayLiteral(literalText, label) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`'use strict'; return (${literalText});`)();
  } catch (e) {
    throw new Error(`${label}：提取到的文本无法作为数组字面量求值（${e.message}）——源文件格式可能已变`);
  }
}

// ============ 二、从 build-data.mjs 源码文本提取 BOOKS（order → domain） ============
// 不 import build-data.mjs 本体：该文件顶层会读取 site/data/*.json 并在末尾写 dist/kb-data.json.gz，
// import 即执行、副作用不可接受；只取其 BOOKS 常量的文本做只读解析。
function loadBooksOrderToDomain() {
  let src;
  try {
    src = readFileSync(BUILD_DATA_FILE, 'utf8');
  } catch (e) {
    throw new Error(`读取 build-data.mjs 失败：${e.message}`);
  }
  const marker = 'const BOOKS = [';
  const markerIdx = src.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`build-data.mjs 中未找到 "${marker}"——BOOKS 常量的声明写法可能已变，请更新本脚本的提取逻辑`);
  }
  const bracketStart = markerIdx + marker.length - 1; // 指向开头的 '['
  const arrLiteral = extractBalanced(src, bracketStart, '[', ']', 'build-data.mjs BOOKS 数组');
  const books = safeEvalArrayLiteral(arrLiteral, 'build-data.mjs BOOKS 数组');
  if (!Array.isArray(books) || !books.length) {
    throw new Error('build-data.mjs 提取出的 BOOKS 求值结果不是非空数组，源文件格式可能已变');
  }
  const orderToDomain = new Map();
  for (const b of books) {
    if (typeof b?.order !== 'number' || typeof b?.domain !== 'string' || !b.domain) {
      throw new Error(`build-data.mjs BOOKS 条目缺少合法的 order/domain 字段：${JSON.stringify(b)}`);
    }
    if (orderToDomain.has(b.order)) {
      throw new Error(`build-data.mjs BOOKS 中 order=${b.order} 重复（${orderToDomain.get(b.order)} 与 ${b.domain}）`);
    }
    orderToDomain.set(b.order, b.domain);
  }
  return { orderToDomain, count: books.length };
}

// ============ 三、从 graphSections.ts 源码文本提取 SECTION_GROUPS（id/label/prefixes/tier） ============
// graphSections.ts 是 TypeScript 文件，不能被 node 直接 import；且该文件刻意零依赖，
// 不应为了校验反过来给它加 import。只解析其源码文本，安全求值出纯数据部分。
function loadSectionGroups() {
  let src;
  try {
    src = readFileSync(GRAPH_SECTIONS_FILE, 'utf8');
  } catch (e) {
    throw new Error(`读取 graphSections.ts 失败：${e.message}`);
  }
  const declMarker = 'export const SECTION_GROUPS';
  const declIdx = src.indexOf(declMarker);
  if (declIdx === -1) {
    throw new Error(`graphSections.ts 中未找到 "${declMarker}"——声明写法可能已变，请更新本脚本的提取逻辑`);
  }
  // 类型标注本身含 "SectionGroup[]"（方括号），故须先定位赋值号 "="，再从其后找数组字面量的 '['，
  // 否则会误把类型标注里的 '[' 当成数组起点。
  const eqIdx = src.indexOf('=', declIdx);
  if (eqIdx === -1) throw new Error('graphSections.ts 中 SECTION_GROUPS 声明后未找到 "="，格式可能已变');
  const bracketStart = src.indexOf('[', eqIdx);
  if (bracketStart === -1) throw new Error('graphSections.ts 中 SECTION_GROUPS 赋值号后未找到数组起始 "["，格式可能已变');
  const arrLiteral = extractBalanced(src, bracketStart, '[', ']', 'graphSections.ts SECTION_GROUPS 数组');
  const groups = safeEvalArrayLiteral(arrLiteral, 'graphSections.ts SECTION_GROUPS 数组');
  if (!Array.isArray(groups) || !groups.length) {
    throw new Error('graphSections.ts 提取出的 SECTION_GROUPS 求值结果不是非空数组，源文件格式可能已变');
  }
  for (const g of groups) {
    if (typeof g?.id !== 'string' || typeof g?.label !== 'string' || !Array.isArray(g?.prefixes) || typeof g?.tier !== 'string') {
      throw new Error(`graphSections.ts SECTION_GROUPS 条目缺少合法的 id/label/prefixes/tier 字段：${JSON.stringify(g)}`);
    }
    // 波L：非术语组必须声明 docType（图例的文种子段据此归并）
    if (g.tier !== 'term' && typeof g.docType !== 'string') {
      throw new Error(`graphSections.ts SECTION_GROUPS 组 id="${g.id}"（label="${g.label}"）缺少 docType 字段`);
    }
  }
  return groups;
}

// ============ 四、折叠规则：组号 → 期望 field（"9" 术语层跳过，见文件头说明） ============
// 2026-08-31 阶段5.11 波L：图例按「法域 × 文种」完整归类，6 个跨文种扩展组被拆开，
// 组数 15 → 30、新增组号 16–30。本表刻意仍是**独立手写**的期望表，而非从
// graphSections.ts 的 SectionGroup.field 直接取值——P9 的价值正在于「两侧各自
// 声明、由脚本比对」，若改成读同一处字段，校验就退化为自证。
const GROUP_ID_TO_FIELD = {
  1: '专利', 2: '专利', 3: '专利', 4: '专利', 5: '专利', 6: '专利', 7: '专利',
  10: '专利', // 专利·规章（波L 前为「专利扩展」整组）
  16: '专利', // 专利·法规（国防专利条例 / 专利代理条例）
  17: '专利', // 专利·司解
  18: '专利', // 专利·指引（行政裁决办案指南 / 专利质量评价指南）
  8: '商标',  // 商标·规章（波L 前为「商标」整组）
  15: '商标', // 2026-08-24 阶段5.1：商标审查审理指南自组 8 拆出独立成组（prefix 80）
  19: '商标', // 商标·法律
  20: '商标', // 商标·法规
  21: '商标', // 商标·司解
  13: '著作权', // 著权·法规（波L 前为「著作权」整组）
  22: '著作权', // 著权·法律
  23: '著作权', // 著权·规章
  24: '著作权', // 著权·司解
  12: '竞争法', // 竞争·司解（波L 前为「竞争法」整组）
  25: '竞争法', // 竞争·法律
  26: '竞争法', // 竞争·规章
  11: '品种布图', // 品图·司解（波L 前为「品种布图」整组）
  27: '品种布图', // 品图·法规
  28: '品种布图', // 品图·规章
  14: '综合程序', // 综合·司解（波L 前为「综合程序」整组）
  29: '综合程序', // 综合·法规
  30: '综合程序', // 综合·规章
};
const SKIP_GROUP_IDS = new Set(['9']); // 术语层，非书域，不参与比对

// ============ 五、76 域三字段齐备与取值合法性校验 ============
// 沿革：2026-08-24 阶段5.2 批 Q-1 新入库《专利质量评价指南》（prefix 91，
// key quality-evaluation），KNOWN_DOMAINS 由 87 增至 88；同批 Q-2 另将
// GROUP_ID_TO_FIELD 的 5/6 键（机械/化学撰写规范）随 SECTION_GROUPS 召回为
// main 组一并核验（该两键此前已在，未被 5.1 摘除影响，见下表）。
// 2026-08-30 阶段5.11 波O：12 部低检索价值文献归档下线（编号 51/53/63/72/74/75/
// 77/79/82/87/89/90），三处登记表同批注释摘除，KNOWN_DOMAINS 由 88 减至 76；
// 该批 GROUP_ID_TO_FIELD 折叠规则表不变（组号与法域映射零变更，仅组内前缀变少）。
// 2026-08-31 阶段5.11 波L：SECTION_GROUPS 按「法域 × 文种」拆组，15 → 30 组，
// GROUP_ID_TO_FIELD 随之补入 16–30 共 15 个新组号；KNOWN_DOMAINS 仍 76 域、
// 书目与 field 取值零变更（拆的是图谱侧的分组，不是书的分类）。
function checkDomainsTaxonomyFields() {
  if (KNOWN_DOMAINS.length !== 76) {
    fail(`KNOWN_DOMAINS 长度 ${KNOWN_DOMAINS.length} ≠ 76`);
  }
  const docTypeKeys = new Set(Object.keys(DOC_TYPES));
  for (const d of KNOWN_DOMAINS) {
    if (d.country !== 'CN') fail(`域 ${d.key}：country 缺失或非 'CN'（实际 ${JSON.stringify(d.country)}）`);
    if (!FIELDS.includes(d.field)) fail(`域 ${d.key}：field 缺失或不在 FIELDS 六标签之内（实际 ${JSON.stringify(d.field)}）`);
    if (!docTypeKeys.has(d.docType)) fail(`域 ${d.key}：docType 缺失或不在 DOC_TYPES D1–D6 之内（实际 ${JSON.stringify(d.docType)}）`);
  }
}

// ============ 六、主流程：比对 SECTION_GROUPS 与 domains.field ============
function main() {
  checkDomainsTaxonomyFields();

  const { orderToDomain, count: booksCount } = loadBooksOrderToDomain();
  if (booksCount !== KNOWN_DOMAINS.length) {
    fail(`build-data.mjs BOOKS 条目数 ${booksCount} ≠ domains.mjs KNOWN_DOMAINS 长度 ${KNOWN_DOMAINS.length}（P7 应已保证二者一致，此处出现偏差说明上游已变）`);
  }
  const domainByKey = new Map(KNOWN_DOMAINS.map((d) => [d.key, d]));

  const groups = loadSectionGroups();

  let comparedPrefixes = 0;
  let comparedGroups = 0;
  const seenPrefixes = new Map(); // prefix → groupId（跨组重复登记检测）

  for (const g of groups) {
    if (SKIP_GROUP_IDS.has(g.id)) continue;
    const expectedField = GROUP_ID_TO_FIELD[Number(g.id)];
    if (expectedField === undefined) {
      fail(`SECTION_GROUPS 组 id="${g.id}"（label="${g.label}"）未被折叠规则表覆盖——`
        + '新增了图谱分组组号？请先更新本脚本 GROUP_ID_TO_FIELD 或确认是否应加入 SKIP_GROUP_IDS');
      continue;
    }
    comparedGroups++;
    for (const prefix of g.prefixes) {
      comparedPrefixes++;
      if (seenPrefixes.has(prefix)) {
        fail(`前缀 ${prefix} 同时登记于组 "${seenPrefixes.get(prefix)}" 与组 "${g.id}"（SECTION_GROUPS 内部重复，与 P9 无关但一并拦截）`);
      } else {
        seenPrefixes.set(prefix, g.id);
      }
      const domain = orderToDomain.get(prefix);
      if (!domain) {
        fail(`组 "${g.id}"（${g.label}）前缀 ${prefix} 在 build-data.mjs BOOKS 中无对应域（order→domain 映射落空）`);
        continue;
      }
      const meta = domainByKey.get(domain);
      if (!meta) {
        fail(`组 "${g.id}"（${g.label}）前缀 ${prefix} 映射到域 ${domain}，但该域不在 domains.mjs KNOWN_DOMAINS 中`);
        continue;
      }
      if (meta.field !== expectedField) {
        fail(`不一致：组 "${g.id}"（${g.label}）前缀 ${prefix} → 域 ${domain}（${meta.title}）`
          + `的 field="${meta.field}"，与该组折叠规则期望的 field="${expectedField}" 不符`);
      }
      // 波L：组内单文种。组自带的 docType 是图例文种子段的归并键，
      // 一旦与某个成员前缀的实际 docType 不符，该书在图例里就会被归进错误的文种子段。
      if (meta.docType !== g.docType) {
        fail(`不一致：组 "${g.id}"（${g.label}）前缀 ${prefix} → 域 ${domain}（${meta.title}）`
          + `的 docType="${meta.docType}"，与该组声明的 docType="${g.docType}" 不符`
          + '（组内不得混文种：图例按 (法域, 文种) 分子段，混文种即组划分错误）');
      }
    }
  }

  if (errors.length) {
    console.error(`P9 校验失败，共 ${errors.length} 项：`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }

  console.log('P9（check-taxonomy）通过：');
  console.log(`  domains.mjs：${KNOWN_DOMAINS.length} 域 country/field/docType 三字段齐备、取值均合法。`);
  console.log(`  build-data.mjs BOOKS：${booksCount} 条 order→domain 映射，与 KNOWN_DOMAINS 条目数一致。`);
  console.log(`  graphSections.ts SECTION_GROUPS：共 ${groups.length} 组（比对 ${comparedGroups} 组、跳过 ${groups.length - comparedGroups} 组「术语层」），`
    + `合计比对 ${comparedPrefixes} 个顶层目录前缀，逐一折叠映射后与 domains 的 field 与 docType 全部一致。`);
}

main();
