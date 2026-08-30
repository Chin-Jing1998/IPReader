// book-efficacy.test.mjs —— 书根「效力信息」小节渲染单测（阶段5.3 批次 W8）
// 跑法：
//   断言：node --test site/scripts/lib/book-efficacy.test.mjs
//   看产出：node site/scripts/lib/book-efficacy.test.mjs --print   （打印五例完整 md，不跑断言）
// 数据：直接读 site/data/book-meta.json 真实条目，不造样本——本节的铁律就是「逐字落语料」。
//
// ⚠ renderProse 的两步（mdParagraphs 段落化、linkLawCites force 档法条内链化）在本文件内是
//   build-quartz-md.mjs 同名逻辑的**镜像副本**：该生成器为顶层副作用脚本（import 即跑全量并落盘），
//   无法在单测中安全 import，故此处按其源码逐行复刻，用于验证「内链替换生效形态」。
//   生产路径的真身覆盖由 C1 全量重跑 + 死链断言兜底；改动 build-quartz-md.mjs 的
//   mdParagraphs / linkLawCites 时须同步本文件的镜像。
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { extractCitations } from './law-cite.mjs';
import { efficacySection, efficacyRows } from './book-efficacy.mjs';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const bookMeta = JSON.parse(readFileSync(join(DATA_DIR, 'book-meta.json'), 'utf8'));
const nodes = JSON.parse(readFileSync(join(DATA_DIR, 'nodes.json'), 'utf8'));
const lawKeyToNode = new Map();
for (const n of nodes) if (n.lawKey) lawKeyToNode.set(n.lawKey, n.id);

// ---- 镜像 1：build-quartz-md.mjs 的 escapeMd + mdParagraphs ----
const escapeMd = (s) => String(s).replace(/</g, '\\<').replace(/#/g, '\\#');
const mdParagraphs = (text) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.split('\n').map((line) => line.replace(/^>/, '\\>')).join('  \n'))
    .map((p) => escapeMd(p))
    .filter((p) => p.trim());

// ---- 镜像 2：build-quartz-md.mjs 的 linkLawCites（force: true 档，即 allowAllLaws 恒真）----
function linkLawCitesForced(para, domain) {
  const trace = [];
  extractCitations(para, domain, { trace });
  if (!trace.length) return para;
  const hits = new Map();
  for (const t of trace) if (!hits.has(t.index)) hits.set(t.index, t);
  const applied = [];
  for (const h of [...hits.values()].sort((a, b) => b.index - a.index)) {
    if (!/第.+条/.test(h.raw)) continue;
    const target = lawKeyToNode.get(h.lawKey);
    if (!target) continue;
    applied.push({ ...h, target });
  }
  applied.sort((a, b) => a.index - b.index);
  const linked = new Set();
  const chosen = [];
  for (const h of applied) {
    if (linked.has(h.lawKey)) continue;
    linked.add(h.lawKey);
    chosen.push(h);
  }
  chosen.sort((a, b) => b.index - a.index);
  let out = para;
  for (const h of chosen) {
    const sep = (h.raw.match(/^(以及|或者|、|和|及|或)/) || [''])[0];
    const body = h.raw.slice(sep.length);
    out = out.slice(0, h.index) + sep + `[[${h.target}|${body}]]` + out.slice(h.index + h.raw.length);
  }
  return out;
}

const renderOf = (domain) => ({
  renderProse: (p) => linkLawCitesForced(mdParagraphs(p).join('\n\n'), domain),
});
const render = (domain) => efficacySection(bookMeta[domain], renderOf(domain));

/** 逆变换：还原成原始语料形态（去 wikilink、去硬换行、去最小转义），供逐字比对 */
const unrender = (md) =>
  md
    .replace(/\[\[[^\]|]+\|([^\]]*)\]\]/g, '$1')
    .replace(/ {2}\n/g, '\n')
    .replace(/^\\>/gm, '>')
    .replace(/\\</g, '<')
    .replace(/\\#/g, '#');

/** 断言原文逐字落页：产出中的原文段落集合与语料段落集合完全一致 */
function assertVerbatim(md, domain) {
  const src = String(bookMeta[domain].promulgationText || '');
  const srcParas = src.split(/\n{2,}/).filter((p) => p.trim());
  const body = md.slice(md.indexOf('### 公布与施行原文') + '### 公布与施行原文\n\n'.length);
  const outParas = unrender(body).split(/\n{2,}/).filter((p) => p.trim());
  assert.deepEqual(outParas, srcParas, `${domain} 公布与施行原文未逐字落页`);
}

const SAMPLES = [
  ['copyright-law-rules-2013', '字段全 + 原文 504 字（含「著作权法第四十八条」跨法引用）'],
  ['patent-enforcement-2015', '原文 1585 字修改决定'],
  ['patent-adjudication-manual-2019', 'DROP 域：有字段、原文被上游裁决丢弃'],
  ['patent-law', '无「公布与施行」域，且元数据字段全空'],
];

if (process.argv.includes('--print')) {
  for (const [domain, note] of SAMPLES) {
    const md = render(domain);
    console.log(`\n${'='.repeat(78)}\n■ ${domain} —— ${note}\n${'='.repeat(78)}`);
    console.log(md === '' ? '（整节不出：字段全空且无原文，efficacySection 返回空串）' : md);
  }
} else {
  describe('效力信息小节：字段行', () => {
    test('copyright-law-rules-2013：五行字段按序渲染，来源附采集日期', () => {
      const rows = efficacyRows(bookMeta['copyright-law-rules-2013']);

      assert.deepEqual(rows.map((r) => r.label), ['施行日期', '通过／公布日期', '发文字号', '效力状态', '来源']);
      assert.equal(rows[0].value, '2013年3月1日');
      assert.equal(rows[2].value, '国务院令第633号'); // documentNo 优先
      assert.equal(rows[4].value, 'https://ipr.mofcom.gov.cn/law/detail.shtml?id=1999（采集于 2026-08-18）');
      assert.ok(!rows.some((r) => r.label === '制定机关'), 'issuedBy 为空则不渲染该行');
    });

    // 阶段5.11 波O（2026-08-30）：本例原取 gb-standards-index（字段为「不适用（…）」
    // 自述），该书随 12 部书目归档下线已不在 book-meta 中，改取仍在册的
    // patent-adjudication-manual-2019——其 effectiveDate 同为「非规范日期的自述式
    // 括注文本」，且 sourceUrl 空、adoptedDate 空，与原例覆盖同样三项行为。
    // 全库复核：波O 后在册域已无以「不适用（…）」起首的字段，该形态改由括注自述承载；
    // 本例守的判据本就是「非日期文本原样落页、不造词不改写」，与「不适用」四字无关。
    test('patent-adjudication-manual-2019：自述式非日期字段原样渲染，sourceRef 兜底', () => {
      const md = render('patent-adjudication-manual-2019');

      assert.match(md, /- \*\*施行日期\*\*：2019年12月印发（办案指南性质文件，未见独立施行日期条款）/);
      assert.match(md, /- \*\*发文字号\*\*：国知发保字〔2019〕57号/);
      assert.match(md, /- \*\*来源\*\*：https:\/\/amr\.sz\.gov\.cn\//); // sourceUrl 空 → sourceRef
      assert.ok(!md.includes('通过／公布日期'), 'adoptedDate 为空则不渲染该行');
    });

    test('发文字号：documentNo 为空时回落 judicialInterpretationNo', () => {
      const jud = Object.values(bookMeta).find(
        (v) => !(v.documentNo || '').trim() && (v.judicialInterpretationNo || '').trim(),
      );
      const rows = efficacyRows(jud);

      assert.equal(rows.find((r) => r.label === '发文字号').value, jud.judicialInterpretationNo);
    });
  });

  describe('效力信息小节：整节出/不出', () => {
    test('patent-law：字段全空且无原文 → 整节不出（空串）', () => {
      assert.equal(render('patent-law'), '');
    });

    test('patent-adjudication-manual-2019（DROP 域）：出字段行、不出「### 公布与施行原文」', () => {
      const md = render('patent-adjudication-manual-2019');

      assert.match(md, /^## 效力信息\n/);
      assert.match(md, /- \*\*施行日期\*\*：2019年12月印发（办案指南性质文件，未见独立施行日期条款）/);
      assert.ok(!md.includes('### 公布与施行原文'), '原文为空串时不得出子节');
    });

    // 域数随入库规模变动：2026-08-30 阶段5.11 波O 归档下线 12 部书后，
    // 有「公布与施行」正文的域由 77 减至 66（下线的 12 部中 11 部本有该 H1，
    // 其中 gb-standards-index 属源 md 本无此标题的一类；口径与 parse-domains.mjs
    // 的 PROMULGATION_STRIPPED_EXPECTED=68 减去 PROMULGATION_DROP 的 2 域一致）。
    test('promulgationText 非空的 66 域全部产出原文子节，且逐字落页', () => {
      const keys = Object.entries(bookMeta)
        .filter(([, v]) => (v.promulgationText || '').trim())
        .map(([k]) => k);

      assert.equal(keys.length, 66);
      for (const k of keys) {
        const md = render(k);
        assert.ok(md.includes('### 公布与施行原文'), `${k} 缺原文子节`);
        assertVerbatim(md, k);
      }
    });
  });

  describe('效力信息小节：公布与施行原文的法条内链化（D2 全域授权）', () => {
    test('copyright-law-rules-2013：跨法引用「著作权法第四十八条」成链，且逐字可还原', () => {
      const md = render('copyright-law-rules-2013');

      assert.ok(md.includes('[[cpl-04-04-04|著作权法第四十八条]]'), '跨法引用未成链');
      assert.equal((md.match(/\[\[/g) || []).length, 1); // 全篇仅此 1 处可解析法名
      assertVerbatim(md, 'copyright-law-rules-2013');
    });

    test('同一条文一段内只链首次出现（段内去重口径与正文一致）', () => {
      // 语料实况：copyright-law-rules-2013 全篇「著作权法第四十八条」仅 1 处，
      // 段内去重口径无真实语料可验，改以合成段落经同一 renderProse 钩子验证。
      const { renderProse } = renderOf('copyright-law-rules-2013');

      const out = renderProse('依著作权法第四十八条处理；再次援引著作权法第四十八条时不重复成链。');

      assert.equal((out.match(/\[\[cpl-04-04-04\|/g) || []).length, 1);
      assert.equal((out.match(/著作权法第四十八条/g) || []).length, 2);
    });

    test('patent-enforcement-2015：无可解析法名的裸条号一律不成链', () => {
      const md = render('patent-enforcement-2015');

      assert.ok(md.includes('### 公布与施行原文'));
      assert.ok(!md.includes('[['), '「一、第一条改为…」等裸条号属本法自指以外的修改指令，不得成链');
      assertVerbatim(md, 'patent-enforcement-2015');
    });

    test('全库口径：77 段原文合计成链 2 处，法条目标齐备（无死链）', () => {
      let links = 0;
      for (const [k, v] of Object.entries(bookMeta)) {
        if (!(v.promulgationText || '').trim()) continue;
        for (const m of render(k).matchAll(/\[\[([^\]|]+)\|/g)) {
          links++;
          assert.ok(
            nodes.some((n) => n.id === m[1]),
            `${k} 的法条链接目标 ${m[1]} 不存在`,
          );
        }
      }
      assert.equal(links, 2); // copyright-law-rules-2013 跨法 1 处 + trademark-law-2026 本法自指 1 处
    });
  });
}
