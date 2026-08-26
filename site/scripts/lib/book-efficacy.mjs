// book-efficacy.mjs —— 书根 index 页「效力信息」小节渲染（阶段5.3 批次 W8）。
//
// 数据源：data/book-meta.json 的原始字段（批次 W1 产物、W3 确认为原始事实层），逐字取用。
// 铁律（与 W8 任务书一致）：
//   1. 只渲染非空字段，一律不造词、不补默认值、不改写值——例如 gb-standards-index 的
//      effectiveDate「不适用（多项标准各自实施日期见清单表内'实施日期'列，详见正文）」
//      属语料自述，原样落页；
//   2. promulgationText 逐字落页，不改写／不摘要／不截断，仅做与正文同规格的段落化
//      （由调用方经 renderProse 注入，见下）。
//
// 产出结构（整节仅在「至少一行字段非空」或「有公布与施行原文」时才出）：
//   ## 效力信息
//   - **施行日期**／**通过／公布日期**／**发文字号**／**制定机关**／**效力状态**／**来源**
//   ### 公布与施行原文        （promulgationText 非空才出）
//
// 全库口径（2026-08-25 实测 88 键）：
//   promulgationText 非空 77 键；promulgationLabel「公布与施行」79 键——差额 2 键
//   （patent-adjudication-manual-2019、trademark-exam-guide-2021）系上游裁决丢弃该节点，
//   文本为空串，故只出字段行、不出「### 公布与施行原文」子节；另 9 键无该节点（标签空）。
//   字段与原文皆空的 6 键（patent-law、implementation-rules、mechanical-drafting-rules、
//   chemistry-drafting-rules、oa-response-guide、quality-evaluation）天然整节不出。
//   子节标题取固定字面「公布与施行原文」而非 promulgationLabel：实测 77 个非空原文的
//   label 恒为「公布与施行」，两者等价，固定字面免去标签缺失时的兜底分支。
//
// 纯函数、无 I/O、无模块级副作用：可被 scripts/test/ 下的小脚本独立单测（不跑全量生成）。

/** 「公布与施行原文」子节标题（固定字面，见文件头说明） */
export const PROMULGATION_HEADING = '### 公布与施行原文';

const val = (v) => String(v ?? '').trim();

/**
 * 效力信息字段行（按固定顺序，逐行"非空才出"）。
 *   发文字号：documentNo 优先，空则 judicialInterpretationNo（实测两者互斥，无并存键）；
 *   来源：sourceUrl 优先，空则 sourceRef（实测两者互斥），fetchedAt 非空时以「（采集于 X）」后缀附着——
 *     来源本身为空时整行不出（连带 fetchedAt 不单独成行，不为其另造标签）。
 * @param {object} meta data/book-meta.json 的单域原始条目
 * @returns {Array<{label:string, value:string}>}
 */
export function efficacyRows(meta) {
  const m = meta || {};
  const rows = [];
  const push = (label, value) => {
    const v = val(value);
    if (v) rows.push({ label, value: v });
  };
  push('施行日期', m.effectiveDate);
  push('通过／公布日期', m.adoptedDate);
  push('发文字号', val(m.documentNo) || val(m.judicialInterpretationNo));
  push('制定机关', m.issuedBy);
  push('效力状态', m.status);
  const source = val(m.sourceUrl) || val(m.sourceRef);
  if (source) {
    const fetchedAt = val(m.fetchedAt);
    push('来源', fetchedAt ? `${source}（采集于 ${fetchedAt}）` : source);
  }
  return rows;
}

/**
 * 渲染「效力信息」小节 markdown（不含前后空行，由调用方拼装）。
 * @param {object} meta data/book-meta.json 的单域原始条目（缺键/undefined 均安全返回空串）
 * @param {object} [options]
 * @param {(para:string)=>string} [options.renderProse]
 *   公布与施行原文的**逐段**加工钩子：入参为按空行切出的原始段落，出参为该段 markdown。
 *   生成器侧注入「与正文同规格的段落化（mdParagraphs：单换行转硬换行 + < # 最小转义）
 *   ＋ 法条内链化（linkLawCites force 档）」；单测侧可注入恒等函数或桩函数。
 *   逐段调用而非整篇调用，是为了与正文链路 contentBlocks→linkLawCites 的粒度严格一致
 *   （法条引用不跨段、"同一条文一段内只链首次出现"的去重范围同为段）。
 * @returns {string} 空串表示本域无效力信息可渲染（整节不出）
 */
export function efficacySection(meta, { renderProse = (p) => p } = {}) {
  const rows = efficacyRows(meta);
  const paras = String((meta && meta.promulgationText) || '')
    .split(/\n{2,}/)
    .filter((p) => p.trim());
  if (!rows.length && !paras.length) return '';
  const lines = ['## 效力信息', ''];
  for (const r of rows) lines.push(`- **${r.label}**：${r.value}`);
  if (paras.length) {
    if (rows.length) lines.push('');
    lines.push(PROMULGATION_HEADING, '');
    lines.push(paras.map((p) => renderProse(p)).join('\n\n'));
  }
  return lines.join('\n');
}
