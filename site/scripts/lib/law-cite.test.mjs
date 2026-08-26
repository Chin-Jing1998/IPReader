// law-cite.test.mjs —— 法条引用抽取（注册表引擎）单测
// 跑法（仓根执行）：
//   node --test site/scripts/lib/law-cite.test.mjs          # 单文件
//   node --test site/scripts/lib/*.test.mjs                 # 与 rich-text.test.mjs 一并跑
//   （node v22 起目录形参 `--test site/scripts/lib/` 会被当作模块解析并报 MODULE_NOT_FOUND，请用上面的写法）
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  extractCitations,
  extractLawKeys,
  extractLaws,
  createCiteStats,
  buildLawRegistry,
  normLawText,
  LAW_REGISTRY,
  LAW_RE,
} from './law-cite.mjs';
import { KNOWN_DOMAINS } from './domains.mjs';

// ---- 测试助手 ----
const keysOf = (text, domain = 'examination-guideline') => extractLawKeys(text, domain);
const citesOf = (text, domain = 'examination-guideline') =>
  extractCitations(text, domain).map((c) => c.fullCite);
/** 命中的第一条 lawKey（无命中返回 null） */
const firstKey = (text, domain = 'examination-guideline') => keysOf(text, domain)[0] ?? null;
/** 剥掉法名的三种书写形态：《》包裹 / 〈〉包裹 / 无任何括号 */
function writings(lawName) {
  const bare = lawName.replace(/[《》〈〉（）()]/g, '');
  const inner = lawName.replace(/《/g, '〈').replace(/》/g, '〉');
  return { book: `《${inner}》`, angle: `〈${inner}〉`, bare };
}

describe('注册表派生', () => {
  test('别名池 = 70 全称 + 1 显式 lawAlias + 1 遗留别名 = 72 项，按归一长度降序', () => {
    const kinds = LAW_REGISTRY.entries.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {});

    assert.equal(kinds.full, KNOWN_DOMAINS.filter((d) => d.lawName).length);
    assert.deepEqual(kinds, { full: 70, alias: 1, legacy: 1 });
    assert.equal(LAW_REGISTRY.entries.length, 72);
    // 降序：相邻两项归一长度非递增
    for (let i = 1; i < LAW_REGISTRY.entries.length; i++) {
      assert.ok(
        LAW_REGISTRY.entries[i - 1].norm.length >= LAW_REGISTRY.entries[i].norm.length,
        `第 ${i} 项破坏了长度降序`,
      );
    }
  });

  test('显式 lawAlias 登记：copyright-civil-interp 的「著作权解释」在池内且可命中', () => {
    assert.equal(LAW_REGISTRY.byAlias.get('著作权解释').kind, 'alias');
    assert.ok(!LAW_REGISTRY.byAlias.has('著作权')); // 「著作权」若入池会与「著作权法」抢后缀
    assert.deepEqual(
      extractLawKeys('依照著作权解释第八条', 'examination-guideline'),
      ['最高人民法院关于审理著作权民事纠纷案件适用法律若干问题的解释第8条'],
    );
  });

  test('domains.mjs 的 short 一律不入正文注册表（自造 4 字标签在正文里是常用词组）', () => {
    for (const a of ['驰名商标', '地理标志', '行政裁决', '商业秘密', '优先审查', '专利代理', '证据规定']) {
      assert.equal(LAW_REGISTRY.byAlias.has(a), false, `简称「${a}」不应入池`);
    }
    // 唯一例外是遗留别名「实施细则」，它以 legacy 身份单独登记
    assert.equal(LAW_REGISTRY.byAlias.get('实施细则').kind, 'legacy');
  });

  test('简称退池后的两处存量误命中消失（tmeg-07-01 并列条号句）', () => {
    // 原文枚举的是《商标法》各条，简称「驰名商标」「地理标志」曾把并列条号吸成他法引用
    const t1 = '《商标法》第十三条规定的他人的驰名商标，第十五条规定的被代理人、被代表人商标';
    assert.deepEqual(keysOf(t1, 'trademark-exam-guide-2021'), ['商标法第13条']);
    const t2 = '第十六条第一款规定的他人的地理标志，第三十条规定的他人已经注册的商标';
    assert.deepEqual(keysOf(t2, 'trademark-exam-guide-2021'), []);
  });

  test('归一两侧同尺：书名号、括号序号、分隔标点一律剥离', () => {
    assert.equal(normLawText('《商标法》'), '商标法');
    assert.equal(normLawText('最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）'),
      '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释二');
    assert.equal(normLawText('最高人民法院、最高人民检察院关于办理侵犯知识产权刑事案件适用法律若干问题的解释'),
      '最高人民法院最高人民检察院关于办理侵犯知识产权刑事案件适用法律若干问题的解释');
  });

  test('无 lawName 的域不入注册表（审查指南/裁判要旨等）', () => {
    assert.equal(LAW_REGISTRY.lawNameByDomain.has('examination-guideline'), false);
    assert.equal(LAW_REGISTRY.lawNameByDomain.has('ipc-digest-2023'), false);
    assert.equal(LAW_REGISTRY.lawNameByDomain.get('trademark-law-2026'), '商标法');
  });
});

describe('① 自带书名号/括号序号的长法名，三种书写形态均命中', () => {
  const LONG_NAMES = [
    '最高人民法院关于适用《中华人民共和国反不正当竞争法》若干问题的解释',
    '海关关于《中华人民共和国知识产权海关保护条例》的实施办法',
    '最高人民法院关于审理专利授权确权行政案件适用法律若干问题的规定（一）',
    '最高人民法院关于审理侵害植物新品种权纠纷案件具体应用法律问题的若干规定（二）',
    '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）',
  ];

  test('5 个长法名确实登记在注册表中（用例基准取自 domains.mjs 实际 lawName）', () => {
    for (const ln of LONG_NAMES) assert.ok(LAW_REGISTRY.byAlias.has(ln), `注册表缺 ${ln}`);
  });

  for (const ln of LONG_NAMES) {
    test(`《》/〈〉/无括号：${ln.slice(0, 14)}…`, () => {
      const w = writings(ln);
      for (const [form, name] of Object.entries(w)) {
        assert.equal(firstKey(`依照${name}第五条的规定`), `${ln}第5条`, `${form} 写法未命中`);
      }
    });
  }

  test('长法名前缀「中华人民共和国」等不影响后缀命中', () => {
    assert.equal(
      firstKey('参见中华人民共和国海关关于《中华人民共和国知识产权海关保护条例》的实施办法第五条'),
      '海关关于《中华人民共和国知识产权海关保护条例》的实施办法第5条',
    );
    assert.equal(firstKey('《中华人民共和国商标法》第八条'), '商标法第8条');
    assert.equal(firstKey('《中华人民共和国著作权法实施条例》第五条'), '著作权法实施条例第5条');
  });
});

describe('② 子串包含：长名优先（后缀匹配 + 归一长度降序）', () => {
  // 从注册表实测派生包含对，避免用例与注册表脱节。
  const containment = [];
  for (const a of LAW_REGISTRY.entries)
    for (const b of LAW_REGISTRY.entries)
      if (a !== b && a.norm.length > b.norm.length && a.norm.includes(b.norm))
        containment.push({ short: b, long: a });

  test('包含对规模符合实测：全别名池 11 对，其中全称⊂全称 9 对', () => {
    const fullPairs = containment.filter((p) => p.short.kind === 'full' && p.long.kind === 'full');
    assert.equal(containment.length, 11);
    assert.equal(fullPairs.length, 9);
  });

  test('逐对验证：写长名时命中长名所属法，短名不得抢占', () => {
    for (const { short, long } of containment) {
      const got = firstKey(`依照${long.alias}第五条`);
      assert.equal(got, `${long.lawName}第5条`, `「${long.alias}」被「${short.alias}」抢占`);
    }
  });

  test('11 对关键包含（专利法系/商标系/著作权系）逐条点名', () => {
    assert.equal(firstKey('专利法第二十二条'), '专利法第22条');
    assert.equal(firstKey('专利法实施细则第五十七条'), '专利法实施细则第57条');
    assert.equal(firstKey('商标法第八条'), '商标法第8条');
    assert.equal(firstKey('商标法实施条例第五条'), '商标法实施条例第5条');
    assert.equal(firstKey('著作权法第十条'), '著作权法第10条');
    assert.equal(firstKey('著作权法实施条例第五条'), '著作权法实施条例第5条');
    assert.equal(firstKey('集成电路布图设计保护条例第五条'), '集成电路布图设计保护条例第5条');
    assert.equal(firstKey('集成电路布图设计保护条例实施细则第五条'), '集成电路布图设计保护条例实施细则第5条');
    assert.equal(firstKey('反不正当竞争法第九条'), '反不正当竞争法第9条');
    assert.equal(
      firstKey('最高人民法院关于适用《中华人民共和国反不正当竞争法》若干问题的解释第九条'),
      '最高人民法院关于适用《中华人民共和国反不正当竞争法》若干问题的解释第9条',
    );
    assert.equal(
      firstKey('知识产权海关保护条例第五条'),
      '知识产权海关保护条例第5条',
    );
  });
});

describe('③ 插入语：括号夹注不阻断法名与条号', () => {
  test('《中华人民共和国专利法》（以下简称专利法）第三十四条', () => {
    const text = '根据《中华人民共和国专利法》（以下简称专利法）第三十四条的规定，专利局收到发明专利申请后';
    assert.deepEqual(keysOf(text, '01'), ['专利法第34条']);
  });

  test('括号内起点的命中，raw 截到右括号之后（不残留半截插入语）', () => {
    const text = '根据《中华人民共和国专利法》（以下简称专利法）第三十四条的规定';
    const trace = [];
    extractCitations(text, 'examination-guideline', { trace });
    assert.equal(trace.length, 1);
    assert.equal(trace[0].raw, '第三十四条');
  });

  test('书名号包裹的命中，raw 外扩至左书名号（不残留半截书名号）', () => {
    const text = '依照《中华人民共和国商标法》第八条的规定';
    const trace = [];
    extractCitations(text, 'examination-guideline', { trace });
    assert.equal(trace[0].raw, '《中华人民共和国商标法》第八条');
  });

  test('年份/版本号尾缀不阻断（商标法（2013）第五条）', () => {
    assert.equal(firstKey('依照商标法（2013）第五条'), '商标法第5条');
  });
});

describe('④ 枚举续接：法名只出现一次，后续条目归于同一法名', () => {
  test('第X条、第Y条', () => {
    assert.deepEqual(keysOf('违反商标法第十条、第十一条的规定'), ['商标法第10条', '商标法第11条']);
  });

  test('顿号/和/及/以及/或者 五类分隔符', () => {
    assert.deepEqual(keysOf('专利法第二条、第三条和第四条及第五条以及第六条或者第七条'), [
      '专利法第2条', '专利法第3条', '专利法第4条', '专利法第5条', '专利法第6条', '专利法第7条',
    ]);
  });

  test('款/项级续接挂靠链内最近落定的条号', () => {
    assert.deepEqual(citesOf('专利法第二十二条第二款、第三款'), ['专利法第22条第2款', '专利法第22条第3款']);
    // 款/项序号在 fullCite 中一律归一为阿拉伯数字（与既有 law-citations.json 产物同形）
    assert.deepEqual(citesOf('专利法实施细则第五十三条第（一）项或者第（二）项'), [
      '专利法实施细则第53条第（1）项',
      '专利法实施细则第53条第（2）项',
    ]);
  });

  test('续接命中的 raw 以分隔符开头（build-quartz-md 据此把分隔符留在链接外）', () => {
    const text = '违反商标法第十条、第十一条的规定';
    const trace = [];
    extractCitations(text, 'examination-guideline', { trace });
    assert.equal(trace[0].raw, '商标法第十条');
    assert.equal(trace[1].raw, '、第十一条');
  });
});

describe('⑤ 范围展开：第X条至第Y条', () => {
  test('中文数字范围逐条展开', () => {
    assert.deepEqual(keysOf('不符合专利法实施细则第十九条至第二十二条的规定'), [
      '专利法实施细则第19条', '专利法实施细则第20条', '专利法实施细则第21条', '专利法实施细则第22条',
    ]);
  });

  test('阿拉伯数字与一字线/波浪线变体同样展开', () => {
    assert.deepEqual(keysOf('商标法第10条至第12条'), ['商标法第10条', '商标法第11条', '商标法第12条']);
    assert.deepEqual(keysOf('商标法第10条—第12条'), ['商标法第10条', '商标法第11条', '商标法第12条']);
    assert.deepEqual(keysOf('商标法第10条～第12条'), ['商标法第10条', '商标法第11条', '商标法第12条']);
  });

  test('范围与枚举混排：专利法第2条、第3条、第19条至第26条', () => {
    const got = keysOf('专利法第2条、第3条、第19条至第26条');
    assert.equal(got.length, 10);
    assert.equal(got[0], '专利法第2条');
    assert.equal(got.at(-1), '专利法第26条');
  });

  test('跨度超过 MAX_RANGE_SPAN（60）时只记首尾，不整段展开', () => {
    assert.deepEqual(keysOf('专利法第1条至第200条'), ['专利法第1条', '专利法第200条']);
  });
});

describe('⑥ 域外法负例：一律不产出（不再静默回落专利法）', () => {
  const OUT_OF_SCOPE = [
    '构成犯罪的，依照刑法第二百一十三条追究刑事责任',
    '当事人应当依照民法典第一百七十九条承担民事责任',
    '申请人可以根据专利合作条约第19条对权利要求书提出修改',
    '按照商标国际注册马德里协定有关议定书第九条办理',
    '依照民事诉讼法第六十四条的规定',
    '依照《中华人民共和国行政诉讼法》第七十条',
    '依照巴黎公约第四条主张优先权',
  ];
  for (const t of OUT_OF_SCOPE) {
    test(`不命中：${t.slice(0, 18)}…`, () => {
      assert.deepEqual(keysOf(t), []);
    });
  }
});

describe('⑦ 章节 xref 不算法条引用', () => {
  test('本指南第二部分第五章：无「第N条」锚点，零产出', () => {
    assert.deepEqual(keysOf('参见本指南第二部分第五章第 3 节'), []);
  });

  test('本指南 + 第N条：不解析（本指南刻意不入自指代词表）', () => {
    assert.deepEqual(keysOf('本指南第五条', 'examination-guideline'), []);
    // 即便所在域设有 lawName，「本指南」仍不解析
    assert.deepEqual(keysOf('本指南第五条', 'patent-law'), []);
  });
});

describe('⑧ 域内自指代：本X → 所在域 lawName', () => {
  test('trademark-law-2026 域内「本法第十条」→ 商标法第10条', () => {
    assert.deepEqual(keysOf('已经注册的商标，违反本法第十条规定的', 'trademark-law-2026'), ['商标法第10条']);
  });

  test('ic-layout-rules-2001 域内「本细则第五条」→ 集成电路布图设计保护条例实施细则第5条', () => {
    assert.deepEqual(keysOf('依照本细则第五条办理', 'ic-layout-rules-2001'), [
      '集成电路布图设计保护条例实施细则第5条',
    ]);
  });

  test('patent-law / implementation-rules 沿用旧口径', () => {
    assert.deepEqual(keysOf('依照本法第二十二条', 'patent-law'), ['专利法第22条']);
    assert.deepEqual(keysOf('依照本细则第五十三条', 'implementation-rules'), ['专利法实施细则第53条']);
  });

  test('11 个自指代词逐个可解析（以 anti-monopoly-law-2022 / 反垄断法 为宿主域验证词表本身）', () => {
    for (const tok of ['本法', '本条例', '本办法', '本细则', '本规定', '本规则', '本解释', '本标准', '本规程', '本纲要', '本指引']) {
      assert.deepEqual(keysOf(`依照${tok}第五条`, 'anti-monopoly-law-2022'), ['反垄断法第5条'], `${tok} 未解析`);
    }
  });

  test('域无 lawName 时自指代不解析（商标审查审理指南引述商标法原文的「本法」）', () => {
    assert.deepEqual(keysOf('当事人依照本法第十三条请求驰名商标保护', 'trademark-exam-guide-2021'), []);
    assert.deepEqual(keysOf('依照本条例第十三条', 'examination-guideline'), []);
  });

  test('自指代让位于具名法名（同一句里写明法名时按法名走）', () => {
    assert.deepEqual(keysOf('依照专利法第二十二条', 'trademark-law-2026'), ['专利法第22条']);
  });
});

describe('⑨ 裸「实施细则」的历史兼容', () => {
  test('实施细则第五十三条 → 专利法实施细则第53条', () => {
    assert.deepEqual(keysOf('申请的修改不符合实施细则第五十三条的规定'), ['专利法实施细则第53条']);
  });

  test('以 legacy 身份单独登记（short 退池后由遗留别名承接）', () => {
    const e = LAW_REGISTRY.byAlias.get('实施细则');
    assert.equal(e.kind, 'legacy');
    assert.equal(e.lawName, '专利法实施细则');
    assert.equal(e.domain, 'implementation-rules');
  });

  test('条约防护：条约/议定书/公约 + 实施细则 一律不回落专利法实施细则', () => {
    assert.deepEqual(keysOf('不符合专利合作条约实施细则第46条的规定'), []);
    assert.deepEqual(keysOf('不属于专利合作条约实施细则第39条规定所排除的内容'), []);
    assert.deepEqual(keysOf('适用《商标国际注册马德里协定有关议定书实施细则》第二十二条'), []);
    assert.deepEqual(keysOf('依照某某公约实施细则第五条'), []);
  });

  test('条约防护不误伤：正常的裸实施细则与全称实施细则照常命中', () => {
    assert.deepEqual(keysOf('申请的修改是否符合专利法第三十三条及实施细则第五十七条的规定'), [
      '专利法第33条', '专利法实施细则第57条',
    ]);
    assert.deepEqual(keysOf('集成电路布图设计保护条例实施细则第五条'), ['集成电路布图设计保护条例实施细则第5条']);
  });

  test('mcp 检索侧的「细则」「则」「法」三条查询期简写不在正文侧登记', () => {
    for (const a of ['细则', '则', '法']) assert.equal(LAW_REGISTRY.byAlias.has(a), false);
    assert.deepEqual(keysOf('依照细则第五条'), []);
    assert.deepEqual(keysOf('违反原则第五条'), []);
  });
});

describe('⑩ 泛化词负例：不得命中任何法', () => {
  const NEGATIVES = [
    '依照有关规定第五条',
    '根据前款规定第三条',
    '按照上述办法第八条',
    '参照该解释第九条',
    '依照本条第二款、第三款',
    '第五条 商标注册申请人应当是依法成立的主体',
  ];
  for (const t of NEGATIVES) {
    test(`不命中：${t.slice(0, 16)}`, () => {
      assert.deepEqual(keysOf(t), []);
    });
  }

  test('句号是天然哨兵：跨句不成链', () => {
    assert.deepEqual(keysOf('该行为不适用商标法。第五条另有规定的除外'), []);
  });

  test('空行是段落边界：引用不跨段', () => {
    assert.deepEqual(keysOf('前段结尾提到商标法\n\n第五条 本段另起一段'), []);
    // 同段内的软换行仍可跨越（与 build-quartz-md 逐段成链的粒度一致）
    assert.deepEqual(keysOf('前段提到商标法\n第五条另有规定'), ['商标法第5条']);
  });
});

describe('消费方契约：返回记录与 trace 字段', () => {
  const TEXT = '不符合专利法第二十六条第三款、第四款及实施细则第二十条第一款的规定，参见商标法第八条';

  test('返回记录字段恒为 {lawKey, fullCite, count}', () => {
    const recs = extractCitations(TEXT, 'examination-guideline');
    assert.ok(recs.length > 0);
    for (const r of recs) {
      assert.deepEqual(Object.keys(r).sort(), ['count', 'fullCite', 'lawKey']);
      assert.equal(typeof r.lawKey, 'string');
      assert.equal(typeof r.fullCite, 'string');
      assert.ok(Number.isInteger(r.count) && r.count > 0);
      assert.ok(r.fullCite.startsWith(r.lawKey)); // lawKey 为 fullCite 的条级前缀
    }
  });

  test('同一 fullCite 按出现次数聚合', () => {
    const recs = extractCitations('专利法第二条规定……不符合专利法第二条的', 'examination-guideline');
    assert.deepEqual(recs, [{ lawKey: '专利法第2条', fullCite: '专利法第2条', count: 2 }]);
  });

  test('trace 字段恒为 {lawKey, fullCite, index, raw}，且 raw 是 text 自 index 起的原文连续片段', () => {
    const trace = [];
    extractCitations(TEXT, 'examination-guideline', { trace });
    assert.ok(trace.length > 0);
    for (const t of trace) {
      assert.deepEqual(Object.keys(t).sort(), ['fullCite', 'index', 'lawKey', 'raw']);
      assert.equal(TEXT.slice(t.index, t.index + t.raw.length), t.raw, `raw 与原文偏移不符：${t.raw}`);
    }
  });

  test('范围展开的多个 lawKey 共享同一 index（linkLawCites 据此取首条为链接目标）', () => {
    const text = '参见专利法第二十二条至第二十四条';
    const trace = [];
    extractCitations(text, 'examination-guideline', { trace });
    assert.equal(trace.length, 3);
    assert.equal(new Set(trace.map((t) => t.index)).size, 1);
    assert.equal(new Set(trace.map((t) => t.raw)).size, 1);
  });

  test('款/项级续接命中的 raw 不含「第N条」（linkLawCites 据此跳过、不单独成链）', () => {
    const trace = [];
    extractCitations('专利法第二十二条第二款、第三款', 'examination-guideline', { trace });
    assert.equal(trace.length, 2);
    assert.ok(/第.+条/.test(trace[0].raw));
    assert.ok(!/第.+条/.test(trace[1].raw));
  });

  test('extractLawKeys 返回按出现顺序去重的 lawKey 串数组（nodes.laws 形状）', () => {
    const keys = extractLawKeys(TEXT, 'examination-guideline');
    assert.deepEqual(keys, ['专利法第26条', '专利法实施细则第20条', '商标法第8条']);
    assert.equal(new Set(keys).size, keys.length);
    for (const k of keys) assert.equal(typeof k, 'string');
  });

  test('空文本/无命中时返回空数组，不抛异常', () => {
    assert.deepEqual(extractCitations('', 'patent-law'), []);
    assert.deepEqual(extractCitations(null, 'patent-law'), []);
    assert.deepEqual(extractLawKeys('本段没有任何法条引用', 'patent-law'), []);
  });

  test('currentDomain 缺省（不传）时仅具名可解析，自指代静默跳过', () => {
    assert.deepEqual(extractLawKeys('专利法第二条'), ['专利法第2条']);
    assert.deepEqual(extractLawKeys('本法第二条'), []);
  });
});

describe('命中统计', () => {
  test('具名/自指代/未解析三类计数与产出条目数', () => {
    const stats = createCiteStats();
    const text = '依照商标法第八条、第九条，参照本法第十条，另见刑法第二百一十三条';
    extractCitations(text, 'trademark-law-2026', { stats });

    assert.equal(stats.anchors, 3); // 第八条（含续接第九条）/ 第十条 / 第二百一十三条
    assert.equal(stats.named, 1);
    assert.equal(stats.selfRef, 1);
    assert.equal(stats.unresolved, 1);
    assert.deepEqual(stats.byAliasKind, { full: 1, alias: 0, legacy: 0 });
    assert.equal(stats.emitted, 3); // 商标法第8条/第9条 + 商标法第10条
  });

  test('统计可跨多次调用累加（全库干跑用法）', () => {
    const stats = createCiteStats();
    extractCitations('专利法第二条', 'patent-law', { stats });
    extractCitations('专利法第三条', 'patent-law', { stats });
    assert.equal(stats.anchors, 2);
    assert.equal(stats.named, 2);
  });

  test('未解析锚点可回收（options.unresolved），供排查漏法', () => {
    const unresolved = [];
    extractCitations('依照刑法第二百一十三条', 'examination-guideline', { unresolved });
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].raw, '第二百一十三条');
    assert.ok(unresolved[0].left.endsWith('刑法'));
  });
});

describe('条号解析能力（波B 前既有能力全部保留）', () => {
  test('中文数字含百位', () => {
    assert.deepEqual(keysOf('专利法实施细则第一百四十九条'), ['专利法实施细则第149条']);
  });

  test('阿拉伯数字与中文数字等价', () => {
    assert.deepEqual(keysOf('专利法第22条'), keysOf('专利法第二十二条'));
  });

  test('之N 后缀并入 lawKey', () => {
    assert.deepEqual(keysOf('专利法第五条之二'), ['专利法第5条之2']);
  });

  test('款/项组装 fullCite，lawKey 归并到条级', () => {
    const recs = extractCitations('专利法第二十二条第三款', 'examination-guideline');
    assert.deepEqual(recs, [{ lawKey: '专利法第22条', fullCite: '专利法第22条第3款', count: 1 }]);
    const recs2 = extractCitations('专利法实施细则第五十三条第（三）项', 'examination-guideline');
    assert.deepEqual(recs2, [{
      lawKey: '专利法实施细则第53条',
      fullCite: '专利法实施细则第53条第（3）项',
      count: 1,
    }]);
  });

  test('cn2num 不支持的字（〇/两）安全跳过，不产出坏键', () => {
    assert.deepEqual(keysOf('专利法第两条'), []);
  });
});

describe('注册表可注入（buildLawRegistry）', () => {
  test('自定义域表可独立驱动引擎，不受默认注册表影响', () => {
    const registry = buildLawRegistry([
      { key: 'demo-law', lawName: '演示法', short: '演示' },
      { key: 'demo-rules', lawName: '演示法实施条例', short: '演示条例' },
    ]);
    // short 不入池；域表内无 implementation-rules，遗留别名亦不登记 → 仅两条全称
    assert.equal(registry.entries.length, 2);
    assert.deepEqual(registry.entries.map((e) => e.alias), ['演示法实施条例', '演示法']);
    assert.deepEqual(extractCitations('依照演示第五条', 'x', { registry }), []);
    assert.deepEqual(extractCitations('依照实施细则第五条', 'x', { registry }), []);
    assert.equal(
      extractCitations('依照演示法实施条例第五条', 'x', { registry })[0].lawKey,
      '演示法实施条例第5条',
    );
    assert.equal(extractCitations('依照演示法第五条', 'x', { registry })[0].lawKey, '演示法第5条');
    // 默认注册表里的法在自定义注册表下不认识
    assert.deepEqual(extractCitations('依照商标法第五条', 'x', { registry }), []);
  });
});

describe('沿用版 extractLaws（文档化遗留，行为冻结）', () => {
  test('仍只认专利法 / 专利法实施细则 / 裸实施细则三名', () => {
    assert.deepEqual(extractLaws('专利法第二十二条与实施细则第五十三条'), [
      '专利法第22条',
      '专利法实施细则第53条',
    ]);
    assert.deepEqual(extractLaws('商标法第八条'), []);
  });

  test('LAW_RE 仍作为导出符号存在（回滚与历史口径比对用）', () => {
    assert.ok(LAW_RE instanceof RegExp);
    assert.ok(LAW_RE.global);
  });

  test('新引擎是旧引擎在两法名上的超集', () => {
    const text = '不符合专利法第二十六条第三款、专利法实施细则第二十条以及实施细则第五十三条的规定';
    const oldKeys = extractLaws(text);
    const newKeys = new Set(extractLawKeys(text, 'examination-guideline'));
    for (const k of oldKeys) assert.ok(newKeys.has(k), `新引擎丢失旧命中 ${k}`);
  });
});
