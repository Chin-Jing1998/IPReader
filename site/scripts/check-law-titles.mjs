// 条旨（「第X条」小标题）校验脚本 —— 只读校验，不改写任何 _index.md / nodes.json。
//   背景：多个并行子代理正往各域 _index.md 写入形如
//     - **第N条**（条旨）：可选说明
//   的条旨行。本脚本对每个"应有条旨的域"做五项检查，核对 _index.md 的写入结果
//   是否与 nodes.json（该域主 md 解析出的条文节点，视为地面真值）一致、格式是否合规。
//
// 用法：
//   node site/scripts/check-law-titles.mjs                 # 全库
//   node site/scripts/check-law-titles.mjs --domain <key>  # 仅查一个域
//   node site/scripts/check-law-titles.mjs --samples        # 附带每域抽样 3 条（种子固定，可复现）
//   node site/scripts/check-law-titles.mjs --strict          # WARN 也计入致命，exit 1
//
// 五项检查（任一 FAIL 使进程最终 exit 1；WARN 默认不致命，--strict 时致命）：
//   1. 覆盖对账：_index.md 中 LINE_RE 命中的条号集合 == nodes.json 中该域"条"节点的条号集合（去重后比较）
//   2. article_count 对账：_index.md frontmatter 的 article_count（或旧七部的 total_articles）
//      == nodes.json 去重条号数（以 nodes.json 为地面真值，不依赖 _index.md 当前写入进度）
//   3. 条号连续 / 不重复：同一条号只能在 _index.md 中出现一行（对所有域强制）；
//      若该域在 lib/domains.mjs 有 lawName，_index.md 已写条旨的条号（去重、转阿拉伯数字）还必须 1..N 连续
//   4. 格式与长度：条旨文本非空、无首尾空白、长度 ≤20 字（按码点计）、不含 （）()|[]/#?［］【】、不含"·"与换行
//   5. 哨兵预检（WARN）：条旨含"等同侵权"或"假冒专利" —— 提示人工裁决，防止哨兵查询 Top1 被抢
//
// 说明：
//   - "应有条旨的域"由数据自动判定：_index.md 命中数与 nodes.json 条文节点数二者皆 0 时视为"该域无条文体例"，
//     直接跳过（不计入 PASS/FAIL/WARN），例如《专利审查指南》（部/章/节/子节体例，无"第X条"）。
//   - 检查 1/2 以 nodes.json 为准（主 md 才是条文的地面真值）；检查 3/4/5 只针对 _index.md 已写入的行本身。
//   - 中文数字转换失败（如误用"〇""两"等 cn2num 不支持的字符）不会让脚本崩溃，计入 WARN「解析异常」，
//     并从连续性判断的数值集合中剔除，供人工核实语料，不自动改写。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cn2num } from './lib/cn-num.mjs';
import { discoverDomains, projectRoot } from './lib/domains.mjs';
import { TMEG_GROUP_RE } from './lib/law-titles.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(__dirname); // site/scripts → site → patent-kb → 仓库根（源域目录所在层）
const DATA_DIR = join(__dirname, '..', 'data');

// 与 lib/law-titles.mjs:8 的 LINE_RE 保持同一正则口径。该文件未导出此常量，故在此按同一字面量复制；
// 若上游修改了该行正则，须同步更新此处，否则两处口径会漂移。
const LINE_RE = /\*\*第([一二三四五六七八九十百零〇两]+)条\*\*\s*[（(]\s*([^）)]+?)\s*[）)]/;
// nodes.json 侧"条"节点判定正则（题面给定口径，含 〇 以兼容 numFromHeading 目前不产出但未来可能出现的写法）
const NODE_NUM_RE = /^第[一二三四五六七八九十百零〇]+条$/;

// "·" 单独在 formatViolations 中检查，不放进此表，避免与下方"含'·'"重复报告同一违规
const FORBIDDEN_CHARS = ['（', '）', '(', ')', '|', '[', ']', '/', '#', '?', '［', '］', '【', '】'];

// ---- 多法源域白名单（阶段5.1 批次 T-4）----
// 名单内的域，其 _index.md 条旨索引按章分组书写，同一条号可在不同章合法重复（指向不同法源的同号条文）。
//   《商标审查审理指南》下编 19 章解读 45 个「第X条」，跨《商标法》《商标法实施条例》
//   《规范商标申请注册行为若干规定》三部法源，例如「第十三条」在第六/七/八章分别引《条例》
//   第十三条第三/四/五款、在第十章引《商标法》第十三条，四行同号异义、均属正当。
// 对白名单域，检查 3a 的判重键由「条号」升为「章序:条号」——**同章同号重复仍 FAIL**，
//   仅跨章同号获准；非白名单域判重键与行为逐字不变（仍按条号，一号一行）。
// 检查 1/2 不受影响：二者按 LINE_RE 命中行的条号**去重**集合对账，45 行去重后仍是 28 个条号。
const MULTI_SOURCE_LAWS = new Set(['trademark-exam-guide-2021']);

// ---- CLI 参数 ----
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const showSamples = argv.includes('--samples');
let onlyDomain = null;
{
  const i = argv.indexOf('--domain');
  if (i >= 0) {
    onlyDomain = argv[i + 1];
    if (!onlyDomain || onlyDomain.startsWith('--')) {
      console.error('✗ --domain 后须跟域 key，例如 --domain patent-law');
      process.exit(1);
    }
  }
}

// ---- 固定种子伪随机（mulberry32），供 --samples 抽样可复现 ----
const BASE_SEED = 20260823;
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sampleN(arr, n, domainKey) {
  const rng = mulberry32(BASE_SEED ^ hashStr(domainKey));
  const pool = arr.slice();
  const picked = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

// ---- frontmatter 极简解析（仅取顶部 --- ... --- 之间的 key: value 行） ----
function parseFrontmatter(text) {
  const lines = text.split('\n');
  const fm = {};
  if (lines[0]?.trim() !== '---') return fm;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}
function fmInt(raw) {
  if (raw == null) return null;
  const s = raw.replace(/^"(.*)"$/, '$1').trim();
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// ---- 解析 _index.md：LINE_RE 命中行（不去重，保留每一行，供重复行检测） ----
// grouped=true（仅 MULTI_SOURCE_LAWS 域）时额外记录每行所属的分组章序 group（下编第N章的 N，
//   识别口径与 lib/law-titles.mjs 的 TMEG_GROUP_RE 同源；无归属章时为 null）。
//   grouped=false 时完全不读章标题、行记录不含 group 字段，与改造前逐字等价。
function parseIndexLines(indexPath, grouped = false) {
  let text = '';
  try {
    text = readFileSync(indexPath, 'utf8');
  } catch {
    return { lines: [], text: '', readable: false };
  }
  const lines = [];
  let group = null;
  text.split('\n').forEach((line, i) => {
    if (grouped) {
      const g = line.match(TMEG_GROUP_RE);
      if (g) {
        const n = cn2num(g[1]);
        group = Number.isFinite(n) ? n : null;
        return;
      }
    }
    const m = line.match(LINE_RE);
    if (!m) return;
    const cnStr = m[1];
    const rec = { lineNo: i + 1, cnStr, rawNum: `第${cnStr}条`, title: m[2].trim() };
    if (grouped) rec.group = group;
    lines.push(rec);
  });
  return { lines, text, readable: true };
}

function formatViolations(title) {
  const problems = [];
  if (!title) {
    problems.push('文本为空');
    return problems; // 空文本后续检查无意义
  }
  if (title !== title.trim()) problems.push('首尾含空白');
  const cpLen = [...title].length;
  if (cpLen > 20) problems.push(`长度${cpLen}字超过20字上限`);
  const badChars = [...new Set([...title].filter((ch) => FORBIDDEN_CHARS.includes(ch)))];
  if (badChars.length) problems.push(`含禁用字符：${badChars.join(' ')}`);
  if (title.includes('·')) problems.push('含"·"');
  if (/[\r\n]/.test(title)) problems.push('含换行符');
  return problems;
}

function fmtNumList(arr) {
  const sorted = [...arr].sort((a, b) => {
    const va = cn2num(a.slice(1, -1));
    const vb = cn2num(b.slice(1, -1));
    return (Number.isFinite(va) ? va : 0) - (Number.isFinite(vb) ? vb : 0);
  });
  const shown = sorted.slice(0, 30).join('、');
  return sorted.length > 30 ? `${shown} …（共${sorted.length}个）` : shown;
}

// ---- 单域校验 ----
function checkDomain(dom, nodesByDomain, nodeBodies) {
  const r = {
    key: dom.key,
    skipped: false,
    pass: 0,
    fail: 0,
    warn: 0,
    failMsgs: [],
    warnMsgs: [],
    indexCount: 0,
    nodesCount: 0,
    samples: [],
  };

  const domainNodes = nodesByDomain.get(dom.key) || [];
  const articleNodes = domainNodes.filter((n) => n.num && NODE_NUM_RE.test(n.num));
  const nodesRawNumSet = new Set(articleNodes.map((n) => n.num));

  const indexPath = join(dom.dir, '_index.md');
  const grouped = MULTI_SOURCE_LAWS.has(dom.key); // 白名单域：判重键含分组章序
  const { lines: idxLines, text: idxText, readable } = parseIndexLines(indexPath, grouped);
  const indexRawNumSet = new Set(idxLines.map((l) => l.rawNum));

  r.indexCount = indexRawNumSet.size;
  r.nodesCount = nodesRawNumSet.size;

  if (indexRawNumSet.size === 0 && nodesRawNumSet.size === 0) {
    r.skipped = true;
    return r;
  }

  // ---- 检查1：覆盖对账（以 nodes.json 为地面真值）----
  const missing = [...nodesRawNumSet].filter((x) => !indexRawNumSet.has(x)); // 该有条旨但 _index.md 里没有
  const extra = [...indexRawNumSet].filter((x) => !nodesRawNumSet.has(x)); // _index.md 有但 nodes.json 里查无此条
  if (missing.length || extra.length) {
    r.fail++;
    if (missing.length) r.failMsgs.push(`[覆盖对账] 缺失${missing.length}条：${fmtNumList(missing)}`);
    if (extra.length) r.failMsgs.push(`[覆盖对账] 多余${extra.length}条（nodes.json无此条号）：${fmtNumList(extra)}`);
  } else {
    r.pass++;
  }

  // ---- 检查2：article_count / total_articles 对账（以 nodes.json 去重条号数为准）----
  if (!readable) {
    r.fail++;
    r.failMsgs.push('[article_count对账] _index.md 不可读');
  } else {
    const fm = parseFrontmatter(idxText);
    let keyUsed = null;
    if (Object.prototype.hasOwnProperty.call(fm, 'article_count')) keyUsed = 'article_count';
    else if (Object.prototype.hasOwnProperty.call(fm, 'total_articles')) keyUsed = 'total_articles';
    if (!keyUsed) {
      r.fail++;
      r.failMsgs.push(`[article_count对账] frontmatter 缺少 article_count/total_articles 键，应补 article_count: ${r.nodesCount}`);
    } else {
      const val = fmInt(fm[keyUsed]);
      if (val !== r.nodesCount) {
        r.fail++;
        r.failMsgs.push(`[article_count对账] frontmatter.${keyUsed}=${val} ≠ nodes.json去重条号数${r.nodesCount}`);
      } else {
        r.pass++;
      }
    }
  }

  // ---- 检查3a：同一条号只能出现一行（对所有域强制，仅当已有 _index.md 命中行时评估）----
  //   白名单（MULTI_SOURCE_LAWS）域判重键为「章序:条号」：跨章同号合法，同章同号仍 FAIL；
  //   其余域判重键为条号本身，与改造前一致（键值与插入顺序均不变，故 --samples 抽样结果亦不变）。
  const dupKeyOf = (l) => (grouped ? `${l.group ?? '-'}:${l.rawNum}` : l.rawNum);
  const dupLabelOf = (l) => (grouped ? `${l.group == null ? '（无归属章）' : `下编第${l.group}章`} ${l.rawNum}` : l.rawNum);
  const byDupKey = new Map();
  for (const l of idxLines) {
    const k = dupKeyOf(l);
    if (!byDupKey.has(k)) byDupKey.set(k, []);
    byDupKey.get(k).push(l);
  }
  if (idxLines.length) {
    const dupGroups = [...byDupKey.values()].filter((arr) => arr.length > 1);
    if (dupGroups.length) {
      r.fail++;
      for (const arr of dupGroups) {
        r.failMsgs.push(`[条号重复] ${dupLabelOf(arr[0])} 出现于 ${arr.length} 行（行号：${arr.map((x) => x.lineNo).join(',')}）`);
      }
    } else {
      r.pass++;
    }
  }

  // ---- 检查3b：条号连续 1..N（仅 lawName 域，仅当已有命中行时评估）----
  if (dom.lawName && indexRawNumSet.size) {
    const uniqueVals = [];
    const parseFails = [];
    for (const rawNum of indexRawNumSet) {
      const v = cn2num(rawNum.slice(1, -1));
      if (Number.isFinite(v)) uniqueVals.push(v);
      else parseFails.push(rawNum);
    }
    if (parseFails.length) {
      r.warn++;
      r.warnMsgs.push(`[解析异常] 中文数字转换失败（已从连续性判断中剔除）：${parseFails.join('、')}`);
    }
    if (uniqueVals.length) {
      const maxV = Math.max(...uniqueVals);
      const valSet = new Set(uniqueVals);
      const missingNums = [];
      for (let n = 1; n <= maxV; n++) if (!valSet.has(n)) missingNums.push(n);
      if (missingNums.length) {
        r.fail++;
        r.failMsgs.push(`[条号连续] 已写条旨的条号非 1..${maxV} 连续，缺：${missingNums.map((n) => `第${n}条`).join('、')}`);
      } else {
        r.pass++;
      }
    }
  }

  // ---- 检查4：格式与长度（对 _index.md 中每一行条旨文本逐条检查）----
  // 豁免（2026-08-23 主会话裁决）：patent-law / implementation-rules 两部老书的存量条旨早于本规格
  // 定稿（含「/」并列简写与 1 处 25 字超长），且其条文均为 section 级叶子、label 不参与目录命名，
  // 无路径安全风险——对这两域格式违规降级为 WARN 不阻断；新写条旨的域一律按 FAIL 硬判。
  const FORMAT_GRANDFATHERED = new Set(['patent-law', 'implementation-rules']);
  if (idxLines.length) {
    const lenient = FORMAT_GRANDFATHERED.has(dom.key);
    let fmtFailCount = 0;
    for (const l of idxLines) {
      const problems = formatViolations(l.title);
      if (problems.length) {
        const msg = `[格式与长度] ${l.rawNum}（第${l.lineNo}行）：${problems.join('；')}——「${l.title}」`;
        if (lenient) {
          r.warnMsgs.push(`${msg}（老书存量豁免）`);
        } else {
          fmtFailCount++;
          r.failMsgs.push(msg);
        }
      }
    }
    if (fmtFailCount) r.fail++;
    else r.pass++;
  }

  // ---- 检查5：哨兵预检（WARN）----
  if (idxLines.length) {
    const sentinelHits = idxLines.filter((l) => l.title.includes('等同侵权') || l.title.includes('假冒专利'));
    if (sentinelHits.length) {
      r.warn++;
      for (const l of sentinelHits) {
        r.warnMsgs.push(`[哨兵预检] ${l.rawNum}（第${l.lineNo}行）条旨含敏感短语：「${l.title}」`);
      }
    } else {
      r.pass++;
    }
  }

  // ---- --samples：每域固定种子抽样 3 条（不足则全抽）----
  if (showSamples && idxLines.length) {
    // 与检查 3a 同一判重键：非白名单域即「条号」，与改造前逐字等价；
    // 白名单域按「章序:条号」去重，故 tmeg 抽样池由 28 扩为 45（同号异章各自可被抽中）。
    const uniqLines = [...byDupKey.values()].map((arr) => arr[0]);
    const picked = sampleN(uniqLines, Math.min(3, uniqLines.length), dom.key);
    // 节点回查键与判重键同口径：白名单域用「章序:条号」（否则同号异章会取错节点、正文预览与条旨错位），
    // 其余域仍用条号，键值与插入顺序不变。白名单域的章序取 nodes.json 的 chapterNum。
    const nodeKeyOf = (n) => (grouped ? `${n.chapterNum ?? '-'}:${n.num}` : n.num);
    const byNum = new Map(); // 键 -> 首个节点
    for (const n of articleNodes) if (!byNum.has(nodeKeyOf(n))) byNum.set(nodeKeyOf(n), n);
    for (const l of picked) {
      const node = byNum.get(dupKeyOf(l));
      let bodyPreview = '(nodes.json 无对应条号节点)';
      if (node && nodeBodies && nodeBodies[node.id]) {
        const own = (nodeBodies[node.id].ownText || '').replace(/\s+/g, ' ').trim();
        const cps = [...own];
        bodyPreview = cps.slice(0, 80).join('') + (cps.length > 80 ? '…' : '') || '(该条 ownText 为空)';
      }
      r.samples.push(`${l.rawNum}｜${l.title}｜${bodyPreview}`);
    }
  }

  return r;
}

// ============ 主流程 ============
const allNodes = JSON.parse(readFileSync(join(DATA_DIR, 'nodes.json'), 'utf8'));
const nodesByDomain = new Map();
for (const n of allNodes) {
  if (!nodesByDomain.has(n.domain)) nodesByDomain.set(n.domain, []);
  nodesByDomain.get(n.domain).push(n);
}
let nodeBodies = null;
if (showSamples) {
  nodeBodies = JSON.parse(readFileSync(join(DATA_DIR, 'node-bodies.json'), 'utf8'));
}

const domains = discoverDomains(ROOT);
let targets = domains;
if (onlyDomain) {
  targets = domains.filter((d) => d.key === onlyDomain);
  if (!targets.length) {
    console.error(`✗ 未找到域：${onlyDomain}（可用域数：${domains.length}，如 patent-law / trademark-law-2026）`);
    process.exit(1);
  }
}

console.log(`条旨校验：共 ${targets.length} 个待查域${onlyDomain ? `（--domain ${onlyDomain}）` : ''}${strict ? '（--strict：WARN 致命）' : ''}`);
console.log('');

let passDomains = 0;
let warnDomains = 0;
let failDomains = 0;
let skipped = 0;
const failKeys = [];
const warnKeys = [];

for (const dom of targets) {
  const r = checkDomain(dom, nodesByDomain, nodeBodies);
  if (r.skipped) {
    skipped++;
    console.log(`- 跳过 ${dom.key}（无条文节点、_index.md 亦无条旨行，视为非条文体例域）`);
    continue;
  }
  const status = r.fail > 0 ? 'FAIL' : r.warn > 0 ? 'WARN' : 'PASS';
  if (r.fail > 0) {
    failDomains++;
    failKeys.push(dom.key);
  } else if (r.warn > 0) {
    warnDomains++;
    warnKeys.push(dom.key);
  } else {
    passDomains++;
  }
  console.log(`${dom.key}｜条旨 ${r.indexCount}/${r.nodesCount} 行｜PASS:${r.pass} FAIL:${r.fail} WARN:${r.warn}｜${status}`);
  for (const m of r.failMsgs) console.log(`  FAIL ${m}`);
  for (const m of r.warnMsgs) console.log(`  WARN ${m}`);
  if (showSamples && r.samples.length) {
    console.log('  样例（--samples，种子20260823固定抽样，格式：条号｜条旨｜该条ownText前80字）：');
    for (const s of r.samples) console.log(`    ${s}`);
  }
}

console.log('');
console.log('==== 总表 ====');
console.log(`待查域: ${targets.length}｜跳过(非条文体例): ${skipped}｜PASS: ${passDomains}｜含WARN: ${warnDomains}｜含FAIL: ${failDomains}`);
if (failKeys.length) console.log(`FAIL域: ${failKeys.join(', ')}`);
if (warnKeys.length) console.log(`WARN域: ${warnKeys.join(', ')}`);

const exitCode = failDomains > 0 || (strict && warnDomains > 0) ? 1 : 0;
console.log(
  `退出码: ${exitCode}（存在 FAIL 域即致命；WARN 默认不致命${strict ? '，本次 --strict 已将 WARN 计入致命' : '，加 --strict 可令 WARN 致命'}）`,
);
process.exit(exitCode);
