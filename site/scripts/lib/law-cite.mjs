// 法条引用抽取共享库（数据管线 D2）。
//
// 一、沿用版：LAW_RE + extractLaws —— 自 parse-domains.mjs 原样迁出的两法名正则。
//    ⚠ 2026-08-23（阶段 5 波B）起，parse-domains 的 nodes.laws 已改由下述注册表引擎 extractCitations 供给，
//    本对符号随之降级为**文档化遗留**：保留定义以备回滚与历史口径比对，数据管线不再调用，行为亦不再更动。
//
// 二、注册表引擎：extractCitations(text, currentDomain, options) —— 供 build-law-citations.mjs、
//    build-quartz-md.mjs 的 linkLawCites 与 parse-domains.mjs 的 nodes.laws 共同消费。
//    2026-08-23 波B 前本函数以「法名 alternation」锚定，只认专利法／专利法实施细则两部；
//    波B 改为**先锚条号、再回看左侧窗口做后缀匹配**的注册表引擎，覆盖 domains.mjs 全部 70 部有条文规范：
//      a. 锚点：正文中的「第N条」条目（条号兼容中文数字含百位与阿拉伯数字，捕获 之N / 款 / 项 / 范围终点）；
//      b. 法名：注册表别名 = 70 部规范的 lawName 全称 + 显式 lawAlias + 遗留别名「实施细则」（不含 short，
//         理由见 buildLawRegistry）。取锚点左侧窗口（长度按注册表最长别名自适应，且不跨空行），两侧同一把尺归一
//         （剥《》〈〉（）与空白分隔标点，见 LAW_DECOR_CLASS）后，按归一长度降序对注册表做 endsWith 后缀匹配。
//         后缀匹配天然解「子串包含」（专利法⊂专利法实施细则、商标法⊂商标法实施条例、著作权法⊂著作权法实施条例…）
//         与插入语（「《中华人民共和国专利法》（以下简称专利法）第三十四条」归一后 endsWith 专利法 成立）；
//      c. 域内自指代：本法/本条例/本办法/本细则/本规定/本规则/本解释/本标准/本规程/本纲要/本指引 → 所在域 lawName
//         （域无 lawName 则不解析）；「本指南」不在表内，仍属章节 xref、不产出引用；
//      d. 款（第X款）与项（第（X）项，全角括号）组装 fullCite，lawKey 归并到条级，与 laws.json 键位对齐；
//      e. 范围展开：「第四十五条至第四十七条」（含全角一字线、波浪线、连字符等变体）逐条展开；
//      f. 枚举续接：法名只出现一次的「专利法第2条、第3条、第19条至第26条」逐项归于同一法名。
//    只产出能落到注册表的法名（键式 `${lawName}第N条`，与 mcp/src 侧 lawArticles 键格式一致）；
//    域外法（刑法／民法典／专利合作条约／马德里协定等）一律不产出，不再静默回落专利法。
//    策略先例：mcp/src/search.mjs 的 lawRegistry / matchLawAlias（检索侧同一套口径，两侧独立派生、语义对齐）。
import { cn2num } from './cn-num.mjs';
import { KNOWN_DOMAINS } from './domains.mjs';

// ============ 一、沿用版（迁自 parse-domains.mjs，行为保持完全一致；2026-08-23 起管线不再调用） ============
export const LAW_RE = /(专利法实施细则|专利法|实施细则)第([一二三四五六七八九十百零]+)条(之([一二三四五六七八九十]+))?(第([一二三四五六七八九十]+)款)?/g;

export function extractLaws(text) {
  const refs = new Set();
  let m;
  LAW_RE.lastIndex = 0;
  while ((m = LAW_RE.exec(text))) {
    const law = m[1] === '实施细则' ? '专利法实施细则' : m[1];
    const art = cn2num(m[2]);
    if (!Number.isFinite(art)) continue;
    const zhi = m[4] ? `之${cn2num(m[4])}` : '';
    refs.add(`${law}第${art}条${zhi}`); // 归一到"法+条"，忽略款用于聚类
  }
  return [...refs];
}

// ============ 二、法名注册表 ============
// 法名文本的修饰字符：书名号、引号、括号（只去括号本身、保留括内序号）、空白与分隔标点。
//   与 mcp/src/search.mjs 的 LAW_DECOR_RE 同一把尺 —— 司法解释全称自带括号序号
//   （「…若干问题的解释（二）」）、法名常带书名号，只有注册表侧与正文侧同等归一，
//   「《…解释（二）》」「…解释（二）」「…解释二」才落到同一条目。
//   注意「。」「！」「？」等句末标点**不在**剥离之列：它们天然充当左窗口的截断哨兵。
const LAW_DECOR_CLASS = '[《》〈〉「」『』【】“”‘’]|[()（）\\[\\]]|[\\s,，、;；:：·・—-]';
const LAW_DECOR_RE = new RegExp(LAW_DECOR_CLASS, 'g');
const LAW_DECOR_CHAR_RE = new RegExp(`^(?:${LAW_DECOR_CLASS})$`);

/** 法名文本归一：《商标法》→ 商标法；侵权解释（二）→ 侵权解释二 */
export function normLawText(s) {
  return String(s || '').replace(LAW_DECOR_RE, '');
}

// 归一并保留「归一串下标 → 原文下标」映射，用于把后缀命中位置换算回原文偏移（trace.index / raw 需原文精确）
function normWithMap(s) {
  let norm = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (LAW_DECOR_CHAR_RE.test(ch)) continue;
    norm += ch;
    map.push(i);
  }
  return { norm, map };
}

// 域内自指代词 → 所在域 lawName。
//   「本指南」刻意不列入：《专利审查指南》的「本指南第二部分第五章」属章节 xref，不是法条引用。
export const SELF_REF_TOKENS = [
  '本法', '本条例', '本办法', '本细则', '本规定', '本规则', '本解释', '本标准', '本规程', '本纲要', '本指引',
];

// 遗留别名：裸「实施细则第X条」→ 专利法实施细则，沿用波B 前 LAW_RE / ANCHOR_RE 的历史口径。
//   仅此一条。mcp 检索侧的「细则」「则」「法」三条查询期简写**不予登记**：正文里的
//   「原则第5条」「本法第5条」会被它们误吞（查询期是用户主动输入，正文期是被动扫描，风险不对称）。
const LEGACY_ALIASES = [
  { alias: '实施细则', domain: 'implementation-rules', lawName: '专利法实施细则', kind: 'legacy' },
];

// 遗留别名「实施细则」的条约防护（2026-08-23 波B 修正令）：
//   「专利合作条约实施细则」「（马德里协定有关）议定书实施细则」「…公约实施细则」是域外条约的配套细则，
//   与专利法实施细则无关。归一左窗在「实施细则」之前还能续出条约/议定书/公约字样时判为不可解析，
//   不再回落专利法实施细则（根治全库 4 处存量误吸：PCT 细则第46/39条、马德里议定书细则第二十二条×2）。
const TREATY_TAIL_RE = /(?:条约|议定书|公约)$/;

/**
 * 从域表派生法名注册表。
 *   别名集 = lawName 全称 + 显式 lawAlias（现仅 copyright-civil-interp 的「著作权解释」）+ 遗留别名。
 *   **不纳入 domains.mjs 的 short**：short 是项目自造的 4 字 UI 标签（驰名商标／地理标志／行政裁决…），
 *   在正文里是常用普通词组，紧贴条号时会把并列条号误吸成他法引用（实测 tmeg-07-01 一句内误吸 2 处）；
 *   全库简称命中仅 9 处，其中 7 处另有全称覆盖、零键损失，故正文侧一律不登记 short。
 *   entries 按归一后长度降序（同长按字典序），最长优先匹配即由该序保证。
 * @param {Array<{key:string, lawName?:string, lawAlias?:string}>} domainList
 */
export function buildLawRegistry(domainList = KNOWN_DOMAINS) {
  const byAlias = new Map();
  const lawNameByDomain = new Map();
  const push = (e) => {
    if (!e.alias || byAlias.has(e.alias)) return;
    const norm = normLawText(e.alias);
    if (!norm) return;
    byAlias.set(e.alias, { ...e, norm });
  };
  for (const d of domainList) {
    if (!d.lawName) continue;
    lawNameByDomain.set(d.key, d.lawName);
    push({ alias: d.lawName, domain: d.key, lawName: d.lawName, kind: 'full' });
    if (d.lawAlias && d.lawAlias !== d.lawName)
      push({ alias: d.lawAlias, domain: d.key, lawName: d.lawName, kind: 'alias' });
  }
  for (const e of LEGACY_ALIASES) {
    if (!lawNameByDomain.has(e.domain)) continue; // 该域不在表内时不登记，免得指向取不到的条文
    push({ ...e });
  }
  const entries = [...byAlias.values()].sort(
    (x, y) => y.norm.length - x.norm.length || (x.alias < y.alias ? -1 : x.alias > y.alias ? 1 : 0),
  );
  const maxNormLen = entries.reduce((a, e) => Math.max(a, e.norm.length), 0);
  return { entries, byAlias, lawNameByDomain, maxNormLen };
}

export const LAW_REGISTRY = buildLawRegistry();

// 左窗口原文长度：需保证归一后仍够放下最长别名（38 字），留 20 字余量吸收书名号/括号/空白等修饰字符。
//   窗口放长不会引入误命中——判据是 endsWith，只有紧贴条号左侧的那截文本参与比对。
const WINDOW_SLACK = 20;
const PARA_BREAK_RE = /\n[ \t]*\n/g; // 空行=段落边界：引用不跨段，与 build-quartz-md 逐段调用 linkLawCites 的粒度对齐

// ============ 三、条目正则（波B 前的 ART_ITEM_SRC / CONT_RE 原样保留） ============
// 数字片段：中文数字（类与 parse-domains 的 lawKey 标题类一致，含 百/零/〇/两）或阿拉伯数字。
//   注：〇/两 不在 cn2num 支持范围内，解析为 NaN 时该条目安全跳过。
const NUM_SRC = '(?:[一二三四五六七八九十百零〇两]+|[0-9]+)';
// 范围分隔符：至/到 + 一字线（—/―）、连接号（–/－/‐/-）、波浪线（~/～）等变体
const RANGE_SEP_SRC = '(?:[—–―－‐~～\\-]|至|到)';
// 款/项的"范围尾缀"：第X款至第Y款 / 第（X）项至第（Y）项。全部非捕获——
//   只把范围整体吞入本次命中（终点不另产出引用：款/项无独立页面节点，lawKey 归并到条级），
//   保证 ART_ANCHOR_RE(5)/CONT_RE(8) 的捕获组数与语义位置零移位。
const KUAN_TAIL_SRC = `(?:\\s*${RANGE_SEP_SRC}\\s*第${NUM_SRC}款)?`;
const XIANG_TAIL_SRC = `(?:\\s*${RANGE_SEP_SRC}\\s*第[（(]${NUM_SRC}[)）]项)?`;
// 单个"条目"：第X条 后接（范围终点 | 之N? 款? 项?）。捕获组（相对序）：
//   1=条号 2=范围终点条号 3=之N 4=款号 5=项号
const ART_ITEM_SRC =
  `第(${NUM_SRC})条` +
  `(?:\\s*${RANGE_SEP_SRC}\\s*第(${NUM_SRC})条` +
  `|(?:之(${NUM_SRC}))?(?:第(${NUM_SRC})款${KUAN_TAIL_SRC})?(?:第[（(](${NUM_SRC})[)）]项${XIANG_TAIL_SRC})?)`;
// 锚定：正文中的每个条目。法名不再进正则（改由左窗口后缀匹配裁定），故组序整体前移一位：1..5=条目组
const ART_ANCHOR_RE = new RegExp(ART_ITEM_SRC, 'g');
// 续接条目（sticky，自锚定链末尾逐项吞并）：枚举分隔符 + （完整条目 | 款级续接 | 项级续接）。
//   组：1..5=条目组 6=续接款号 7=续接款下项号 8=续接项号
const CONT_RE = new RegExp(
  `(?:、|和|及|以及|或者|或)` +
  `(?:${ART_ITEM_SRC}` +
  `|第(${NUM_SRC})款${KUAN_TAIL_SRC}(?:第[（(](${NUM_SRC})[)）]项${XIANG_TAIL_SRC})?` +
  `|第[（(](${NUM_SRC})[)）]项${XIANG_TAIL_SRC})`,
  'y',
);
// 范围展开上限：超过视为误匹配，仅记首尾两条（实施细则条文最多至第一百四十九条，正常范围远小于此）
const MAX_RANGE_SPAN = 60;

// ============ 四、法名裁定 ============
// 书名号/括号配对表：raw 需为原文连续片段，法名起点落在括号内侧时要么外扩到配对左括号、要么截到括号右侧
const CLOSER_TO_OPENER = new Map([['》', '《'], ['〉', '〈'], ['）', '（'], [')', '(']]);
const OPENERS = new Set(['《', '〈', '（', '(']);
const BOOK_OPENERS = new Set(['《', '〈']);

/**
 * 修正 raw 的起点，使 [start, artStart) 内不残留未配对的右括号。
 *   - 未配对的「》〉」：法名被书名号整体包裹（《中华人民共和国商标法》第八条），向左外扩到配对左书名号；
 *   - 未配对的「）)」：法名落在插入语内（（以下简称专利法）第三十四条），截到该右括号之后——
 *     此时 raw 退化为「第三十四条」，链接文本干净且不含半截插入语。
 */
function adjustRawStart(text, start, artStart, minStart) {
  let s = start;
  for (let guard = 0; guard < 8; guard++) {
    const stack = [];
    let unmatchedAt = -1;
    for (let i = s; i < artStart; i++) {
      const ch = text[i];
      if (OPENERS.has(ch)) stack.push(ch);
      else if (CLOSER_TO_OPENER.has(ch)) {
        if (stack.length && stack[stack.length - 1] === CLOSER_TO_OPENER.get(ch)) stack.pop();
        else { unmatchedAt = i; break; }
      }
    }
    if (unmatchedAt < 0) return s;
    const need = CLOSER_TO_OPENER.get(text[unmatchedAt]);
    if (BOOK_OPENERS.has(need)) {
      const p = text.lastIndexOf(need, s - 1);
      if (p >= minStart && p < s) { s = p; continue; }
    }
    s = unmatchedAt + 1; // 括号内侧起点：截到右括号之后
  }
  return s;
}

/**
 * 裁定某条号锚点归属的法名。
 * @returns {{lawName:string, kind:'full'|'short'|'self', alias:string, startOrig:number}|null}
 *   startOrig 为法名在原文中的起点（供 raw / trace.index 使用）；null 表示不可解析（整链跳过）。
 */
function resolveLawAt(text, winStart, artStart, currentDomain, registry) {
  const window = text.slice(winStart, artStart);
  const { norm, map } = normWithMap(window);
  if (!norm) return null;
  // 归一串同时另试「剥掉尾部年份/版本号」形态，使「商标法（2013）第五条」「商标法2026第8条」成立
  const forms = [norm];
  const noVer = norm.replace(/[0-9]{2,4}$/, '');
  if (noVer && noVer !== norm) forms.push(noVer);

  // 1) 注册表别名（已按归一长度降序，最长优先）
  for (const e of registry.entries) {
    for (const f of forms) {
      if (!f.endsWith(e.norm)) continue;
      const cut = f.length - e.norm.length;
      // 遗留别名的条约防护：…条约/议定书/公约 + 实施细则 属域外条约配套细则，跳过该别名继续下探
      if (e.kind === 'legacy' && TREATY_TAIL_RE.test(f.slice(0, cut))) continue;
      return { lawName: e.lawName, kind: e.kind, alias: e.alias, startOrig: winStart + map[cut] };
    }
  }
  // 2) 域内自指代（token 均为 2 字，短于全部注册表别名，故置于其后即满足"最长优先"）
  const selfLaw = registry.lawNameByDomain.get(currentDomain);
  if (selfLaw) {
    for (const tok of SELF_REF_TOKENS) {
      if (!norm.endsWith(tok)) continue;
      return { lawName: selfLaw, kind: 'self', alias: tok, startOrig: winStart + map[norm.length - tok.length] };
    }
  }
  return null;
}

// ============ 五、命中统计 ============
/** 新建一份统计计数器，传入 extractCitations 的 options.stats 即逐次累加（跨节点可复用同一份） */
export function createCiteStats() {
  return {
    anchors: 0, // 扫描到的「第N条」锚点数（不含枚举续接项）
    named: 0, // 具名命中（注册表别名）
    selfRef: 0, // 域内自指代命中（本法/本条例…）
    unresolved: 0, // 落不到注册表的锚点：域外法、章节 xref、裸条号
    emitted: 0, // 实际产出的引用条目次数（含范围展开与枚举续接）
    byAliasKind: { full: 0, alias: 0, legacy: 0 },
  };
}

/** 统计计数器的单行可打印形态 */
export function formatCiteStats(s) {
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '0%');
  return (
    `条号锚点 ${s.anchors}｜具名 ${s.named}（${pct(s.named, s.anchors)}；全称 ${s.byAliasKind.full}` +
    `／显式别名 ${s.byAliasKind.alias}／遗留 ${s.byAliasKind.legacy}）` +
    `｜自指代 ${s.selfRef}（${pct(s.selfRef, s.anchors)}）｜未解析 ${s.unresolved}（${pct(s.unresolved, s.anchors)}）` +
    `｜产出条目 ${s.emitted}`
  );
}

// ============ 六、抽取主体 ============
// 数字解析：cn2num 同时接受中文与阿拉伯数字；非法（含 〇/两）返回 NaN
function toNum(raw) {
  return raw == null ? null : cn2num(raw);
}

// 记一次引用：聚合到 ctx.map（键 fullCite），并按需写 trace（供抽查定位原文）
function emitCite(ctx, law, art, { zhi = null, kuan = null, xiang = null }, hit) {
  const zhiPart = Number.isFinite(zhi) ? `之${zhi}` : '';
  const lawKey = `${law}第${art}条${zhiPart}`;
  let fullCite = lawKey;
  if (Number.isFinite(kuan)) fullCite += `第${kuan}款`;
  if (Number.isFinite(xiang)) fullCite += `第（${xiang}）项`;
  const cur = ctx.map.get(fullCite) || { lawKey, fullCite, count: 0 };
  cur.count++;
  ctx.map.set(fullCite, cur);
  if (ctx.trace) ctx.trace.push({ lawKey, fullCite, index: hit.index, raw: hit.raw });
  if (ctx.stats) ctx.stats.emitted++;
}

// 处理一个"条目"（锚定首项或续接项）。返回本条目落定的条号（供后续款/项级续接挂靠；范围条目返回 null）
function handleArtItem(ctx, law, hit, artRaw, rangeEndRaw, zhiRaw, kuanRaw, xiangRaw) {
  const art = toNum(artRaw);
  if (!Number.isFinite(art)) return null;
  if (rangeEndRaw != null) {
    // 范围条目：逐条展开为条级引用（范围写法不带款/项）
    const end = toNum(rangeEndRaw);
    if (Number.isFinite(end) && end > art && end - art <= MAX_RANGE_SPAN) {
      for (let a = art; a <= end; a++) emitCite(ctx, law, a, {}, hit);
    } else {
      emitCite(ctx, law, art, {}, hit);
      if (Number.isFinite(end) && end !== art) emitCite(ctx, law, end, {}, hit);
    }
    return null;
  }
  const zhi = toNum(zhiRaw);
  const kuan = toNum(kuanRaw);
  const xiang = toNum(xiangRaw);
  emitCite(ctx, law, art, { zhi, kuan, xiang }, hit);
  return art;
}

// 左窗口起点：锚点左侧 maxNormLen+SLACK 字，且不跨最近的空行（引用不跨段）
function windowStartOf(text, artStart, winLen) {
  let start = Math.max(0, artStart - winLen);
  const seg = text.slice(start, artStart);
  PARA_BREAK_RE.lastIndex = 0;
  let m;
  let cut = -1;
  while ((m = PARA_BREAK_RE.exec(seg))) cut = m.index + m[0].length;
  if (cut >= 0) start += cut;
  return start;
}

/**
 * 注册表引擎抽取：返回 [{lawKey, fullCite, count}]（按 fullCite 聚合，出现顺序稳定）。
 * @param {string} text 待抽取正文
 * @param {string} currentDomain 当前节点所属域 key（用于 本法/本条例… 自指代解析）
 * @param {object} [options]
 * @param {Array}  [options.trace]      传入数组则逐命中追加 {lawKey, fullCite, index, raw}，
 *                                      raw 为 text 自 index 起的**原文连续片段**（消费方据此就地替换成链）
 * @param {object} [options.stats]      传入 createCiteStats() 的计数器则累加命中统计
 * @param {Array}  [options.unresolved] 传入数组则逐个追加未解析锚点 {index, raw, left}（干跑排查用）
 * @param {object} [options.registry]   覆盖默认注册表（单测注入用）
 */
export function extractCitations(text, currentDomain = '', options = {}) {
  const map = new Map();
  if (!text) return [];
  const ctx = {
    map,
    trace: Array.isArray(options.trace) ? options.trace : null,
    stats: options.stats || null,
  };
  const unresolvedOut = Array.isArray(options.unresolved) ? options.unresolved : null;
  const registry = options.registry || LAW_REGISTRY;
  const winLen = registry.maxNormLen + WINDOW_SLACK;

  let m;
  ART_ANCHOR_RE.lastIndex = 0;
  while ((m = ART_ANCHOR_RE.exec(text))) {
    const artStart = m.index;
    const artEnd = artStart + m[0].length;
    const winStart = windowStartOf(text, artStart, winLen);
    const hitLaw = resolveLawAt(text, winStart, artStart, currentDomain, registry);
    const law = hitLaw ? hitLaw.lawName : null;

    if (ctx.stats) {
      ctx.stats.anchors++;
      if (!hitLaw) ctx.stats.unresolved++;
      else if (hitLaw.kind === 'self') ctx.stats.selfRef++;
      else {
        ctx.stats.named++;
        ctx.stats.byAliasKind[hitLaw.kind]++;
      }
    }
    if (!hitLaw && unresolvedOut) {
      unresolvedOut.push({ index: artStart, raw: m[0], left: text.slice(winStart, artStart).slice(-16) });
    }

    // raw 自法名起点起算，供 linkLawCites 就地替换（未解析时仅覆盖条目本身，但该分支不产出 trace）
    const rawStart = hitLaw ? adjustRawStart(text, hitLaw.startOrig, artStart, winStart) : artStart;
    const anchorHit = { index: rawStart, raw: text.slice(rawStart, artEnd) };

    let lastArt = null;
    if (law) lastArt = handleArtItem(ctx, law, anchorHit, m[1], m[2], m[3], m[4], m[5]);
    let pos = artEnd;
    // 枚举续接：自链首末尾连续吞并 "、第X条…" / "、第Y款…" / "或者第（Z）项" 等同法名条目
    //   未解析锚点亦照常吞并（law=null 不产出），以免 "刑法第213条、第214条" 的续接项被二次锚定
    CONT_RE.lastIndex = pos;
    let c;
    while ((c = CONT_RE.exec(text))) {
      const contHit = { index: c.index, raw: c[0] };
      if (c[1] != null) {
        // 完整条目续接（第X条…）：更新款/项挂靠条号（范围条目不挂靠）
        lastArt = law ? handleArtItem(ctx, law, contHit, c[1], c[2], c[3], c[4], c[5]) : null;
      } else if (c[6] != null) {
        // 款级续接（…第Y款[第（Z）项]）：挂靠链内最近落定的条号
        if (law && Number.isFinite(lastArt))
          emitCite(ctx, law, lastArt, { kuan: toNum(c[6]), xiang: toNum(c[7]) }, contHit);
      } else if (c[8] != null) {
        // 项级续接（…第（Z）项）：挂靠链内最近落定的条号
        if (law && Number.isFinite(lastArt)) emitCite(ctx, law, lastArt, { xiang: toNum(c[8]) }, contHit);
      }
      pos = CONT_RE.lastIndex;
      CONT_RE.lastIndex = pos;
    }
    ART_ANCHOR_RE.lastIndex = pos; // 链尾续扫，避免续接区间被重复锚定
  }
  return [...map.values()];
}

/** nodes.laws 形态：按出现顺序去重的 lawKey 串数组（与沿用版 extractLaws 的返回形状一致） */
export function extractLawKeys(text, currentDomain = '', options = {}) {
  return [...new Set(extractCitations(text, currentDomain, options).map((c) => c.lawKey))];
}
