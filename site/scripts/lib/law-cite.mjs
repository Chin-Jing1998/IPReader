// 法条引用抽取共享库（数据管线 D2）。
// 一、沿用版：LAW_RE + extractLaws —— 自 parse-domains.mjs 原样迁出。
//    laws.json / nodes.laws / lawref 边全部依赖它，属"回归零漂移"硬约束：正则与归一规则不得改动。
// 二、增强版：extractCitations(text, currentDomain, options) —— 供 build-law-citations 及后续 D3/D4 使用，
//    不接入 parse-domains 既有调用路径。增强点：
//    a. 条号兼容中文数字（含"百"位）与阿拉伯数字；法名可带书名号（如"《专利法》第22条"）；
//    b. 捕获款（第X款）与项（第（X）项，全角括号）组装 fullCite（如"专利法第22条第3款"）；
//       lawKey 仍归并到条级（"专利法第22条"），与既有 laws.json 键位对齐；
//    c. 域内指代解析：patent-law 域"本法"→专利法；implementation-rules 域"本细则"→专利法实施细则；
//       examination-guideline-2025 域"本指南"属章节 xref、不算法条，整链跳过（不产出引用）；
//    d. 范围展开："第四十五条至第四十七条"（分隔符含 至/到 与全角一字线、波浪线、连字符等变体）逐条展开；
//    e. 枚举续接：法名只出现一次的"专利法第2条、第3条、第19条至第26条"逐项归于同一法名；
//       "第38条第（一）项或者第（二）项"中款/项续接项归于同一条。
import { cn2num } from './cn-num.mjs';

// ============ 一、沿用版（迁自 parse-domains.mjs，行为保持完全一致） ============
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

// ============ 二、增强版 extractCitations ============
// 数字片段：中文数字（类与 parse-domains 的 lawKey 标题类一致，含 百/零/〇/两）或阿拉伯数字。
//   注：〇/两 不在 cn2num 支持范围内，解析为 NaN 时该条目安全跳过。
const NUM_SRC = '(?:[一二三四五六七八九十百零〇两]+|[0-9]+)';
// 范围分隔符：至/到 + 一字线（—/―）、连接号（–/－/‐/-）、波浪线（~/～）等变体
const RANGE_SEP_SRC = '(?:[—–―－‐~～\\-]|至|到)';
// 款/项的"范围尾缀"：第X款至第Y款 / 第（X）项至第（Y）项。全部非捕获——
//   只把范围整体吞入本次命中（终点不另产出引用：款/项无独立页面节点，lawKey 归并到条级），
//   保证 ANCHOR_RE(6)/CONT_RE(8) 的捕获组数与语义位置零移位。
const KUAN_TAIL_SRC = `(?:\\s*${RANGE_SEP_SRC}\\s*第${NUM_SRC}款)?`;
const XIANG_TAIL_SRC = `(?:\\s*${RANGE_SEP_SRC}\\s*第[（(]${NUM_SRC}[)）]项)?`;
// 单个"条目"：第X条 后接（范围终点 | 之N? 款? 项?）。捕获组（相对序）：
//   1=条号 2=范围终点条号 3=之N 4=款号 5=项号
const ART_ITEM_SRC =
  `第(${NUM_SRC})条` +
  `(?:\\s*${RANGE_SEP_SRC}\\s*第(${NUM_SRC})条` +
  `|(?:之(${NUM_SRC}))?(?:第(${NUM_SRC})款${KUAN_TAIL_SRC})?(?:第[（(](${NUM_SRC})[)）]项${XIANG_TAIL_SRC})?)`;
// 锚定链起点：法名（可带书名号）+ 首个条目。组：1=法名 2..6=条目组
const ANCHOR_RE = new RegExp(
  `《?(专利法实施细则|专利法|实施细则|本法|本细则|本指南)》?${ART_ITEM_SRC}`,
  'g',
);
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

// 域内指代解析：返回归一法名；返回 null 表示不可解析（整链跳过，不产出引用）
function resolveLawName(raw, currentDomain) {
  if (raw === '专利法' || raw === '专利法实施细则') return raw;
  if (raw === '实施细则') return '专利法实施细则';
  if (raw === '本法') return currentDomain === 'patent-law' ? '专利法' : null;
  if (raw === '本细则') return currentDomain === 'implementation-rules' ? '专利法实施细则' : null;
  return null; // 本指南（章节 xref）及其他不可解析指代
}

// 数字解析：cn2num 同时接受中文与阿拉伯数字；非法（含 〇/两）返回 NaN
function toNum(raw) {
  return raw == null ? null : cn2num(raw);
}

// 记一次引用：聚合到 map（键 fullCite），并按需写 trace（供抽查定位原文）
function emitCite(map, trace, law, art, { zhi = null, kuan = null, xiang = null }, hit) {
  const zhiPart = Number.isFinite(zhi) ? `之${zhi}` : '';
  const lawKey = `${law}第${art}条${zhiPart}`;
  let fullCite = lawKey;
  if (Number.isFinite(kuan)) fullCite += `第${kuan}款`;
  if (Number.isFinite(xiang)) fullCite += `第（${xiang}）项`;
  const cur = map.get(fullCite) || { lawKey, fullCite, count: 0 };
  cur.count++;
  map.set(fullCite, cur);
  if (trace) trace.push({ lawKey, fullCite, index: hit.index, raw: hit.raw });
}

// 处理一个"条目"（锚定首项或续接项）。返回本条目落定的条号（供后续款/项级续接挂靠；范围条目返回 null）
function handleArtItem(map, trace, law, hit, artRaw, rangeEndRaw, zhiRaw, kuanRaw, xiangRaw) {
  const art = toNum(artRaw);
  if (!Number.isFinite(art)) return null;
  if (rangeEndRaw != null) {
    // 范围条目：逐条展开为条级引用（范围写法不带款/项）
    const end = toNum(rangeEndRaw);
    if (Number.isFinite(end) && end > art && end - art <= MAX_RANGE_SPAN) {
      for (let a = art; a <= end; a++) emitCite(map, trace, law, a, {}, hit);
    } else {
      emitCite(map, trace, law, art, {}, hit);
      if (Number.isFinite(end) && end !== art) emitCite(map, trace, law, end, {}, hit);
    }
    return null;
  }
  const zhi = toNum(zhiRaw);
  const kuan = toNum(kuanRaw);
  const xiang = toNum(xiangRaw);
  emitCite(map, trace, law, art, { zhi, kuan, xiang }, hit);
  return art;
}

// 增强版抽取：返回 [{lawKey, fullCite, count}]（按 fullCite 聚合，出现顺序稳定）。
//   currentDomain：当前节点所属域 key（用于 本法/本细则 指代解析）。
//   options.trace：若传入数组，则逐命中追加 {lawKey, fullCite, index, raw}，供调用方截取原文片段抽查。
export function extractCitations(text, currentDomain = '', options = {}) {
  const map = new Map();
  if (!text) return [];
  const trace = Array.isArray(options.trace) ? options.trace : null;
  let m;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(text))) {
    const law = resolveLawName(m[1], currentDomain); // null=整链跳过（仍需吞并续接项以推进扫描位置）
    const anchorHit = { index: m.index, raw: m[0] };
    let lastArt = null;
    if (law) lastArt = handleArtItem(map, trace, law, anchorHit, m[2], m[3], m[4], m[5], m[6]);
    let pos = ANCHOR_RE.lastIndex;
    // 枚举续接：自链首末尾连续吞并 "、第X条…" / "、第Y款…" / "或者第（Z）项" 等同法名条目
    CONT_RE.lastIndex = pos;
    let c;
    while ((c = CONT_RE.exec(text))) {
      const contHit = { index: c.index, raw: c[0] };
      if (c[1] != null) {
        // 完整条目续接（第X条…）：更新款/项挂靠条号（范围条目不挂靠）
        lastArt = law ? handleArtItem(map, trace, law, contHit, c[1], c[2], c[3], c[4], c[5]) : null;
      } else if (c[6] != null) {
        // 款级续接（…第Y款[第（Z）项]）：挂靠链内最近落定的条号
        if (law && Number.isFinite(lastArt))
          emitCite(map, trace, law, lastArt, { kuan: toNum(c[6]), xiang: toNum(c[7]) }, contHit);
      } else if (c[8] != null) {
        // 项级续接（…第（Z）项）：挂靠链内最近落定的条号
        if (law && Number.isFinite(lastArt))
          emitCite(map, trace, law, lastArt, { xiang: toNum(c[8]) }, contHit);
      }
      pos = CONT_RE.lastIndex;
      CONT_RE.lastIndex = pos;
    }
    ANCHOR_RE.lastIndex = pos; // 链尾续扫，避免续接区间被重复匹配
  }
  return [...map.values()];
}
