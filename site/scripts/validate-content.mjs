// 校验 content/*.json：可解析、字段齐全、结构合法。
// public/content 下并存两套 schema，本脚本按类分流校验，不再以 doc schema 套 term 详情：
//   · doc  详情（6247 个）：17 个顶层字段，narrative/infographics/examples/related 等正文结构；
//   · term 详情（1035 个，term-NNNN.json）：9 个顶层字段，definition/occurrences/laws/relatedTerms。
// 两类均有「数据事实如此」的已知形态，按结构判据豁免并计数输出，不静默吞掉（见 EXEMPT_BASELINE）。
//
//   用法：node scripts/validate-content.mjs [id前缀] [选项]
//     [id前缀]          仅校验 id 以该前缀开头的文件，省略=全部
//     --dir=<路径>      指定内容目录（默认 ../public/content），供夹具测试用
//     --max=<n>         最多打印 n 条问题，默认 40
//     --list-exempt     打印豁免明细（默认仅打印分类计数）
//     --strict          把豁免项一并视为异常，用于人工复核数据形态
//     --refs/--no-refs  强制开/关跨文件引用检查（默认：扫描默认目录全量时开，取子集时关）
//   退出码：0=无真实异常；1=存在真实异常（豁免项不影响退出码，--strict 除外）
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 命令行解析 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { dir: '', max: 40, listExempt: false, strict: false, refs: null };
let prefix = '';
for (const a of argv) {
  if (a.startsWith('--dir=')) opts.dir = a.slice(6);
  else if (a.startsWith('--max=')) opts.max = Number(a.slice(6)) || 40;
  else if (a === '--list-exempt') opts.listExempt = true;
  else if (a === '--strict') opts.strict = true;
  else if (a === '--refs') opts.refs = true;
  else if (a === '--no-refs') opts.refs = false;
  else if (a.startsWith('--')) {
    console.error(`✗ 未知选项 ${a}`);
    process.exit(2);
  } else if (!prefix) prefix = a;
}
const DIR = opts.dir || join(__dirname, '..', 'public', 'content');
// 只有「默认目录 + 无前缀」才是全量视图：此时才能判定引用悬挂、才能与豁免基线比对。
const isFullScan = !prefix && !opts.dir;
const checkRefs = opts.refs === null ? isFullScan : opts.refs;

// ── 已知豁免形态的基线数（20260828 全量核验实测值） ──────────────────────────
// 豁免规模偏离基线时打印提示，提醒人工复核数据形态变化；提示本身不改变退出码。
const EXEMPT_BASELINE = {
  'doc.narrative-empty-own-text': 33, // 标题即全文的叶子节点，original（ownText）为空 → narrative 必空
  'term.definition-empty-seed': 147, // 词表 seed 词条且 df=0，提取产物无 role=defined 记录 → definition 回退为空串
};

// ── 取值域 ───────────────────────────────────────────────────────────────────
const DOC_FIELDS = [
  'id', 'level', 'domain', 'label', 'breadcrumb', 'partNum', 'sourceRef', 'brief',
  'narrative', 'infographics', 'examples', 'related', 'lawRefs', 'original', 'fidelity', 'shell',
];
const TERM_FIELDS = ['id', 'label', 'aliases', 'tier', 'df', 'definition', 'occurrences', 'laws', 'relatedTerms'];
const DOC_LEVELS = new Set(['part', 'chapter', 'section', 'subsection']);
const NARRATIVE_TYPES = new Set(['p', 'subhead']);
const TERM_TIERS = new Set(['seed', 'mid', 'high']);
const TERM_RELATIONS = new Set(['broader', 'narrower']);

const SPEC_TYPE = {
  steps: 'array', stat: 'array',
  table: 'object', compare: 'object', echarts: 'object',
  mermaid: 'string',
};
function specOk(kind, spec) {
  const t = SPEC_TYPE[kind];
  if (!t) return false;
  if (t === 'array') return Array.isArray(spec);
  if (t === 'string') return typeof spec === 'string' && spec.trim().length > 0;
  if (t === 'object') return spec && typeof spec === 'object' && !Array.isArray(spec);
  return false;
}

// ── 断言小工具 ───────────────────────────────────────────────────────────────
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// ── 校验状态 ─────────────────────────────────────────────────────────────────
const problems = [];
const exempt = []; // { id, rule, note }
const stats = {
  doc: { total: 0, pass: 0, fail: 0 },
  term: { total: 0, pass: 0, fail: 0 },
  unknown: { total: 0, pass: 0, fail: 0 },
  parseFail: 0,
  occTotal: 0,
  occWithEvidence: 0,
};
const idSet = new Set(); // 本次扫描到的全部 id，供跨文件引用检查

/** 记录豁免；--strict 下升级为问题。返回 true 表示已按豁免处理（调用方不再报问题）。 */
function markExempt(bag, id, rule, note) {
  if (opts.strict) {
    bag.push(`${id}: [strict] ${note}（正常运行时按 ${rule} 豁免）`);
    return false;
  }
  exempt.push({ id, rule, note });
  return true;
}

/** 按结构判类，不单纯依赖文件名，便于发现「文件名与内容不匹配」。 */
function classify(obj) {
  if (!isPlainObject(obj)) return 'unknown';
  if ('definition' in obj && 'occurrences' in obj) return 'term';
  if ('narrative' in obj && 'breadcrumb' in obj) return 'doc';
  return 'unknown';
}

// ── doc 详情校验 ─────────────────────────────────────────────────────────────
function validateDoc(id, doc, bag) {
  for (const k of DOC_FIELDS) if (!(k in doc)) bag.push(`${id}: doc 缺字段 ${k}`);

  if (doc.id !== id) bag.push(`${id}: id 字段「${doc.id}」与文件名不一致`);
  if (!isNonEmptyStr(doc.label)) bag.push(`${id}: label 为空`);
  if (!DOC_LEVELS.has(doc.level)) bag.push(`${id}: level 取值非法「${doc.level}」（应属 ${[...DOC_LEVELS].join('/')}）`);
  if (!isNonEmptyStr(doc.domain)) bag.push(`${id}: domain 为空`);

  if (!isStrArray(doc.breadcrumb)) bag.push(`${id}: breadcrumb 应为字符串数组`);
  else if (doc.breadcrumb.length === 0 && doc.level !== 'part') bag.push(`${id}: 非 part 级节点 breadcrumb 为空`);

  if (!Number.isInteger(doc.partNum) || doc.partNum < 0) bag.push(`${id}: partNum 应为非负整数，实为 ${JSON.stringify(doc.partNum)}`);
  if (typeof doc.original !== 'string') bag.push(`${id}: original 应为字符串`);
  if (typeof doc.brief !== 'string') bag.push(`${id}: brief 应为字符串`);
  if (typeof doc.shell !== 'boolean') bag.push(`${id}: shell 应为布尔值`);

  if (!isPlainObject(doc.sourceRef)) bag.push(`${id}: sourceRef 应为对象`);
  else {
    if (!Number.isInteger(doc.sourceRef.line) || doc.sourceRef.line < 0) bag.push(`${id}: sourceRef.line 应为非负整数`);
    if (!Number.isInteger(doc.sourceRef.chars) || doc.sourceRef.chars < 0) bag.push(`${id}: sourceRef.chars 应为非负整数`);
  }

  if (!isPlainObject(doc.fidelity)) bag.push(`${id}: fidelity 应为对象`);
  else if (typeof doc.fidelity.verified !== 'boolean') bag.push(`${id}: fidelity.verified 应为布尔值`);

  // narrative：正文段落。ownText（original）为空时 narrative 必空，属已知形态，豁免。
  if (!Array.isArray(doc.narrative)) {
    bag.push(`${id}: narrative 应为数组`);
  } else if (doc.narrative.length === 0) {
    const ownTextEmpty = typeof doc.original === 'string' && doc.original.trim().length === 0;
    if (!(ownTextEmpty && isNonEmptyStr(doc.label))) {
      bag.push(`${id}: narrative 空（original 长度 ${typeof doc.original === 'string' ? doc.original.length : '非串'}，非 ownText 为空所致）`);
    } else {
      markExempt(bag, id, 'doc.narrative-empty-own-text', 'narrative 空：该节点 ownText 为空，标题即全文');
    }
  } else {
    doc.narrative.forEach((n, i) => {
      if (!isPlainObject(n)) return bag.push(`${id}: narrative[${i}] 应为对象`);
      if (!NARRATIVE_TYPES.has(n.type)) bag.push(`${id}: narrative[${i}].type 非法「${n.type}」（应属 ${[...NARRATIVE_TYPES].join('/')}）`);
      if (!isNonEmptyStr(n.text)) bag.push(`${id}: narrative[${i}].text 为空`);
      if ('num' in n && typeof n.num !== 'string') bag.push(`${id}: narrative[${i}].num 应为字符串`);
    });
  }

  if (!Array.isArray(doc.infographics)) bag.push(`${id}: infographics 应为数组`);
  else for (const ig of doc.infographics) {
    if (!specOk(ig?.kind, ig?.spec)) bag.push(`${id}: 信息图 kind=${ig?.kind} 的 spec 类型不符（应为 ${SPEC_TYPE[ig?.kind] || '未知kind'}）`);
  }

  if (!Array.isArray(doc.examples)) bag.push(`${id}: examples 应为数组`);
  else doc.examples.forEach((e, i) => {
    if (!isPlainObject(e)) return bag.push(`${id}: examples[${i}] 应为对象`);
    if (!isNonEmptyStr(e.type)) bag.push(`${id}: examples[${i}].type 为空`);
    if (!isNonEmptyStr(e.title)) bag.push(`${id}: examples[${i}].title 为空`);
    if (!isNonEmptyStr(e.text)) bag.push(`${id}: examples[${i}].text 为空`);
  });

  if (!Array.isArray(doc.related)) bag.push(`${id}: related 应为数组`);
  else doc.related.forEach((r, i) => {
    if (!isPlainObject(r)) return bag.push(`${id}: related[${i}] 应为对象`);
    if (!isNonEmptyStr(r.id)) bag.push(`${id}: related[${i}].id 为空`);
    if (!isNonEmptyStr(r.label)) bag.push(`${id}: related[${i}].label 为空`);
    if (!Number.isInteger(r.part)) bag.push(`${id}: related[${i}].part 应为整数`);
    if (!isNonEmptyStr(r.reason)) bag.push(`${id}: related[${i}].reason 为空`);
  });

  if (!isStrArray(doc.lawRefs)) bag.push(`${id}: lawRefs 应为字符串数组`);
  else doc.lawRefs.forEach((l, i) => {
    if (!l.trim()) bag.push(`${id}: lawRefs[${i}] 为空串`);
  });
}

// ── term 详情校验 ────────────────────────────────────────────────────────────
function validateTerm(id, t, bag) {
  for (const k of TERM_FIELDS) if (!(k in t)) bag.push(`${id}: term 缺字段 ${k}`);

  if (t.id !== id) bag.push(`${id}: id 字段「${t.id}」与文件名不一致`);
  if (!/^term-\d+$/.test(id)) bag.push(`${id}: term 详情 id 应形如 term-NNNN`);
  if (!isNonEmptyStr(t.label)) bag.push(`${id}: label 为空`);
  if (!TERM_TIERS.has(t.tier)) bag.push(`${id}: tier 取值非法「${t.tier}」（应属 ${[...TERM_TIERS].join('/')}）`);
  if (!Number.isInteger(t.df) || t.df < 0) bag.push(`${id}: df 应为非负整数，实为 ${JSON.stringify(t.df)}`);

  if (!isStrArray(t.aliases)) bag.push(`${id}: aliases 应为字符串数组`);
  else t.aliases.forEach((a, i) => {
    if (!a.trim()) bag.push(`${id}: aliases[${i}] 为空串`);
  });

  // definition：定义处 evidence。seed 词条且 df=0 时生成器回退为空串，属已知形态，豁免。
  if (typeof t.definition !== 'string') {
    bag.push(`${id}: definition 应为字符串`);
  } else if (!t.definition.trim()) {
    if (t.tier === 'seed' && t.df === 0) {
      markExempt(bag, id, 'term.definition-empty-seed', 'definition 空：seed 词条且 df=0，无 role=defined 提取记录');
    } else {
      bag.push(`${id}: definition 空（tier=${t.tier}, df=${t.df}，非 seed/df=0 的已知形态）`);
    }
  }

  // occurrences：{ <domain>: [ { nodeId, nodeLabel, breadcrumb, evidence, fullCites } ] }
  if (!isPlainObject(t.occurrences)) {
    bag.push(`${id}: occurrences 应为对象`);
  } else {
    const groups = Object.entries(t.occurrences);
    if (groups.length === 0) bag.push(`${id}: occurrences 无任何出处分组`);
    for (const [dom, list] of groups) {
      if (!isNonEmptyStr(dom)) bag.push(`${id}: occurrences 存在空的域名键`);
      if (!Array.isArray(list) || list.length === 0) {
        bag.push(`${id}: occurrences.${dom} 应为非空数组`);
        continue;
      }
      list.forEach((o, i) => {
        const at = `${id}: occurrences.${dom}[${i}]`;
        if (!isPlainObject(o)) return bag.push(`${at} 应为对象`);
        if (!isNonEmptyStr(o.nodeId)) bag.push(`${at}.nodeId 为空`);
        if (!isNonEmptyStr(o.nodeLabel)) bag.push(`${at}.nodeLabel 为空`);
        if (!isStrArray(o.breadcrumb)) bag.push(`${at}.breadcrumb 应为字符串数组`);
        // evidence 允许为空串：生成器按覆盖率统计，缺证据属常态，仅计入统计不作断言。
        if (typeof o.evidence !== 'string') bag.push(`${at}.evidence 应为字符串`);
        else {
          stats.occTotal++;
          if (o.evidence.trim()) stats.occWithEvidence++;
        }
        if (!isStrArray(o.fullCites)) bag.push(`${at}.fullCites 应为字符串数组`);
      });
    }
  }

  if (!Array.isArray(t.laws)) bag.push(`${id}: laws 应为数组`);
  else t.laws.forEach((l, i) => {
    if (!isPlainObject(l)) return bag.push(`${id}: laws[${i}] 应为对象`);
    if (!isNonEmptyStr(l.lawKey)) bag.push(`${id}: laws[${i}].lawKey 为空`);
    if (!isNonEmptyStr(l.fullCite)) bag.push(`${id}: laws[${i}].fullCite 为空`);
    if (l.nodeId !== null && !isNonEmptyStr(l.nodeId)) bag.push(`${id}: laws[${i}].nodeId 应为节点 id 或 null`);
  });

  if (!Array.isArray(t.relatedTerms)) bag.push(`${id}: relatedTerms 应为数组`);
  else t.relatedTerms.forEach((r, i) => {
    if (!isPlainObject(r)) return bag.push(`${id}: relatedTerms[${i}] 应为对象`);
    if (!isNonEmptyStr(r.id)) bag.push(`${id}: relatedTerms[${i}].id 为空`);
    if (!isNonEmptyStr(r.label)) bag.push(`${id}: relatedTerms[${i}].label 为空`);
    if (!TERM_RELATIONS.has(r.relation)) bag.push(`${id}: relatedTerms[${i}].relation 非法「${r.relation}」（应属 ${[...TERM_RELATIONS].join('/')}）`);
  });
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
let files;
try {
  files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f.startsWith(prefix)).sort();
} catch (e) {
  console.error(`✗ 无法读取内容目录 ${DIR}：${e.message}`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`✗ 目录 ${DIR} 中没有匹配前缀「${prefix || '全部'}」的 .json 文件`);
  process.exit(2);
}

const parsed = []; // { id, kind, obj }
for (const f of files) {
  const id = f.replace(/\.json$/, '');
  let obj;
  try {
    obj = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
  } catch (e) {
    problems.push(`${id}: JSON 解析失败 ${e.message}`);
    stats.parseFail++;
    continue;
  }
  const kind = classify(obj);
  // 文件名前缀与结构判类交叉核对：term-*.json 必须是 term 结构，反之亦然。
  const byName = id.startsWith('term-') ? 'term' : 'doc';
  if (kind !== 'unknown' && kind !== byName) problems.push(`${id}: 文件名指向 ${byName} 详情，实际结构为 ${kind} 详情`);
  idSet.add(id);
  parsed.push({ id, kind, obj });
}

for (const { id, kind, obj } of parsed) {
  const bag = [];
  if (kind === 'term') validateTerm(id, obj, bag);
  else if (kind === 'doc') validateDoc(id, obj, bag);
  else bag.push(`${id}: 无法识别的详情类型（既非 doc 也非 term：顶层键 ${isPlainObject(obj) ? Object.keys(obj).join(',') || '空对象' : typeof obj}）`);

  const slot = stats[kind === 'unknown' ? 'unknown' : kind];
  slot.total++;
  if (bag.length) { slot.fail++; problems.push(...bag); } else slot.pass++;
}

// 跨文件引用检查：仅在扫描全量时执行，按前缀或 --dir 取子集会把正常引用误判为悬挂。
let dangling = 0;
if (checkRefs) {
  for (const { id, kind, obj } of parsed) {
    const refs = [];
    if (kind === 'doc') for (const r of obj.related || []) refs.push(['related', r?.id]);
    if (kind === 'term') {
      for (const list of Object.values(obj.occurrences || {})) {
        for (const o of Array.isArray(list) ? list : []) refs.push(['occurrences', o?.nodeId]);
      }
      for (const l of obj.laws || []) if (l?.nodeId) refs.push(['laws', l.nodeId]);
      for (const r of obj.relatedTerms || []) refs.push(['relatedTerms', r?.id]);
    }
    for (const [where, ref] of refs) {
      if (typeof ref === 'string' && ref && !idSet.has(ref)) {
        problems.push(`${id}: ${where} 引用的节点「${ref}」在 content/ 中不存在`);
        dangling++;
      }
    }
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
const exemptByRule = exempt.reduce((acc, e) => ((acc[e.rule] = (acc[e.rule] || 0) + 1), acc), {});
console.log(`扫描 ${files.length} 个文件（前缀「${prefix || '全部'}」，目录 ${DIR}）${opts.strict ? ' [strict]' : ''}`);
console.log(`  doc  详情：通过 ${stats.doc.pass} / ${stats.doc.total}${stats.doc.fail ? `，异常 ${stats.doc.fail}` : ''}`);
console.log(`  term 详情：通过 ${stats.term.pass} / ${stats.term.total}${stats.term.fail ? `，异常 ${stats.term.fail}` : ''}`);
if (stats.unknown.total) console.log(`  未识别类型：${stats.unknown.total} 个`);
if (stats.parseFail) console.log(`  JSON 解析失败：${stats.parseFail} 个`);
if (stats.occTotal) {
  const pct = ((stats.occWithEvidence / stats.occTotal) * 100).toFixed(1);
  console.log(`  term 出处 evidence 覆盖：${stats.occWithEvidence} / ${stats.occTotal}（${pct}%，空 evidence 为常态，不计异常）`);
}
console.log(checkRefs ? `  跨文件引用：悬挂 ${dangling} 处` : '  跨文件引用：未检查（子集扫描，用 --refs 强制开启）');

console.log(`豁免 ${exempt.length} 处（已知数据形态，不计异常）：`);
// --strict 下豁免被清空并计入异常，与基线比对无意义，故只在常规全量扫描时比对。
const compareBaseline = isFullScan && !opts.strict;
const ruleNames = compareBaseline
  ? new Set([...Object.keys(EXEMPT_BASELINE), ...Object.keys(exemptByRule)])
  : new Set(Object.keys(exemptByRule));
if (ruleNames.size === 0) console.log('  - 无');
for (const rule of ruleNames) {
  const n = exemptByRule[rule] || 0;
  const base = compareBaseline ? EXEMPT_BASELINE[rule] : undefined;
  let tail = '';
  if (base !== undefined && n !== base) tail = `  ⚠ 偏离基线 ${base}（${n > base ? '+' : ''}${n - base}），请复核数据形态变化`;
  console.log(`  - ${rule}: ${n}${base !== undefined ? `（基线 ${base}）` : ''}${tail}`);
}
if (opts.listExempt && exempt.length) {
  console.log('  豁免明细：');
  exempt.forEach((e) => console.log(`    · ${e.id} [${e.rule}] ${e.note}`));
}

if (problems.length) {
  console.log(`\n⚠ ${problems.length} 处真实异常：`);
  problems.slice(0, opts.max).forEach((p) => console.log('  - ' + p));
  if (problems.length > opts.max) console.log(`  …… 另有 ${problems.length - opts.max} 处，用 --max=<n> 查看更多`);
  process.exit(1);
} else {
  console.log('\n✓ 全部通过');
}
