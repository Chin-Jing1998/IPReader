#!/usr/bin/env node
// 数据管线 D3-5：词条主题「章节投票」归类 —— 按词条出处章节把仍留 99-综合 的词判给细粒度主题，
//   产物写入 data/term-topic-decisions.json（merge-terms.mjs 的人工决策层，优先级最高）。
//
//   为什么要另立这一步：merge-terms 的三级算法（精确 / 双向子串 / 定义句计分）依赖主题 kw 表，
//   而 5.9 波1/波2 新纳入的商标指南 44 章与四法域 8 部法律，其术语多是「受让人」「缴费码」
//   「转让终局」一类**本身不含主题词面**的程序性专名——kw 表再怎么扩也吃不住。但这类词的
//   归属由其出处章节唯一决定（《商标审查审理指南》第十四章的词必属马德里后续业务），
//   故按「出处章节 → 主题」映射投票，比继续堆 kw 既准确又可审计。
//
//   映射表 CHAPTER_TOPIC 按节点 id 前缀登记，取**最长前缀命中**（因此可先写章、再写更细的节覆盖）。
//   只覆盖 5.9 新入库的 9 部书（商标指南 + 四法域 8 部）；专利 7 部规范一律不登记——
//   专利域落类率已达 89~90% 的对标线，无须改动，也避免动到既有词条页路径。
//
//   处理规则：
//     · 只处理当前 topicKey 为空（99-综合）的词条；已落类者一律不碰；
//     · 已在 term-topic-decisions.json 中有条目的词条不碰（人工决策优先，且保证幂等）；
//     · 排除名单 EXCLUDE 中的词条不碰（smoke/shots 对其目录路径有硬编码断言）；
//     · 每个出处节点投一票，票数最高者胜出；并列（含并列第一）一律放弃、保留 99-综合。
//   幂等：重复运行产出逐字相同；--dry-run 只统计不写盘。
//   运行：node scripts/classify-terms-by-chapter.mjs [--dry-run]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPIC_NAME } from './lib/topics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DRY = process.argv.includes('--dry-run');

// 排除名单：这两个词条的目录路径被 desktop 端断言写死，归类一经改动 smoke 立即红。
//   term-0001 = 客体审查（smoke.cjs:366/624 断言 9-关键词索引/04-可专利客体/term-0001）
//   term-0210 = 先用权（shots.cjs:53 断言 9-关键词索引/99-综合/term-0210 —— 必须保持不落类）
//   term-0028 = 现有技术（smoke.cjs:2075 断言 01-新颖性/term-0028，其归类由种子既有 topicKey 定，
//     本脚本只碰未落类词，天然不受影响，仍一并列入以防日后误改）
const EXCLUDE = new Set(['客体审查', '先用权', '现有技术']);

// ============ 章节 → 细粒度主题 映射（按节点 id 前缀，最长前缀优先） ============
const CHAPTER_TOPIC = {
  // ---- 《商标审查审理指南》44 章（上编五部分 + 下编十九章 + 说明）----
  'tmeg-01-01': 'tmFormalProc',      // 第一章 形式审查的一般性要求
  'tmeg-01-02': 'tmFormalProc',      // 第二章 注册申请形式审查
  'tmeg-01-03': 'tmOppositionReview', // 第三章 异议形式审查
  'tmeg-01-04': 'tmOppositionReview', // 第四章 评审形式审查
  'tmeg-01-05': 'tmUseRevocation',   // 第五章 撤销注册商标申请形式审查
  'tmeg-02-01': 'tmClassification',  // 第六章 商品服务分类
  'tmeg-02-02': 'tmClassification',  // 第七章 商标文字检索要素分类
  'tmeg-02-03': 'tmClassification',  // 第八章 商标图形要素分类
  'tmeg-02-04': 'tmClassification',  // 第九章 商标其他检索要素分类
  'tmeg-03-01': 'tmChangeAssign',    // 第十章 商标变更类申请
  'tmeg-03-02': 'tmChangeAssign',    // 第十一章 商标权的处分类申请
  'tmeg-03-03': 'tmChangeAssign',    // 第十二章 注册商标的续展
  'tmeg-04': 'tmMadrid',             // 第四部分 马德里商标国际注册审查（第十三~十八章整部分）
  'tmeg-05-01': 'tmFormalProc',      // 第十九章 商标申请文件的接收
  'tmeg-05-02': 'tmFeeArchive',      // 第二十章 商标费用
  'tmeg-05-03': 'tmFeeArchive',      // 第二十一章 商标文件的送达
  'tmeg-05-04': 'tmFeeArchive',      // 第二十二章 出具和补发证明文件
  'tmeg-05-05': 'tmFeeArchive',      // 第二十三章 商标档案
  'tmeg-05-06': 'tmFeeArchive',      // 第二十四章 商标公告
  'tmeg-05-07': 'tmFeeArchive',      // 第二十五章 电子申请有关规定
  'tmeg-06-01': 'tmMisc',            // 下编第一章 概述（审查审理原则通则，无实体主题可挂）
  'tmeg-06-02': 'tmBadFaith',        // 第二章 不以使用为目的的恶意注册
  'tmeg-06-03': 'tmAbsoluteGrounds', // 第三章 不得作为商标标志
  'tmeg-06-04': 'tmDistinctiveness', // 第四章 商标显著特征
  'tmeg-06-05': 'tmSimilarity',      // 第五章 商标相同、近似
  'tmeg-06-06': 'tmDistinctiveness', // 第六章 三维标志商标
  'tmeg-06-07': 'tmDistinctiveness', // 第七章 颜色组合商标
  'tmeg-06-08': 'tmDistinctiveness', // 第八章 声音商标
  'tmeg-06-09': 'tmCollectiveGI',    // 第九章 集体商标、证明商标
  'tmeg-06-10': 'tmWellKnown',       // 第十章 复制、摹仿或者翻译他人驰名商标
  'tmeg-06-11': 'tmBadFaith',        // 第十一章 擅自注册被代理人或者被代表人商标
  'tmeg-06-12': 'tmBadFaith',        // 第十二章 特定关系人抢注他人在先使用商标
  'tmeg-06-13': 'tmBadFaith',        // 第十三章 商标代理机构申请注册商标
  'tmeg-06-14': 'tmBadFaith',        // 第十四章 损害他人在先权利
  'tmeg-06-15': 'tmBadFaith',        // 第十五章 抢注他人已经使用并有一定影响商标
  'tmeg-06-16': 'tmBadFaith',        // 第十六章 以欺骗手段或者其他不正当手段取得商标注册
  'tmeg-06-17': 'tmUseRevocation',   // 第十七章 撤销注册商标案件
  'tmeg-06-18': 'tmUseRevocation',   // 第十八章 《商标法》第五十条
  'tmeg-06-19': 'tmFormalProc',      // 第十九章 审查意见书
  'tmeg-07': 'tmMisc',               // 《商标审查审理指南》的说明

  // ---- 《著作权法》（cpl）----
  'cpl-01': 'cprWorks',              // 第一章 总则（作品定义与种类、主体范围）
  'cpl-02': 'cprWorks',              // 第二章 著作权（默认归属向）
  'cpl-02-01-02': 'cprRightsLimit',  //   第十条 著作权的内容（十七项权利）
  'cpl-02-03': 'cprRightsLimit',     //   第三节 权利的保护期
  'cpl-02-04': 'cprRightsLimit',     //   第四节 权利的限制（合理使用、法定许可）
  'cpl-03': 'cprContract',           // 第三章 许可使用和转让合同
  'cpl-04': 'cprNeighboring',        // 第四章 与著作权有关的权利
  'cpl-05': 'cprProtection',         // 第五章 著作权和与著作权有关的权利的保护
  'cpl-06': 'cprWorks',              // 第六章 附则（著作权即版权、出版的含义）

  // ---- 《著作权法实施条例》（cplr，38 条平铺，按条归类）----
  'cplr-01': 'cprWorks', 'cplr-02': 'cprWorks', 'cplr-03': 'cprWorks', 'cplr-04': 'cprWorks',
  'cplr-05': 'cprWorks', 'cplr-06': 'cprWorks', 'cplr-07': 'cprWorks', 'cplr-08': 'cprWorks',
  'cplr-09': 'cprWorks', 'cplr-10': 'cprWorks', 'cplr-11': 'cprWorks', 'cplr-12': 'cprWorks',
  'cplr-13': 'cprWorks', 'cplr-14': 'cprWorks', 'cplr-16': 'cprWorks',
  'cplr-15': 'cprRightsLimit', 'cplr-17': 'cprRightsLimit', 'cplr-18': 'cprRightsLimit',
  'cplr-19': 'cprRightsLimit', 'cplr-20': 'cprRightsLimit', 'cplr-21': 'cprRightsLimit',
  'cplr-22': 'cprContract', 'cplr-23': 'cprContract', 'cplr-24': 'cprContract',
  'cplr-25': 'cprContract',
  'cplr-26': 'cprNeighboring', 'cplr-27': 'cprNeighboring', 'cplr-28': 'cprNeighboring',
  'cplr-29': 'cprNeighboring', 'cplr-30': 'cprNeighboring', 'cplr-31': 'cprNeighboring',
  'cplr-32': 'cprNeighboring', 'cplr-33': 'cprNeighboring', 'cplr-34': 'cprNeighboring',
  'cplr-35': 'cprNeighboring',
  'cplr-36': 'cprProtection', 'cplr-37': 'cprProtection',

  // ---- 《反不正当竞争法》（aucl）----
  'aucl-01': 'cmpUnfairActs',        // 第一章 总则（竞争原则与不正当竞争界定）
  'aucl-02': 'cmpUnfairActs',        // 第二章 不正当竞争行为
  'aucl-02-04': 'cmpTradeSecret',    //   第十条 侵犯商业秘密的行为与定义
  'aucl-03': 'cmpEnforcement',       // 第三章 对涉嫌不正当竞争行为的调查
  'aucl-04': 'cmpEnforcement',       // 第四章 法律责任
  'aucl-04-05': 'cmpTradeSecret',    //   第二十六条 侵犯商业秘密的行政处罚
  'aucl-04-18': 'cmpTradeSecret',    //   第三十九条 商业秘密侵权的举证责任
  'aucl-05': 'cmpEnforcement',       // 第五章 附则

  // ---- 《反垄断法》（aml）----
  'aml-01': 'cmpMonopolyConduct',    // 第一章 总则
  'aml-02': 'cmpMonopolyConduct',    // 第二章 垄断协议
  'aml-03': 'cmpMonopolyConduct',    // 第三章 滥用市场支配地位
  'aml-04': 'cmpConcentration',      // 第四章 经营者集中
  'aml-05': 'cmpMonopolyConduct',    // 第五章 滥用行政权力排除、限制竞争
  'aml-06': 'cmpEnforcement',        // 第六章 对涉嫌垄断行为的调查
  'aml-07': 'cmpEnforcement',        // 第七章 法律责任
  'aml-08': 'cmpEnforcement',        // 第八章 附则

  // ---- 《植物新品种保护条例》（pvpr）----
  'pvpr-01': 'pvRightTermination',   // 第一章 总则
  'pvpr-02': 'pvRightTermination',   // 第二章 品种权的内容和归属
  'pvpr-03': 'pvGrantCondition',     // 第三章 授予品种权的条件
  'pvpr-04': 'pvApplicationExam',    // 第四章 品种权的申请和受理
  'pvpr-05': 'pvApplicationExam',    // 第五章 品种权的审查与批准
  'pvpr-06': 'pvRightTermination',   // 第六章 品种权的期限、终止和无效
  'pvpr-07': 'pvRightTermination',   // 第七章 法律责任
  'pvpr-08': 'pvRightTermination',   // 第八章 附则

  // ---- 《集成电路布图设计保护条例》（icld）整部 ----
  icld: 'icLayoutDesign',
  // ---- 《知识产权海关保护条例》（cusr）整部 ----
  cusr: 'prcCustoms',
  // ---- 《关于知识产权民事诉讼证据的若干规定》（ipev）----
  ipev: 'prcEvidence',
  'ipev-11': 'prcPreservation', 'ipev-12': 'prcPreservation', 'ipev-13': 'prcPreservation',
  'ipev-14': 'prcPreservation', 'ipev-15': 'prcPreservation', 'ipev-16': 'prcPreservation',
  'ipev-17': 'prcPreservation',
};

// 映射表自检：所有目标 topicKey 必须是 TOPICS 中登记过的键
for (const [prefix, tk] of Object.entries(CHAPTER_TOPIC)) {
  if (!TOPIC_NAME[tk]) {
    console.error(`✗ 映射表目标主题未登记：${prefix} → ${tk}`);
    process.exit(1);
  }
}
const PREFIXES = Object.keys(CHAPTER_TOPIC).sort((a, b) => b.length - a.length); // 最长前缀优先

function topicOfNode(nodeId) {
  for (const p of PREFIXES) if (nodeId === p || nodeId.startsWith(p + '-')) return CHAPTER_TOPIC[p];
  return null;
}

// ============ 主流程 ============
const readJson = (n, fb) => (existsSync(join(DATA_DIR, n)) ? JSON.parse(readFileSync(join(DATA_DIR, n), 'utf8')) : fb);
const terms = readJson('terms-merged.json', []);
const decisions = readJson('term-topic-decisions.json', []);
const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const decided = new Set(decisions.map((d) => norm(d.termKey || d.canonical)));

const added = [];
const stat = { skipClassified: 0, skipDecided: 0, skipExcluded: 0, noVote: 0, tie: 0 };
for (const t of terms) {
  if (t.topicKey) { stat.skipClassified++; continue; }
  if (EXCLUDE.has(t.canonical)) { stat.skipExcluded++; continue; }
  const key = norm(t.termKey || t.canonical);
  if (decided.has(key)) { stat.skipDecided++; continue; }
  const votes = new Map();
  for (const ids of Object.values(t.sources || {})) {
    for (const id of ids) {
      const tk = topicOfNode(id);
      if (tk) votes.set(tk, (votes.get(tk) || 0) + 1);
    }
  }
  if (!votes.size) { stat.noVote++; continue; }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) { stat.tie++; continue; }
  added.push({
    termKey: t.termKey,
    canonical: t.canonical,
    topicKey: ranked[0][0],
    note: `5.9 章节投票（${ranked[0][1]} 票 / ${[...votes.entries()].map(([k, v]) => `${k}:${v}`).join('，')}）`,
  });
}

// 稳定排序后追加写出（既有条目原样保留在前，新增条目按 termKey 升序，保证幂等与可审阅）
added.sort((a, b) => (a.termKey < b.termKey ? -1 : a.termKey > b.termKey ? 1 : 0));
const out = [...decisions, ...added];
const byTopic = added.reduce((a, d) => ((a[d.topicKey] = (a[d.topicKey] || 0) + 1), a), {});
console.log('—— 章节投票归类 ——');
console.log(
  `词表 ${terms.length} 词｜已落类跳过 ${stat.skipClassified}｜已有人工决策跳过 ${stat.skipDecided}｜` +
  `排除名单跳过 ${stat.skipExcluded}｜出处无映射 ${stat.noVote}｜票数并列放弃 ${stat.tie}`,
);
console.log(`新增决策 ${added.length} 条：`);
for (const [k, v] of Object.entries(byTopic).sort((a, b) => b[1] - a[1])) console.log(`   ${k}（${TOPIC_NAME[k]}）: ${v}`);
if (!DRY) {
  // 缩进 1 空格：与既有 term-topic-decisions.json 逐字同排版，避免整文件重排淹没本次新增
  writeFileSync(join(DATA_DIR, 'term-topic-decisions.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`✓ 写出 data/term-topic-decisions.json（${decisions.length} → ${out.length} 条）`);
} else {
  console.log('（--dry-run 未写盘）');
}
