// 节点关联性复核核查（只读分析，不改任何数据/前端逻辑）。
//   双信号交叉验证：① 规则信号（关键词命中强度 + 主题交集 + 杂项枢纽识别）；② 语义信号（本地 embedding 余弦）。
//   产出 audit/关联核查报告.md + audit/疑似无关连接清单.csv（+ embeddings 缓存）。embedding 不可用时自动降级为纯规则。
//   运行：node scripts/audit-edges.mjs   （首次跑语义需先 npm i -D @huggingface/transformers）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TOPICS, TOPIC_NAME } from './lib/topics.mjs';
import { embedTexts, cosine, MODEL_ID } from './lib/embed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const OUT = join(__dirname, '..', 'audit');

// ---- 可调阈值（报告会输出实际相似度分布辅助校准）----
const SIM_LOW = 0.4; // 语义相似度低于此：内容很可能不相关
const SIM_HIGH = 0.62; // 高于此：内容很可能相关
const MISS_SIM = 0.7; // 漏连阈值：跨域未连但语义≥此 → 提示可考虑补连
const HUB_TOPIC_N = 8; // 主题命中数≥此 → "杂揽型"节点
const GENERIC_TOPICS = new Set(['oaResponse', 'claims', 'description']); // 关键词偏宽泛的主题

// ⚠ 2026-08-23 修复：旧键 'examination-guideline-2025' 随域改名同步为 'examination-guideline'；补登此前未登记的 trademark-exam-guide-2021。
const DOMAIN_CN = {
  'examination-guideline': '审查指南',
  'patent-law': '专利法',
  'implementation-rules': '实施细则',
  'infringement-guide': '侵权判定',
  'mechanical-drafting-rules': '机械撰写',
  'chemistry-drafting-rules': '化学撰写',
  'oa-response-guide': '答复指引',
  'trademark-exam-guide-2021': '商标审查指南',
};
const dcn = (d) => DOMAIN_CN[d] || d;
const HUB_RE = /其他文件|相关手续|相关规定|实质审查/;

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(D, name), 'utf8'));
  } catch (err) {
    console.error(`✗ 读取 data/${name} 失败：${err.message}\n  请先运行 npm run data 生成基础数据。`);
    process.exit(1);
  }
}

// ---- 载入数据与索引 ----
const nodes = readJson('nodes.json');
const edges = readJson('edges.json');
const laws = readJson('laws.json');
const bodies = (() => {
  try {
    return JSON.parse(readFileSync(join(D, 'node-bodies.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const byId = new Map(nodes.map((n) => [n.id, n]));
const children = new Map();
const parent = new Map();
const adj = new Map(); // 无向邻接（全部边类型）
for (const n of nodes) adj.set(n.id, new Set());
for (const e of edges) {
  if (e.type === 'hierarchy') {
    if (!children.has(e.source)) children.set(e.source, []);
    children.get(e.source).push(e.target);
    parent.set(e.target, e.source);
  }
  adj.get(e.source)?.add(e.target);
  adj.get(e.target)?.add(e.source);
}
const TOPIC_KW = new Map(TOPICS.map((t) => [t.key, t.kw]));

// 主题 → 节点（复现前端 topicPeers 所需）
const TOPIC_NODES = new Map();
for (const n of nodes) for (const tk of n.topics || []) {
  if (!TOPIC_NODES.has(tk)) TOPIC_NODES.set(tk, []);
  TOPIC_NODES.get(tk).push(n.id);
}

// 节点自身正文（用于关键词命中；容器节点 ownText 空则退摘要）
function matchText(n) {
  const b = bodies[n.id] || {};
  return ((b.ownText || '').trim() || n.summary || '').slice(0, 4000);
}
// 节点语义代表文本（标题+路径+正文，供 embedding）
function nodeText(n) {
  const head = [n.label, ...(n.breadcrumb || [])].join(' / ');
  return (head + '。' + matchText(n)).slice(0, 2000);
}
// 杂项枢纽：高 degree 且杂揽，不是真正聚焦某主题的实体节点（法条节点的高 degree 属正常引用，排除）
function isJunkHub(n) {
  if (!n) return false;
  if (n.lawKey) return false;
  if (HUB_RE.test(n.label)) return true;
  if ((n.topics?.length ?? 0) >= HUB_TOPIC_N) return true;
  return false;
}
// 某节点正文对某主题的命中强度 = 命中的不同关键词数
function strength(text, topicKey) {
  let hit = 0;
  for (const k of TOPIC_KW.get(topicKey) || []) if (text.includes(k)) hit++;
  return hit;
}
const inter = (a = [], b = []) => a.filter((x) => b.includes(x));

// 复现前端 topicPeers（main.ts）：每主题每跨域取 degree 高的 2 个，封顶 24
function topicPeers(id) {
  const self = byId.get(id);
  if (!self) return [];
  const picked = new Map();
  for (const tk of self.topics || []) {
    const byDom = new Map();
    for (const pid of TOPIC_NODES.get(tk) || []) {
      const p = byId.get(pid);
      if (!p || p.domain === self.domain || pid === id) continue;
      if (!byDom.has(p.domain)) byDom.set(p.domain, []);
      byDom.get(p.domain).push({ id: pid, deg: p.degree || 0 });
    }
    for (const arr of byDom.values()) {
      arr.sort((a, b) => b.deg - a.deg);
      for (const c of arr.slice(0, 2)) picked.set(c.id, c.deg);
    }
  }
  return [...picked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([pid]) => pid);
}

// ---- embedding（带缓存）----
async function buildVectors() {
  const cachePath = join(OUT, 'embeddings.json');
  const cache = existsSync(cachePath)
    ? (() => {
        try {
          return JSON.parse(readFileSync(cachePath, 'utf8'));
        } catch {
          return null;
        }
      })()
    : null;
  const hash = (s) => createHash('md5').update(s).digest('hex').slice(0, 12);
  const texts = nodes.map((n) => nodeText(n));
  const hashes = texts.map((t) => hash(t));

  if (cache && cache.model === MODEL_ID && cache.items) {
    const ok = nodes.every((n, i) => cache.items[n.id]?.h === hashes[i]);
    if (ok) {
      const vecs = new Map(nodes.map((n) => [n.id, cache.items[n.id].v]));
      console.log(`[embed] 命中缓存（${MODEL_ID}），跳过重算。`);
      return vecs;
    }
  }
  const arr = await embedTexts(texts);
  if (!arr) return null; // 降级
  const vecs = new Map();
  const items = {};
  nodes.forEach((n, i) => {
    vecs.set(n.id, arr[i]);
    items[n.id] = { h: hashes[i], v: arr[i] };
  });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ model: MODEL_ID, dim: arr[0]?.length ?? 0, items }));
  console.log(`[embed] 已写向量缓存 → audit/embeddings.json`);
  return vecs;
}

function simOf(vecs, a, b) {
  if (!vecs) return null;
  const va = vecs.get(a);
  const vb = vecs.get(b);
  if (!va || !vb) return null;
  return cosine(va, vb);
}

// ---- 主流程 ----
async function main() {
  mkdirSync(OUT, { recursive: true });
  const vecs = await buildVectors(); // Map 或 null
  const hasSem = !!vecs;

  const byType = edges.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
  const matchCache = new Map(nodes.map((n) => [n.id, matchText(n)]));

  // ---- concept 边核查 ----
  const conceptRows = [];
  const tally = { '高置信·相关': 0, '存疑·待定': 0, '疑似无关': 0 };
  for (const e of edges.filter((x) => x.type === 'concept')) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const shared = inter(s.topics, t.topics);
    let rel = 0;
    for (const tk of shared) rel = Math.max(rel, Math.min(strength(matchCache.get(s.id), tk), strength(matchCache.get(t.id), tk)));
    const sim = simOf(vecs, s.id, t.id);
    const hub = isJunkHub(s) ? s : isJunkHub(t) ? t : null;
    const allGeneric = shared.length > 0 && shared.every((tk) => GENERIC_TOPICS.has(tk));

    let level, advice, reason;
    if (hub) {
      level = '疑似无关';
      advice = '删/改接';
      reason = `一端为杂揽型枢纽「${hub.label}」(主题${hub.topics?.length || 0}个)，多半是按字数选代表造成的伪桥`;
    } else if (rel === 0) {
      level = '疑似无关';
      advice = '删';
      reason = `共享主题[${shared.map((k) => TOPIC_NAME[k]).join('、')}]仅弱命中(关键词强度0)`;
    } else if (hasSem && sim < SIM_LOW) {
      level = '疑似无关';
      advice = '删';
      reason = `字面强度${rel}，但语义相似度仅${sim.toFixed(3)}(＜${SIM_LOW})，内容实不相关`;
    } else if (rel >= 2 && (!hasSem || sim >= SIM_HIGH)) {
      level = '高置信·相关';
      advice = '留';
      reason = `共享[${shared.map((k) => TOPIC_NAME[k]).join('、')}]强度${rel}${hasSem ? `，语义${sim.toFixed(3)}` : ''}`;
    } else {
      level = '存疑·待定';
      advice = '待定';
      reason = `字面强度${rel}${allGeneric ? '(均属宽泛主题)' : ''}${hasSem ? `，语义${sim.toFixed(3)}` : ''}，需人工判定`;
    }
    const key = level.startsWith('高置信') ? '高置信·相关' : level.startsWith('存疑') ? '存疑·待定' : '疑似无关';
    tally[key]++;
    conceptRows.push({ type: 'concept', s, t, shared, rel, sim, hub: !!hub, level, advice, reason });
  }

  // ---- colaw 边核查 ----
  const colawRows = [];
  let colawCross = 0;
  for (const e of edges.filter((x) => x.type === 'colaw')) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const cross = s.domain !== t.domain;
    if (!cross) continue;
    colawCross++;
    const shared = inter(s.topics, t.topics);
    const sim = simOf(vecs, s.id, t.id);
    let level, advice, reason;
    if (shared.length === 0 && (!hasSem || sim < SIM_LOW)) {
      level = '疑似无关';
      advice = '删';
      reason = `跨域共引法条，但无共享主题${hasSem ? `、语义仅${sim.toFixed(3)}` : ''}`;
    } else if (hasSem && sim >= SIM_HIGH) {
      level = '高置信·相关';
      advice = '留';
      reason = `跨域共引，语义${sim.toFixed(3)}支持相关`;
    } else {
      level = '存疑·待定';
      advice = '待定';
      reason = `跨域共引${shared.length ? `，共享[${shared.map((k) => TOPIC_NAME[k]).join('、')}]` : ''}${hasSem ? `，语义${sim.toFixed(3)}` : ''}`;
    }
    colawRows.push({ type: 'colaw', s, t, shared, rel: '-', sim, hub: false, level, advice, reason });
  }

  // ---- lawref hub 法条统计 ----
  const lawIn = new Map();
  for (const e of edges.filter((x) => x.type === 'lawref')) lawIn.set(e.target, (lawIn.get(e.target) || 0) + 1);
  const lawHubs = [...lawIn.entries()]
    .map(([id, c]) => ({ id, c, label: byId.get(id)?.label || id }))
    .sort((a, b) => b.c - a.c)
    .slice(0, 12);

  // ---- 语义漏连发现（跨域、未连、语义≥MISS_SIM）----
  const missing = [];
  if (hasSem) {
    const ids = nodes.map((n) => n.id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = byId.get(ids[i]);
        const b = byId.get(ids[j]);
        if (a.domain === b.domain) continue;
        if (adj.get(ids[i])?.has(ids[j])) continue;
        const sim = cosine(vecs.get(ids[i]), vecs.get(ids[j]));
        if (sim >= MISS_SIM) missing.push({ a, b, sim });
      }
    }
    missing.sort((x, y) => y.sim - x.sim);
  }

  // ---- 相似度分布对照（校准阈值用）----
  const dist = {};
  if (hasSem) {
    const pick = (type) => {
      const arr = edges
        .filter((e) => e.type === type)
        .map((e) => simOf(vecs, e.source, e.target))
        .filter((v) => v != null)
        .sort((a, b) => a - b);
      if (!arr.length) return null;
      const q = (p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
      return { n: arr.length, p10: q(0.1), p50: q(0.5), p90: q(0.9) };
    };
    dist.hierarchy = pick('hierarchy');
    dist.xref = pick('xref');
    dist.lawref = pick('lawref');
    dist.colaw = pick('colaw');
    dist.concept = pick('concept');
    // 随机跨域对作"无关基线"
    const rnd = [];
    const ids = nodes.map((n) => n.id);
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 2000; k++) {
      const a = byId.get(ids[Math.floor(rand() * ids.length)]);
      const b = byId.get(ids[Math.floor(rand() * ids.length)]);
      if (a.id === b.id || a.domain === b.domain) continue;
      rnd.push(cosine(vecs.get(a.id), vecs.get(b.id)));
    }
    rnd.sort((a, b) => a - b);
    dist.random = rnd.length ? { n: rnd.length, p10: rnd[Math.floor(rnd.length * 0.1)], p50: rnd[Math.floor(rnd.length * 0.5)], p90: rnd[Math.floor(rnd.length * 0.9)] } : null;
  }

  // ---- 点击点亮模拟（取 degree 最高的 3 个非法条节点为样本）----
  const samples = nodes
    .filter((n) => !n.lawKey)
    .sort((a, b) => (b.degree || 0) - (a.degree || 0))
    .slice(0, 3);
  const simRows = samples.map((n) => {
    const nb = new Set([n.id, ...(adj.get(n.id) || [])]);
    for (const p of topicPeers(n.id)) nb.add(p);
    nb.delete(n.id);
    const lit = [...nb];
    const cross = lit.filter((id) => byId.get(id)?.domain !== n.domain).length;
    let lowSim = 0;
    if (hasSem) for (const id of lit) {
      const sv = simOf(vecs, n.id, id);
      if (sv != null && sv < SIM_LOW) lowSim++;
    }
    return { n, total: lit.length, cross, lowSim };
  });

  writeReport({ byType, tally, conceptRows, colawRows, colawCross, lawHubs, missing, dist, simRows, hasSem });
  writeCsv([...conceptRows, ...colawRows]);
  writeMissingCsv(missing);

  console.log('\n==== 核查摘要 ====');
  console.log('边类型:', byType);
  console.log('concept 分级:', tally);
  console.log(`跨域 colaw: ${colawCross} 条；lawref hub 法条 top1: ${lawHubs[0]?.label}(${lawHubs[0]?.c})`);
  console.log(hasSem ? `语义漏连建议: ${missing.length} 条（≥${MISS_SIM}）` : '语义层未启用（纯规则）');
  console.log(`产出 → audit/关联核查报告.md、audit/疑似无关连接清单.csv${hasSem ? '、audit/语义漏连建议.csv、audit/embeddings.json' : ''}`);
}

// ---- 报告与清单输出 ----
function bar(v) {
  if (v == null) return '—';
  return `${v.toFixed(3)}`;
}
function writeReport(R) {
  const L = [];
  L.push('# 专利星图 · 节点关联性复核报告');
  L.push('');
  L.push(`- 生成时间：${new Date().toISOString()}`);
  L.push(`- 数据规模：${nodes.length} 节点，${edges.length} 条边`);
  L.push(`- 语义层：${R.hasSem ? `已启用（本地 ${MODEL_ID}）` : '未启用（纯规则；如需语义请 `npm i -D @huggingface/transformers` 后重跑）'}`);
  L.push('');
  L.push('## 一、边类型总览');
  L.push('');
  L.push('| 类型 | 条数 | 说明 |');
  L.push('|---|---|---|');
  L.push(`| hierarchy | ${R.byType.hierarchy || 0} | 层级父子（id 前缀，可靠） |`);
  L.push(`| lawref | ${R.byType.lawref || 0} | 节点→引用法条（事实性） |`);
  L.push(`| xref | ${R.byType.xref || 0} | 正文显式"参见"（可靠） |`);
  L.push(`| colaw | ${R.byType.colaw || 0} | 共引同一法条（跨域 ${R.colawCross} 条需查） |`);
  L.push(`| concept | ${R.byType.concept || 0} | 跨域同主题桥（核查重点） |`);
  L.push('');
  L.push('## 二、concept 边分级结果');
  L.push('');
  L.push(`- ✅ 高置信·相关：**${R.tally['高置信·相关']}** 条（建议保留）`);
  L.push(`- ⚠️ 存疑·待定：**${R.tally['存疑·待定']}** 条（需人工研判）`);
  L.push(`- ❌ 疑似无关：**${R.tally['疑似无关']}** 条（建议删除/改接）`);
  L.push('');
  L.push('### 疑似无关 / 存疑明细（按级别，前 40）');
  L.push('');
  L.push('| 级别 | 源(域) | 目标(域) | 共享主题 | 字面 | 语义 | 建议 | 理由 |');
  L.push('|---|---|---|---|---|---|---|---|');
  const order = { 疑似无关: 0, '存疑·待定': 1, '高置信·相关': 2 };
  const showC = R.conceptRows.slice().sort((a, b) => order[a.level] - order[b.level]).slice(0, 40);
  for (const r of showC)
    L.push(
      `| ${r.level} | ${r.s.label}(${dcn(r.s.domain)}) | ${r.t.label}(${dcn(r.t.domain)}) | ${r.shared.map((k) => TOPIC_NAME[k]).join('、') || '—'} | ${r.rel} | ${bar(r.sim)} | ${r.advice} | ${r.reason} |`
    );
  L.push('');
  L.push('## 三、跨域 colaw 边核查');
  L.push('');
  if (R.colawRows.length) {
    L.push('| 级别 | 源(域) | 目标(域) | 共享主题 | 语义 | 建议 | 理由 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const r of R.colawRows.slice(0, 25))
      L.push(`| ${r.level} | ${r.s.label}(${dcn(r.s.domain)}) | ${r.t.label}(${dcn(r.t.domain)}) | ${r.shared.map((k) => TOPIC_NAME[k]).join('、') || '—'} | ${bar(r.sim)} | ${r.advice} | ${r.reason} |`);
  } else L.push('无跨域 colaw 边。');
  L.push('');
  L.push('## 四、lawref 高频法条（hub，信息量低，前端可考虑弱化）');
  L.push('');
  L.push('| 法条节点 | 被引次数 |');
  L.push('|---|---|');
  for (const h of R.lawHubs) L.push(`| ${h.label} | ${h.c} |`);
  L.push('');
  if (R.hasSem) {
    L.push('## 五、语义漏连发现（跨域、未连线、但内容语义相近，前 30）');
    L.push('');
    L.push(`> 余弦 ≥ ${MISS_SIM} 视为"内容相近却没连"，可考虑在第二阶段补连。共发现 ${R.missing.length} 对。`);
    L.push('');
    L.push('| 语义 | 节点A(域) | 节点B(域) |');
    L.push('|---|---|---|');
    for (const m of R.missing.slice(0, 30)) L.push(`| ${m.sim.toFixed(3)} | ${m.a.label}(${dcn(m.a.domain)}) | ${m.b.label}(${dcn(m.b.domain)}) |`);
    L.push('');
    L.push('## 六、相似度分布对照（阈值校准依据）');
    L.push('');
    L.push('> 同一套向量下，不同边类型两端的余弦分布。hierarchy/xref 是"真相关"基线，random 是"无关"基线；concept 越接近 random 越说明噪声重。');
    L.push('');
    L.push('| 边类型/基线 | 样本 | p10 | 中位 p50 | p90 |');
    L.push('|---|---|---|---|---|');
    for (const k of ['hierarchy', 'xref', 'lawref', 'colaw', 'concept', 'random']) {
      const d = R.dist[k];
      if (d) L.push(`| ${k} | ${d.n} | ${bar(d.p10)} | ${bar(d.p50)} | ${bar(d.p90)} |`);
    }
    L.push('');
    L.push(`当前阈值：SIM_LOW=${SIM_LOW}、SIM_HIGH=${SIM_HIGH}、漏连 MISS_SIM=${MISS_SIM}。可据上表分布在脚本顶部调整。`);
  }
  L.push('');
  L.push('## 七、点击"点亮"模拟（现有 neighborsOf + topicPeers）');
  L.push('');
  L.push('> 模拟点击高 degree 节点会点亮多少节点、其中跨域占比、语义偏低占比——量化"广撒网"程度。');
  L.push('');
  L.push(`| 样本节点 | 点亮总数 | 跨域数 | ${R.hasSem ? '语义偏低数' : ''} |`);
  L.push(`|---|---|---|${R.hasSem ? '---|' : ''}`);
  for (const s of R.simRows) L.push(`| ${s.n.label} | ${s.total} | ${s.cross} | ${R.hasSem ? s.lowSim : ''} |`);
  L.push('');
  L.push('## 八、结论与下一步');
  L.push('');
  L.push('1. **concept**：删除「疑似无关」、人工研判「存疑」；第二阶段把代表选择从"字数最长"改为"主题命中强度最高 + 排除杂揽枢纽"。');
  L.push('2. **跨域 colaw**：删除无共享主题且语义低的。');
  L.push('3. **前端点亮**：`neighborsOf` 改为按边类型/权重分级（硬关联高亮、弱关联淡显）；`topicPeers` 弃用 degree 排序、排除杂揽枢纽。');
  L.push('4. 详单见同目录 `疑似无关连接清单.csv`（可逐条勾选）。');
  L.push('');
  writeFileSync(join(OUT, '关联核查报告.md'), L.join('\n'));
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(rows) {
  const head = ['类型', '源id', '源label', '源域', '目标id', '目标label', '目标域', '共享主题', '关键词强度', '语义相似度', '枢纽', '级别', '建议', '理由'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.type,
        r.s.id,
        r.s.label,
        dcn(r.s.domain),
        r.t.id,
        r.t.label,
        dcn(r.t.domain),
        r.shared.map((k) => TOPIC_NAME[k]).join('、'),
        r.rel,
        r.sim == null ? '' : r.sim.toFixed(3),
        r.hub ? '是' : '',
        r.level,
        r.advice,
        r.reason,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  writeFileSync(join(OUT, '疑似无关连接清单.csv'), '﻿' + lines.join('\n'));
}
function writeMissingCsv(missing) {
  if (!missing.length) return;
  const lines = ['﻿语义相似度,节点A_id,节点A,域A,节点B_id,节点B,域B'];
  for (const m of missing.slice(0, 200))
    lines.push([m.sim.toFixed(3), m.a.id, m.a.label, dcn(m.a.domain), m.b.id, m.b.label, dcn(m.b.domain)].map(csvCell).join(','));
  writeFileSync(join(OUT, '语义漏连建议.csv'), lines.join('\n'));
}

main().catch((err) => {
  console.error('核查失败：', err);
  process.exit(1);
});
