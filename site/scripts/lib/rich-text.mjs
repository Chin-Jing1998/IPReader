// rich-text.mjs —— PDF 抽取正文的三类渲染缺陷在生成期的归一化（纯函数，无副作用、无依赖）
//
// 上游 node-bodies.json / public/content/*.json 的正文系 PDF 抽取产物，携带三类
// 不能被 markdown 直接渲染的形态：
//   1. 内嵌 HTML 表格 <table><tr><td>…  —— 生成器旧逻辑把 `<` 统一转义成 `\<`，
//      于是整张表按字面文本平铺；本模块转成 GFM 管道表格（规则网格）或原样 raw HTML
//      （含 rowspan/colspan 的合并单元格，管道表格表达不了，交给 rehype-raw 渲染）。
//   2. 行内 LaTeX 公式 $6 0 ^ { \circ } \mathrm { C }$ —— quartz.config.ts 已移除
//      Plugin.Latex（KaTeX 走 jsdelivr CDN，与离线铁律冲突），故在生成期把公式降解为
//      Unicode 纯文本（上下标、度数、希腊字母、关系符），零依赖零外链。
//   3. HTML 字符实体 &#x27; &quot; —— 原样落入 markdown 后按字面显示，需就地解码。
//
// 三者的处理顺序在 normalizeProse / htmlTableToMarkdown 中固定为
//   「先切表格块 → 再解实体 → 再降解公式 → 最后由调用方做 markdown 转义」：
//   切表格在最前，保证正文里本应显示的尖括号文本不会被误认成 HTML；
//   解实体在降解公式之前，保证实体形态的 `&#x24;`（$）不会凭空造出公式定界符；
//   markdown 转义在最后，保证公式降解产生的 `<` `>` 仍会被转义成字面字符。

// ============ 一、HTML 字符实体解码 ============
// 白名单制：只解码确定安全的具名实体 + 全部数字实体；未收录的具名实体原样保留
//（正文里的裸 `&` 与「&左;」一类非实体串因此不受影响）。
const NAMED_ENTITIES = new Map(
  Object.entries({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u0020', // 不间断空格降为普通半角空格：markdown 里 U+00A0 是不可见的排版暗礁
    ndash: '–',
    mdash: '—',
    hellip: '…',
    times: '×',
    divide: '÷',
    plusmn: '±',
    deg: '°',
    micro: 'µ',
    middot: '·',
    laquo: '«',
    raquo: '»',
    ldquo: '“',
    rdquo: '”',
    lsquo: '‘',
    rsquo: '’',
    le: '≤',
    ge: '≥',
    ne: '≠',
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    mu: 'μ',
  }),
);

const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,30}));/g;

// 单趟替换：不会出现「先解 &amp; 再把结果里的 &lt; 二次解码」的二次转义问题
export function decodeEntities(text) {
  return String(text).replace(ENTITY_RE, (whole, dec, hex, name) => {
    if (dec !== undefined) {
      const cp = Number.parseInt(dec, 10);
      return isValidCodePoint(cp) ? String.fromCodePoint(cp) : whole;
    }
    if (hex !== undefined) {
      const cp = Number.parseInt(hex, 16);
      return isValidCodePoint(cp) ? String.fromCodePoint(cp) : whole;
    }
    const v = NAMED_ENTITIES.get(name);
    return v === undefined ? whole : v;
  });
}

function isValidCodePoint(cp) {
  // 排除代理区与越界码位；同时排除 C0 控制字符（制表/换行除外），避免解出不可见字符
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) return false;
  return true;
}

// ============ 二、行内 LaTeX → Unicode 纯文本 ============
// 覆盖范围按全库实测语料定版（142 处公式 / 96 种去重形态）：单位与量（\mathrm 系字体命令）、
// 度数 ^{\circ}、上下标、希腊字母、关系符与区间号。凡出现未收录命令或上下标无法用
// Unicode 表达者，一律判为不可转换 —— 保留 $…$ 原文，由调用方计数上报，绝不产出半截结果。

// 字体/样式命令：纯视觉修饰，在纯文本里无对应，直接展开其内容
//（\mathbf 与 \mathrm 在本语料中混用于同一变量，丢弃粗体反而更一致）
const FONT_CMDS = new Set([
  'mathrm', 'mathsf', 'mathbf', 'mathit', 'mathtt', 'mathnormal', 'mathcal', 'mathbb',
  'text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt',
  'rm', 'sf', 'bf', 'it', 'tt',
  'operatorname',
]);
// 样式切换与定界修饰：不吃参数，直接忽略
const IGNORED_CMDS = new Set([
  'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle',
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'limits', 'nolimits',
]);
// 空白命令：统一产出一个半角空格。
// 只收字母名命令——词法上 `\ ` `\,` `\;` `\:` 会被切成 ctrl 记号（见 tokenizeMath），
// 其中 `\ ` 在 renderNodes 的 ctrl 分支单独产出空格，`\,` 一类细分空白刻意不收：
// 语料中不存在，真出现时宁可判不可转换、保留 $…$ 原文并由生成器断言拦下人工复核。
const SPACE_CMDS = new Set(['quad', 'qquad', 'thinspace', 'enspace', 'space']);
// 符号命令 → Unicode
const SYMBOLS = new Map(
  Object.entries({
    circ: '°', degree: '°', prime: '′',
    times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '*',
    sim: '∼', approx: '≈', neq: '≠', ne: '≠',
    leq: '≤', le: '≤', leqslant: '≤', geq: '≥', ge: '≥', geqslant: '≥',
    ll: '≪', gg: '≫', equiv: '≡', propto: '∝', infty: '∞',
    to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
    ldots: '…', cdots: '⋯', dots: '…',
    colon: ':', percent: '%', angle: '∠', perp: '⊥', parallel: '∥',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ',
    sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ',
    chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  }),
);
// 转义字符：\% \$ \& \_ \{ \} \# 等，取其字面
// 刻意不收 `\~`：降解结果中一旦出现 ASCII 波浪线，remark-gfm 的 singleTilde 默认开启，
// 同段两处波浪线会被吃成删除线；区间号一律走 \sim → ∼（U+223C），与 markdown 语法无交集。
const ESCAPABLE = new Set(['%', '$', '&', '_', '{', '}', '#']);

// Unicode 上标 / 下标映射：不在表内的字符即判定该公式不可转换
// （°′″ 本身已是升位形态，在上标语境中原样通过）
const SUP_MAP = new Map(Object.entries({
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', '/': 'ᐟ',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ',
  k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ',
  v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
  '°': '°', '′': '′', '″': '″', '‴': '‴',
}));
const SUB_MAP = new Map(Object.entries({
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ',
  p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
}));

class Unconvertible extends Error {}

// 词法：命令 / 转义符 / 结构符（{ } ^ _）/ 字面字符
function tokenizeMath(src) {
  const out = [];
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+)/.exec(src.slice(i));
      if (m) { out.push({ t: 'cmd', v: m[1] }); i += m[0].length; continue; }
      const next = src[i + 1];
      if (next === undefined) throw new Unconvertible('孤立反斜杠');
      out.push({ t: 'ctrl', v: next });
      i += 2;
      continue;
    }
    if (c === '{' || c === '}' || c === '^' || c === '_') { out.push({ t: c }); i += 1; continue; }
    out.push({ t: 'char', v: c });
    i += 1;
  }
  return out;
}

// 语法：把 token 流折成节点树；`^`/`_` 吃紧随其后的一个「原子」（组或单 token）
function parseMath(tokens, pos = { i: 0 }, depth = 0) {
  if (depth > 24) throw new Unconvertible('嵌套过深');
  const nodes = [];
  while (pos.i < tokens.length) {
    const tk = tokens[pos.i];
    if (tk.t === '}') break;
    pos.i += 1;
    if (tk.t === '{') {
      const kids = parseMath(tokens, pos, depth + 1);
      if (tokens[pos.i]?.t !== '}') throw new Unconvertible('花括号不匹配');
      pos.i += 1;
      nodes.push({ t: 'group', kids });
      continue;
    }
    if (tk.t === '^' || tk.t === '_') {
      const atom = parseAtom(tokens, pos, depth + 1);
      nodes.push({ t: tk.t === '^' ? 'sup' : 'sub', kid: atom });
      continue;
    }
    nodes.push(tk);
  }
  return nodes;
}

function parseAtom(tokens, pos, depth) {
  // 数学模式下 `^` 与其内容之间的空白无意义（PDF 抽取产物里普遍存在 `^ +` 这种写法）
  while (tokens[pos.i]?.t === 'char' && /^[ \t~]$/.test(tokens[pos.i].v)) pos.i += 1;
  const tk = tokens[pos.i];
  if (!tk) throw new Unconvertible('上下标缺少内容');
  pos.i += 1;
  if (tk.t === '{') {
    const kids = parseMath(tokens, pos, depth);
    if (tokens[pos.i]?.t !== '}') throw new Unconvertible('花括号不匹配');
    pos.i += 1;
    return { t: 'group', kids };
  }
  if (tk.t === '}' || tk.t === '^' || tk.t === '_') throw new Unconvertible('上下标语法异常');
  // \circ / \prime 一类命令可直接充当上下标内容
  if (tk.t === 'cmd' && FONT_CMDS.has(tk.v)) {
    const arg = parseAtom(tokens, pos, depth);
    return { t: 'group', kids: [arg] };
  }
  return tk;
}

function renderNodes(nodes) {
  let out = '';
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (n.t === 'group') { out += renderNodes(n.kids); continue; }
    if (n.t === 'sup' || n.t === 'sub') {
      const inner = renderNodes([n.kid]);
      out += mapScript(inner, n.t === 'sup' ? SUP_MAP : SUB_MAP);
      continue;
    }
    // 数学模式忽略字面空白；`~` 是 LaTeX 的不间断空格，降为普通空格
    // （同时避免 ASCII 波浪线进入产物触发 GFM 删除线）
    if (n.t === 'char') {
      if (n.v === ' ' || n.v === '\t' || n.v === '\n') continue;
      out += n.v === '~' ? ' ' : n.v;
      continue;
    }
    if (n.t === 'ctrl') {
      if (n.v === ' ') { out += ' '; continue; }
      if (ESCAPABLE.has(n.v)) { out += n.v; continue; }
      if (n.v === '\\') { out += ' '; continue; } // 换行符：行内场景降为空格
      throw new Unconvertible(`未知控制符 \\${n.v}`);
    }
    if (n.t === 'cmd') {
      if (SPACE_CMDS.has(n.v)) { out += ' '; continue; }
      if (IGNORED_CMDS.has(n.v)) continue;
      if (SYMBOLS.has(n.v)) { out += SYMBOLS.get(n.v); continue; }
      if (FONT_CMDS.has(n.v) || n.v === 'substack') {
        // 字体命令与单行 substack 展开其后紧邻的组；\substack 含 \\ 多行时判不可转换
        const arg = nodes[i + 1];
        if (!arg) throw new Unconvertible(`命令 \\${n.v} 缺少参数`);
        i += 1;
        out += renderNodes([arg]);
        continue;
      }
      throw new Unconvertible(`未收录命令 \\${n.v}`);
    }
    throw new Unconvertible('未知节点');
  }
  return out;
}

function mapScript(inner, table) {
  if (!inner) return '';
  let out = '';
  for (const ch of inner) {
    const v = table.get(ch);
    if (v === undefined) throw new Unconvertible(`上下标字符无 Unicode 对应：${ch}`);
    out += v;
  }
  return out;
}

// 单条公式（不含 $ 定界符）→ { ok, text }；不可转换时 ok=false 且 reason 说明原因
export function latexToPlain(tex) {
  const src = String(tex);
  if (src.includes('\\\\')) return { ok: false, reason: '含换行的多行结构' };
  try {
    const nodes = parseMath(tokenizeMath(src));
    const text = renderNodes(nodes)
      .replace(/ {2,}/g, ' ')
      // 连续 \prime 归并为双撇/三撇（分秒记法 1′30′′ → 1′30″）
      .replace(/′′′/g, '‴')
      .replace(/′′/g, '″')
      .trim();
    if (!text) return { ok: false, reason: '降解结果为空' };
    return { ok: true, text };
  } catch (e) {
    if (e instanceof Unconvertible) return { ok: false, reason: e.message };
    throw e;
  }
}

// 文本中全部行内 $…$ 的批量降解；不可转换者保留原文（含 $ 定界符）
export function convertInlineMath(text, sink) {
  const src = String(text);
  // 定界符必须成对；奇数个 $ 说明该文本里的 $ 不是数学定界符，整体不处理
  if (((src.match(/\$/g) || []).length) % 2 !== 0) return src;
  return src.replace(/\$([^$]{1,400})\$/g, (whole, body) => {
    const r = latexToPlain(body);
    if (r.ok) {
      if (sink) sink.converted = (sink.converted || 0) + 1;
      return r.text;
    }
    if (sink) {
      sink.kept = (sink.kept || 0) + 1;
      (sink.keptList ||= []).push({ raw: whole, reason: r.reason });
    }
    return whole;
  });
}

// 散文文本归一化：解实体 → 降解公式（不含 markdown 转义，转义由调用方按语境施加）
export function normalizeProse(text, sink) {
  return convertInlineMath(decodeEntities(text), sink);
}

// ============ 三、内嵌 HTML 表格 ============
// 表格块切分：只识别成对的 <table>…</table>，未闭合的 <table 视为普通文本
// （因此正文里本应显示的尖括号文本不会被误当作 HTML 放行）。
const TABLE_BLOCK_RE = /<table\b[^>]*>[\s\S]*?<\/table\s*>/gi;

export function splitTableSegments(text) {
  const src = String(text);
  const segs = [];
  let last = 0;
  TABLE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = TABLE_BLOCK_RE.exec(src))) {
    if (m.index > last) segs.push({ kind: 'prose', text: src.slice(last, m.index) });
    segs.push({ kind: 'table', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) segs.push({ kind: 'prose', text: src.slice(last) });
  if (!segs.length) segs.push({ kind: 'prose', text: src });
  return segs;
}

const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
const CELL_RE = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const SPAN_RE = /\b(rowspan|colspan)\s*=\s*["']?\s*(\d+)/i;

// 单元格文本：去残留标签 → 解实体 → 降解公式 → markdown 转义（反斜杠优先，再管道/尖括号/井号）
function cellText(raw, sink) {
  const withBreaks = String(raw)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?p\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  const normalized = normalizeProse(withBreaks, sink)
    .replace(/\s+/g, ' ')
    .trim();
  return normalized
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '\\<')
    .replace(/#/g, '\\#');
}

// <table> HTML → GFM 管道表格；含 rowspan/colspan 等无损转不了的结构时 ok=false
export function htmlTableToMarkdown(html, sink) {
  const src = String(html);
  const rows = [];
  ROW_RE.lastIndex = 0;
  let rm;
  while ((rm = ROW_RE.exec(src))) {
    const cells = [];
    CELL_RE.lastIndex = 0;
    let cm;
    while ((cm = CELL_RE.exec(rm[1]))) {
      const span = SPAN_RE.exec(cm[2] || '');
      if (span && Number(span[2]) > 1) {
        return { ok: false, reason: `合并单元格（${span[1]}=${span[2]}）` };
      }
      cells.push(cellText(cm[3], sink));
    }
    rows.push(cells);
  }
  if (!rows.length) return { ok: false, reason: '未解析到 <tr>' };
  const width = Math.max(...rows.map((r) => r.length));
  if (width === 0) return { ok: false, reason: '未解析到 <td>/<th>' };
  const pad = (r) => {
    const c = r.slice();
    while (c.length < width) c.push('');
    return c;
  };
  const line = (cells) => `| ${pad(cells).join(' | ')} |`;
  const out = [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`];
  for (const r of rows.slice(1)) out.push(line(r));
  return { ok: true, text: out.join('\n'), rows: rows.length, cols: width };
}

// 表格块 → 可直接落盘的 markdown 块：优先 GFM 管道表格，回退不转义的 raw HTML
// （quartz 的 ofm.ts htmlPlugins 无条件挂载 rehype-raw，raw HTML 会被正常解析渲染；
//  jsx.tsx 的 customComponents.table 同样会给它套上 .table-container 滚动容器）
export function renderTableBlock(html, sink) {
  const r = htmlTableToMarkdown(html, sink);
  if (r.ok) {
    if (sink) sink.gfmTables = (sink.gfmTables || 0) + 1;
    return { kind: 'gfm', text: r.text };
  }
  if (sink) {
    sink.rawTables = (sink.rawTables || 0) + 1;
    (sink.rawTableReasons ||= []).push(r.reason);
  }
  // raw HTML 必须是单行块（含空行会被 CommonMark 截断为两个 HTML 块）
  return { kind: 'raw', text: String(html).replace(/\s*\n\s*/g, ' ').trim() };
}
