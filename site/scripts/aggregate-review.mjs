// 汇总 Opus 复核结果：合并样本(review-nodes/result-*) + 聚焦(review-focused/fresult-*)，校验覆盖，
//   生成最终《Opus复核报告.md》+ 清理清单/存疑清单/污染源 CSV，并检测 edges 自环与重复边。只读分析，不改数据。
//   运行：node scripts/aggregate-review.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D = join(__dirname, '..', 'data');
const OUT = join(__dirname, '..', 'audit');
const RN = join(OUT, 'review-nodes');
const RF = join(OUT, 'review-focused');
const RA = join(OUT, 'review-all');
const RS = join(OUT, 'review-suspect');

const DOMAIN_CN = {
  'examination-guideline-2025': '审查指南', 'patent-law': '专利法', 'implementation-rules': '实施细则',
  'infringement-guide': '侵权判定', 'mechanical-drafting-rules': '机械撰写', 'chemistry-drafting-rules': '化学撰写', 'oa-response-guide': '答复指引',
};
const dcn = (d) => DOMAIN_CN[d] || d || '?';

const nodes = JSON.parse(readFileSync(join(D, 'nodes.json'), 'utf8'));
const edges = JSON.parse(readFileSync(join(D, 'edges.json'), 'utf8'));
const byId = new Map(nodes.map((n) => [n.id, n]));

// ---- 载入所有判定 ----
const results = [];
const fileStats = [];
function load(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => /^(result|fresult|aresult|sresult)-(\d+|fix)\.json$/.test(x))) {
    let r;
    try { r = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch (e) { fileStats.push({ f, ok: false, err: e.message }); continue; }
    let cnt = 0;
    for (const nd of r.nodes || []) for (const j of nd.judged || []) {
      results.push({ centerId: nd.centerId, centerLabel: nd.centerLabel, nbrId: j.id, nbrLabel: j.label, relation: j.relation, verdict: j.verdict, confidence: j.confidence, reason: j.reason });
      cnt++;
    }
    fileStats.push({ f, ok: true, nodes: (r.nodes || []).length, judged: cnt });
  }
}
load(RN);
load(RF);
load(RA);
load(RS);

// 去重（同 中心|邻居）：后载入覆盖先载入 —— 载入序 RN→RF→RA→RS，
//   故 review-suspect(RS) 的二次判定覆盖早轮的"存疑"，聚焦(RF)覆盖样本(RN)。
const dedupMap = new Map();
for (const r of results) dedupMap.set(`${r.centerId}|${r.nbrId}`, r);
const dedup = [...dedupMap.values()];

// 补域信息
for (const r of dedup) {
  r.cDom = dcn(byId.get(r.centerId)?.domain);
  r.nDom = dcn(byId.get(r.nbrId)?.domain);
  r.cross = r.cDom !== r.nDom;
  r.fixed = r.relation === '同主题桥' || r.relation === '共引法条'; // 固化边(concept/colaw)；否则 topicPeers 动态
}

const norm = (v) => (v?.startsWith('相关') ? '相关' : v?.startsWith('不相关') ? '不相关' : '存疑');
const tally = { 相关: 0, 不相关: 0, 存疑: 0 };
const relTally = {};
for (const r of dedup) {
  const v = norm(r.verdict);
  tally[v]++;
  (relTally[r.relation] ||= { 相关: 0, 不相关: 0, 存疑: 0 })[v]++;
}

const centers = new Set(dedup.map((r) => r.centerId));
const unrelated = dedup.filter((r) => norm(r.verdict) === '不相关');
const suspect = dedup.filter((r) => norm(r.verdict) === '存疑');
const unrelatedFixed = unrelated.filter((r) => r.fixed);
const unrelatedDyn = unrelated.filter((r) => !r.fixed);

// 污染源：被判"不相关"次数最多的邻居节点（即被各中心广泛误连的"万能邻居"）
const pollute = new Map();
for (const r of unrelated) {
  const e = pollute.get(r.nbrId) || { id: r.nbrId, label: r.nbrLabel, dom: r.nDom, bad: 0, suspect: 0 };
  e.bad++;
  pollute.set(r.nbrId, e);
}
for (const r of suspect) { const e = pollute.get(r.nbrId); if (e) e.suspect++; }
const polluters = [...pollute.values()].sort((a, b) => b.bad - a.bad).slice(0, 25);

// ---- 数据 bug 检测：自环 + 重复边 ----
const selfLoops = edges.filter((e) => e.source === e.target);
const seenE = new Set();
const dupEdges = [];
for (const e of edges) {
  const k = `${e.type}|${e.source}|${e.target}`;
  if (seenE.has(k)) dupEdges.push(e); else seenE.add(k);
}

// ---- 输出 ----
const L = [];
L.push('# 专利星图 · Opus 4.8 节点关联性复核报告');
L.push('');
L.push(`- 生成时间：${new Date().toISOString()}`);
L.push('- 复核方式：以节点为中心，Opus 4.8 子 agent 读两端正文逐条判定（不依赖 embedding，不看规则初判，独立裁定）');
L.push(`- 覆盖：${centers.size} 个中心节点（degree 最高 150 ∪ 全部固化边两端），共判定 ${dedup.length} 个弱关联邻居`);
L.push('');
L.push('## 一、判定总览');
L.push('');
L.push(`| 裁定 | 数量 | 占比 |`);
L.push('|---|---|---|');
for (const k of ['相关', '不相关', '存疑']) L.push(`| ${k} | ${tally[k]} | ${(tally[k] / dedup.length * 100).toFixed(1)}% |`);
L.push('');
L.push('## 二、按关系类型分布');
L.push('');
L.push('| 关系类型 | 相关 | 不相关 | 存疑 | 性质 |');
L.push('|---|---|---|---|---|');
for (const [rel, t] of Object.entries(relTally)) {
  const nature = rel === '同主题桥' ? 'concept 固化边·可删' : rel === '共引法条' ? 'colaw 固化边·可删' : 'topicPeers 动态·改前端';
  L.push(`| ${rel} | ${t.相关} | ${t.不相关} | ${t.存疑} | ${nature} |`);
}
L.push('');
L.push('## 三、清理清单（判定"不相关"）');
L.push('');
L.push(`共 **${unrelated.length}** 条判为不相关：`);
L.push(`- **固化边(concept/colaw) ${unrelatedFixed.length} 条**：存在于 edges.json，可直接删除（详见 \`清理清单-固化边.csv\`）。`);
L.push(`- **动态 topicPeers ${unrelatedDyn.length} 条**：非存储边，是前端点击时按"主题标签+热度"实时拉取的，须靠第二阶段重构 topicPeers 逻辑解决（详见 \`清理清单-动态.csv\`）。`);
L.push('');
L.push('## 四、污染源 top（被各中心广泛误连的"万能邻居"，前端重构优先剔除）');
L.push('');
L.push('| 邻居节点 | 域 | 被判不相关次数 | 被判存疑次数 |');
L.push('|---|---|---|---|');
for (const p of polluters) L.push(`| ${p.label} | ${p.dom} | ${p.bad} | ${p.suspect} |`);
L.push('');
L.push('## 五、典型无关连接模式（各批 Opus 高度一致）');
L.push('');
L.push('1. **授权前审查 ↔ 授权后维权硬凑**（最普遍）：实审/初审/撰写/答复节点被连到《侵权判定指南》的等同侵权、相同侵权、保护范围解释方法。两者分属专利局授权确权与法院诉讼维权，仅靠"权利要求/保护范围"标签相撞。');
L.push('2. **杂揽容器节点滥连**：`实质审查`、`其他文件和相关手续的审查`、`外观设计国际申请其他文件审查` 等容器节点自身无独立正文、却堆叠十几到二十几个异质主题标签，几乎与任何节点都能凑出共同标签，是误连最大来源。');
L.push('3. **代理人撰写规范 ↔ 审查员审查程序错配**：机械/化学撰写示例（背景技术、具体实施方式）被挂到审查/答复节点，二者业务角色相反。');
L.push('4. **客体错配**：发明/实用新型节点与外观设计节点互连（外观无权利要求书与说明书充分公开问题）。');
L.push('5. **宽泛标签/同词异义巧合**：如"创造性"（署名贡献 vs 授权三性）、"全面"（全面审查 vs 全面覆盖）、"国际申请"等单一标签字面相撞。');
L.push('');
L.push('## 六、附带发现的数据缺陷（建议一并修）');
L.push('');
L.push(`- **自环边（节点连自己）${selfLoops.length} 条**：${selfLoops.slice(0, 10).map((e) => `${e.type}:${e.source}`).join('；') || '无'}`);
L.push(`- **完全重复边 ${dupEdges.length} 条**：${dupEdges.slice(0, 10).map((e) => `${e.type}:${e.source}→${e.target}`).join('；') || '无'}`);
L.push('');
L.push('## 七、存疑清单（需你人工定夺）');
L.push('');
L.push(`共 **${suspect.length}** 条，多为"同制度但跨环节""有间接衔接但牵强"的边界情形，详见 \`存疑清单.csv\`。`);
L.push('');
L.push('## 八、下一步（第二阶段修复方向）');
L.push('');
L.push('1. **删固化边**：按 `清理清单-固化边.csv` 从 edges.json 删除被判不相关的 concept/colaw 边。');
L.push('2. **重构前端 topicPeers**（`src/main.ts`）：弃用 degree 排序、剔除"污染源 top"中的容器/枢纽节点、加相关度门槛与"同业务环节"约束；硬关联(hierarchy/xref/lawref)高亮、弱关联淡显。');
L.push('3. **修数据缺陷**：删自环与重复边；修正 extract-edges.mjs 防止再生成。');
L.push('4. **回归校验**：跨域边两端须真正同环节同主题；容器节点不得作为 concept 桥或 topicPeer。');
L.push('');

writeFileSync(join(OUT, 'Opus复核报告.md'), L.join('\n'));

// CSV
function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function writeCsv(file, rows) {
  const head = ['中心id', '中心label', '中心域', '邻居id', '邻居label', '邻居域', '关系类型', '固化/动态', '裁定', '置信', '理由'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.centerId, r.centerLabel, r.cDom, r.nbrId, r.nbrLabel, r.nDom, r.relation, r.fixed ? '固化边' : '动态', norm(r.verdict), r.confidence, r.reason].map(csvCell).join(','));
  writeFileSync(join(OUT, file), '﻿' + lines.join('\n'));
}
writeCsv('清理清单-固化边.csv', unrelatedFixed);
writeCsv('清理清单-动态.csv', unrelatedDyn);
writeCsv('存疑清单.csv', suspect);

const pl = ['﻿邻居id,邻居label,域,被判不相关次数,被判存疑次数'];
for (const p of [...pollute.values()].sort((a, b) => b.bad - a.bad)) pl.push([p.id, p.label, p.dom, p.bad, p.suspect].map(csvCell).join(','));
writeFileSync(join(OUT, '污染源排行.csv'), pl.join('\n'));

// 控制台
console.log('==== 文件校验 ====');
const bad = fileStats.filter((s) => !s.ok);
console.log(`结果文件 ${fileStats.length} 个，解析失败 ${bad.length} 个${bad.length ? '：' + bad.map((b) => b.f).join(',') : ''}`);
console.log(`覆盖中心节点 ${centers.size}，判定总数 ${dedup.length}（去重前 ${results.length}）`);
console.log('==== 判定分布 ====', tally, `相关率 ${(tally.相关 / dedup.length * 100).toFixed(1)}%`);
console.log('按关系：', JSON.stringify(relTally));
console.log(`不相关 ${unrelated.length}（固化边 ${unrelatedFixed.length} 可删 / 动态 ${unrelatedDyn.length} 改前端）；存疑 ${suspect.length}`);
console.log(`数据缺陷：自环 ${selfLoops.length}、重复边 ${dupEdges.length}`);
console.log('污染源 top5：', polluters.slice(0, 5).map((p) => `${p.label}(${p.bad})`).join('  '));
console.log('产出 → audit/Opus复核报告.md、清理清单-固化边.csv、清理清单-动态.csv、存疑清单.csv、污染源排行.csv');
