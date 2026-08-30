#!/usr/bin/env node
// 数据管线 D3-5：审校抽查清单导出 —— 把 LLM 预裁结果（data/term-audit-decisions/batch-NN.json）
//   按分层比例抽样，生成供用户逐条复核的 Markdown 清单。
//
//   三级审校流水中的第三级（stage59 方案「三级审校流水」节）：
//     一级 自动  merge-terms.mjs 的停用词、入图门槛、evidence 校验；
//     二级 LLM   逐批预裁，产出 {termKey,canonical,decision,note}；
//     三级 用户  本脚本产出的 md 清单，复核列填「OK」或改写为其他裁决。
//
//   —— 分层抽样比例（方案固化，改动须同步方案）——
//     · decision=drop        100%（误删代价最高，全部过目）
//     · decision=merge-into  100%（并错会静默吞掉一个词条，全部过目）
//     · decision=keep 且 tier=high  10%
//     · decision=keep 且 tier=mid   25%（mid 是「多处 used」的弱证据词，错留率高于 high，抽样比更高）
//   抽样确定性：层内按原顺序编号后取模（high 取 i%10===0、mid 取 i%4===0），
//     同一输入必得同一份清单，便于中断续做与结果复现——不使用随机数。
//
//   为何用 md 而不是 CSV：清单要给人读，每条都带原文证据与裁决理由，CSV 在 Excel 里
//     长文本折行严重；md 表格在编辑器与预览器中均可读，且「复核」列可直接键入。
//
//   回灌（放行后执行，不在本脚本职责内）：读回各 batch-NN.md 的复核列，
//     填「OK」= 采纳预裁；填其他裁决（keep / drop / merge-into:xxx）= 覆盖预裁；
//     覆盖结果写回 data/term-audit-decisions/ 对应条目后，
//     执行 apply-term-audit.mjs --from-decisions 固化，再复跑 merge-terms.mjs。
//
//   运行：node scripts/export-term-audit-sample.mjs --from 16 --to 28
//     --from <N> / --to <N>   决策批次号区间（含端点）
//     --out <dir>             清单输出目录，默认 audit/terms/5.9-审校抽查
//     --size <N>              每份清单条数，默认 60
//     --dry-run               只打印统计不落盘
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_DOMAINS } from './lib/domains.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const BATCH_DIR = join(DATA_DIR, 'term-audit-batches');
const DEC_DIR = join(DATA_DIR, 'term-audit-decisions');

// 默认比例为方案固化值。命令行可覆盖 keep 两档——预裁若极度保守（drop/merge 占比很低），
//   按默认比例抽出的量会明显低于预期复核强度，此时调高 keep 档比例即可，无须改代码。
const RATE = { drop: 1, merge: 1, keepHigh: 0.1, keepMid: 0.25 };
const EVID_MAX = 60; // 证据摘录字数上限

const opt = { from: null, to: null, out: join(__dirname, '..', 'audit', 'terms', '5.9-审校抽查'), size: 60, dryRun: false };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opt.from = Number(argv[++i]);
    else if (a === '--to') opt.to = Number(argv[++i]);
    else if (a === '--out') opt.out = resolve(argv[++i]);
    else if (a === '--size') opt.size = Number(argv[++i]);
    else if (a === '--keep-high-rate') RATE.keepHigh = Number(argv[++i]);
    else if (a === '--keep-mid-rate') RATE.keepMid = Number(argv[++i]);
    else if (a === '--dry-run') opt.dryRun = true;
    else {
      console.error(`✗ 未知参数：${a}`);
      process.exit(1);
    }
  }
  for (const [k, v] of [['--keep-high-rate', RATE.keepHigh], ['--keep-mid-rate', RATE.keepMid]]) {
    if (!(v > 0 && v <= 1)) {
      console.error(`✗ ${k} 必须落在 (0,1] 区间，当前 ${v}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opt.from) || !Number.isInteger(opt.to) || opt.from > opt.to) {
    console.error('✗ 必须提供合法的 --from / --to 批次号区间');
    process.exit(1);
  }
}

const STEP_HIGH = Math.max(1, Math.round(1 / RATE.keepHigh)); // 默认 10 → 每 10 条取 1
const STEP_MID = Math.max(1, Math.round(1 / RATE.keepMid)); // 默认 4 → 每 4 条取 1
const pad = (n) => String(n).padStart(2, '0');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// md 表格单元格转义：竖线会截断列，换行会断表
const cell = (s) => String(s ?? '').replace(/\|/g, '｜').replace(/\r?\n/g, ' ').trim();
const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
// 域 key → 短名（与全站同源，取 KNOWN_DOMAINS.short）：清单「出处」列只留章节末段时，
//   「1.6审查结论 › 1.6.2不予核准」这类小节号看不出属于哪部规范，须冠以法域短名。
const DOMAIN_SHORT = new Map(KNOWN_DOMAINS.map((d) => [d.key, d.short || d.key]));

// ---- 读取批次与决策，逐条配对 ----
const all = [];
const missing = [];
const stat = { total: 0, keep: 0, drop: 0, merge: 0, high: 0, mid: 0 };
for (let n = opt.from; n <= opt.to; n++) {
  const bp = join(BATCH_DIR, `batch-${pad(n)}.json`);
  const dp = join(DEC_DIR, `batch-${pad(n)}.json`);
  if (!existsSync(bp)) {
    console.error(`✗ 待审批次缺失：${bp}`);
    process.exit(1);
  }
  if (!existsSync(dp)) {
    missing.push(`batch-${pad(n)}`);
    continue;
  }
  const src = readJson(bp);
  const dec = readJson(dp);
  const decBy = new Map(dec.map((d) => [d.termKey, d]));
  for (const s of src) {
    const d = decBy.get(s.termKey);
    if (!d) {
      console.error(`✗ batch-${pad(n)} 决策缺失词条：${s.canonical}`);
      process.exit(1);
    }
    const v = String(d.decision || '').trim();
    const kind = v === 'drop' ? 'drop' : /^merge-into[:：]/i.test(v) ? 'merge' : 'keep';
    all.push({
      batch: n,
      termKey: s.termKey,
      canonical: s.canonical,
      tier: s.tier,
      df: s.df,
      domains: s.domains || [],
      decision: v,
      note: d.note || '',
      evidence: (s.sampleEvidence || []).map((e) => e.text).filter(Boolean),
      breadcrumb: (s.breadcrumbs || [])[0] || '',
      kind,
    });
    stat.total++;
    stat[kind]++;
    if (kind === 'keep') stat[s.tier === 'high' ? 'high' : 'mid']++;
  }
}
if (missing.length) {
  console.error(`✗ 以下批次尚无决策文件，无法出清单：${missing.join('、')}`);
  process.exit(1);
}

// ---- 分层抽样 ----
const picked = [];
let iHigh = 0;
let iMid = 0;
for (const r of all) {
  if (r.kind === 'drop' || r.kind === 'merge') {
    picked.push({ ...r, layer: r.kind === 'drop' ? '剔除' : '归并' });
    continue;
  }
  if (r.tier === 'high') {
    if (iHigh++ % STEP_HIGH === 0) picked.push({ ...r, layer: '保留·high 抽样' });
  } else if (iMid++ % STEP_MID === 0) picked.push({ ...r, layer: '保留·mid 抽样' });
}

// ---- 分批写 md ----
mkdirSync(opt.out, { recursive: true });
const sheets = [];
for (let i = 0; i < picked.length; i += opt.size) sheets.push(picked.slice(i, i + opt.size));

const HEADER = (no, count, total) => `# 术语审校抽查清单 · 第 ${pad(no)} 份（共 ${total} 份）

> 本份 ${count} 条。阶段5.9 术语索引扩充批（商标域 895 片 + 四法域 384 片新语料），
> 经 LLM 逐条预裁后按分层比例抽样，请在「复核」列填写意见。

**填写方式**：认可预裁结论填 \`OK\`；不认可则直接把该格改写为你要的裁决——
\`keep\`（保留）、\`drop\`（剔除）、\`merge-into:目标词\`（并入已有词条，目标词写全称）。
留空视同尚未复核，回灌时按预裁结论处理。

**抽样口径**：裁决为「剔除」「归并」的 100% 列入；裁决为「保留」的按证据强度抽样——
tier=high（有明确定义句且置信度高）抽 10%，tier=mid（多处引用但无定义句）抽 25%。

| # | 词条 | 层 | tier/df | 预裁 | 预裁理由 | 原文证据 | 出处 | 复核 |
|---|------|----|---------|------|----------|----------|------|------|`;

const written = [];
for (let i = 0; i < sheets.length; i++) {
  const no = i + 1;
  const lines = [HEADER(no, sheets[i].length, sheets.length)];
  sheets[i].forEach((r, j) => {
    // 出处 = 法域短名 · 面包屑末两段（无面包屑时退回域列表）
    const short = r.domains.map((d) => DOMAIN_SHORT.get(d) || d).join('/');
    const tail = r.breadcrumb ? r.breadcrumb.replace(/^[^:]*:/, '').split(' › ').slice(-2).join(' › ') : '';
    const src = tail ? `${short} · ${clip(tail, 34)}` : short;
    // 首尾竖线必须写全：GFM 虽允许省略，但表头写了而数据行省略会让最后一个空单元格
    //   （「复核」列）被解析器吞掉，用户就没有可填的格子。
    lines.push(
      '| ' +
      [
        i * opt.size + j + 1,
        cell(r.canonical),
        cell(r.layer),
        `${r.tier}/${r.df}`,
        cell(r.decision),
        cell(clip(r.note, 120)),
        cell(clip(r.evidence[0] || '', EVID_MAX)),
        cell(src),
        '',
      ].join(' | ') +
      ' |',
    );
  });
  const body = lines.join('\n') + '\n';
  const file = join(opt.out, `batch-${pad(no)}.md`);
  if (!opt.dryRun) writeFileSync(file, body);
  written.push({ file, count: sheets[i].length });
}

// ---- 抽样说明（供复核者与后续回灌者对账）----
const layerCount = picked.reduce((a, r) => ((a[r.layer] = (a[r.layer] || 0) + 1), a), {});
const readme = `# 抽样说明 · 阶段5.9 术语审校抽查

- 生成时间：${new Date().toISOString()}
- 决策批次区间：batch-${pad(opt.from)} … batch-${pad(opt.to)}
- 预裁总量：${stat.total} 条（keep ${stat.keep} / merge-into ${stat.merge} / drop ${stat.drop}）
  - keep 中 tier=high ${stat.high} 条、tier=mid ${stat.mid} 条
- 抽样比例：drop 100%、merge-into 100%、keep·high ${RATE.keepHigh * 100}%、keep·mid ${RATE.keepMid * 100}%
- 抽样方式：层内按原顺序取模（high 每 ${STEP_HIGH} 条取 1、mid 每 ${STEP_MID} 条取 1），确定性可复现
- 抽出总量：**${picked.length} 条**，分 ${sheets.length} 份清单（每份 ${opt.size} 条，末份 ${sheets.length ? sheets[sheets.length - 1].length : 0} 条）

| 抽样层 | 条数 |
|--------|------|
${Object.entries(layerCount)
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join('\n')}

## 复核完成后的回灌路径
1. 各 \`batch-NN.md\` 的「复核」列填「OK」或改写裁决；
2. 把改写结果覆盖回 \`site/data/term-audit-decisions/batch-NN.json\` 对应条目；
3. \`node scripts/apply-term-audit.mjs --from-decisions --no-csv --since ${opt.from}\` 固化为
   term-merges.json / term-blacklist.json；
4. 复跑 \`node scripts/merge-terms.mjs\`，再接主题归类与全量重建。
`;
if (!opt.dryRun) writeFileSync(join(opt.out, '_抽样说明.md'), readme);

console.log('—— 审校抽查清单 ——');
console.log(`预裁 ${stat.total} 条：keep ${stat.keep}（high ${stat.high} / mid ${stat.mid}）| merge-into ${stat.merge} | drop ${stat.drop}`);
console.log(`抽出 ${picked.length} 条：${Object.entries(layerCount).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
console.log(`清单 ${sheets.length} 份 → ${opt.out}`);
for (const w of written) console.log(`  ${w.file}（${w.count} 条）`);
if (opt.dryRun) console.log('（--dry-run：以上均未落盘）');
