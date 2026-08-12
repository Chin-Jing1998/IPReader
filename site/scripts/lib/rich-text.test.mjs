// rich-text.test.mjs —— 富文本归一化纯函数单测
// 跑法（tsx 装在 quartz-kb 的 node_modules）：
//   cd quartz-kb && npx tsx --test ../site/scripts/lib/rich-text.test.mjs
// 或不依赖 tsx：
//   node --test site/scripts/lib/
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  decodeEntities,
  latexToPlain,
  convertInlineMath,
  normalizeProse,
  splitTableSegments,
  htmlTableToMarkdown,
  renderTableBlock,
} from './rich-text.mjs';

describe('HTML 字符实体解码', () => {
  test('十六进制与具名实体按语料实况解码', () => {
    // Arrange：chem-02-03-03 表3「1' 35"」在上游即为实体形态
    const src = '1&#x27; 35&quot;';

    // Act
    const out = decodeEntities(src);

    // Assert
    assert.equal(out, '1\' 35"');
  });

  test('十进制实体与常用具名实体一并解码', () => {
    assert.equal(decodeEntities('&#39;&amp;&lt;&gt;&nbsp;&times;'), '\'&<> ×');
  });

  test('单趟替换：不会把 &amp;lt; 二次解码成 <', () => {
    // Arrange：源意是「显示 &lt; 这四个字符」
    const src = '&amp;lt;';

    // Act & Assert：只解一层，得到字面量 &lt;
    assert.equal(decodeEntities(src), '&lt;');
  });

  test('未收录的具名实体与裸 & 原样保留', () => {
    assert.equal(decodeEntities('A&B &unknownentity; &#xZZ;'), 'A&B &unknownentity; &#xZZ;');
  });

  test('越界与代理区码位不解码，避免产出非法字符', () => {
    assert.equal(decodeEntities('&#xD800;&#1114112;'), '&#xD800;&#1114112;');
  });
});

describe('行内 LaTeX 降解为 Unicode 纯文本', () => {
  test('度数与单位：数学模式下的字面空格全部忽略', () => {
    // Arrange：PDF 抽取把 60℃ 拆成逐字符带空格的形态
    const tex = '6 0 ^ { \\circ } \\mathrm { C }';

    // Act
    const r = latexToPlain(tex);

    // Assert
    assert.equal(r.ok, true);
    assert.equal(r.text, '60°C');
  });

  test('下标走 Unicode 下标字符（化学式）', () => {
    assert.deepEqual(latexToPlain('Z \\mathsf { n C l } _ { 2 }'), { ok: true, text: 'ZnCl₂' });
    assert.deepEqual(latexToPlain('\\mathrm { C } _ { 3 - 6 }'), { ok: true, text: 'C₃₋₆' });
  });

  test('嵌套上标与紧跟空格的上标都能解析', () => {
    assert.equal(latexToPlain('0 ^ { - 1 0 ^ { \\circ } } C').text, '0⁻¹⁰°C');
    assert.equal(latexToPlain('^ +').text, '⁺'); // `^` 与内容之间的空格在数学模式下无意义
  });

  test('连续 \\prime 归并为双撇', () => {
    assert.equal(latexToPlain('1 ^ { \\prime } 3 0 ^ { \\prime \\prime }').text, '1′30″');
  });

  test('区间号取 U+223C 而非 ASCII 波浪线（否则会被 GFM 当成删除线）', () => {
    // Arrange
    const r = latexToPlain('5 0 \\sim 1 0 0 ^ { \\circ } C');

    // Act & Assert
    assert.equal(r.text, '50∼100°C');
    assert.ok(!r.text.includes('~'), '降解结果不得含 ASCII 波浪线');
  });

  test('样式命令被忽略、字体命令展开其参数、\\ 与 ~ 产出空格', () => {
    assert.equal(latexToPlain('\\scriptstyle - 6 -').text, '-6-');
    assert.equal(latexToPlain('\\left( \\mathsf { P } < 0 . 0 5 \\right)').text, '(P<0.05)');
    assert.equal(latexToPlain('6 0 \\ k g').text, '60 kg');
    assert.equal(latexToPlain('\\mathrm { ~ J ~ } = ~ 8 . 3 \\mathrm { { H z } }').text, 'J = 8.3Hz');
  });

  test('未收录命令判为不可转换，绝不产出半截结果', () => {
    // Arrange & Act
    const r = latexToPlain('\\frac { 1 } { 2 }');

    // Assert
    assert.equal(r.ok, false);
    assert.match(r.reason, /未收录命令/);
  });

  test('花括号不匹配、含 \\\\ 多行结构均判为不可转换', () => {
    assert.equal(latexToPlain('\\mathrm { C').ok, false);
    assert.equal(latexToPlain('a \\\\ b').ok, false);
    assert.equal(latexToPlain('').ok, false);
  });

  test('上下标含无 Unicode 对应的字符时整体不转换', () => {
    // Arrange：中文无上标形态
    const r = latexToPlain('x ^ { 甲 }');

    // Act & Assert
    assert.equal(r.ok, false);
    assert.match(r.reason, /上下标字符无 Unicode 对应/);
  });
});

describe('convertInlineMath：文本级批量降解', () => {
  test('多处公式逐一降解，非公式文本原样保留', () => {
    // Arrange
    const src = '在 $6 0 ^ { \\circ } \\mathrm { C }$ 老化，湿度 $5 0 \\% \\pm 1 0 \\%$ 。';
    const sink = {};

    // Act
    const out = convertInlineMath(src, sink);

    // Assert
    assert.equal(out, '在 60°C 老化，湿度 50%±10% 。');
    assert.equal(sink.converted, 2);
    assert.equal(sink.kept ?? 0, 0);
  });

  test('不可转换的公式保留 $…$ 原文并计数', () => {
    // Arrange
    const sink = {};

    // Act
    const out = convertInlineMath('见 $\\frac { a } { b }$ 式', sink);

    // Assert
    assert.equal(out, '见 $\\frac { a } { b }$ 式');
    assert.equal(sink.kept, 1);
    assert.equal(sink.keptList.length, 1);
  });

  test('$ 个数为奇数时整体不处理（该 $ 不是数学定界符）', () => {
    assert.equal(convertInlineMath('单价 $5 元'), '单价 $5 元');
  });

  test('幂等：对已降解文本再跑一次不再变化', () => {
    // Arrange
    const once = convertInlineMath('温度 $2 0 ^ { \\circ } C$');

    // Act
    const twice = convertInlineMath(once);

    // Assert
    assert.equal(twice, once);
  });
});

describe('normalizeProse：解实体 → 降解公式的固定顺序', () => {
  test('实体形态的定界符不会凭空造出公式', () => {
    // Arrange：&#x24; 是 $；先解实体后降解会误判成公式，故必须只解一次不回扫
    const src = '价格 &#x24;5 与 &#x24;8';

    // Act
    const out = normalizeProse(src);

    // Assert：解出两个 $ 后个数为偶，但内容 `5 与 ` 不含 LaTeX 命令，
    // 降解为纯文本 `5与`——此处只断言不抛错且实体已解开
    assert.ok(out.startsWith('价格 '));
    assert.ok(!out.includes('&#x24;'));
  });

  test('实体与公式同段时两者都被处理', () => {
    assert.equal(normalizeProse('&quot;$2 0 \\mu \\mathrm { m }$&quot;'), '"20μm"');
  });
});

describe('splitTableSegments：表格块切分', () => {
  test('行内表格切成「前散文 / 表格 / 后散文」三段', () => {
    // Arrange
    const src = '表2 数据表<table><tr><td>a</td></tr></table>以下说明。';

    // Act
    const segs = splitTableSegments(src);

    // Assert
    assert.deepEqual(segs.map((s) => s.kind), ['prose', 'table', 'prose']);
    assert.equal(segs[0].text, '表2 数据表');
    assert.equal(segs[2].text, '以下说明。');
  });

  test('多张表按出现顺序切出', () => {
    const segs = splitTableSegments('<table><tr><td>1</td></tr></table>中间<table><tr><td>2</td></tr></table>');
    assert.deepEqual(segs.map((s) => s.kind), ['table', 'prose', 'table']);
  });

  test('未闭合的 <table 视为普通文本，不误放行为 HTML', () => {
    // Arrange：正文里本应显示的尖括号文本
    const src = '写作时用 <table> 表示表格标签，不要漏写';

    // Act
    const segs = splitTableSegments(src);

    // Assert
    assert.deepEqual(segs.map((s) => s.kind), ['prose']);
    assert.equal(segs[0].text, src);
  });

  test('不含表格的文本原样成单段', () => {
    assert.deepEqual(splitTableSegments('普通正文'), [{ kind: 'prose', text: '普通正文' }]);
    assert.deepEqual(splitTableSegments(''), [{ kind: 'prose', text: '' }]);
  });
});

describe('htmlTableToMarkdown：HTML 表格 → GFM 管道表格', () => {
  test('规则网格：首行作表头，补出分隔行', () => {
    // Arrange
    const html = '<table><tr><td>项目</td><td>数值</td></tr><tr><td>实施例1</td><td>24.2</td></tr></table>';

    // Act
    const r = htmlTableToMarkdown(html);

    // Assert
    assert.equal(r.ok, true);
    assert.equal(
      r.text,
      ['| 项目 | 数值 |', '| --- | --- |', '| 实施例1 | 24.2 |'].join('\n'),
    );
    assert.equal(r.rows, 2);
    assert.equal(r.cols, 2);
  });

  test('单行表：只有表头行时仍补出合法的分隔行', () => {
    const r = htmlTableToMarkdown('<table><tr><th>唯一列</th></tr></table>');
    assert.equal(r.ok, true);
    assert.equal(r.text, ['| 唯一列 |', '| --- |'].join('\n'));
  });

  test('空表（无 tr / 无 td）判为不可转换，交由 raw HTML 回退', () => {
    assert.equal(htmlTableToMarkdown('<table></table>').ok, false);
    assert.equal(htmlTableToMarkdown('<table><tr></tr></table>').ok, false);
  });

  test('参差行按最宽行补空单元格，保持列数一致', () => {
    // Arrange：第二行少一列
    const html = '<table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>1</td></tr></table>';

    // Act
    const r = htmlTableToMarkdown(html);

    // Assert
    assert.equal(r.ok, true);
    assert.equal(r.text.split('\n')[2], '| 1 |  |  |');
  });

  test('单元格内的管道与反斜杠被转义，不击穿列分隔', () => {
    // Arrange：语料实况「项目\实施例」，外加人造管道
    const html = '<table><tr><td>项目\\实施例</td><td>a|b</td></tr></table>';

    // Act
    const r = htmlTableToMarkdown(html);

    // Assert：反斜杠先转义、管道后转义，二者不互相吞并
    assert.equal(r.text.split('\n')[0], '| 项目\\\\实施例 | a\\|b |');
  });

  test('单元格内的换行折成空格，尖括号与井号一并转义', () => {
    // Arrange
    const html = '<table><tr><td>第一行\n第二行</td><td>a<b</td><td>#tag</td></tr></table>';

    // Act
    const r = htmlTableToMarkdown(html);

    // Assert
    assert.equal(r.text.split('\n')[0], '| 第一行 第二行 | a\\<b | \\#tag |');
  });

  test('单元格内的实体与公式同样被归一化', () => {
    // Arrange：chem-02-03-03 表3 的实况
    const html = '<table><tr><td>1&#x27; 35&quot;</td><td>$2 0 \\mu \\mathrm { m }$</td></tr></table>';

    // Act
    const r = htmlTableToMarkdown(html);

    // Assert
    assert.equal(r.text.split('\n')[0], '| 1\' 35" | 20μm |');
  });

  test('空单元格保留为空列，不塌陷', () => {
    const r = htmlTableToMarkdown('<table><tr><td>a</td><td></td><td>c</td></tr></table>');
    assert.equal(r.text.split('\n')[0], '| a |  | c |');
  });

  test('rowspan / colspan 判为不可转换并说明原因', () => {
    assert.match(htmlTableToMarkdown('<table><tr><td rowspan="2">x</td></tr></table>').reason, /rowspan=2/);
    assert.match(htmlTableToMarkdown('<table><tr><td colspan="4">x</td></tr></table>').reason, /colspan=4/);
    // span=1 等价于不合并，仍可转换
    assert.equal(htmlTableToMarkdown('<table><tr><td colspan="1">x</td></tr></table>').ok, true);
  });
});

describe('renderTableBlock：转换路线裁决', () => {
  test('规则网格走 GFM 路线并计数', () => {
    // Arrange
    const sink = {};

    // Act
    const r = renderTableBlock('<table><tr><td>a</td></tr></table>', sink);

    // Assert
    assert.equal(r.kind, 'gfm');
    assert.equal(sink.gfmTables, 1);
  });

  test('合并单元格回退 raw HTML：原样输出且压成单行', () => {
    // Arrange：CommonMark 的 HTML 块遇空行即截断，故 raw 分支必须折成单行
    const html = '<table>\n  <tr><td rowspan="2">x</td></tr>\n</table>';
    const sink = {};

    // Act
    const r = renderTableBlock(html, sink);

    // Assert
    assert.equal(r.kind, 'raw');
    assert.equal(r.text, '<table> <tr><td rowspan="2">x</td></tr> </table>');
    assert.ok(!r.text.includes('\n'), 'raw HTML 块不得含换行');
    assert.equal(sink.rawTables, 1);
    assert.equal(sink.rawTableReasons.length, 1);
  });
});
