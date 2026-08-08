// 数据管线 2/4：抽取边 → data/edges.json
//   内容节点四类：hierarchy（父子）/ xref（正文交叉引用）/ colaw（共引同一法条的小团簇）/ lawref（跨规范法条勾连）
//   term 三类（D4 新增）：termref（词↔章节出处）/ termlaw（词↔法条节点）/ termrel（词↔词 人工种子上下位）
//   term 共现边（W1 新增）：termco（词↔词 章节出处共现，主动配额封顶 + 孤立词补边）
//   concept 边停产（ENABLE_CONCEPT=false，代码保留可恢复）。
//   附带产物：degree/hub 写回 nodes.json、data/graph-meta.json（schemaVersion/termCount/edgeCounts/generatedAt）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPIC_NAME } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');

// ---- D4 配置 ----
const ENABLE_CONCEPT = false; // concept 边停产开关（true 可恢复旧行为）
const TERMREF_CAP = 30; // 每 term 的 termref 边上限（超出按 weight、对端 degree 取 top）
const TERMLAW_CAP = 8; // 每 term 的 termlaw 边上限
const TERMLAW_W_DIRECT = 0.7; // 词表 lawKeys 直连权重
const TERMLAW_W_COCITE = 0.4; // 出处节点共引法条补强权重
const TERMREL_W = 0.8; // 同主题组员 → 组长（上下位种子）权重
const TERMREF_TOTAL_MAX = 20000; // termref 总量断言上限
const TERM_HUB_TOP = 120; // term degree 排名前 N 标 hub
// ---- W1 termco 配置 ----
const TERMCO_MIN_SHARE = 2; // 共享出处 ≥2 的词对才建正式候选边
const TERMCO_W_MAX = 0.7; // weight = min(共享数, TERMCO_W_SAT) / TERMCO_W_SAT × 0.7
const TERMCO_W_SAT = 5; // 共享数饱和点（≥5 视为满权）
const TERMCO_ACTIVE_CAP = 8; // 每词"主动入选"配额（超出按 共享数↓ → 对方df↓ → 对方canonical↑ 取前 8）
const TERMCO_ACTIVE_MAX = TERMCO_ACTIVE_CAP + 1; // 主动配额上限 = 入选 8 + 孤立补边 1
const TERMCO_TOTAL_MAX = 2000; // termco 总量断言上限
function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(D, name), 'utf8'));
  } catch (err) {
    console.error(`✗ 无法读取/解析 data/${name}：${err.message}\n  请先运行 npm run data 生成基础数据。`);
    process.exit(1);
  }
}
const nodes = readJson('nodes.json');
const bodies = readJson('node-bodies.json');
const laws = readJson('laws.json');

const byId = new Map(nodes.map(n => [n.id, n]));
const ids = new Set(byId.keys());

// Opus 复核生成的固化边删除名单（"a~b::concept|colaw"，判定不相关者）。无文件则不过滤，保持向后兼容。
let EDGE_BLACKLIST = new Set();
try { EDGE_BLACKLIST = new Set(JSON.parse(readFileSync(join(D, 'edge-blacklist.json'), 'utf8'))); } catch { /* 无黑名单：全量生成 */ }
const pad = (n) => String(n).padStart(2, '0');
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cn2num(s) {
  if (!s) return NaN;
  if (s.includes('十')) { const [a, b] = s.split('十'); return (a === '' ? 1 : CN[a]) * 10 + (b === '' ? 0 : CN[b]); }
  return CN[s] ?? NaN;
}

const edges = [];
const seen = new Set();
function addEdge(s, t, type, weight) {
  if (s === t || !ids.has(s) || !ids.has(t)) return;
  // 跨域弱关联（concept/colaw）经 Opus 复核判为不相关者，按黑名单剔除（硬关联 hierarchy/xref/lawref 不受影响）
  if ((type === 'concept' || type === 'colaw') && EDGE_BLACKLIST.has([s, t].sort().join('~') + '::' + type)) return;
  const key = [s, t].sort().join('::') + '::' + type;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ source: s, target: t, type, weight });
}
function pairKey(s, t) { return [s, t].sort().join('::'); }
const hierPairs = new Set();

// ---- 1. hierarchy：由 id 前缀确定父子（term- 前缀节点显式排除，不参与层级推导）----
for (const n of nodes) {
  if (n.kind === 'term') continue; // term 节点无层级，且 'term-NNNN' 切前缀会得到假父 'term'
  const parts = n.id.split('-');
  if (parts.length <= 1) continue;
  const parentId = parts.slice(0, -1).join('-');
  if (ids.has(parentId)) { addEdge(parentId, n.id, 'hierarchy', 1); hierPairs.add(pairKey(parentId, n.id)); }
}

// ---- 2. xref：正文交叉引用 ----
// 形如：本部分第三章第2.1节 / 第二部分第六章第3节 / 本章第3.2节 / 第3.2.1节 / 第二部分第十章
const REF_RE = /(本部分|第([一二三四五六七八九十]+)部分)?\s*(本章|第([一二三四五六七八九十]+)章)?\s*第(\d+(?:\.\d+){0,2})节/g;
const CHAP_RE = /(本部分|第([一二三四五六七八九十]+)部分)\s*第([一二三四五六七八九十]+)章(?!第)/g;
let xrefCount = 0;
for (const n of nodes) {
  const text = bodies[n.id]?.ownText || '';
  if (!text) continue;
  // 2a. 带“节”的引用
  let m; REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text))) {
    const pp = m[1] ? (m[1] === '本部分' ? n.partNum : cn2num(m[2])) : n.partNum;
    let cc;
    if (m[3]) cc = m[3] === '本章' ? n.chapterNum : cn2num(m[4]);
    else cc = n.chapterNum; // 无章信息默认本章
    const secTok = m[5].split('.').map(Number); // [N] / [N,M] / [N,M,K]
    if (!Number.isFinite(pp) || !Number.isFinite(cc)) continue;
    const base = `${pad(pp)}-${pad(cc)}`;
    let target = secTok.length >= 2 ? `${base}-${pad(secTok[0])}-${pad(secTok[1])}` : `${base}-${pad(secTok[0])}`;
    if (!ids.has(target) && secTok.length >= 2) target = `${base}-${pad(secTok[0])}`; // 子节不存在则退到节
    if (ids.has(target) && !hierPairs.has(pairKey(n.id, target))) { addEdge(n.id, target, 'xref', 0.6); xrefCount++; }
  }
  // 2b. 仅到“章”的引用
  CHAP_RE.lastIndex = 0;
  while ((m = CHAP_RE.exec(text))) {
    const pp = m[1] === '本部分' ? n.partNum : cn2num(m[2]);
    const cc = cn2num(m[3]);
    if (!Number.isFinite(pp) || !Number.isFinite(cc)) continue;
    const target = `${pad(pp)}-${pad(cc)}`;
    if (ids.has(target) && !hierPairs.has(pairKey(n.id, target))) { addEdge(n.id, target, 'xref', 0.45); xrefCount++; }
  }
}

// ---- 3. colaw：共引同一法条的小团簇（高频法条过于宽泛，跳过）----
const COLAW_MIN = 2, COLAW_MAX = 6; // 仅 2..6 个节点共引的“具体条款”连边
let colawCount = 0;
for (const l of laws) {
  const ns = l.nodes;
  if (ns.length < COLAW_MIN || ns.length > COLAW_MAX) continue;
  for (let i = 0; i < ns.length; i++)
    for (let j = i + 1; j < ns.length; j++) {
      const before = edges.length;
      addEdge(ns[i], ns[j], 'colaw', 0.3);
      if (edges.length > before) colawCount++;
    }
}

// ---- 4. lawref：跨规范勾连 —— 引用了某条法/细则的节点 → 该条文节点（专利法/实施细则的“第X条”节点带 lawKey）----
//   例：审查指南“新颖性”节点引用“专利法第22条” → 连到 patent-law 的 第22条 节点。实现“法—指南—实务”跨域知识网。
const lawNodeByKey = new Map();
for (const n of nodes) if (n.lawKey) lawNodeByKey.set(n.lawKey, n.id);
let lawrefCount = 0;
for (const n of nodes) {
  if (n.kind === 'term') continue; // term 节点的法条关联走 termlaw，不混入 lawref
  if (!n.laws || !n.laws.length) continue;
  for (const lk of n.laws) {
    const tgt = lawNodeByKey.get(lk);
    if (!tgt || tgt === n.id) continue;
    const before = edges.length;
    addEdge(n.id, tgt, 'lawref', 0.5);
    if (edges.length > before) lawrefCount++;
  }
}

// ---- 5. concept：跨域同主题"代表节点"连边 —— 把 7 部规范按主题拧到一起，驱动融合大星云 + 提供基础主题关联。
//   每个主题在每域取实质内容最多的若干代表；其余域代表连向"主代表"（优先审查指南，其次专利法），形成跨域桥。
//   点击节点时的"同主题全关联"由前端按 topics 索引动态扩展（不依赖这些静态边），故此处只取代表、控量防止杂乱。
//   D4 起停产（ENABLE_CONCEPT=false）：主题勾连改由 term 节点 + termref/termrel 承担；代码保留以便回退。
const REPS_PER_DOMAIN = 2;
let conceptCount = 0;
if (ENABLE_CONCEPT) {
const topicNodes = new Map(); // topicKey -> [node...]
for (const n of nodes) for (const tk of n.topics || []) {
  if (!topicNodes.has(tk)) topicNodes.set(tk, []);
  topicNodes.get(tk).push(n);
}
for (const [, ns] of topicNodes) {
  const byDom = new Map();
  for (const n of ns) {
    if (!byDom.has(n.domain)) byDom.set(n.domain, []);
    byDom.get(n.domain).push(n);
  }
  if (byDom.size < 2) continue; // 仅单域命中，无跨域可连
  const reps = [];
  for (const [, arr] of byDom) {
    arr.sort((a, b) => (b.charLen || 0) - (a.charLen || 0));
    reps.push(...arr.slice(0, REPS_PER_DOMAIN));
  }
  const primary =
    reps.find((r) => r.domain === 'examination-guideline-2025') ||
    reps.find((r) => r.domain === 'patent-law') ||
    reps[0];
  for (const r of reps) {
    if (r.domain === primary.domain) continue; // 不连同域、不自连
    const before = edges.length;
    addEdge(r.id, primary.id, 'concept', 0.35);
    if (edges.length > before) conceptCount++;
  }
}
}

// ---- 6. term 三类边（D4）：termref / termlaw / termrel ----
//   termref：词 ↔ 章节出处（词表 sources）。weight：seed 来源（terms-seed.json 登记的出处）=1.0，其余=0.6；
//            每 term 封顶 TERMREF_CAP，超出按 weight 降序、对端节点（截至此处的非 term 边）degree 降序取 top。
//   termlaw：词 ↔ 法条节点。词表 lawKeys 直连（0.7）+ law-citations.json 中该词出处节点共引法条聚合补强
//            （≥2 个出处节点共引才算，0.4）；每 term 封顶 TERMLAW_CAP。
//   termrel：仅人工种子上下位 —— 同一 topicKey 的 term 中 canonical 等于主题 name 者为组长，
//            组内其他词连向组长（0.8，source=下位组员 → target=上位组长）；无组长的 topicKey 跳过。不做共现 PMI。
const termNodes = nodes.filter((n) => n.kind === 'term');
const termIds = new Set(termNodes.map((n) => n.id));
let termrefCount = 0, termlawCount = 0, termrelCount = 0;
let termrefMaxPer = 0, termlawMaxPer = 0;
let termcoCount = 0, termcoActiveMax = 0, termcoSupplement = 0, termcoDegMax = 0;
if (termNodes.length) {
  const termsMerged = readJson('terms-merged.json');
  const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const termIdByLabel = new Map(termNodes.map((n) => [norm(n.label), n.id]));

  // seed 来源判定：terms-seed.json 中该词（canonical/alias 归一命中）登记过的出处节点 → weight 1.0
  const seedSrcByKey = new Map(); // 归一词键 → Set(nodeId)
  try {
    const seeds = JSON.parse(readFileSync(join(D, 'terms-seed.json'), 'utf8'));
    for (const s of seeds) {
      const srcSet = new Set(Object.values(s.sources || {}).flat());
      for (const k of [norm(s.canonical), ...(s.aliases || []).map(norm)]) {
        if (!k) continue;
        if (!seedSrcByKey.has(k)) seedSrcByKey.set(k, new Set());
        for (const id of srcSet) seedSrcByKey.get(k).add(id);
      }
    }
  } catch {
    console.warn('⚠ 未读到 data/terms-seed.json：termref 权重全部按 0.6 处理');
  }

  // 共引法条聚合输入：law-citations.json（可缺省，缺省则 termlaw 不做补强）
  const citesByNode = new Map(); // sourceNode → [{lawKey, fullCite, count}]
  try {
    for (const c of JSON.parse(readFileSync(join(D, 'law-citations.json'), 'utf8'))) {
      if (!citesByNode.has(c.sourceNode)) citesByNode.set(c.sourceNode, []);
      citesByNode.get(c.sourceNode).push(c);
    }
  } catch {
    console.warn('⚠ 未读到 data/law-citations.json：termlaw 不做共引补强');
  }

  // 截至此处（term 边生成前）的度数快照，供 termref 超限裁剪按对端重要度排序
  const interimDeg = new Map();
  for (const e of edges) {
    interimDeg.set(e.source, (interimDeg.get(e.source) || 0) + 1);
    interimDeg.set(e.target, (interimDeg.get(e.target) || 0) + 1);
  }

  for (const t of termsMerged) {
    const tid = termIdByLabel.get(norm(t.canonical));
    if (!tid) continue; // 未通过 build-term-nodes 过滤闸的词不建边

    // 该词的 seed 来源节点集合（canonical 与 aliases 命中的并集）
    const seedSet = new Set();
    for (const k of [norm(t.canonical), ...(t.aliases || []).map(norm)])
      for (const id of seedSrcByKey.get(k) || []) seedSet.add(id);

    // 6a. termref
    const srcNodeIds = [...new Set(Object.values(t.sources || {}).flat())].filter((id) => ids.has(id) && id !== tid);
    const cand = srcNodeIds.map((nid) => ({ nid, w: seedSet.has(nid) ? 1.0 : 0.6, deg: interimDeg.get(nid) || 0 }));
    cand.sort((a, b) => b.w - a.w || b.deg - a.deg || (a.nid < b.nid ? -1 : 1));
    let refAdded = 0;
    for (const c of cand.slice(0, TERMREF_CAP)) {
      const before = edges.length;
      addEdge(tid, c.nid, 'termref', c.w);
      if (edges.length > before) { termrefCount++; refAdded++; }
    }
    termrefMaxPer = Math.max(termrefMaxPer, refAdded);

    // 6b. termlaw：直连候选在前（score 置顶），共引补强按聚合计数降序排队，去重后取前 TERMLAW_CAP
    const ownLawKeys = new Set(t.lawKeys || []);
    const lawCand = [];
    for (const lk of [...ownLawKeys].sort()) {
      const ln = lawNodeByKey.get(lk);
      if (ln && ln !== tid) lawCand.push({ ln, w: TERMLAW_W_DIRECT });
    }
    const agg = new Map(); // lawKey → { ln, nodes:Set, cnt }
    for (const nid of srcNodeIds) for (const c of citesByNode.get(nid) || []) {
      if (ownLawKeys.has(c.lawKey)) continue;
      const ln = lawNodeByKey.get(c.lawKey);
      if (!ln) continue;
      if (!agg.has(c.lawKey)) agg.set(c.lawKey, { ln, nodes: new Set(), cnt: 0 });
      const a = agg.get(c.lawKey);
      a.nodes.add(nid);
      a.cnt += c.count || 1;
    }
    for (const [, a] of [...agg].sort((x, y) => y[1].cnt - x[1].cnt || (x[0] < y[0] ? -1 : 1)))
      if (a.nodes.size >= 2) lawCand.push({ ln: a.ln, w: TERMLAW_W_COCITE });
    const seenLaw = new Set();
    let lawAdded = 0;
    for (const c of lawCand) {
      if (lawAdded >= TERMLAW_CAP) break;
      if (seenLaw.has(c.ln)) continue;
      seenLaw.add(c.ln);
      const before = edges.length;
      addEdge(tid, c.ln, 'termlaw', c.w);
      if (edges.length > before) { termlawCount++; lawAdded++; }
    }
    termlawMaxPer = Math.max(termlawMaxPer, lawAdded);
  }

  // 6c. termrel：同 topicKey 组内连向组长
  const byTopic = new Map();
  for (const n of termNodes) {
    if (!n.topicKey) continue;
    if (!byTopic.has(n.topicKey)) byTopic.set(n.topicKey, []);
    byTopic.get(n.topicKey).push(n);
  }
  const normLabel = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  for (const [tk, arr] of byTopic) {
    const topicName = TOPIC_NAME[tk];
    const leader = topicName ? arr.find((n) => normLabel(n.label) === normLabel(topicName)) : null;
    if (!leader) continue; // 无组长的主题跳过（不强连）
    for (const m of arr) {
      if (m.id === leader.id) continue;
      const before = edges.length;
      addEdge(m.id, leader.id, 'termrel', TERMREL_W);
      if (edges.length > before) termrelCount++;
    }
  }

  // 6d. termco（W1）：词共现边 —— 章节出处共同出现的词对。与 termrel（人工上下位）并存互不影响。
  //   规则：
  //   - 每词跨域合并出处集合，倒排（出处章节 → 词列表）建词对共享计数；
  //   - 共享出处 ≥TERMCO_MIN_SHARE(2) 的词对为正式候选，weight = min(共享数,5)/5 × 0.7；
  //   - 主动配额口径：每词按 共享数降序 → 对方 df 降序 → 对方 canonical(label) 码点升序 → 对方 id 升序
  //     主动入选前 TERMCO_ACTIVE_CAP(8) 条；最终边集 = 全词主动入选的并集（同对去重，无向边 id 小者为 source）。
  //     一个词还可能被其他词"被动"选中，故其总度数可超 8——断言按主动配额 ≤9（入选 8 + 补边 1）计。
  //   - 孤立补边：对没有任何 ≥2 候选的词，补其共享数最高的一条 ≥1 边（并列裁决同上，确定性）；
  //     无任何共享出处的词不补（其仍有 termref 边可达）。
  {
    // 每词出处集合（跨域合并；仅保留真实存在的非 term 节点）
    const srcSetOf = new Map(); // termId → Set(章节出处 id)
    for (const t of termsMerged) {
      const tid = termIdByLabel.get(norm(t.canonical));
      if (!tid) continue;
      const s = new Set(
        [...new Set(Object.values(t.sources || {}).flat())].filter((id) => ids.has(id) && !termIds.has(id)),
      );
      srcSetOf.set(tid, s);
    }
    // 倒排：出处章节 → 出现词列表
    const termsBySrc = new Map();
    for (const [tid, s] of srcSetOf)
      for (const nid of s) {
        if (!termsBySrc.has(nid)) termsBySrc.set(nid, []);
        termsBySrc.get(nid).push(tid);
      }
    // 词对共享计数（key: "idA~idB"，idA < idB）
    const shareCnt = new Map();
    for (const [, arr] of termsBySrc) {
      arr.sort();
      for (let i = 0; i < arr.length; i++)
        for (let j = i + 1; j < arr.length; j++) {
          const k = arr[i] + '~' + arr[j];
          shareCnt.set(k, (shareCnt.get(k) || 0) + 1);
        }
    }
    // 每词候选邻接
    const candOf = new Map(); // termId → [{other, share}]
    for (const [k, share] of shareCnt) {
      const [a, b] = k.split('~');
      if (!candOf.has(a)) candOf.set(a, []);
      if (!candOf.has(b)) candOf.set(b, []);
      candOf.get(a).push({ other: b, share });
      candOf.get(b).push({ other: a, share });
    }
    // 并列裁决：共享数降序 → 对方 df 降序 → 对方 canonical(label) 码点升序 → 对方 id 升序（全部确定性）
    const dfOf = (id) => byId.get(id)?.df || 0;
    const labelOf = (id) => byId.get(id)?.label || '';
    const candCmp = (x, y) =>
      y.share - x.share ||
      dfOf(y.other) - dfOf(x.other) ||
      (labelOf(x.other) < labelOf(y.other) ? -1 : labelOf(x.other) > labelOf(y.other) ? 1 : 0) ||
      (x.other < y.other ? -1 : 1);

    const chosenPairs = new Map(); // pairKey → share
    const activeCnt = new Map(); // termId → 主动配额使用数（入选 + 补边）
    const tidSorted = [...srcSetOf.keys()].sort();
    // ① 正式候选（≥2）按主动配额入选
    for (const tid of tidSorted) {
      const cands = (candOf.get(tid) || []).filter((c) => c.share >= TERMCO_MIN_SHARE).sort(candCmp);
      let used = 0;
      for (const c of cands) {
        if (used >= TERMCO_ACTIVE_CAP) break;
        used++;
        const k = [tid, c.other].sort().join('~');
        if (!chosenPairs.has(k)) chosenPairs.set(k, c.share);
      }
      activeCnt.set(tid, used);
    }
    // ② 孤立补边（无任何 ≥2 候选者，补最高共享的一条 ≥1 边）
    for (const tid of tidSorted) {
      const cands = candOf.get(tid) || [];
      if (!cands.length) continue; // 与任何词都无共享出处 → 不补
      if (cands.some((c) => c.share >= TERMCO_MIN_SHARE)) continue;
      const best = cands.slice().sort(candCmp)[0];
      const k = [tid, best.other].sort().join('~');
      if (!chosenPairs.has(k)) { chosenPairs.set(k, best.share); termcoSupplement++; }
      activeCnt.set(tid, (activeCnt.get(tid) || 0) + 1);
    }
    // ③ 落边：无向边 id 小者为 source（pairKey 已保证 a < b）；按 pairKey 排序保证输出顺序确定
    for (const [k, share] of [...chosenPairs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const [a, b] = k.split('~');
      const w = +((Math.min(share, TERMCO_W_SAT) / TERMCO_W_SAT) * TERMCO_W_MAX).toFixed(3);
      const before = edges.length;
      addEdge(a, b, 'termco', w);
      if (edges.length > before) termcoCount++;
    }
    termcoActiveMax = Math.max(0, ...activeCnt.values());
    // 实际总度数（含被动入选），仅作观测输出，不做 ≤9 断言（口径见上注释）
    const coDeg = new Map();
    for (const k of chosenPairs.keys()) {
      const [a, b] = k.split('~');
      coDeg.set(a, (coDeg.get(a) || 0) + 1);
      coDeg.set(b, (coDeg.get(b) || 0) + 1);
    }
    termcoDegMax = Math.max(0, ...coDeg.values());
  }
}

// ---- 校验 + 输出 ----
const dangling = edges.filter(e => !ids.has(e.source) || !ids.has(e.target));
const byType = edges.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
console.log('边计数:', byType, ' 合计:', edges.length);
console.log('xref:', xrefCount, ' colaw:', colawCount, ' lawref:', lawrefCount, ' concept:', conceptCount, ' 悬空边:', dangling.length);
console.log(`termref: ${termrefCount}（单词最多 ${termrefMaxPer}） termlaw: ${termlawCount}（单词最多 ${termlawMaxPer}） termrel: ${termrelCount}`);
console.log(`termco: ${termcoCount}（孤立补边 ${termcoSupplement} / 主动配额最多 ${termcoActiveMax} / 实际度最大 ${termcoDegMax}）`);
writeFileSync(join(D, 'edges.json'), JSON.stringify(edges, null, 0));

// 顺带把 degree（星等）写回 nodes.json（覆盖 term 节点）
const deg = new Map();
for (const e of edges) { deg.set(e.source, (deg.get(e.source) || 0) + 1); deg.set(e.target, (deg.get(e.target) || 0) + 1); }
for (const n of nodes) n.degree = deg.get(n.id) || 0;

// hub 标记（仅 term 节点）：tier='seed' 且带 topicKey，或 term degree 排名前 TERM_HUB_TOP
for (const n of nodes) delete n.hub; // 先清历史标记，防重跑残留
const termByDeg = nodes
  .filter((n) => n.kind === 'term')
  .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
const topDegIds = new Set(termByDeg.slice(0, TERM_HUB_TOP).map((n) => n.id));
let hubCount = 0;
for (const n of termByDeg) {
  if ((n.tier === 'seed' && n.topicKey) || topDegIds.has(n.id)) { n.hub = true; hubCount++; }
}
writeFileSync(join(D, 'nodes.json'), JSON.stringify(nodes, null, 0));
console.log('degree 已写回；最大度:', Math.max(...nodes.map(n => n.degree)), ' term hub 数:', hubCount);

// 图元数据（schemaVersion 3 = 在 2 基础上并入 termco 词共现边；edgeCounts 覆盖含 termco 的全部边型）
writeFileSync(
  join(D, 'graph-meta.json'),
  JSON.stringify({ schemaVersion: 3, termCount: termNodes.length, edgeCounts: byType, generatedAt: new Date().toISOString() }, null, 2),
);

// ---- 断言 ----
let ok = true;
if (dangling.length > 0) { ok = false; console.error(`✗ 存在悬空边: ${dangling.length}`); }
if (termrefCount > TERMREF_TOTAL_MAX) { ok = false; console.error(`✗ termref 总量 ${termrefCount} 超过上限 ${TERMREF_TOTAL_MAX}`); }
if (termrefMaxPer > TERMREF_CAP) { ok = false; console.error(`✗ termref 单词封顶失效：最多 ${termrefMaxPer} > ${TERMREF_CAP}`); }
if (termlawMaxPer > TERMLAW_CAP) { ok = false; console.error(`✗ termlaw 单词封顶失效：最多 ${termlawMaxPer} > ${TERMLAW_CAP}`); }
if (termcoCount > TERMCO_TOTAL_MAX) { ok = false; console.error(`✗ termco 总量 ${termcoCount} 超过上限 ${TERMCO_TOTAL_MAX}`); }
if (termcoActiveMax > TERMCO_ACTIVE_MAX) { ok = false; console.error(`✗ termco 主动配额失效：最多 ${termcoActiveMax} > ${TERMCO_ACTIVE_MAX}（入选 ${TERMCO_ACTIVE_CAP} + 补边 1）`); }
const termcoOffTerm = edges.filter((e) => e.type === 'termco' && (!termIds.has(e.source) || !termIds.has(e.target)));
if (termcoOffTerm.length) { ok = false; console.error(`✗ termco 边端点非 term 节点: ${termcoOffTerm.length} 条`); }
const hierOnTerm = edges.filter((e) => e.type === 'hierarchy' && (termIds.has(e.source) || termIds.has(e.target)));
if (hierOnTerm.length) { ok = false; console.error(`✗ hierarchy 边混入 term 节点: ${hierOnTerm.length} 条`); }
console.log(ok ? '✓ 边校验通过（无悬空边 / termref 总量与封顶 / termlaw 封顶 / termco 总量与主动配额 / term 不入 hierarchy）' : '✗ 边校验未通过');
if (!ok) process.exit(1);
