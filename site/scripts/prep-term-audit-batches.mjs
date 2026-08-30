#!/usr/bin/env node
// 数据管线 D3-3b：术语审校批次拆分 —— 从 merge-terms.mjs 产物中切出「本批新增词」，
//   按固定批量拆成 data/term-audit-batches/batch-NN.json，供二级 LLM 预裁与三级用户抽查消费。
//
//   动机（阶段5.9 波3 / 阶段5.11 波F）：merge-terms.mjs 每次重跑都会重写整张 term-audit.csv
//   （现表全量 1757 行），而审校只需要看「相对上一次发布的词表新出现的词」。全量送审既浪费
//   算力，也会让已定案词条被反复重裁。故本脚本以 registry 基线做差分，只送新增词。
//
//   —— 差分口径（务必理解后再改）——
//     · registry 基线 = 上一次发布到 public/content 的词表快照（data/terms-merged.json 的
//       发布态副本）。差分键为 termKey（canonical 归一），与 merge-terms.mjs 同口径。
//     · 只送「现表有、基线无」的词。基线有而现表无的词（消失词）不进审校批次——那属于防回退
//       差分闸（stage59 方案 D3）的处置范围，与审校是两件事，不可混为一谈。
//     · 候选池（data/term-candidates.json）默认不审：其成员未过入图门槛、本就不进图谱，
//       审了也不改变产物。确有需要时用 --include-candidates 显式开启。
//
//   批号接续：默认扫描输出目录既有 batch-NN.json 取最大编号 +1（历史 batch-01..15 是既有
//     决策格式的先例，本脚本产出的批次与之同构，可被同一套消费方读取）。
//     补零位数固定两位（padStart(2,'0')）；批号一旦 ≥100 需与消费方约定同改三位。
//
//   幂等：目标文件已存在且内容逐字相同 → 跳过；内容不同 → 报错退出（除非 --force）。
//     故 429 中断后重跑安全：已落盘批次原样保留，不会被静默改写。
//     ⚠ 批号自动接续必须先做「同差分复用」判定（见 resolveFrom）：否则重跑时上一次自己写出的
//     批次会被算进「既有最大批号」，把同一批新增词再拆一遍到新批号（实测 batch-16..28 复跑
//     变成 batch-29..41），幂等彻底失效。判定键 = 基线文件 + 现表文件 + 批量 + 候选池开关 +
//     新增词数 + 首末词 termKey，全等才复用该次的起始批号。
//
//   产物：
//     - <out>/batch-NN.json        批次文件，记录字段对齐历史 batch-01..15
//                                  （termKey/canonical/aliases/tier/df/domains/sampleEvidence），
//                                  新增 breadcrumbs 字段（出处节点面包屑，供裁决时判断语境）——
//                                  纯增字段，历史消费方按名取值不受影响。
//     - <out>/_reference-<from>.json  参考词表（基线在表词 canonical/tier/df/topicKey），
//                                  供裁决 merge-into 目标是否「已在表」。不覆盖历史 _reference.json。
//     - <out>/_manifest-<from>.json   本次拆分台账（批号区间、词数、来源文件、生成时间）。
//
//   运行：node scripts/prep-term-audit-batches.mjs --baseline <基线词表.json> [选项]
//     --terms <path>          现表，默认 data/terms-merged.json
//     --baseline <path>       registry 基线（必填，缺省即报错——防止把全表误当新增全量送审）
//     --out <dir>             默认 data/term-audit-batches
//     --size <N>              每批词数，默认 60
//     --from <N>              起始批号，默认自动接续
//     --include-candidates    额外纳入候选池新增词（默认关闭）
//     --force                 允许覆盖内容不同的既有批次文件
//     --dry-run               只打印统计，不落盘
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// 归一化：与 merge-terms.mjs / apply-term-audit.mjs 同口径
const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// ---- 参数解析 ----
function parseArgs(argv) {
  const o = {
    terms: join(DATA_DIR, 'terms-merged.json'),
    baseline: null,
    out: join(DATA_DIR, 'term-audit-batches'),
    size: 60,
    from: null,
    includeCandidates: false,
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) {
        console.error(`✗ 参数 ${a} 缺少取值`);
        process.exit(1);
      }
      return v;
    };
    if (a === '--terms') o.terms = resolve(next());
    else if (a === '--baseline') o.baseline = resolve(next());
    else if (a === '--out') o.out = resolve(next());
    else if (a === '--size') o.size = Number(next());
    else if (a === '--from') o.from = Number(next());
    else if (a === '--include-candidates') o.includeCandidates = true;
    else if (a === '--force') o.force = true;
    else if (a === '--dry-run') o.dryRun = true;
    else {
      console.error(`✗ 未知参数：${a}`);
      process.exit(1);
    }
  }
  return o;
}
const opt = parseArgs(process.argv.slice(2));
if (!opt.baseline) {
  console.error('✗ 必须显式提供 --baseline <registry 基线词表.json>。');
  console.error('  缺省会把现表全部词当作新增送审（1700+ 词），故不设默认值。');
  process.exit(1);
}
if (!Number.isInteger(opt.size) || opt.size < 1) {
  console.error(`✗ --size 非法：${opt.size}`);
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
for (const p of [opt.terms, opt.baseline]) {
  if (!existsSync(p)) {
    console.error(`✗ 文件不存在：${p}`);
    process.exit(1);
  }
}

// ---- 差分 ----
const terms = readJson(opt.terms);
const baseline = readJson(opt.baseline);
const baseKeys = new Set(baseline.map((e) => norm(e.termKey || e.canonical)));
const pool = [...terms];
if (opt.includeCandidates) {
  const candPath = join(DATA_DIR, 'term-candidates.json');
  if (existsSync(candPath)) pool.push(...readJson(candPath));
  else console.warn(`⚠ --include-candidates 已开启但候选池不存在：${candPath}`);
}
// 现表顺序即 merge-terms 的排序结果（种子在前，新词按 tier/df/canonical），直接沿用保证批次可复现
const seen = new Set();
const added = [];
for (const e of pool) {
  const k = norm(e.termKey || e.canonical);
  if (!k || baseKeys.has(k) || seen.has(k)) continue;
  seen.add(k);
  added.push(e);
}
const lost = baseline.filter((e) => !new Set(terms.map((t) => norm(t.termKey))).has(norm(e.termKey || e.canonical)));

// ---- 出处面包屑 ----
const nodesPath = join(DATA_DIR, 'nodes.json');
const bcOf = new Map(); // nodeId → "面包屑 › label"
if (existsSync(nodesPath)) {
  for (const n of readJson(nodesPath)) {
    if (!n || !n.id) continue;
    bcOf.set(n.id, [...(n.breadcrumb || []), n.label].filter(Boolean).join(' › '));
  }
} else {
  console.warn(`⚠ nodes.json 不存在（${nodesPath}），批次将不含 breadcrumbs 字段`);
}
const MAX_BC = 3; // 每词保留的面包屑上限：够判断语境即可，避免批次文件过大
function breadcrumbsOf(entry) {
  const out = [];
  for (const [dom, ids] of Object.entries(entry.sources || {})) {
    for (const id of ids) {
      const bc = bcOf.get(id);
      if (bc) out.push(`${dom}:${bc}`);
      if (out.length >= MAX_BC) return out;
    }
  }
  return out;
}

// ---- 批次记录：字段对齐历史 batch-01..15 ----
function toRecord(e) {
  const rec = {
    termKey: norm(e.termKey || e.canonical),
    canonical: e.canonical,
    aliases: e.aliases || [],
    tier: e.tier,
    df: e.df,
    domains: Object.keys(e.sources || {}),
    sampleEvidence: (e.evidence || []).map((v) => ({ chunk: v.chunk, text: v.text })),
  };
  const bc = breadcrumbsOf(e);
  if (bc.length) rec.breadcrumbs = bc;
  return rec;
}

// ---- 批号接续 ----
const BATCH_RE = /^batch-(\d+)\.json$/;
const MANIFEST_RE = /^_manifest-(\d+)\.json$/;
mkdirSync(opt.out, { recursive: true });

// 本次差分的身份指纹：同一份基线 + 同一份现表 + 同样的切分参数 + 同样的新增词集合
const fingerprint = {
  termsFile: opt.terms,
  baselineFile: opt.baseline,
  includeCandidates: opt.includeCandidates,
  batchSize: opt.size,
  addedCount: added.length,
  firstTermKey: added.length ? norm(added[0].termKey || added[0].canonical) : '',
  lastTermKey: added.length ? norm(added[added.length - 1].termKey || added[added.length - 1].canonical) : '',
};
function resolveFrom() {
  if (opt.from != null) return opt.from;
  // ① 同差分复用：命中既有台账则回到它的起始批号，走内容比对幂等路径
  const hits = [];
  for (const f of readdirSync(opt.out)) {
    if (!MANIFEST_RE.test(f)) continue;
    let m;
    try {
      m = JSON.parse(readFileSync(join(opt.out, f), 'utf8'));
    } catch {
      continue;
    }
    const same =
      m.termsFile === fingerprint.termsFile &&
      m.baselineFile === fingerprint.baselineFile &&
      !!m.includeCandidates === fingerprint.includeCandidates &&
      m.batchSize === fingerprint.batchSize &&
      m.addedCount === fingerprint.addedCount &&
      (m.firstTermKey ?? fingerprint.firstTermKey) === fingerprint.firstTermKey &&
      (m.lastTermKey ?? fingerprint.lastTermKey) === fingerprint.lastTermKey;
    if (same && Number.isInteger(m.batchFrom)) hits.push(m.batchFrom);
  }
  if (hits.length) {
    const reuse = Math.min(...hits);
    console.log(`（命中既有台账，复用起始批号 batch-${String(reuse).padStart(2, '0')}）`);
    return reuse;
  }
  // ② 否则接续既有最大批号
  const existing = readdirSync(opt.out)
    .map((f) => BATCH_RE.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return existing.length ? Math.max(...existing) + 1 : 1;
}
const from = resolveFrom();
if (!Number.isInteger(from) || from < 1) {
  console.error(`✗ 起始批号非法：${from}`);
  process.exit(1);
}

// ---- 落盘 ----
const batches = [];
for (let i = 0; i < added.length; i += opt.size) batches.push(added.slice(i, i + opt.size));
const pad = (n) => String(n).padStart(2, '0');
const written = [];
const skipped = [];
let conflict = 0;
for (let i = 0; i < batches.length; i++) {
  const no = from + i;
  const file = join(opt.out, `batch-${pad(no)}.json`);
  const content = JSON.stringify(batches[i].map(toRecord), null, 1) + '\n';
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') === content) {
      skipped.push(`batch-${pad(no)}`);
      continue;
    }
    if (!opt.force) {
      console.error(`✗ ${file} 已存在且内容不同（加 --force 可覆盖）`);
      conflict++;
      continue;
    }
  }
  if (!opt.dryRun) writeFileSync(file, content);
  written.push({ no, file, count: batches[i].length });
}

// 参考词表：基线在表词，供裁决 merge-into 目标是否「已在表」
const refPath = join(opt.out, `_reference-${pad(from)}.json`);
const refContent =
  JSON.stringify(
    baseline.map((e) => ({
      canonical: e.canonical,
      tier: e.tier,
      df: e.df,
      ...(e.topicKey ? { topicKey: e.topicKey } : {}),
    })),
    null,
    1,
  ) + '\n';
if (!opt.dryRun) writeFileSync(refPath, refContent);

const manifestPath = join(opt.out, `_manifest-${pad(from)}.json`);
const manifest = {
  generatedAt: new Date().toISOString(),
  termsFile: opt.terms,
  baselineFile: opt.baseline,
  baselineCount: baseline.length,
  termsCount: terms.length,
  addedCount: added.length,
  // 首末词 termKey：与上面三项共同构成差分指纹，供重跑时复用起始批号（见 resolveFrom）
  firstTermKey: fingerprint.firstTermKey,
  lastTermKey: fingerprint.lastTermKey,
  lostCount: lost.length,
  lostTermKeys: lost.map((e) => e.termKey),
  includeCandidates: opt.includeCandidates,
  batchSize: opt.size,
  batchFrom: from,
  batchTo: from + batches.length - 1,
  batchCount: batches.length,
  referenceFile: refPath,
};
// 台账只在内容变化时写：generatedAt 每次都变，故比对时剔除该字段
if (!opt.dryRun) {
  const stripTime = (o) => {
    const { generatedAt, ...rest } = o;
    return JSON.stringify(rest);
  };
  let same = false;
  if (existsSync(manifestPath)) {
    try {
      same = stripTime(JSON.parse(readFileSync(manifestPath, 'utf8'))) === stripTime(manifest);
    } catch {
      same = false;
    }
  }
  if (!same) writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
}

// ---- 统计 ----
const tierCount = added.reduce((a, e) => ((a[e.tier] = (a[e.tier] || 0) + 1), a), {});
console.log('—— 审校批次拆分 ——');
console.log(`基线 ${baseline.length} 词（${opt.baseline}）`);
console.log(`现表 ${terms.length} 词（${opt.terms}）${opt.includeCandidates ? ' + 候选池' : ''}`);
console.log(`新增待审 ${added.length} 词 ${JSON.stringify(tierCount)}；基线消失 ${lost.length} 词（不进审校批次）`);
console.log(
  `批次 batch-${pad(from)} … batch-${pad(from + batches.length - 1)} 共 ${batches.length} 批` +
  `（每批 ${opt.size}，末批 ${batches.length ? batches[batches.length - 1].length : 0}）`,
);
console.log(`写出 ${written.length} 批${skipped.length ? `，幂等跳过 ${skipped.length} 批（内容一致）` : ''}`);
if (opt.dryRun) console.log('（--dry-run：以上均未落盘）');
if (conflict) {
  console.error(`✗ ${conflict} 个批次文件存在内容冲突，未写出`);
  process.exit(1);
}
console.log('✓ 完成');
