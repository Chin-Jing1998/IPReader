// search-cases.mjs —— 检索调优专项用例
//
// 与 baseline.json 的分工：基线守的是「50 条真实查询的 Top8 不塌」，是面上的回归网；
// 本脚本守的是「三类已知缺陷不复发」，是点上的定向断言。基线会随语料扩容重定版，
// 本脚本的断言则应长期恒真——凡本脚本转红，必是检索逻辑退化而非语料变化。
//
// 六组：
//   C 容器与目录     R1 目录倾倒降权 + R2 容器命中补偿
//   N 条号直达       R3 法条路由；阶段 3 起 N6–N7 由「必须拦截他法」反转为「必须正确路由到他法」
//   S 排名稳定       R4 名次分归零，防候选池截断窗口抖动
//   L 跨法域直达     阶段 3 新增：69 部规范的条文可经全称／简称／书名号写法直达
//   V 法名变体       阶段 3 新增：勘误二登记的七类漏判逐条封堵（解析级断言）
//   M 回退与消歧     阶段 3 新增：裸条号在 find_law 与 search_kb 的分工、跨法同条号消歧
//
// 阶段 3 的语义反转说明：阶段 3 前库内只有专利法与实施细则两部有条文的规范，
// 「商标法第八条」无处可去，正确行为是拦截（否则被当成专利法第8条以 2400 分置顶）；
// 阶段 3 为 69 部规范登记 lawName、法条键增至 2496 后，正确行为变为路由到商标法本身。
// 拦截仍在，只是拦截面收窄为「库内确实没有的法」（如民法典）与「不成条文的引用」。
//
// 用法：node scripts/search-cases.mjs           全部用例
//       node scripts/search-cases.mjs --group N 只跑一组
import { loadKb } from '../src/data.mjs';
import * as SEARCH from '../src/search.mjs';
import { searchKb, findLaw } from '../src/tools.mjs';

// 显式传 domains:'' 绕开环境变量，保证用例在任何 shell 环境下口径一致
const kb = loadKb({ domains: '' });
const index = SEARCH.buildIndex(kb);
const ctx = { kb, index };

const top = (query, limit = 8) => searchKb(ctx, { query, limit }).results;
const ids = (query, limit = 8) => top(query, limit).map((r) => r.id);
const label = (id) => (kb.byId.get(id) || {}).label || '(缺失)';
const isLawNode = (id) => /^(law|rule)-\d/.test(id);

let passed = 0;
const failures = [];
let group = null;

function G(name) {
  group = name;
  console.log(`\n${name}`);
  console.log('─'.repeat(78));
}

function ok(code, name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${code} ${name}${detail ? ` —— ${detail}` : ''}`);
  } else {
    failures.push(`${code} ${name}${detail ? `：${detail}` : ''}`);
    console.log(`  ✗ ${code} ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

// 已知残留的登记位：打印但不计失败。用于「已定位、已评估、本轮不修」的行为，
// 使其每次运行都在眼前，而不是沉进文档里被遗忘。
const warnings = [];
function warn(code, name, detail) {
  warnings.push(`${code} ${name}${detail ? `：${detail}` : ''}`);
  console.log(`  ⚠ ${code} ${name}${detail ? ` —— ${detail}` : ''}`);
}

const only = (() => {
  const i = process.argv.indexOf('--group');
  return i !== -1 ? process.argv[i + 1] : null;
})();
const run = (g) => !only || only.toUpperCase() === g;

// ============ C 组｜容器与目录 ============
if (run('C')) {
  G('C 组｜容器与目录（R1 目录降权 · R2 容器补偿）');

  // C1 目录倾倒判别面：判别规则与 search.mjs 的 bodyFactor 保持同一口径。
  // 沿革：旧口径为「全库唯一命中 padm-01（公布与施行）」；阶段5.3 摘除该『公布与施行』章后，
  // 目录倾倒形态在全库消除（TOC 行≥20 判别面 0 命中），断言改锁新健康态「0 命中」，防同类
  // 倾倒形态复发。判别扫描逻辑本身不变。
  const TOC_LINE = /…+\s*\d+/g;
  const tocHits = [];
  for (const n of kb.nodes) {
    if (n.level === 'term') continue;
    const own = (kb.bodies[n.id] || {}).own || '';
    if (!own) continue;
    if ((own.match(TOC_LINE) || []).length >= 20) tocHits.push(n.id);
  }
  ok('C1', '目录倾倒判别面全库 0 命中（阶段5.3 摘除『公布与施行』后倾倒形态消除）',
    tocHits.length === 0, tocHits.join('、') || '无命中');

  // C2–C4 目录节点不得占据实体席位
  for (const [code, q] of [['C2', '全面覆盖原则'], ['C3', '现有技术抗辩'], ['C4', '专利法第45条']]) {
    const r = ids(q);
    ok(code, `「${q}」Top8 不含 padm-01`, !r.includes('padm-01'), r.join('、'));
  }

  // C5 容器补偿：命中容器须带 entry，且摘录取自该实体子节点而非 summary
  const penf = top('假冒专利').find((r) => r.id === 'penf-04');
  const penfOwn = (kb.bodies['penf-04-01'] || {}).own || '';
  ok('C5', '「假冒专利」命中 penf-04 并附实体子节点',
    !!penf && penf.isContainer === true && penf.entry && penf.entry.id === 'penf-04-01'
      && penf.excerpt && penfOwn.includes(penf.excerpt.replace(/^…|…$/g, '').slice(0, 20)),
    penf ? `entry=${penf.entry && penf.entry.id} 摘录取自子节点正文` : 'penf-04 未命中');

  // C6 补偿覆盖率：有子容器须全部能在 3 层内解出实体后代，否则 depth=3 的取值不成立
  const entryOf = (id, depth = 3) => {
    const kids = kb.childrenOf.get(id) || [];
    for (const c of kids) if ((kb.bodies[c] || {}).own) return c;
    if (depth <= 1) return null;
    for (const c of kids) { const d = entryOf(c, depth - 1); if (d) return d; }
    return null;
  };
  // 结构特征豁免（2026-08-24 阶段5.2 批次 W-R，经主会话裁决）：若某容器的全部后代都是
  // 「无正文叶子」（既无 own 正文、也无子节点），说明该处源书的条款要义完全写在标题里、
  // 标题之下不存在任何正文段——此时解不出实体后代是语料的结构事实，不是补偿机制失效。
  // 现实案例 qeval-15《专利质量评价指南》第十五章附则，其唯一子节点 qeval-15-01
  // 「第一百九十九条【通用】未列入上述条款的缺陷，以专利法及其实施细则、审查指南中的规定为准」
  // 是全书最后一行标题，其下无任何正文（语料第 2411 行即文末）。
  // 另两条路径均被否决：改写原文补正文会动源书；把标题回填为 ownText 会令页面标题与正文重复显示。
  // 豁免不静默——命中者计入 WARN 明细随断言一并打印。
  const allDescendantsAreEmptyLeaves = (id, depth = 8) => {
    const kids = kb.childrenOf.get(id) || [];
    if (!kids.length) return false;
    if (depth <= 0) return false;
    for (const c of kids) {
      if ((kb.bodies[c] || {}).own) return false;
      const gk = kb.childrenOf.get(c) || [];
      if (gk.length && !allDescendantsAreEmptyLeaves(c, depth - 1)) return false;
    }
    return true;
  };
  let containers = 0; let solved = 0; const exempt = [];
  for (const n of kb.nodes) {
    if (n.level === 'term' || (kb.bodies[n.id] || {}).own) continue;
    if (!(kb.childrenOf.get(n.id) || []).length) continue;
    if (!entryOf(n.id) && allDescendantsAreEmptyLeaves(n.id)) {
      exempt.push(`${n.id}「${n.label}」`);
      continue;
    }
    containers++;
    if (entryOf(n.id)) solved++;
  }
  ok('C6', '有子容器均可在 3 层内解出实体子节点',
    containers > 0 && solved === containers,
    `${solved} / ${containers}` +
      (exempt.length ? `　⚠ 结构特征豁免 ${exempt.length} 个（全部后代均为无正文叶子）：${exempt.join('、')}` : ''));
}

// ============ N 组｜条号直达 ============
if (run('N')) {
  G('N 组｜条号直达（R3 法条路由 · N6–N10 防他法误判）');

  const parse = SEARCH.parseArticleQuery;
  const hasParser = typeof parse === 'function';
  ok('N0', 'search.mjs 导出 parseArticleQuery', hasParser,
    hasParser ? '' : '未实现——N6–N10 的守卫断言无法执行');

  // N1–N5 条文原文置顶
  const DIRECT = [
    ['N1', '专利法第26条', 'law-03-01'],
    ['N2', '专利法第2条', 'law-01-02'],
    ['N3', '专利法第二十二条', 'law-02-01'],
    ['N4', '实施细则第57条', 'rule-03-16'],
    ['N5', '专利法实施细则第11条', 'rule-01-11'],
  ];
  for (const [code, q, want] of DIRECT) {
    const r = ids(q);
    ok(code, `「${q}」首条为条文原文`, r[0] === want,
      r[0] ? `${r[0]} ${label(r[0])}` : '无结果');
  }
  // 条号串扰专项：标题带其他条号的要旨案例不得入榜
  for (const q of ['专利法第26条', '专利法第2条']) {
    ok('N1b', `「${q}」Top8 不含 dg23-02-26（标题条号为二十三）`,
      !ids(q).includes('dg23-02-26'), ids(q).join('、'));
  }

  // ——— N6–N7：他法路由（阶段 3 反转）———
  // 阶段 3 前：白名单守卫拦下他法查询，断言「解析为 null」「Top8 不含专利法系条文」。
  // 阶段 3 后：他法各有自己的条文键，断言「解析到该法自己的键」「Top1 为该法条文节点」，
  // 同时保留「不得混入专利法系条文」这一半——原防线的实质诉求（不答非所问）不变。
  const OTHER_LAWS = [
    ['N6', '商标法第八条', '商标法第8条', 'trademark-law-2026', 'tml-01-08'],
    ['N7a', '著作权法第十条', '著作权法第10条', 'copyright-law-2020', 'cpl-02-01-02'],
    ['N7b', '反不正当竞争法第九条', '反不正当竞争法第9条', 'anti-unfair-competition-2025', null],
    ['N7c', '商标法实施条例第八条', '商标法实施条例第8条', 'trademark-law-rules-2014', null],
  ];
  for (const [code, q, wantKey, wantDomain, wantTop] of OTHER_LAWS) {
    const parsed = hasParser ? parse(kb, q) : null;
    ok(`${code}-a`, `「${q}」解析为「${wantKey}」（${wantDomain}）`,
      !!parsed && parsed.key === wantKey && parsed.domain === wantDomain && parsed.explicit === true,
      hasParser ? JSON.stringify(parsed) : '解析器未实现');
    const r = ids(q);
    const top = r[0] ? kb.byId.get(r[0]) : null;
    const wantNode = kb.lawArticles.get(wantKey);
    ok(`${code}-b`, `「${q}」首条为该法条文原文${wantTop ? `（${wantTop}）` : ''}，且 Top8 不含专利法/细则条文`,
      !!top && r[0] === wantNode && (!wantTop || r[0] === wantTop) && top.domain === wantDomain && !r.some(isLawNode),
      `${r[0] || '无结果'} ${r[0] ? label(r[0]) : ''}${r.some(isLawNode) ? ` · 混入 ${r.filter(isLawNode).join('、')}` : ''}`);
  }

  // N8 无法名前缀：弱路由，条文入首位但不以强权重压制；阶段 3 增断言 notes 须讲明法域推定
  if (hasParser) {
    const p = parse(kb, '第26条');
    ok('N8-a', '「第26条」解析为专利法第26条且标记为非显式法名',
      p && p.key === '专利法第26条' && p.explicit === false, JSON.stringify(p));
  } else {
    ok('N8-a', '「第26条」解析为专利法第26条且标记为非显式法名', false, '解析器未实现');
  }
  ok('N8-b', '「第26条」首条为 law-03-01', ids('第26条')[0] === 'law-03-01', ids('第26条')[0] || '无结果');
  {
    const notes = searchKb(ctx, { query: '第26条', limit: 8 }).notes || [];
    const hint = notes.find((x) => x.includes('未写明法名'));
    ok('N8-c', '「第26条」notes 含法域推定提示（裸条号不静默判法域）',
      !!hint && /\d+ 部规范/.test(hint), hint || `notes 共 ${notes.length} 条`);
  }

  // N9 简写不得被路由劫持：这三条交由 find_law，search_kb 行为须与调优前逐位一致
  const SHORTHAND = { '法22': null, '22': null, '细则57': null };
  for (const q of Object.keys(SHORTHAND)) {
    const parsed = hasParser ? parse(kb, q) : '解析器未实现';
    ok('N9', `「${q}」不进入法条路由`, hasParser && parsed === null,
      hasParser ? JSON.stringify(parsed) : '解析器未实现');
  }

  // N10 键缺失：不得抛异常，不得置顶
  let n10 = false; let n10d = '';
  try {
    const p = hasParser ? parse(kb, '专利法第999条') : null;
    const r = ids('专利法第999条');
    n10 = hasParser && p && p.missing === true && !r.some(isLawNode);
    n10d = `parse=${JSON.stringify(p)} 结果 ${r.length} 条`;
  } catch (e) { n10d = `抛异常：${e.message}`; }
  ok('N10', '「专利法第999条」标记 missing、无条文置顶、不抛异常', n10, n10d);
}

// ============ L 组｜跨法域直达（阶段 3 新增） ============
if (run('L')) {
  G('L 组｜跨法域直达（69 部规范 2496 键 · 全称／简称／书名号写法）');

  const PII2 = '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）';
  // [编号, 写法集, 期望首条节点, 说明]
  const DIRECT = [
    ['L1', ['商标法第8条', '商标法第八条', '《商标法》第8条', '《中华人民共和国商标法》第8条'], 'tml-01-08', '章→条：条文落在 section 层'],
    ['L2', ['著作权法第10条'], 'cpl-02-01-02', '章→节→条：条文落在 subsection 层，验证批①的条号自洽判据'],
    ['L3', ['侵权解释二第22条', '侵权解释（二）第22条', `${PII2}第22条`], 'pii2-22', '扁平无章：条文落在 chapter 层'],
    ['L4', ['刑事解释第九条'], 'ipcrm-09', '39 字全称经简称别名直达'],
    ['L5', ['布图细则第43条'], 'icldr-06-07', '「细则」二义：简称锚定集成电路布图设计保护条例实施细则'],
    ['L6', ['实施细则第57条'], 'rule-03-16', 'legacy 别名：「实施细则」仍锚定专利法实施细则'],
    ['L7', ['商标条例第98条'], 'tmlr-10-07', '简称别名'],
    // L11 收口新增：build-data.mjs 补齐 lawAlias 透传后，copyright-civil-interp 的别名槽
    // 由 short「著作权」（与「著作权法/著作权条例」构成子串歧义）改为 domains.mjs 既定的
    // lawAlias「著作权解释」，「著作权解释第10条」（含中文数字写法）应直达本解释第十条。
    ['L11', ['著作权解释第10条', '著作权解释第十条'], 'cprt-10', 'lawAlias 透传：短别名槽由「著作权」改注册为「著作权解释」以消歧'],
  ];
  for (const [code, forms, want, why] of DIRECT) {
    for (const q of forms) {
      const r = ids(q);
      ok(code, `「${q}」首条为 ${want}`, r[0] === want,
        `${r[0] || '无结果'} ${r[0] ? label(r[0]) : ''}${forms.length > 1 ? '' : ` · ${why}`}`);
    }
  }

  // L8 最长优先匹配：「著作权条例」不得被「著作权」抢先，二者须指向不同节点
  {
    const a = ids('著作权条例第38条')[0];
    const b = ids('著作权法第38条')[0];
    ok('L8', '「著作权条例第38条」与「著作权法第38条」指向不同节点（最长优先匹配）',
      a === 'cplr-38' && b === 'cpl-04-02-01' && a !== b, `${a} vs ${b}`);
  }

  // L9 该法确实没有这一条：报「无此条」，不得改判他法、不得抛异常
  {
    let detail = ''; let pass = false;
    try {
      const r = findLaw(ctx, { article: '商标法第999条' });
      const p = SEARCH.parseArticleQuery(kb, '商标法第999条');
      pass = typeof r.error === 'string' && r.error.includes('商标法') && r.error.includes('999')
        && !!p && p.missing === true && !ids('商标法第999条').some(isLawNode);
      detail = `${r.error} · parse.missing=${p && p.missing}`;
    } catch (e) { detail = `抛异常：${e.message}`; }
    ok('L9', '「商标法第999条」报《商标法》无此条、不改判他法、不抛异常', pass, detail);
  }

  // L10 库内没有这部法：报「未收录」，绝不回落专利法（勘误一的根治点）
  {
    const r = findLaw(ctx, { article: '民法典第1185条' });
    const p = SEARCH.parseArticleQuery(kb, '民法典第1185条');
    ok('L10', '「民法典第1185条」报未收录法律且不回落专利法',
      typeof r.error === 'string' && r.error.includes('未收录法律') && r.error.includes('民法典')
        && !r.article && p === null,
      `${r.error} · parse=${JSON.stringify(p)}`);
  }

  // L12 收口新增：lawAlias 取代 short 后，裸「著作权」不再单独入册（不再是任何域的别名）——
  // 沿用设计 S2 正文原例「著作权第30条」（"用户输入……时含义晦涩"）：该写法仍含义晦涩
  // （著作权法／著作权条例／本解释三者皆可能），设计明确不代猜，故应落入「有法名样文本
  // 但不认识」分支，不路由、不误判为本解释；find_law 侧应报「未收录法律」而非静默指向他域。
  {
    const p = SEARCH.parseArticleQuery(kb, '著作权第30条');
    const r = findLaw(ctx, { article: '著作权第30条' });
    ok('L12', '「著作权第30条」（设计 S2 原例，裸 short 无「解释」）不进入法条路由、find_law 报未收录',
      p === null && typeof r.error === 'string' && r.error.includes('未收录法律') && r.error.includes('著作权'),
      `parse=${JSON.stringify(p)} · find_law=${r.error}`);
  }
}

// ============ V 组｜法名变体（阶段 3 新增，勘误二七类漏判） ============
if (run('V')) {
  G('V 组｜法名变体（书名号／括号序号／年份序号 · 勘误二七类漏判封堵）');

  // 阶段 3 前，法名分组的字符类为 [一-龥]，跨不过书名号《》、括号序号（二）与阿拉伯年份，
  // 遂整体失配并落入「无法名」分支，按专利法弱路由 1200 分——七类写法全部误答专利法。
  const TM8 = '商标法第8条';
  const PII2K = '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）第22条';
  const VARIANTS = [
    ['V1', '《商标法》第8条', TM8],
    ['V2', '《中华人民共和国商标法》第8条', TM8],
    ['V3', '侵权解释二第22条', PII2K],
    ['V4', '侵权解释（二）第22条', PII2K],
    ['V5', PII2K, PII2K],
    ['V6a', '商标法2026第8条', TM8],
    ['V6b', '商标法（2026）第8条', TM8],
  ];
  for (const [code, q, wantKey] of VARIANTS) {
    const p = SEARCH.parseArticleQuery(kb, q);
    ok(code, `「${q}」解析为「${wantKey}」`, !!p && p.key === wantKey && p.explicit === true,
      p ? p.key : 'null');
  }

  // V7 非条文引用：书中「第二部分第四章第3条」这类定位串不得被当作法条查询
  for (const [code, q] of [['V7', '见《专利审查指南》第二部分第四章第3条'], ['V8', '本法第22条']]) {
    const p = SEARCH.parseArticleQuery(kb, q);
    ok(code, `「${q}」不进入法条路由（有法名样文本但不在注册表内）`, p === null, JSON.stringify(p));
  }
}

// ============ M 组｜裸条号回退与跨法同条号消歧（阶段 3 新增） ============
if (run('M')) {
  G('M 组｜裸条号回退分工具行为 · 跨法同条号消歧');

  // M1 find_law 的裸条号：列出全部候选、截断 20、专利法置首，不代用户择一
  {
    const r = findLaw(ctx, { article: '第26条' });
    const first = r.candidates && r.candidates[0];
    ok('M1', 'find_law「第26条」返回多候选（专利法置首、截断 20）',
      r.ambiguous === true && Array.isArray(r.candidates) && r.candidates.length === 20
        && r.truncated === true && first && first.article === '专利法第26条' && !r.error,
      `候选 ${r.candidates ? r.candidates.length : 0} 条 · 首项 ${first ? first.article : '—'} · note：${(r.note || '').slice(0, 40)}`);
  }

  // M2 候选唯一时不走多候选分支，直接直达
  {
    const r = findLaw(ctx, { article: '第149条' });
    ok('M2', 'find_law「第149条」候选唯一 → 直达实施细则条文',
      !r.ambiguous && r.article === '专利法实施细则第149条' && /^rule-/.test(r.id || ''), `${r.article} ${r.id}`);
  }

  // M3 同一裸条号在两个工具中的分工：检索给排序（专利法优先 + 提示），查条文给候选清单
  {
    const s = searchKb(ctx, { query: '第26条', limit: 8 });
    const f = findLaw(ctx, { article: '第26条' });
    ok('M3', '裸条号分工：search_kb 专利法优先并提示，find_law 交还候选清单',
      s.results[0] && s.results[0].id === 'law-03-01'
        && (s.notes || []).some((x) => x.includes('未写明法名')) && f.ambiguous === true,
      `search Top1 ${s.results[0] && s.results[0].id} · find ambiguous=${!!f.ambiguous}`);
  }

  // M4 键格式守门（与 smoke.mjs:153 同源）：维持 `${lawName}第N条`，不加 domain 命名空间前缀
  {
    const r = findLaw(ctx, { article: '细则22' });
    ok('M4', 'find_law「细则22」→「专利法实施细则第22条」（键格式与 legacy 别名双守门）',
      r.article === '专利法实施细则第22条', `${r.article} ${r.id}`);
  }

  // M5 历史简写：「法22」仍解专利法（find_law 专属遗留别名）；「22」按第 3 级回退给候选
  {
    const a = findLaw(ctx, { article: '法22' });
    const b = findLaw(ctx, { article: '22' });
    ok('M5', '「法22」直达专利法第22条，「22」返回候选清单（专利法置首）',
      a.article === '专利法第22条' && b.ambiguous === true
        && b.candidates[0].article === '专利法第22条',
      `法22→${a.article} · 22→${b.ambiguous ? `${b.candidates.length} 候选，首项 ${b.candidates[0].article}` : b.article}`);
  }

  // M6 节点 id 直入路径不受注册表改造影响
  {
    const r = findLaw(ctx, { article: 'pii2-23' });
    ok('M6', 'find_law 直接给节点 id 仍可用', r.id === 'pii2-23' && !!r.text, `${r.article} ${r.id}`);
  }

  // M7 跨法同条号消歧：同一条号在不同法各指各的条文，互不串味
  {
    const a = findLaw(ctx, { article: '商标法第22条' });
    const b = findLaw(ctx, { article: '专利法第22条' });
    const tm8 = ids('商标法第8条');
    ok('M7', '同条号跨法互不串味，且查商标法时专利法同条号不入榜',
      a.id !== b.id && a.article === '商标法第22条' && b.article === '专利法第22条'
        && !tm8.includes('law-01-08'),
      `商标法第22条→${a.id} · 专利法第22条→${b.id} · 「商标法第8条」Top8=${tm8.join('、')}`);
  }

  // M8 跨法域惩罚不得误伤第二梯队：引用了目标条的他法节点（law-cited）豁免。
  // 这是基线第 33 题「专利法第59条」零偏离的支点——其 Top8 有 4 席属有条文的他法域。
  {
    const r = ids('专利法第59条');
    const cited = new Set(kb.lawCitedBy.get('专利法第59条') || []);
    const kept = r.filter((id) => cited.has(id));
    ok('M8', '「专利法第59条」Top8 保留引用该条的他法节点（lawClash 不误伤 law-cited）',
      kept.length >= 3, `${kept.length} 席被引节点：${kept.join('、')}`);
  }
}

// ============ S 组｜排名稳定 ============
if (run('S')) {
  G('S 组｜排名稳定（R4 名次分归零 · 防候选池截断抖动）');

  // S1 条文序列连续：截断窗口若仍影响名次，law-06-07/08/09 会被 13/14/15 顶替
  const want = ['term-0201', 'law-06-06', 'law-06-07', 'law-06-08', 'law-06-09', 'law-06-10', 'law-06-11', 'law-06-12'];
  const got = ids('强制许可');
  ok('S1', '「强制许可」Top8 为条文连续序列',
    want.every((x, i) => got[i] === x), got.join('、'));

  // S2 分数不随候选池大小变化——这是 fs 名次分归零后的真实不变量。
  // pool = max(limit*8,80)，limit 8 与 30 对应 pool 80 与 240；归零前，落在截断窗口外的
  // 节点恒少 10 分，同一节点在两次调用中的分数会不同，这正是批次四三处「纯重排」的来源。
  for (const q of ['强制许可', '所属技术领域的技术人员', '通式']) {
    const a = new Map(SEARCH.search(kb, index, { query: q, limit: 8 }).map((r) => [r.id, r.score]));
    const b = new Map(SEARCH.search(kb, index, { query: q, limit: 30 }).map((r) => [r.id, r.score]));
    const drift = [...a].filter(([id, s]) => b.has(id) && Math.abs(b.get(id) - s) > 1e-9);
    ok('S2', `「${q}」同一节点的分数不随 limit(→pool) 变化`, drift.length === 0,
      drift.length ? drift.map(([id, s]) => `${id} ${s}→${b.get(id)}`).join('、') : `共比对 ${a.size} 节点`);
  }

  // S2b Top8 成员稳定性。分数不变只保证「进了候选池的节点排名一致」，
  // 未进候选池的节点仍会因 FlexSearch 结果被 pool 截断而整体缺席，这是与分数无关的第二重效应。
  for (const q of ['强制许可', '所属技术领域的技术人员']) {
    const a = ids(q, 8);
    const b = ids(q, 30).slice(0, 8);
    ok('S2b', `「${q}」Top8 不随 limit(→pool) 变化`,
      a.length === b.length && a.every((x, i) => x === b[i]),
      `limit8=${a.join(',')}`);
  }
  {
    // 已知残留：pool=80 时「通式」的 FlexSearch content 列表被截断，
    // 02-03-03-02 / 02-10-03-05 / 02-10-05-01 / 02-10-08-01 四个节点根本未进候选，
    // 故 limit=8 只返回 6 条。经调优前源码对照，该行为在批①前后逐位相同，非本次引入；
    // 根治需扩大 pool（实测 80→400 会带来 8/50 基线漂移），已登记待单独立项。
    const a = ids('通式', 8);
    const b = ids('通式', 30).slice(0, 8);
    const same = a.length === b.length && a.every((x, i) => x === b[i]);
    if (same) {
      ok('S2c', '「通式」Top8 已不随 pool 变化（残留已消解，可删除本登记）', true, a.join(','));
    } else {
      warn('S2c', '「通式」Top8 随 pool 变化（已知残留：候选池成员截断，非分数效应）',
        `limit8 ${a.length} 条 / limit30前8 ${b.length} 条`);
    }
  }

  // S3 哨兵余量：smoke 的 Top1 断言之外，另锁分差，使余量侵蚀可被提前发现。
  // 次名参照节点随阶段5.3 id 大迁移由 dg22-03-04 更名为 dg22-02-04，参照对象未变、仅 id 更新。
  const r = SEARCH.search(kb, index, { query: '等同侵权', limit: 3 });
  const a = r.find((x) => x.id === 'infr-02-03');
  const b = r.find((x) => x.id === 'dg22-02-04');
  ok('S3', '哨兵「等同侵权」infr-02-03 居首且对次名余量为 100',
    r[0] && r[0].id === 'infr-02-03' && a && b && Math.round(a.score - b.score) === 100,
    a && b ? `${Math.round(a.score)} vs ${Math.round(b.score)}，余量 ${Math.round(a.score - b.score)}` : '节点缺失');

  // S4 英文短语（阶段 0 成果）不得被后续改动破坏
  const en = [['Animal Cell Lysis Solution', 'chem-01-04-06'], ['one-way ANOVA', 'chem-01-04-06']];
  for (const [q, want2] of en) {
    ok('S4', `「${q}」命中 ${want2}`, ids(q).includes(want2), ids(q).join('、') || '无结果');
  }
  ok('S4', '库中不存在的词返回空而非噪音', ids('量子纠缠区块链').length === 0);
}

// ============ 汇总 ============
console.log('\n' + '─'.repeat(78));
if (warnings.length) {
  console.log(`已知残留 ${warnings.length} 项（不计失败）：`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
if (failures.length) {
  console.error(`用例失败：${failures.length} 项未通过（通过 ${passed} 项）`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`全部 ${passed} 项用例通过${warnings.length ? `（另有 ${warnings.length} 项已知残留）` : ''}`);
