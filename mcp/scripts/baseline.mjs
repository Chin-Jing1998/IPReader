// baseline.mjs —— 检索质量回归基线：生成、分层比对与重定版
//
// 用途：把 50 条中文查询在当前代码与当前数据包下的 Top8 结果 id 固化为 baseline.json，
// 作为后续全部改造阶段的回归防线。
//
// 50 条查询分三类：书目场景 28 条（七书各 4 条）、法条直达 10 条、术语查询 12 条。
// 全部经 tools.mjs 的 searchKb 走真实调用路径，不直接调 search.mjs，
// 以便同时覆盖 tools 层的参数归一与结果装配。
//
// ============ 判定口径：为何从「Top8 全等」演进为分层判定 ============
//
// 原口径是「Top8 结果 id 集合完全一致」。它在七书时代成立，在 87 书时代失效：
// 四批入库把节点从 2044 扩到 5306，新域切题内容挤入既有查询的 Top8 属预期收益，
// 却与「真实召回退化」在原口径下同样表现为「偏离」，二者无法区分——批次四 30 条漂移
// 里 27 条是新域挤入、3 条是旧域轮换，全靠人工逐条裁决才分得开。
//
// 分层判定按变更来源分两种模式，模式由 baseline.json 的 domains 快照与当前库比对确定：
//
//   模式 A｜代码改动（域快照无新增）——严格，逐条硬判
//     A0 哨兵 Top1 全部保持          否则 FAIL
//     A1 Top8 覆盖的 domain 集合一致  否则 FAIL
//     A2 Top3 节点级序列全等          否则 FAIL
//     A3 Top4–8 的丢失与新增按 domain 等量配平  否则 FAIL
//     A4 以上全满足而尾部有轮换       PASS（记「尾部同域轮换」）
//
//   模式 B｜语料扩容（域快照有新增）——按席位流向分类
//     哨兵 Top1 变化                          FAIL（无条件）
//     旧域挤出 > 新域挤入 + 旧域内新增（净减席位）  FAIL（真实召回退化）
//     新域挤入 ≥ 1 且席位配平                  PASS（记「新域切题挤入」，预期收益）
//     纯旧域轮换且 Top3 未变                   PASS（记「旧域内轮换」）
//     纯旧域轮换且 Top3 变化                   升级人工裁决
//
// 分层判定只改变「怎么判」，不改变「不得无痕覆盖」：已有基线且结果变化时，仍须以
// --reason 说明重定版依据，变更明细连同依据与分层判定结论一并记入 revisions 字段。
//
// 用法：
//   node scripts/baseline.mjs                  首次生成；已有基线且无变化时空转
//   node scripts/baseline.mjs --check          分层比对，有硬失败则退出码 1
//   node scripts/baseline.mjs --check --explain 比对并打印每条的席位流向明细
//   node scripts/baseline.mjs --migrate        增量补写 domains / sentinels / criteria 三字段
//                                              （只增不改，既有字段逐字节保持，并当场自证）
//   node scripts/baseline.mjs --replay [n]     以第 n 次重定版记录回放分层判定（缺省最后一次）
//   node scripts/baseline.mjs --reason "…"     重定版：写入新基线并追加一条 revision 记录
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { loadKb } from '../src/data.mjs';
import { buildIndex } from '../src/search.mjs';
import { searchKb } from '../src/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(HERE, '..', 'baseline.json');

// ============ 50 条基线查询 ============
// category 取值：book:<domain> | law | term
const QUERIES = [
  // —— 一、书目典型场景 28 条（七书各 4 条）——
  { category: 'book:patent-law', query: '授予专利权的条件' },
  { category: 'book:patent-law', query: '不授予专利权的情形' },
  { category: 'book:patent-law', query: '专利权的期限' },
  { category: 'book:patent-law', query: '强制许可' },

  { category: 'book:implementation-rules', query: '要求优先权的手续' },
  { category: 'book:implementation-rules', query: '恢复权利的请求' },
  { category: 'book:implementation-rules', query: '专利登记簿' },
  { category: 'book:implementation-rules', query: '期限的计算' },

  { category: 'book:examination-guideline', query: '创造性的判断方法' },
  { category: 'book:examination-guideline', query: '新颖性的判断标准' },
  { category: 'book:examination-guideline', query: '说明书充分公开' },
  { category: 'book:examination-guideline', query: '权利要求得到说明书支持' },

  { category: 'book:infringement-guide', query: '等同原则' },
  { category: 'book:infringement-guide', query: '禁止反悔原则' },
  { category: 'book:infringement-guide', query: '全面覆盖原则' },
  { category: 'book:infringement-guide', query: '现有技术抗辩' },

  { category: 'book:mechanical-drafting-rules', query: '机械领域独立权利要求' },
  { category: 'book:mechanical-drafting-rules', query: '附图标记的使用' },
  { category: 'book:mechanical-drafting-rules', query: '部件之间的连接关系' },
  { category: 'book:mechanical-drafting-rules', query: '具体实施方式的撰写' },

  { category: 'book:chemistry-drafting-rules', query: '实施例与对比例' },
  { category: 'book:chemistry-drafting-rules', query: '组分的含量范围' },
  { category: 'book:chemistry-drafting-rules', query: '制备方法权利要求' },
  { category: 'book:chemistry-drafting-rules', query: '用途权利要求' },

  { category: 'book:oa-response-guide', query: '三步法创造性答复' },
  { category: 'book:oa-response-guide', query: '意见陈述书的撰写' },
  { category: 'book:oa-response-guide', query: '修改超范围的答复' },
  { category: 'book:oa-response-guide', query: '区别技术特征' },

  // —— 二、法条直达 10 条 ——
  { category: 'law', query: '专利法第22条' },
  { category: 'law', query: '专利法第26条' },
  { category: 'law', query: '专利法第33条' },
  { category: 'law', query: '专利法第二十二条' },
  { category: 'law', query: '专利法第59条' },
  { category: 'law', query: '专利法第2条' },
  { category: 'law', query: '专利法第9条' },
  { category: 'law', query: '专利法第45条' },
  { category: 'law', query: '实施细则第57条' },
  { category: 'law', query: '专利法实施细则第11条' },

  // —— 三、术语查询 12 条 ——
  { category: 'term', query: '所属技术领域的技术人员' },
  { category: 'term', query: '背景技术' },
  { category: 'term', query: '客体审查' },
  { category: 'term', query: '假冒专利' },
  { category: 'term', query: '富有美感' },
  { category: 'term', query: '著录事项' },
  { category: 'term', query: '权利的恢复' },
  { category: 'term', query: '中间文件' },
  { category: 'term', query: '单一性' },
  { category: 'term', query: '优先权' },
  { category: 'term', query: '通式' },
  { category: 'term', query: '说明书及附图的解释作用' },
];

// ============ 哨兵集 ============
// 一小组必须恒定的查询。哨兵与 50 条基线的分工：基线守面（Top8 不塌），哨兵守点
// （最要紧的那一条答案不得动）。任何模式下哨兵 Top1 变化即硬失败，不接受「同域轮换」抗辩。
// 前两条与 smoke.mjs:107 的断言同源，第三条锁术语页优先于章节点的既有次序。
const SENTINELS = [
  { query: '等同侵权', top1: 'infr-02-03', why: '侵权判定指南「（三）等同侵权」，与 smoke 断言同源' },
  { query: '专利法第26条', top1: 'law-03-01', why: '法条直达：条文原文须居首' },
  { query: '假冒专利', top1: 'term-0204', why: '术语页优先于条文与章节点' },
];

/** 跑一遍全部基线查询，返回 [{ no, category, query, topIds }] */
function runAll() {
  // 显式传 domains:'' 绕开环境变量，保证基线在任何 shell 环境下口径一致
  const kb = loadKb({ domains: '' });
  const index = buildIndex(kb);
  const ctx = { kb, index };
  const records = QUERIES.map((q, i) => ({
    no: i + 1,
    category: q.category,
    query: q.query,
    topIds: searchKb(ctx, { query: q.query, limit: 8 }).results.map((r) => r.id),
  }));
  const sentinels = SENTINELS.map((s) => ({
    query: s.query,
    top1: (searchKb(ctx, { query: s.query, limit: 1 }).results[0] || {}).id || null,
    why: s.why,
  }));
  return { kb, records, sentinels };
}

/** 当前库的域快照，用于识别语料扩容 */
const domainSnapshot = (kb) => kb.books.map((b) => b.domain).sort();

const setEq = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
const seqEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 席位流向四分类。新域＝本次域快照有、上次快照无的域。
 * 四个数把「这条查询到底发生了什么」讲清楚：新域挤入是收益，旧域挤出是代价，
 * 二者配平即为正常换血，旧域挤出多于挤入则是净减席位——真实的召回退化。
 */
function classifyFlow(lost, added, newDomains, domOf) {
  const isNew = (id) => newDomains.has(domOf(id));
  return {
    newIn: added.filter(isNew).length,
    oldIn: added.filter((x) => !isNew(x)).length,
    newOut: lost.filter(isNew).length,
    oldOut: lost.filter((x) => !isNew(x)).length,
  };
}

/**
 * 单条查询的分层判定。
 * @returns {{ level:string, verdict:string, fail:boolean, flow:object|null }}
 */
function judgeOne(oldIds, newIds, { mode, newDomains, domOf }) {
  const lost = oldIds.filter((x) => !newIds.includes(x));
  const added = newIds.filter((x) => !oldIds.includes(x));

  if (mode === 'B') {
    const flow = classifyFlow(lost, added, newDomains, domOf);
    const net = flow.newIn + flow.oldIn - flow.oldOut - flow.newOut;
    if (net < 0) {
      return { level: 'B-净减', verdict: `净减 ${-net} 席（旧域挤出未被补回）·真实召回退化`, fail: true, flow };
    }
    if (flow.newIn > 0) {
      return { level: 'B-新域', verdict: `新域切题挤入 ${flow.newIn} 席·预期收益`, fail: false, flow };
    }
    if (!seqEq(oldIds.slice(0, 3), newIds.slice(0, 3))) {
      return { level: 'B-Top3', verdict: '纯旧域轮换但 Top3 变化·须人工裁决', fail: true, flow };
    }
    return { level: 'B-轮换', verdict: '旧域内轮换且 Top3 未变', fail: false, flow };
  }

  // 模式 A
  const domSet = (ids) => new Set(ids.map(domOf));
  const od = domSet(oldIds); const nd = domSet(newIds);
  if (od.size !== nd.size || ![...od].every((d) => nd.has(d))) {
    const gone = [...od].filter((d) => !nd.has(d));
    const came = [...nd].filter((d) => !od.has(d));
    return {
      level: 'A1-域集合',
      verdict: `Top8 域集合变化（去 ${gone.join('、') || '—'} / 来 ${came.join('、') || '—'}）·须人工裁决`,
      fail: true, flow: null,
    };
  }
  if (!seqEq(oldIds.slice(0, 3), newIds.slice(0, 3))) {
    return { level: 'A2-Top3', verdict: 'Top3 节点级序列变化·须人工裁决', fail: true, flow: null };
  }
  const cnt = (arr) => arr.reduce((m, x) => (m[domOf(x)] = (m[domOf(x)] || 0) + 1, m), {});
  const cl = cnt(lost); const ca = cnt(added);
  const balanced = [...new Set([...Object.keys(cl), ...Object.keys(ca)])]
    .every((d) => (cl[d] || 0) === (ca[d] || 0));
  if (!balanced) {
    return { level: 'A3-跨域增删', verdict: '尾部丢失与新增未按域配平·须人工裁决', fail: true, flow: null };
  }
  return { level: 'A4-同域轮换', verdict: 'Top4–8 同域等量轮换', fail: false, flow: null };
}

/** 与既有基线逐条比对，返回带分层判定的偏离明细 */
function diffAgainst(base, records, judgeCtx) {
  const byNo = new Map(base.queries.map((q) => [q.no, q]));
  const drifted = [];
  for (const r of records) {
    const b = byNo.get(r.no);
    if (!b || b.query !== r.query) {
      drifted.push({
        no: r.no, query: r.query, note: '基线中无此查询或查询串已变',
        lost: [], added: [], level: '查询集变更', verdict: '基线与脚本的查询集不一致·须人工裁决', fail: true,
      });
      continue;
    }
    if (setEq(b.topIds, r.topIds)) continue;
    const j = judgeOne(b.topIds, r.topIds, judgeCtx);
    drifted.push({
      no: r.no, query: r.query,
      lost: b.topIds.filter((x) => !r.topIds.includes(x)),
      added: r.topIds.filter((x) => !b.topIds.includes(x)),
      level: j.level, verdict: j.verdict, fail: j.fail, flow: j.flow,
    });
  }
  return drifted;
}

function printDrift(drifted, log, explain) {
  for (const d of drifted) {
    log(`  ${d.fail ? '✗' : '·'} [${d.no}] ${d.query}　【${d.level}】${d.verdict}`);
    if (d.note) { log(`      ${d.note}`); continue; }
    if (d.lost.length) log(`      丢失：${d.lost.join('、')}`);
    if (d.added.length) log(`      新增：${d.added.join('、')}`);
    if (explain && d.flow) {
      log(`      席位流向：新域挤入 ${d.flow.newIn}　旧域内新增 ${d.flow.oldIn}`
        + `　旧域挤出 ${d.flow.oldOut}　新域挤出 ${d.flow.newOut}`);
    }
  }
}

/** 汇总分层判定，供 --check 与重定版共用 */
function summarize(drifted) {
  const byLevel = new Map();
  for (const d of drifted) byLevel.set(d.level, (byLevel.get(d.level) || 0) + 1);
  return {
    total: drifted.length,
    fail: drifted.filter((d) => d.fail).length,
    pass: drifted.filter((d) => !d.fail).length,
    byLevel: [...byLevel].map(([k, v]) => `${k} ${v}`).join('　'),
  };
}

/** 分层判定口径的自述，写入基线供离线阅读者理解验收标准 */
const CRITERIA = {
  version: 2,
  summary: '分层判定：模式由 domains 快照与当前库比对确定；哨兵任何模式下 Top1 不得变。',
  modeA: {
    when: '域快照无新增（代码改动）',
    layers: [
      'A0 哨兵 Top1 全部保持，否则 FAIL',
      'A1 Top8 覆盖的 domain 集合一致，否则 FAIL',
      'A2 Top3 节点级序列全等，否则 FAIL',
      'A3 Top4–8 的丢失与新增按 domain 等量配平，否则 FAIL',
      'A4 以上全满足而尾部有轮换：PASS',
    ],
  },
  modeB: {
    when: '域快照有新增（语料扩容）',
    layers: [
      '哨兵 Top1 变化：FAIL',
      '旧域挤出 > 新域挤入 + 旧域内新增（净减席位）：FAIL',
      '新域挤入 ≥ 1 且席位配平：PASS（新域切题挤入，预期收益）',
      '纯旧域轮换且 Top3 未变：PASS',
      '纯旧域轮换且 Top3 变化：FAIL（升级人工裁决）',
    ],
  },
  legacy: 'v1 口径为「Top8 结果 id 集合完全一致」；缺 domains 字段的旧档按模式 A 回落。',
};

function writeBaseline(kb, records, revisions, sentinels) {
  const pack = {
    generatedAt: new Date().toISOString(),
    note: '检索质量回归基线。验收口径见 criteria 字段（v2 分层判定）。',
    kbMeta: { totalNodes: kb.nodes.length, lawArticles: kb.lawArticles.size, books: kb.books.length },
    params: { limit: 8, includeTerms: '默认（true）', domains: '全开放' },
    queryCount: records.length,
    criteria: CRITERIA,
    domains: domainSnapshot(kb),
    sentinels,
    revisions,
    queries: records,
  };
  writeFileSync(OUT_FILE, JSON.stringify(pack, null, 2) + '\n', 'utf8');
}

/**
 * 增量式 schema 迁移：只补 criteria / domains / sentinels 三个新字段，
 * 既有字段一律不碰——包括 generatedAt、note、queries 与 revisions 审计史。
 *
 * 迁移当场自证：把新字段从迁移结果中剥掉后重新序列化，必须与原文件逐字节相同。
 * 该证明成立的前提是原文件本就由 writeBaseline 以 JSON.stringify(pack, null, 2) + '\n'
 * 写出，故 parse → 增补 → stringify 的往返对既有部分是无损的。
 */
function migrate(kb, sentinels) {
  const raw = readFileSync(OUT_FILE, 'utf8');
  const obj = JSON.parse(raw);
  const added = [];
  // 展开在前、新键在后，剥离时可精确还原原键序
  const next = { ...obj };
  if (next.criteria === undefined) { next.criteria = CRITERIA; added.push('criteria'); }
  if (next.domains === undefined) { next.domains = domainSnapshot(kb); added.push('domains'); }
  if (next.sentinels === undefined) { next.sentinels = sentinels; added.push('sentinels'); }

  if (!added.length) {
    console.log('baseline.json 已是 v2 schema（criteria / domains / sentinels 均在），未改写文件。');
    return;
  }

  // —— 自证：剥掉新字段后必须与原文逐字节相同 ——
  const stripped = { ...next };
  for (const k of added) delete stripped[k];
  const roundTrip = JSON.stringify(stripped, null, 2) + '\n';
  if (roundTrip !== raw) {
    console.error('迁移中止：剥离新字段后的往返序列化与原文件不一致，既有内容存在被改写的风险。');
    console.error(`  原文件 ${raw.length} 字节 · 往返结果 ${roundTrip.length} 字节`);
    process.exit(1);
  }

  writeFileSync(OUT_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`baseline.json 已迁移至 v2 schema：新增字段 ${added.join('、')}`);
  console.log(`  既有字段逐字节不变（已自证：剥离新字段后往返序列化与原文件 ${raw.length} 字节完全相同）`);
  console.log(`  查询 ${obj.queryCount} 条、重定版记录 ${(obj.revisions || []).length} 次，均原样保留`);
  console.log(`  域快照 ${next.domains.length} 个 · 哨兵 ${next.sentinels.length} 条`);
}

/**
 * 历史回放：以某次重定版记录复现分层判定，验证规则与当时的人工裁决是否吻合。
 * 只读、只打印，不改写任何文件。
 *
 * 旧态 Top8 由当前态链式回退：自最后一次重定版起逐次撤销（去掉 added、补回 lost），
 * 一直退到目标次之前。只撤销目标那一次是不够的——它与当前态之间还隔着后续几次重定版。
 *
 * 保真度限制：撤销只能还原 id 集合，还原不了原始次序（补回的 lost 一律接在尾部）。
 * 故对目标次之前就已发生过 Top3 换位的查询，Top3 判层可能偏松。集合层面的判定不受影响。
 *
 * 新域集不硬编码，改由数据推导：凡出现在任一 added、却未出现在任何一条旧态 Top8 的域，
 * 即本次入库的新域。该推导经批次四实测校验——推出的 3 个域与按目录时间戳还原的
 * 15 个批次四域清单，在 30 条漂移上给出完全相同的分类结果。
 */
function replay(base, kb, revIndex) {
  const revs = base.revisions || [];
  if (!revs.length) { console.error('baseline.json 无 revisions 记录，无可回放的历史。'); process.exit(1); }
  const i = revIndex === null ? revs.length - 1 : revIndex;
  if (!(i >= 0 && i < revs.length)) { console.error(`回放序号越界：${i}（可选 0..${revs.length - 1}）`); process.exit(1); }
  const rev = revs[i];
  const domOf = (id) => (kb.byId.get(id) || {}).domain || '(节点已不存在)';

  /** 第 k 次重定版之前的全库状态：自当前态起，逐次撤销第 last..k 次 */
  const stateBefore = (k) => {
    const st = new Map(base.queries.map((q) => [q.no, [...q.topIds]]));
    for (let j = revs.length - 1; j >= k; j--) {
      for (const c of revs[j].changed || []) {
        const now = st.get(c.no) || [];
        st.set(c.no, [...now.filter((x) => !(c.added || []).includes(x)), ...(c.lost || [])]);
      }
    }
    return st;
  };
  const before = stateBefore(i);
  const after = stateBefore(i + 1);   // 第 i 次之后 == 第 i+1 次之前
  const oldOf = (no) => before.get(no) || [];
  const newOf = (no) => after.get(no) || [];

  const oldDomains = new Set();
  for (const q of base.queries) for (const id of oldOf(q.no)) oldDomains.add(domOf(id));
  const newDomains = new Set();
  for (const c of rev.changed) for (const id of c.added) if (!oldDomains.has(domOf(id))) newDomains.add(domOf(id));

  const mode = newDomains.size ? 'B' : 'A';
  console.log(`历史回放：第 ${i + 1} 次重定版（${rev.date}）· 模式 ${mode}（${mode === 'A' ? '代码改动' : '语料扩容'}）`);
  console.log('─'.repeat(78));
  console.log(`依据：${rev.reason}`);
  console.log(`推导出的新域 ${newDomains.size} 个：${[...newDomains].sort().join('、') || '（无，按模式 A 判定）'}`);
  console.log('');
  const tally = new Map();
  const flowSum = { newIn: 0, oldIn: 0, oldOut: 0, newOut: 0 };
  const fails = [];
  for (const c of rev.changed) {
    const oldIds = oldOf(c.no);
    const newIds = newOf(c.no);
    const j = judgeOne(oldIds, newIds, { mode, newDomains, domOf });
    tally.set(j.level, (tally.get(j.level) || 0) + 1);
    if (j.flow) for (const k of Object.keys(flowSum)) flowSum[k] += j.flow[k];
    if (j.fail) fails.push({ no: c.no, query: c.query, verdict: j.verdict });
    console.log(`  ${j.fail ? '✗' : '·'} [${String(c.no).padStart(2)}] ${String(c.query).padEnd(16)}【${j.level}】${j.verdict}`);
  }
  console.log('');
  console.log(`判定分布：${[...tally].map(([k, v]) => `${k} ${v}`).join('　')}`);
  console.log(`席位流向合计：新域挤入 ${flowSum.newIn}　旧域内新增 ${flowSum.oldIn}`
    + `　旧域挤出 ${flowSum.oldOut}　新域挤出 ${flowSum.newOut}`);
  console.log(`共 ${rev.changed.length} 条：自动通过 ${rev.changed.length - fails.length} · 须裁决 ${fails.length}`);
  if (fails.length) {
    console.log('\n新规则下须裁决的条目（当时未被单独追查）：');
    for (const f of fails) console.log(`  ✗ [${f.no}] ${f.query} —— ${f.verdict}`);
  }
  console.log('\n（回放为只读演示，未改写 baseline.json 的任何内容）');
}

/**
 * 判定模式与新域集：由基线记录的域快照与当前库比对得出。
 * 旧档没有 domains 字段时无从判断语料是否扩容，回落模式 A（更严格的一侧）并提示。
 */
function resolveMode(existing, kb) {
  const now = domainSnapshot(kb);
  if (!Array.isArray(existing.domains)) {
    return {
      mode: 'A', newDomains: new Set(), legacy: true,
      note: `基线为 v1 档（无 domains 快照），无从判断语料是否扩容，已回落模式 A 严格判定。`
        + `　执行 node scripts/baseline.mjs --migrate 可补写该字段。`,
    };
  }
  const prev = new Set(existing.domains);
  const newDomains = new Set(now.filter((d) => !prev.has(d)));
  const gone = existing.domains.filter((d) => !now.includes(d));
  return {
    mode: newDomains.size ? 'B' : 'A',
    newDomains, legacy: false,
    note: newDomains.size
      ? `域快照 ${existing.domains.length} → ${now.length}，新增 ${newDomains.size} 个：${[...newDomains].join('、')}`
      : `域快照无新增（${now.length} 个）`,
    gone,
  };
}

/** 哨兵比对：任何模式下 Top1 变化即硬失败 */
function checkSentinels(existing, sentinels, log) {
  const expect = new Map((existing.sentinels || SENTINELS).map((s) => [s.query, s.top1]));
  const broken = [];
  for (const s of sentinels) {
    const want = expect.get(s.query);
    if (want === undefined) { log(`  ? ${s.query} —— 基线未登记该哨兵（当前 ${s.top1}），本次不判`); continue; }
    if (want === s.top1) log(`  ✓ ${s.query} → ${s.top1}`);
    else { broken.push(`${s.query}：期望 ${want}，实得 ${s.top1}`); log(`  ✗ ${s.query} —— 期望 ${want}，实得 ${s.top1}`); }
  }
  return broken;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const explain = argv.includes('--explain');
  const doMigrate = argv.includes('--migrate');
  const rpi = argv.indexOf('--replay');
  const doReplay = rpi !== -1;
  const replayIdx = doReplay && argv[rpi + 1] && /^\d+$/.test(argv[rpi + 1]) ? Number(argv[rpi + 1]) : null;
  const ri = argv.indexOf('--reason');
  const reason = ri !== -1 ? argv[ri + 1] : null;

  const { kb, records, sentinels } = runAll();
  const existing = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : null;

  // —— schema 迁移（只增字段，不动既有内容）——
  if (doMigrate) {
    if (!existing) { console.error('未找到 baseline.json，无可迁移的基线。'); process.exit(1); }
    migrate(kb, sentinels);
    return;
  }

  // —— 历史回放（只读演示）——
  if (doReplay) {
    if (!existing) { console.error('未找到 baseline.json，无可回放的历史。'); process.exit(1); }
    replay(existing, kb, replayIdx);
    return;
  }

  // —— 比对模式 ——
  if (check) {
    if (!existing) {
      console.error('未找到 baseline.json——请先执行 node scripts/baseline.mjs 生成基线');
      process.exit(1);
    }
    const m = resolveMode(existing, kb);
    const domOf = (id) => (kb.byId.get(id) || {}).domain || '(节点已不存在)';
    console.log(`基线分层比对　模式 ${m.mode}（${m.mode === 'A' ? '代码改动' : '语料扩容'}）`);
    console.log('─'.repeat(78));
    console.log(m.note);
    if (m.legacy) console.log('');
    if (m.gone && m.gone.length) console.log(`注意：基线登记而当前缺失的域 ${m.gone.length} 个：${m.gone.join('、')}`);

    console.log('\n哨兵：');
    const broken = checkSentinels(existing, sentinels, (s) => console.log(s));

    const drifted = diffAgainst(existing, records, { mode: m.mode, newDomains: m.newDomains, domOf });
    const sum = summarize(drifted);
    console.log(`\n偏离 ${sum.total} / ${records.length} 条　自动通过 ${sum.pass} · 须裁决 ${sum.fail}`);
    if (sum.total) {
      console.log(`判定分布：${sum.byLevel}\n`);
      printDrift(drifted, (s) => console.log(s), explain);
    }

    console.log('\n' + '─'.repeat(78));
    if (!broken.length && !sum.fail) {
      console.log(sum.total
        ? `分层比对通过：${sum.total} 条偏离全部落在自动通过层，哨兵 ${sentinels.length} 条保持。`
        : `分层比对通过：${records.length} 条查询与基线完全一致，哨兵 ${sentinels.length} 条保持。`);
      return;
    }
    if (broken.length) console.error(`\n哨兵断裂 ${broken.length} 条：${broken.join('；')}`);
    if (sum.fail) console.error(`须人工裁决 ${sum.fail} 条——逐条评定改善／中性／劣化后，方可以 --reason 重定版。`);
    process.exit(1);
  }

  // —— 首次生成 ——
  if (!existing) {
    writeBaseline(kb, records, [], sentinels);
    console.log(`已生成基线：${OUT_FILE}`);
    console.log(`查询 ${records.length} 条 · 节点 ${kb.nodes.length} · 法条键 ${kb.lawArticles.size} · 书目 ${kb.books.length}`);
    const empty = records.filter((r) => !r.topIds.length);
    if (empty.length) console.log(`提示：${empty.length} 条查询零命中 —— ${empty.map((r) => r.query).join('、')}`);
    return;
  }

  // —— 已有基线 ——
  const m = resolveMode(existing, kb);
  const domOf = (id) => (kb.byId.get(id) || {}).domain || '(节点已不存在)';
  const drifted = diffAgainst(existing, records, { mode: m.mode, newDomains: m.newDomains, domOf });
  if (!drifted.length) {
    console.log('基线无变化，未改写文件。');
    return;
  }
  const sum = summarize(drifted);
  if (!reason) {
    console.error(`拒绝覆盖：当前结果与既有基线有 ${drifted.length} 条偏离`
      + `（模式 ${m.mode}：自动通过 ${sum.pass} · 须裁决 ${sum.fail}），重定版须以 --reason 说明依据。`);
    printDrift(drifted, (s) => console.error(s), explain);
    console.error('\n用法：node scripts/baseline.mjs --reason "重定版依据"');
    process.exit(1);
  }
  const revisions = [...(existing.revisions || []), {
    date: new Date().toISOString().slice(0, 10),
    reason,
    mode: m.mode,
    newDomains: [...m.newDomains],
    changedCount: drifted.length,
    // verdicts 为 v2 新增：把分层判定结论与席位流向一并留档，使「当时为何放行」可回溯
    verdicts: drifted.map((d) => ({ no: d.no, level: d.level, verdict: d.verdict, fail: !!d.fail, flow: d.flow || undefined })),
    changed: drifted.map((d) => ({ no: d.no, query: d.query, lost: d.lost || [], added: d.added || [] })),
  }];
  writeBaseline(kb, records, revisions, sentinels);
  console.log(`基线已重定版：${drifted.length} / ${records.length} 条变更（模式 ${m.mode}）`);
  console.log(`依据：${reason}`);
  printDrift(drifted, (s) => console.log(s), explain);
  console.log(`\n变更明细与分层判定已记入 baseline.json 的 revisions（累计 ${revisions.length} 次重定版）`);
}

main();
