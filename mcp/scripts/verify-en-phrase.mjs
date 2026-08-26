// verify-en-phrase.mjs —— 阶段 0 任务 0-1 与 0-5 的专项验证：英文多词检索
//
// 涉及两处修复，二者作用于检索链路的不同层级，须合并验证：
//   0-1  精排层。修复前只保留去空白的查询串（qFull），正文里的「inventive step」带空格，
//        includes 判定恒 false，exactTitle 1000 分与 exactBody 500 分两笔加权全部丢失。
//   0-5  召回层。修复前 encoder 不把标点当切分点，「（Animal」被切成带括号的 token，
//        tokenize:'forward' 的前缀匹配对「animal」失效，FlexSearch 取 AND 交集，
//        一词落空即整条查询落空——节点根本进不了候选池，精排层的加权无从施加。
//
// 本脚本以阶段 0 全部改动之前的源码（git show HEAD 导出为 src/__search_before.mjs）作对照，
// 分两路验证：
//   路 A  现有七书的真实语料。七书为中文，英文多词串仅有两处（化学撰写规范的试剂名与
//         统计方法名），且两处均紧跟全角括号——正是 0-5 所修缺陷的实例。修复后应能命中。
//   路 B  合成 fixture。`inventive step`、`prior art` 这类典型英文查询在中文语料中本就
//         不存在真答案（语料性质使然，非缺陷），故构造含目标短语的最小知识库补足至 5 条。
//         噪声节点的标题刻意含目标短语的全部单词但不成串，使其在修复前凭 covTitle 300 分
//         与 fsTitle 30 分压过真答案——只有 exactBody 的 500 分生效才能扳回，
//         fixture 因此具备真实区分力。
//
// 用法：node scripts/verify-en-phrase.mjs
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { loadKb } from '../src/data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEFORE_FILE = join(HERE, '..', 'src', '__search_before.mjs');

// ============ 合成 fixture ============
// 每个目标短语配 4 个噪声节点：标题含该短语的全部单词但不相邻成串
const CASES = [
  {
    phrase: 'inventive step',
    noiseTitles: ['Step review of inventive concepts', 'Inventive practice and the step ladder',
      'The step: inventive or not', 'Stepwise notes on inventive activity'],
  },
  {
    phrase: 'prior art',
    noiseTitles: ['Art of the prior period', 'Prior filings and art classification',
      'The art gallery prior to renovation', 'Prior notice on art materials'],
  },
  {
    phrase: 'claim construction',
    noiseTitles: ['Construction of the building claim form', 'Claim forms in construction projects',
      'The construction site claim register', 'Claim handling during construction'],
  },
  {
    phrase: 'person skilled in the art',
    noiseTitles: ['Art skills of the person in charge', 'The person who is skilled in crafts and art',
      'Skilled person: art and science', 'Art teacher, a skilled person in the studio'],
  },
  {
    phrase: 'unity of invention',
    noiseTitles: ['Invention and the unity of purpose', 'Unity shown by the invention team',
      'The invention of unity in design', 'Unity, invention and cohesion'],
  },
];

/** 构造最小 kb：search.mjs 只用到 nodes / byId / bodies / termDetails / termByName */
function makeFixture() {
  const nodes = [];
  const bodies = {};
  const answers = new Map(); // phrase → 真答案节点 id

  CASES.forEach((c, i) => {
    // 真答案：标题中性（不含目标单词），短语只出现在正文
    const id = `fx-ans-${String(i + 1).padStart(2, '0')}`;
    nodes.push({ id, label: `Examination note ${i + 1}`, level: 'section', domain: 'fixture', charLen: 220 });
    bodies[id] = {
      own: `This note explains how the examiner assesses ${c.phrase} during substantive examination. `
        + `The assessment of ${c.phrase} follows the three-step approach set out in the guidelines.`,
    };
    answers.set(c.phrase, id);

    // 噪声：标题含全部单词但不成串，正文同理。每个标题铺 3 个变体，
    // 使单个短语的噪声达 12 个（> Top8 容量），真答案在修复前必然被挤出榜单
    c.noiseTitles.forEach((t, k) => {
      for (let v = 0; v < 3; v++) {
        const nid = `fx-noise-${String(i + 1).padStart(2, '0')}-${k}-${v}`;
        nodes.push({ id: nid, label: t, level: 'section', domain: 'fixture', charLen: 180 });
        bodies[nid] = { own: `${t}. This background section elaborates on the matters named in the title above, variant ${v}. ${t}.` };
      }
    });
  });

  return {
    kb: { nodes, byId: new Map(nodes.map((n) => [n.id, n])), bodies, termDetails: {}, termByName: new Map() },
    answers,
  };
}

async function main() {
  if (!existsSync(BEFORE_FILE)) {
    console.error('未找到对照文件 src/__search_before.mjs');
    console.error('请先执行：git show HEAD:mcp/src/search.mjs > mcp/src/__search_before.mjs');
    process.exit(1);
  }
  const after = await import('../src/search.mjs');
  const before = await import('../src/__search_before.mjs');
  const run = (mod, kb, index, query) => mod.search(kb, index, { query, limit: 8 });

  let failed = 0;

  // —— 路 A：现有七书真实语料 ——
  console.log('路 A｜现有七书真实语料');
  console.log('─'.repeat(78));
  const realKb = loadKb({ domains: '' });
  const idxBefore = before.buildIndex(realKb);
  const idxAfter = after.buildIndex(realKb);
  for (const q of ['Animal Cell Lysis Solution', 'one-way ANOVA']) {
    const truth = Object.entries(realKb.bodies)
      .filter(([, v]) => (v.own || '').toLowerCase().includes(q.toLowerCase())).map(([id]) => id);
    const pool = (idx) => idx.search(q, { limit: 80 }).reduce((s, x) => s + x.result.length, 0);
    const top = (mod, kbx, idx) => mod.search(kbx, idx, { query: q, limit: 8 }).map((x) => x.id);
    const tb = top(before, realKb, idxBefore);
    const ta = top(after, realKb, idxAfter);
    const hitB = truth.filter((t) => tb.includes(t)).length;
    const hitA = truth.filter((t) => ta.includes(t)).length;
    const ok = truth.length > 0 && hitA === truth.length;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} 「${q}」 正文真答案 ${truth.length} 个（${truth.join('、')}）`);
    console.log(`    修复前：FlexSearch 召回 ${pool(idxBefore)} 条 · Top8 含真答案 ${hitB} 个`);
    console.log(`    修复后：FlexSearch 召回 ${pool(idxAfter)} 条 · Top8 含真答案 ${hitA} 个`);
  }

  // —— 路 B：合成 fixture（验收依据）——
  console.log('\n路 B｜合成 fixture（验收依据）');
  console.log('─'.repeat(78));
  const { kb: fxKb, answers } = makeFixture();
  const fxBefore = before.buildIndex(fxKb);
  const fxAfter = after.buildIndex(fxKb);
  console.log(`规模：真答案 ${answers.size} 个 · 噪声 ${fxKb.nodes.length - answers.size} 个 · 合计 ${fxKb.nodes.length} 节点\n`);

  let improved = 0;
  for (const { phrase } of CASES) {
    const want = answers.get(phrase);
    const b = run(before, fxKb, fxBefore, phrase);
    const a = run(after, fxKb, fxAfter, phrase);
    const pos = (r) => { const i = r.findIndex((x) => x.id === want); return i === -1 ? -1 : i + 1; };
    const pb = pos(b);
    const pa = pos(a);
    const ok = pa !== -1;
    if (!ok) failed++;
    if (pb === -1 && pa !== -1) improved++;
    const hit = a.find((x) => x.id === want);
    console.log(`${ok ? '✓' : '✗'} 「${phrase}」`);
    console.log(`    修复前：${pb === -1 ? '未进 Top8' : `第 ${pb} 位`}`);
    console.log(`    修复后：${pa === -1 ? '未进 Top8' : `第 ${pa} 位`}${hit ? ` · via=${hit.via} · 得分 ${Math.round(hit.score)}` : ''}`);
  }

  console.log(`\nfixture 区分力：${improved} / ${CASES.length} 条在修复前落榜、修复后进入 Top8`);
  if (!improved) {
    console.error('fixture 无区分力——修复前即全部达标，无法证明修复有效');
    failed++;
  }

  console.log('─'.repeat(78));
  if (failed) {
    console.error(`验证失败：${failed} 项未达标`);
    process.exit(1);
  }
  console.log('验证通过：7 条英文多词查询（真实语料 2 + fixture 5）的真答案全部进入 Top8，且 fixture 具备区分力');
}

main();
