// 健壮版精构工作流：args 直接传节点 id 数组（无引导 agent）。
//   每个 agent：读 content/{id}.json 骨架(取 label/level/breadcrumb) → 若已精构则跳过 →
//   读 wave-src/{id}.md 原文 → 生成 narrative/infographics/examples → 合并写回。幂等、sonnet。
export const meta = {
  name: 'enrich-ids',
  description: '精构指定 id 列表的知识点（读骨架+原文→生成→写回，幂等，sonnet）',
  phases: [{ title: '精构' }],
};

const STATUS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { id: { type: 'string' }, ok: { type: 'boolean' }, igKinds: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
  required: ['id', 'ok'],
};

// 路径不再硬编码个人机器绝对路径（可移植）。
//   本脚本经 Workflow 运行时执行，无 Node fs/path API，故路径改为：
//   - 默认用「仓库根」相对路径（子代理工作目录即仓库根：.../专利审查指南知识库）；
//   - 如需在其他工作目录运行，用对象形式 args = { root: '<仓库根绝对路径>', ids: [...] } 显式指定。
const input = typeof args === 'string' ? JSON.parse(args) : args;
const ROOT = Array.isArray(input) ? '.' : input.root || '.';
const ids = Array.isArray(input) ? input : input.ids;
const CONTENT = `${ROOT}/site/public/content`;
const SRC = `${ROOT}/site/data/wave-src`;

function prompt(id) {
  const contentPath = `${CONTENT}/${id}.json`;
  const srcPath = `${SRC}/${id}.md`;
  return `你是中国专利审查领域的资深讲解者，为《专利审查指南（2025）》知识图谱网站精构一个知识点的详情内容。

## 步骤
1) 用 Read 读骨架 JSON：${contentPath}
   - 从中取 label、level、breadcrumb、partNum、sourceRef、brief、related、lawRefs。
   - 若其 "shell" 字段已为 false（已精构），立即通过 StructuredOutput 返回 {id:"${id}", ok:true, note:"skip-existing"}，不要重做或写回。
2) 用 Read 读原文（你的输出必须严格基于它）：${srcPath}
   - 纲目判断：若 level 为 part/chapter，或原文以"（本级为纲目"开头、或正文极短且 related 中含多个"下属"项，则按【纲目型】写简明导览；否则按【叶子知识点】讲透。
3) 生成精构内容，合并进骨架并用 Write 覆盖写回 ${contentPath}。

## 忠实性铁律（最高优先级）
1. 只能重组表达、补充帮助理解的类比与结构、配图说明；严禁新增原文没有的法律结论、判断分支、数字、条款号、期限、比例。
2. 法条号/数字/阈值与原文逐字一致；拿不准就不写。
3. 信息图只呈现原文已明确表达的逻辑，不得虚构步骤或分支。
4. 示例优先取自原文；如给说明性示例须忠于原文规则、不臆造法律结论。

## 写回 JSON（保留骨架的 id/level/label/breadcrumb/partNum/sourceRef/brief/related/lawRefs，仅替换下列三项并把 shell 改 false）
- "narrative": 段落数组，元素 {"type":"p","text":"..."} 或 {"type":"subhead","text":"小标题"}。纲目型写 2-4 段导览；叶子型把内涵/判断要点/易混淆处讲透讲生动(设问/类比/分点)，3-6 段。
- "infographics": 1-2 个，选最能直观说明本知识点的图，优先零依赖图型，能不用 echarts 就不用。spec 按类型直接写成 JSON 对象/数组/字符串（不要再包一层字符串）：
  · "steps": [{"title":"...","desc":"..."}]
  · "table": {"headers":["列1","列2"],"rows":[["...","..."]]}
  · "compare": {"left":{"title":"...","items":["..."]},"right":{"title":"...","items":["..."]}}
  · "stat": [{"value":"3","label":"..."}]
  · "mermaid": "flowchart TD\\n ..."（中文节点加引号，语法从简、保证可渲染，不用需插件特性）
  · "echarts": {echarts option 对象}（仅关系网/树/雷达且前述不胜任时）
- "examples": 1-3 个，{"type":"positive|negative|neutral","title":"...","text":"..."}。判断类尽量正/反对照。
- "fidelity": {"verified":true,"method":"enriched"}，"shell": false。

写回必须是合法 JSON（UTF-8）。【关键】JSON 字符串值内部严禁使用英文双引号 " 作强调或引用；需要强调时一律改用中文引号「」或全角引号“”，否则会破坏 JSON。
完成后通过 StructuredOutput 返回 {id:"${id}", ok:true, igKinds:[图型], note:"一句话"}；失败则 ok:false 并说明。`;
}

log(`精构 ${ids.length} 个节点（id 列表驱动；root=${ROOT}）`);
phase('精构');
const results = await parallel(
  ids.map((id) => () =>
    agent(prompt(id), { label: `gen:${id}`, phase: '精构', schema: STATUS_SCHEMA, model: 'sonnet' }).then((r) => r || { id, ok: false, note: 'agent null' }),
  ),
);
const okN = results.filter((r) => r && r.ok).length;
log(`完成 ${okN}/${results.length}`);
return results;
