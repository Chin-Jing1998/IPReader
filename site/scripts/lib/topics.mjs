// 专利核心主题词表：用于跨规范（审查指南/专利法/实施细则/侵权判定/撰写规范/答复指引）打通"同主题"知识关联。
//   每个节点扫正文命中的主题 → 打 topics 标签；跨域同主题节点互相关联（点击时全亮+流光、并驱动布局融合）。
//   关键词尽量具体，避免泛词误命中；多命中无妨——所有消费方（代表边/点击关联）都按域取代表并封顶。
export const TOPICS = [
  { key: 'novelty', name: '新颖性', kw: ['新颖性', '抵触申请', '现有技术'] },
  { key: 'inventiveness', name: '创造性', kw: ['创造性', '显而易见', '技术启示', '最接近的现有技术', '三步法', '突出的实质性特点', '非显而易见'] },
  { key: 'utility', name: '实用性', kw: ['实用性', '能够制造或者使用'] },
  { key: 'unity', name: '单一性', kw: ['单一性', '总的发明构思'] },
  { key: 'sufficiency', name: '充分公开', kw: ['充分公开', '公开不充分', '能够实现', '公开充分'] },
  { key: 'support', name: '权利要求得到支持', kw: ['得到说明书的支持', '以说明书为依据', '得不到说明书'] },
  { key: 'clarity', name: '权利要求清楚简要', kw: ['清楚、简要', '清楚地限定', '简要'] },
  { key: 'amendment', name: '修改超范围', kw: ['超出原说明书', '原始记载的范围', '原说明书和权利要求书记载的范围', '修改超范围', '超范围'] },
  { key: 'priority', name: '优先权', kw: ['优先权', '本国优先权', '外国优先权', '在先申请'] },
  { key: 'essentialFeatures', name: '必要技术特征', kw: ['必要技术特征'] },
  { key: 'claims', name: '权利要求撰写', kw: ['权利要求书', '独立权利要求', '从属权利要求', '前序部分', '特征部分', '引用关系', '主题名称'] },
  { key: 'description', name: '说明书撰写', kw: ['具体实施方式', '技术领域', '背景技术', '发明内容', '说明书应当'] },
  { key: 'embodiment', name: '实施例与对比例', kw: ['实施例', '对比例'] },
  { key: 'drawings', name: '附图', kw: ['附图标记', '说明书附图', '附图说明'] },
  { key: 'abstract', name: '说明书摘要', kw: ['说明书摘要', '摘要附图'] },
  { key: 'design', name: '外观设计', kw: ['外观设计', '设计要点', '一般消费者', '整体视觉效果'] },
  { key: 'pct', name: '国际申请/PCT', kw: ['国际申请', 'PCT', '进入国家阶段', '国际阶段', '国际检索'] },
  { key: 'reexam', name: '复审', kw: ['复审请求', '复审程序', '驳回决定', '前置审查'] },
  { key: 'invalidation', name: '无效宣告', kw: ['无效宣告', '宣告专利权无效', '无效请求'] },
  { key: 'literalInfringement', name: '相同侵权/全面覆盖', kw: ['相同侵权', '全面覆盖', '字面侵权', '技术特征的比对'] },
  { key: 'equivalence', name: '等同侵权', kw: ['等同特征', '等同原则', '等同侵权', '基本相同的手段'] },
  { key: 'estoppel', name: '禁止反悔', kw: ['禁止反悔', '捐献'] },
  { key: 'priorArtDefense', name: '现有技术/设计抗辩', kw: ['现有技术抗辩', '现有设计抗辩'] },
  { key: 'protectionScope', name: '保护范围解释', kw: ['保护范围', '以权利要求', '权利要求的内容为准'] },
  { key: 'indirectInfringement', name: '共同/间接侵权', kw: ['共同侵权', '帮助他人', '教唆'] },
  { key: 'oaResponse', name: '审查意见答复', kw: ['审查意见', '意见陈述', '陈述意见', '答复', '答辩', '争辩'] },
  { key: 'geneticResources', name: '遗传资源', kw: ['遗传资源'] },
  { key: 'gracePeriod', name: '不丧失新颖性宽限期', kw: ['不丧失新颖性', '宽限期'] },
  { key: 'doubleProtect', name: '重复授权/同样发明', kw: ['重复授权', '同样的发明创造'] },
  { key: 'compound', name: '化合物/组合物', kw: ['化合物', '马库什', '组合物', '立体构型'] },
  { key: 'inventorship', name: '职务发明与权属', kw: ['职务发明', '发明人', '权利归属'] },
  { key: 'fee', name: '费用与期限', kw: ['申请费', '年费', '恢复权利', '期限届满'] },
  // —— 以下 33~36 为 2026-08-11 扩类（关键词索引分类整合）：容纳原 32 类未覆盖的四大议题。
  //    追加在既有 32 类之后，既有 key 与数组序号一律不动——build-quartz-md 的目录编号
  //    直接取 TOPICS 下标（NN-主题名），改动前序会导致全部词条目录改名。
  {
    key: 'subjectMatter',
    name: '可专利客体',
    kw: ['客体', '智力活动', '科学发现', '科学理论', '疾病的诊断', '疾病的治疗', '外科手术方法',
      '美容方法', '动物和植物品种', '动植物品种', '原子核变换', '不授予专利权', '违反法律',
      '妨害公共利益', '社会公德', '计算机程序', '商业规则', '算法特征', '生物学的方法', '天然物质'],
  },
  // examProcedure 于 2026-08-12 拆分为下方 procReception/procSubstantive/procGrant/procAffairs
  //   四个阶段键后即退役：词条侧 851 词无一挂靠，在 TERM_TOPIC_GROUPS 中仅由「实质审查与答复」
  //   组收编以满足完整性自检、并为决策层回退留落点——该收编是停放位，不是语义判断。
  // 2026-08-12 补记 manualOnly：本键的 kw 是高频程序泛词（补正/驳回/受理/送达/审查员…），
  //   在章节层命中 1193 章中的 551 章（46%），既非主题信号、更无法据以判定章节属于哪一审查阶段
  //   （指南初审、实审、复审无效、事务处理各部分均大面积命中）。若放任其进入 nodes.json 的
  //   topics[]，章节标签会经上述停放位一律落到「实质审查与答复」，把初审与事务处理章节错标。
  //   故与四个继任键同等对待：不参与自动归类，只作人工决策落点。kw 予以保留——
  //   build-seed-lexicon 与 audit-edges 仍按 TOPICS.kw 取词，清空会连带损失这批程序词。
  {
    key: 'examProcedure',
    name: '审查程序',
    manualOnly: true,
    kw: ['初步审查', '实质审查', '审查程序', '审查员', '审查决定', '审查文本', '审查基础',
      '合议审查', '独任审查', '形式审查', '全面审查', '依职权', '补正', '驳回', '受理', '送达',
      '听证', '优先审查', '快速审查', '延迟审查', '中止程序', '授权登记', '登记手续'],
  },
  {
    key: 'classificationSearch',
    name: '分类与检索',
    kw: ['专利分类', '分类号', '分类表', 'IPC', '检索', '类文件', '引得码', '最低限度数据库',
      '外观设计分类', '功能分类', '应用分类', '整体分类', '多重分类'],
  },
  {
    key: 'draftingPractice',
    name: '撰写实务',
    kw: ['禁忌', '禁用', '注意事项', '不规范', '错别字', '措辞', '拼凑', '越简越好', '用法', '写法', '陷阱'],
  },
  // —— 以下 37~40 为 2026-08-12 扩类：原 examProcedure（审查程序）单键承载 159 词、
  //    合 oaResponse 共 165 词成为最大组，按审查流程阶段细分为四键。追加在末尾，
  //    既有 key 与数组序号一律不动（目录编号自 2026-08-12 起取 TERM_TOPIC_GROUPS 组序，不再取本表下标）。
  //    manualOnly: 只作为 data/term-topic-decisions.json 人工决策的落点，不参与自动归类——
  //      kw 为空使 tagTopics 永不命中（章节标签零影响），且下方 TOPIC_PROBES 将其整体排除，
  //      使 classifyTopic 的一/二/三级都不会把决策清单外的词条吸进这四键。归属完全由决策层决定。
  { key: 'procReception', name: '受理与初步审查', kw: [], manualOnly: true },
  { key: 'procSubstantive', name: '实质审查与答复', kw: [], manualOnly: true },
  { key: 'procGrant', name: '授权登记与公布', kw: [], manualOnly: true },
  { key: 'procAffairs', name: '程序事务', kw: [], manualOnly: true },
];

// 命中的主题 key 列表（去重）。text 由调用方按"容器用导语、叶子用全文"传入，避免容器揽过多主题。
//   manualOnly 主题整体跳过：其归属只由人工决策指定，不得由关键词自动打到章节上。
//   （四个阶段键 kw 本为空、跳过与否等价；examProcedure 的 kw 非空，此处是其退役的落实点。）
export function tagTopics(text) {
  if (!text) return [];
  const hit = [];
  for (const t of TOPICS) {
    if (t.manualOnly) continue;
    if (t.kw.some((k) => text.includes(k))) hit.push(t.key);
  }
  return hit;
}

export const TOPIC_NAME = Object.fromEntries(TOPICS.map((t) => [t.key, t.name]));

// ============ 词条主题分组：关键词索引的目录体系（2026-08-12）============
//   动因：2026-08-12 删词后词表 968 → 851，原 36 主题 + 综合共 37 组中 17 组不足 10 词
//   （清楚简要 1、必要技术特征 1、说明书摘要 2、相同侵权 2、禁止反悔 2、现有技术抗辩 2 …），
//   目录过碎已妨碍浏览。此处把 36 个细粒度主题归并为 19 个体系化分组，加 99-综合共 20 组。
//
//   为何另设一层而非直接改 TOPICS：TOPICS 的 key 与数组下标被三处强耦合——
//     ① data/term-topic-decisions.json 的 479 条人工归类决策按细粒度 topicKey 记录；
//     ② data/terms-seed.json 中种子词的 topicKey；
//     ③ nodes.json 里章节节点的 topics[]（parse-domains 的 tagTopics 产物，本次不重跑解析）。
//   删改 TOPICS 会让上述引用变成未知 key —— 人工决策整批失效、章节标签静默丢失。
//   故 TOPICS 37 项一律保持原样（顺序、key、kw 不动），归类判定仍在细粒度上进行；
//   只有「目录名 / 面包屑 / 词条页标签」三处呈现改走本分组层。
//
//   分组顺序按专利法体系编排：授权实质条件 → 申请文件 → 特殊类型与领域 → 审查与后续程序
//   → 侵权判定 → 权属与费用 → 综合殿后。members 为该组收编的细粒度 topicKey。
export const TERM_TOPIC_GROUPS = [
  // 授权实质条件。宽限期（专利法 24 条）与重复授权/同样发明（9 条）在审查指南第二部分
  // 第三章「新颖性」项下成章，归入新颖性组有直接体系依据。
  { key: 'gNovelty', name: '新颖性', members: ['novelty', 'gracePeriod', 'doubleProtect'] },
  { key: 'gInventiveness', name: '创造性', members: ['inventiveness'] },
  // 实用性（22 条 4 款）与单一性（31 条）各自不足 10 词，同属三性之外的授权要件，合并成组。
  { key: 'gUtilityUnity', name: '实用性与单一性', members: ['utility', 'unity'] },
  { key: 'gSubjectMatter', name: '可专利客体', members: ['subjectMatter'] },
  // 申请文件。得到支持（26 条 4 款）、清楚简要、必要技术特征均是权利要求本身的法定要求。
  { key: 'gClaims', name: '权利要求', members: ['claims', 'support', 'clarity', 'essentialFeatures'] },
  // 充分公开、实施例与对比例、附图、摘要、撰写实务均围绕说明书及其附属文件。
  {
    key: 'gDescription',
    name: '说明书与申请文件',
    members: ['description', 'sufficiency', 'embodiment', 'drawings', 'abstract', 'draftingPractice'],
  },
  { key: 'gGeneticResources', name: '遗传资源', members: ['geneticResources'] },
  { key: 'gAmendment', name: '修改超范围', members: ['amendment'] },
  { key: 'gPriority', name: '优先权', members: ['priority'] },
  // 特殊类型与领域
  { key: 'gDesign', name: '外观设计', members: ['design'] },
  { key: 'gCompound', name: '化合物与组合物', members: ['compound'] },
  // 审查与后续程序：2026-08-12 把原「审查程序与答复」165 词按审查流程阶段拆为四组。
  //   归类依据以词条「出处」章节规则化投票为主（审查指南 01-01~01-03/05-03 → 受理与初步审查；
  //   02-* 与 03-02、答复指引 → 实质审查与答复；05-08/05-09/05-10、细则第九章 → 授权登记与公布；
  //   05-01/05-04~05-07/05-11 → 程序事务），跨部或语义边界词逐词裁量，全量映射见提交说明。
  { key: 'gProcReception', name: '受理与初步审查', members: ['procReception'] },
  // examProcedure 为拆分前的旧粗粒度键：拆分后无任何词条再挂它（章节节点亦从未携带，
  //   它是 2026-08-11 扩类后未重跑 parse-domains 的纯词条键），此处保留收编仅为满足完整性自检、
  //   并在决策层回退时提供落点。oaResponse 仍有 197 个章节节点携带，其章节标签经本组呈现。
  { key: 'gProcSubstantive', name: '实质审查与答复', members: ['procSubstantive', 'oaResponse', 'examProcedure'] },
  { key: 'gProcGrant', name: '授权登记与公布', members: ['procGrant'] },
  { key: 'gProcAffairs', name: '程序事务', members: ['procAffairs'] },
  { key: 'gClassificationSearch', name: '分类与检索', members: ['classificationSearch'] },
  { key: 'gReexam', name: '复审', members: ['reexam'] },
  { key: 'gInvalidation', name: '无效宣告', members: ['invalidation'] },
  { key: 'gPct', name: '国际申请与PCT', members: ['pct'] },
  // 侵权判定：保护范围解释是侵权比对的前置步骤，与四种侵权形态及抗辩同族。
  {
    key: 'gInfringement',
    name: '侵权判定',
    members: ['protectionScope', 'literalInfringement', 'equivalence', 'estoppel',
      'priorArtDefense', 'indirectInfringement'],
  },
  // 权属与费用
  { key: 'gInventorship', name: '职务发明与权属', members: ['inventorship'] },
  { key: 'gFee', name: '费用与期限', members: ['fee'] },
];

// 细粒度 topicKey → { key, name, no }（no 为 1 起的分组序号，供目录 NN- 前缀使用）
const TERM_GROUP_OF = new Map();
TERM_TOPIC_GROUPS.forEach((g, i) => {
  for (const m of g.members) {
    if (TERM_GROUP_OF.has(m)) {
      throw new Error(`TERM_TOPIC_GROUPS 成员重复收编：${m}（${TERM_GROUP_OF.get(m).name} / ${g.name}）`);
    }
    TERM_GROUP_OF.set(m, { key: g.key, name: g.name, no: i + 1 });
  }
});
// 完整性自检：TOPICS 每一项都必须被收编，否则该主题下的词条会静默落入 99-综合。
// 日后往 TOPICS 追加主题时，此断言会在生成期立即报错，提醒同步登记分组。
for (const t of TOPICS) {
  if (!TERM_GROUP_OF.has(t.key)) {
    throw new Error(`TERM_TOPIC_GROUPS 未收编主题「${t.key}」（${t.name}）：新增主题须同步登记分组`);
  }
}

// 细粒度 topicKey → 分组信息；无 topicKey 或未收编时返回 null（调用方按 99-综合处理）
export function termGroupOf(topicKey) {
  if (!topicKey) return null;
  return TERM_GROUP_OF.get(topicKey) || null;
}

// ============ 词条 → 主题 三级归类（merge-terms.mjs 消费；2026-08-11 需求⑫）============
//   背景：原归类只做「词条名/别名 == 主题 name/kw」的精确相等匹配，968 词中仅 68 条落类、
//         900 条（93%）堆在 99-综合。此处扩展为三级，宁可留综合、不可错归类。
//     一级 exact  ：词条名/别名 归一后等于主题 name 或某个 kw；
//     二级 substr ：词条名（**不含别名**）包含某 kw，或某 kw 包含词条名（双向子串）；
//     三级 text   ：定义句 + evidence 片段合并后按 kw 计数，需「命中 kw 种类 ≥2 或单 kw 出现 ≥3 次」
//                   且总分领先亚军 ≥ L3_MARGIN，才判给冠军主题。
//   同级多命中：取 kw 更长者；再平手取 TOPICS 中更靠前者。
//   为何二级排除别名：词表的 aliases 多为 LLM 提取的相关词/片段而非严格同义词（「附图标号多余」
//     的别名含「重复」「错误」，「外观设计转用」的别名含「组合」），做子串会大面积错归类；
//     一级要求整体相等，别名参与是安全的（原算法即如此），故保留。
export const TOPIC_NORM = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// 二级子串匹配的停用 kw：语义过泛，作子串会大面积误配（'简要' 会把「简要说明/外观设计简要说明」
//   一类说明书与外观设计概念错吸进「权利要求清楚简要」）。仅停用于二级，一级精确相等不受影响。
const L2_STOP_KW = new Set(['简要']);
const L2_MIN_REVERSE_LEN = 3; // 二级反向包含（kw 含词条名）时词条名的最小长度：2 字词条被长 kw 吞掉的误配率过高
const L3_MIN_KINDS = 2; // 三级：命中 kw 种类下限
const L3_MIN_REPEAT = 3; // 三级：单一 kw 重复出现下限（种类不足时的替代门槛）
const L3_MARGIN = 2; // 三级：冠军相对亚军的最小分差

// 每个主题参与匹配的词面 = [name, ...kw]（归一 + 去重 + 按长度降序，便于取最长命中）
//   manualOnly 主题整体排除：其归属只由人工决策指定，不得被算法自动吸词（否则决策清单外的
//   词条会因组名反向子串命中而漂移，如「初步审查」被「受理与初步审查」吞掉）。
const TOPIC_PROBES = TOPICS.filter((t) => !t.manualOnly).map((t) => ({
  key: t.key,
  probes: [...new Set([t.name, ...t.kw].map(TOPIC_NORM))].filter((p) => p.length >= 2).sort((a, b) => b.length - a.length),
}));

// 候选优于现任？级别小者优；同级 kw 长者优；再平手保留先到者（TOPICS 序）
const outranks = (cand, cur) => !cur || cand.level < cur.level || (cand.level === cur.level && cand.kwLen > cur.kwLen);

// canonical：词条正名；aliases：别名（仅参与一级精确相等）；text：定义句 + evidence 合并文本。
// 返回 { topicKey, level, kw } 或 null（判不出即留综合）。
export function classifyTopic({ canonical = '', aliases = [], text = '' } = {}) {
  const self = TOPIC_NORM(canonical);
  const exactNames = [...new Set([canonical, ...aliases].map(TOPIC_NORM))].filter((n) => n.length >= 2);
  let best = null;

  for (const { key, probes } of TOPIC_PROBES) {
    for (const p of probes) {
      if (exactNames.includes(p)) {
        if (outranks({ level: 1, kwLen: p.length }, best)) best = { topicKey: key, level: 1, kw: p, kwLen: p.length };
        continue;
      }
      if (L2_STOP_KW.has(p) || self.length < 2) continue;
      const hit = self.includes(p) || (self.length >= L2_MIN_REVERSE_LEN && p.includes(self));
      if (hit && outranks({ level: 2, kwLen: p.length }, best)) best = { topicKey: key, level: 2, kw: p, kwLen: p.length };
    }
  }
  if (best) return { topicKey: best.topicKey, level: best.level, kw: best.kw };

  // ---- 三级：定义句 + evidence 文本计分 ----
  const body = TOPIC_NORM(text);
  if (body.length < 8) return null;
  const scored = [];
  for (const { key, probes } of TOPIC_PROBES) {
    let total = 0;
    let kinds = 0;
    let maxRepeat = 0;
    let topKw = '';
    for (const p of probes) {
      let n = 0;
      for (let i = body.indexOf(p); i >= 0; i = body.indexOf(p, i + p.length)) n++;
      if (!n) continue;
      total += n;
      kinds++;
      if (n > maxRepeat) {
        maxRepeat = n;
        topKw = p;
      }
    }
    if (kinds >= L3_MIN_KINDS || maxRepeat >= L3_MIN_REPEAT) scored.push({ key, total, topKw });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.total - a.total);
  const runnerUp = scored[1]?.total || 0;
  if (scored[0].total - runnerUp < L3_MARGIN) return null; // 分差不够：判不出，留综合
  return { topicKey: scored[0].key, level: 3, kw: scored[0].topKw };
}
