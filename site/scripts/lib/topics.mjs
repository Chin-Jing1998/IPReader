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
  { key: 'oaResponse', name: '审查意见答复', kw: ['审查意见', '意见陈述', '答复'] },
  { key: 'geneticResources', name: '遗传资源', kw: ['遗传资源'] },
  { key: 'gracePeriod', name: '不丧失新颖性宽限期', kw: ['不丧失新颖性', '宽限期'] },
  { key: 'doubleProtect', name: '重复授权/同样发明', kw: ['重复授权', '同样的发明创造'] },
  { key: 'compound', name: '化合物/组合物', kw: ['化合物', '马库什', '组合物', '立体构型'] },
  { key: 'inventorship', name: '职务发明与权属', kw: ['职务发明', '发明人', '权利归属'] },
  { key: 'fee', name: '费用与期限', kw: ['申请费', '年费', '恢复权利', '期限届满'] },
];

// 命中的主题 key 列表（去重）。text 由调用方按"容器用导语、叶子用全文"传入，避免容器揽过多主题。
export function tagTopics(text) {
  if (!text) return [];
  const hit = [];
  for (const t of TOPICS) {
    if (t.kw.some((k) => text.includes(k))) hit.push(t.key);
  }
  return hit;
}

export const TOPIC_NAME = Object.fromEntries(TOPICS.map((t) => [t.key, t.name]));
