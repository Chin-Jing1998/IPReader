#!/usr/bin/env node
// 数据管线 D4-1：术语节点入图 —— data/terms-merged.json → data/nodes.json 追加 kind:'term' 节点。
//   运行位置：parse-domains 之后、extract-edges 之前（npm run data 链已接入）。
//
//   三道过滤闸（依次执行，均打印被排除清单/计数）：
//     1) 停用词兜底：canonical 归一后整词命中 lib/term-stopwords.mjs 者不建节点（merge-terms 已挡一层，此处兜底）；
//     2) 超高频泛词：df > DF_MAX（159 ≈ 25% × 636 切片）者不建节点；
//     3) tier 门槛：只收 seed / high / mid。
//
//   id registry：data/terms.json（canonical → term-NNNN，4 位零填充）。存在则读取，映射永不改变、id 永不回收；
//   新词按词表顺序追加递增编号。canonical 从词表消失时其映射仍保留（占位不复用）。
//
//   断言：term 节点数 ≤ TERM_NODE_CAP（默认 1000；环境变量 TERM_NODE_CAP 仅供开发验证临时放宽），
//   超限打印按 df 升序的尾部裁剪建议并 exit 1。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOPWORDS } from './lib/term-stopwords.mjs';
import { TOPIC_NAME } from './lib/topics.mjs';
import { loadTermExtractIndex, pickDefinition, normTerm } from './lib/term-extract-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');

const DF_MAX = 159; // ≈ 25% × 636 切片：df 超过即视为全库泛词，不建节点
const ALLOW_TIERS = new Set(['seed', 'high', 'mid']);
const DEFAULT_CAP = 1000; // 原计划 800，因审校后 keep 数偏高放宽到 1000；超过必须失败
const CAP = Number(process.env.TERM_NODE_CAP) > 0 ? Number(process.env.TERM_NODE_CAP) : DEFAULT_CAP;
const ID_PREFIX = 'term-';
const ID_PAD = 4;

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(D, name), 'utf8'));
  } catch (err) {
    console.error(`✗ 无法读取/解析 data/${name}：${err.message}`);
    process.exit(1);
  }
}

const terms = readJson('terms-merged.json');
const nodes = readJson('nodes.json');

// ---- 三道过滤闸 ----
const STOP_NORM = new Set([...STOPWORDS].map(normTerm));
const dropStop = [];
const dropDf = [];
const dropTier = [];
const kept = [];
for (const t of terms) {
  if (STOP_NORM.has(normTerm(t.canonical))) { dropStop.push(t); continue; }
  if ((t.df || 0) > DF_MAX) { dropDf.push(t); continue; }
  if (!ALLOW_TIERS.has(t.tier)) { dropTier.push(t); continue; }
  kept.push(t);
}
console.log(`词表 ${terms.length} 词 → 过闸 ${kept.length} 词`);
console.log(`  闸1 停用词兜底剔除: ${dropStop.length}${dropStop.length ? ' → ' + dropStop.map((t) => t.canonical).join('、') : ''}`);
console.log(
  `  闸2 df>${DF_MAX} 超高频泛词剔除: ${dropDf.length}` +
    (dropDf.length ? ' → ' + dropDf.map((t) => `${t.canonical}(df=${t.df})`).join('、') : ''),
);
console.log(`  闸3 tier 门槛（只收 seed/high/mid）剔除: ${dropTier.length}${dropTier.length ? ' → ' + dropTier.map((t) => `${t.canonical}(${t.tier})`).join('、') : ''}`);

// ---- 断言：节点数上限（超限打印按 df 升序的尾部裁剪建议后失败）----
if (kept.length > CAP) {
  const overflow = kept.length - CAP;
  const tail = [...kept].sort((a, b) => (a.df || 0) - (b.df || 0) || a.canonical.localeCompare(b.canonical, 'zh')).slice(0, overflow);
  console.error(`✗ 断言失败：term 节点数 ${kept.length} 超过上限 ${CAP}（超出 ${overflow}）`);
  console.error('  按 df 升序的尾部裁剪建议（df 最低者优先剔除/降级为候选）:');
  console.error('  ' + tail.map((t) => `${t.canonical}(${t.tier},df=${t.df})`).join('、'));
  process.exit(1);
}

// ---- id registry：canonical → term-NNNN，永不改变、永不复用 ----
const REG_PATH = join(D, 'terms.json');
const registry = existsSync(REG_PATH) ? JSON.parse(readFileSync(REG_PATH, 'utf8')) : {};
{
  // registry 自检：id 值必须唯一（映射被手工改坏时立即失败，避免两词共用一个节点 id）
  const vals = Object.values(registry);
  if (new Set(vals).size !== vals.length) {
    console.error('✗ data/terms.json registry 中存在重复 id，请人工修复后重跑');
    process.exit(1);
  }
}
let nextSeq = 0;
for (const id of Object.values(registry)) {
  const m = /^term-(\d+)$/.exec(id);
  if (m) nextSeq = Math.max(nextSeq, parseInt(m[1], 10));
}
let newIds = 0;
for (const t of kept) {
  if (registry[t.canonical]) continue;
  nextSeq++;
  registry[t.canonical] = `${ID_PREFIX}${String(nextSeq).padStart(ID_PAD, '0')}`;
  newIds++;
}
writeFileSync(REG_PATH, JSON.stringify(registry, null, 2));
console.log(`id registry: 既有 ${Object.keys(registry).length - newIds} 条，本次新增 ${newIds} 条 → data/terms.json`);

// ---- 定义处 evidence（summary）：term-extract 中 role=defined 的记录，无则留空 ----
const extractIndex = loadTermExtractIndex(join(D, 'term-extract'));
console.log(`term-extract 索引: ${extractIndex.files} 片 / ${extractIndex.byNorm.size} 个归一词键`);

// ---- 组装 term 节点（字段口径与既有内容节点对齐，x/y/size 由 compute-layout 写、degree 由 extract-edges 写）----
const baseNodes = nodes.filter((n) => n.kind !== 'term'); // 幂等：先移除历史 term 节点再追加
const existingIds = new Set(baseNodes.map((n) => n.id));
// 下游字段保护：x/y/size 由 compute-layout 写、degree/hub 由 extract-edges 写，本脚本不产出。
//   单跑本脚本（如仅刷新 topicKey）时若不回填，全部 term 节点会丢坐标与度数，图谱布局崩塌
//   且必须重跑 extract-edges + compute-layout 才能恢复。按 id 从旧节点原样搬运即可保持幂等。
const DOWNSTREAM_FIELDS = ['degree', 'x', 'y', 'size', 'hub'];
const prevTermById = new Map(nodes.filter((n) => n.kind === 'term').map((n) => [n.id, n]));
const termNodes = [];
let defCount = 0;
let carried = 0;
for (const t of kept) {
  const id = registry[t.canonical];
  if (existingIds.has(id)) {
    console.error(`✗ term 节点 id 与既有节点冲突：${id}（${t.canonical}）`);
    process.exit(1);
  }
  const srcNodeIds = new Set(Object.values(t.sources || {}).flat());
  const summary = pickDefinition(extractIndex, t.canonical, t.aliases || [], srcNodeIds);
  if (summary) defCount++;
  const node = {
    id,
    kind: 'term',
    level: 'term',
    domain: 'terms',
    label: t.canonical,
    aliases: t.aliases || [],
  };
  if (t.topicKey) node.topicKey = t.topicKey;
  Object.assign(node, {
    laws: t.lawKeys || [],
    summary,
    tier: t.tier,
    df: t.df || 0,
    breadcrumb: ['关键词索引', (t.topicKey && TOPIC_NAME[t.topicKey]) || '综合'],
    partNum: 0,
    chapterNum: null,
    sectionNum: null,
    subNum: null,
    num: null,
    charLen: 0,
    community: 0,
    domainCommunity: 0,
    colorGroup: 'terms',
    hasOwnText: false,
    topics: [],
  });
  const prev = prevTermById.get(id);
  if (prev) {
    let any = false;
    for (const f of DOWNSTREAM_FIELDS) {
      if (prev[f] !== undefined) {
        node[f] = prev[f];
        any = true;
      }
    }
    if (any) carried++;
  }
  termNodes.push(node);
}

// term 节点内部 id 唯一性（registry 自检之外的最后防线）
if (new Set(termNodes.map((n) => n.id)).size !== termNodes.length) {
  console.error('✗ term 节点 id 内部重复');
  process.exit(1);
}

const out = [...baseNodes, ...termNodes];
writeFileSync(join(D, 'nodes.json'), JSON.stringify(out, null, 0));
console.log(
  `✓ term 节点入图: ${termNodes.length} 个（定义 summary 覆盖 ${defCount}）；` +
  `下游字段(${DOWNSTREAM_FIELDS.join('/')})回填 ${carried} 个；nodes.json 合计 ${out.length} 节点`,
);
if (CAP !== DEFAULT_CAP) console.log(`⚠ 当前以环境变量 TERM_NODE_CAP=${CAP} 放宽上限运行（仅限开发验证，正式数据须走默认 ${DEFAULT_CAP}）`);
