// 数据管线 D3-2：636 切片术语提取（Claude Code Workflow 脚本）
//   每批一个 agent：Read 该批（同域）8~10 个切片 → 逐片提取术语 → Write 到
//   `${outDirAbs}/${chunkId 扁平化（/ → __）}.json`。幂等：输出文件已存在则跳过该片，
//   支持断点续跑（重跑同一批只补缺失片）。
//   调用（主会话）：读 data/term-batches/manifest.json 后按波次切片传入——
//     args = {
//       batches:   manifest 批次数组（或其子集，元素形如 {batchNo, chunks:[...]})，
//       outDirAbs: 输出目录绝对路径（如 <site>/data/term-extract，需已存在或由首个 Write 创建），
//       extractedAt: 统一时间戳字符串（如 '2026-07-12T00:00:00+08:00'），
//       model:     可选，默认 'sonnet'
//     }
//   参考 wf-enrich.js：本脚本经 Workflow 运行时执行，无 Node fs/path API，路径全部来自 args。
export const meta = {
  name: 'extract-terms',
  description: '636 切片术语提取（分批 agent 跑批，幂等断点续跑）',
  phases: [{ title: 'Extract' }],
};

// 每批 agent 的结构化返回：写入片数/跳过片数/失败片 chunkId 列表
const BATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    written: { type: 'number' },
    skipped: { type: 'number' },
    failed: { type: 'array', items: { type: 'string' } },
  },
  required: ['written', 'skipped', 'failed'],
};

// 域 key → 规范全名（与 lib/domains.mjs 的 KNOWN_DOMAINS 对齐；wf 运行时无法 import，故内联）
const DOMAIN_TITLES = {
  'examination-guideline-2025': '专利审查指南2025',
  'patent-law': '中华人民共和国专利法',
  'implementation-rules': '专利法实施细则',
  'infringement-guide': '专利侵权判定指南2017',
  'mechanical-drafting-rules': '机械领域申请文件撰写规范',
  'chemistry-drafting-rules': '化学领域申请文件撰写规范',
  'oa-response-guide': '答复审查意见指南',
};

// 停用词表节选（全量见 scripts/lib/term-stopwords.mjs；merge-terms.mjs 会按全量表再兜底过滤）
const STOP_EXCERPT =
  '专利、专利权、专利申请、发明、发明创造、申请、权利、审查、规定、程序、手续、请求、通知、决定、' +
  '文件、材料、办理、内容、方式、方法、原则、要求、情形、特征、技术、方案、步骤、说明、' +
  '审查员、申请人、专利权人、当事人、专利局、国家知识产权局、一般、其他、有关、相关、具体、部分';

const input = typeof args === 'string' ? JSON.parse(args) : args;
const batches = input.batches;
// 批次文件引用模式：manifest 太大无法内联进 args 时，改传
//   { batchDir: '<abs>/data/term-batches/batches', batchCount: 66 } 或 { batchDir, batchNos: [3,7] }，
//   每个 agent 先 Read 自己的 batch-NN.json 拿到切片清单（与 batches 内联模式二选一）。
const batchDir = input.batchDir || '';
const batchNos = Array.isArray(input.batchNos)
  ? input.batchNos
  : input.batchCount
    ? Array.from({ length: input.batchCount }, (_, i) => i + 1)
    : [];
const outDirAbs = input.outDirAbs;
const extractedAt = input.extractedAt || '';
const model = input.model || 'sonnet';

const flat = (chunkId) => chunkId.split('/').join('__');
const pad2 = (n) => String(n).padStart(2, '0');

function prompt(batch) {
  const domain = batch.chunks[0].domain;
  const title = DOMAIN_TITLES[domain] || domain;
  const list = batch.chunks
    .map(
      (c, i) =>
        `${i + 1}. chunkId: ${c.chunkId}\n   原文: ${c.chunkPath}\n   输出: ${outDirAbs}/${flat(c.chunkId)}.json\n   anchorNode: ${c.anchorNodeId}\n   面包屑: 〔${c.breadcrumb}〕`,
    )
    .join('\n');
  return `你是中国专利法律领域的术语工程专家，为专利知识库的术语图谱做受控术语提取。本批 ${batch.chunks.length} 个切片全部出自《${title}》。

## 任务：对下列每个切片，逐片完成「查重 → 读原文 → 提取 → 写出」
${list}

## 每片操作步骤
1) 幂等查重：先用 Read 尝试读取该片的输出 JSON 文件；若能读到（文件已存在），跳过该片、计入 skipped，不要重做或覆盖。
2) 用 Read 读原文切片（首行「> 〔…〕」是面包屑元数据，不属于正文，但可帮助理解语境）。
3) 按下方铁律提取术语，用 Write 写出该片 JSON（UTF-8，合法 JSON）：
{
  "chunk": "<该片 chunkId>",
  "anchorNode": "<该片 anchorNode>",
  "terms": [
    { "name": "术语规范名", "aliases": ["同义/简称，可空数组"], "role": "defined|used",
      "confidence": "high|mid|low", "evidence": "原文连续子串，不超过40字" }
  ],
  "laws": ["专利法第22条第3款", "..."],
  "extractedAt": "${extractedAt}"
}

## 提取铁律（最高优先级）
1. 只提取专利/法律领域有实质内涵的术语与概念（如「抵触申请」「等同原则」「优先权恢复」「马库什权利要求」），不提取泛词与程序动作词。泛词示例（节选，命中一律不取）：${STOP_EXCERPT}。
2. 每个术语必须附 evidence，且 evidence 必须是该片正文中逐字连续的子串（含标点原样复制，不超过 40 字）；找不到合格 evidence 的词宁可不取。
3. 宁缺毋滥：每片一般 3~15 词；正文极短的切片可以更少甚至为空数组。
4. role 判定：该片给出了这个术语的定义、构成要件或判断标准 → "defined"；仅使用/提及 → "used"。
5. confidence：术语规范、边界清晰 → "high"；表述可靠但可能与他词合并 → "mid"；拿不准 → "low"。
6. aliases 只收录该片原文出现的同义写法/简称，不臆造。
7. laws 收录该片正文明确引用的法条，写完整引用（条号用阿拉伯数字，如「专利法第22条第3款」「专利法实施细则第57条」）；没有则为空数组。
8. JSON 字符串值内部严禁出现英文双引号 "，需要引用时改用中文引号「」或“”，否则会破坏 JSON。

## 完成后
通过 StructuredOutput 返回 {"written": 本批新写出片数, "skipped": 已存在跳过片数, "failed": [写出失败的 chunkId]}；全部成功时 failed 为空数组。`;
}

// 批次文件引用模式的提示词：agent 先读批次清单，再逐片处理
function promptByRef(no) {
  const fileAbs = `${batchDir}/batch-${pad2(no)}.json`;
  return `你是中国专利法律领域的术语工程专家，为专利知识库的术语图谱做受控术语提取。

## 第一步：用 Read 读取批次清单 ${fileAbs}
该 JSON 的 chunks 数组列出本批 8~10 个切片，每片含：chunkPath（原文绝对路径）、chunkId、anchorNodeId、breadcrumb。

## 第二步：对每片依次完成「查重 → 读原文 → 提取 → 写出」
- 输出文件路径 = ${outDirAbs}/<chunkId 中的 / 全部替换为 __>.json
1) 幂等查重：先用 Read 尝试读取该片输出文件；已存在则跳过该片、计入 skipped，不要重做或覆盖。
2) 用 Read 读 chunkPath 原文（首行「> 〔…〕」是面包屑元数据，不属于正文，但可帮助理解语境）。
3) 按下方铁律提取术语，用 Write 写出该片 JSON（UTF-8，合法 JSON）：
{
  "chunk": "<该片 chunkId>",
  "anchorNode": "<该片 anchorNodeId>",
  "terms": [
    { "name": "术语规范名", "aliases": ["同义/简称，可空数组"], "role": "defined|used",
      "confidence": "high|mid|low", "evidence": "原文连续子串，不超过40字" }
  ],
  "laws": ["专利法第22条第3款", "..."],
  "extractedAt": "${extractedAt}"
}

## 提取铁律（最高优先级）
1. 只提取专利/法律领域有实质内涵的术语与概念（如「抵触申请」「等同原则」「优先权恢复」「马库什权利要求」），不提取泛词与程序动作词。泛词示例（节选，命中一律不取）：${STOP_EXCERPT}。
2. 每个术语必须附 evidence，且 evidence 必须是该片正文中逐字连续的子串（含标点原样复制，不超过 40 字）；找不到合格 evidence 的词宁可不取。
3. 宁缺毋滥：每片一般 3~15 词；正文极短的切片可以更少甚至为空数组。
4. role 判定：该片给出了这个术语的定义、构成要件或判断标准 → "defined"；仅使用/提及 → "used"。
5. confidence：术语规范、边界清晰 → "high"；表述可靠但可能与他词合并 → "mid"；拿不准 → "low"。
6. aliases 只收录该片原文出现的同义写法/简称，不臆造。
7. laws 收录该片正文明确引用的法条，写完整引用（条号用阿拉伯数字，如「专利法第22条第3款」「专利法实施细则第57条」）；没有则为空数组。
8. JSON 字符串值内部严禁出现英文双引号 "，需要引用时改用中文引号「」或“”，否则会破坏 JSON。

## 完成后
通过 StructuredOutput 返回 {"written": 本批新写出片数, "skipped": 已存在跳过片数, "failed": [写出失败的 chunkId]}；全部成功时 failed 为空数组。`;
}

const useRefMode = !!(batchDir && batchNos.length);
if ((!Array.isArray(batches) || !batches.length || !outDirAbs) && !(useRefMode && outDirAbs)) {
  log('✗ 参数不合法：需要 args.batches（非空数组）或 args.batchDir+batchCount/batchNos，且必须有 args.outDirAbs');
  return { written: 0, skipped: 0, failed: [], error: 'bad-args' };
}

if (useRefMode) log(`术语提取（批次文件模式）：${batchNos.length} 批 → ${outDirAbs}（model=${model}）`);
else {
  const totalChunks = batches.reduce((a, b) => a + b.chunks.length, 0);
  log(`术语提取：${batches.length} 批 / ${totalChunks} 片 → ${outDirAbs}（model=${model}）`);
}
phase('Extract');

const results = await parallel(
  useRefMode
    ? batchNos.map((no) => () =>
        agent(promptByRef(no), {
          label: `batch:${pad2(no)}`,
          phase: 'Extract',
          schema: BATCH_SCHEMA,
          model,
        }).then((r) => r || { written: 0, skipped: 0, failed: [`batch-${pad2(no)}`] }),
      )
    : batches.map((b) => () =>
        agent(prompt(b), {
          label: `batch:${String(b.batchNo).padStart(2, '0')}:${b.chunks[0].domain}`,
          phase: 'Extract',
          schema: BATCH_SCHEMA,
          model,
        }).then(
          (r) => r || { written: 0, skipped: 0, failed: b.chunks.map((c) => c.chunkId) },
        ),
      ),
);

// 汇总：逐批累加，failed 列表合并供重跑定位
const total = { written: 0, skipped: 0, failed: [] };
for (const r of results) {
  total.written += r.written || 0;
  total.skipped += r.skipped || 0;
  for (const f of r.failed || []) total.failed.push(f);
}
log(`完成：写出 ${total.written} / 跳过 ${total.skipped} / 失败 ${total.failed.length}`);
if (total.failed.length) log(`失败片：${total.failed.join(', ')}`);
return total;
