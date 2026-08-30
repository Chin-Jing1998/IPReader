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
  // —— 以下 41~48 为 2026-08-23 商标扩类：商标审查审理指南（tmeg，105 节点/23.4 万字）入库后，
  //    原 40 主题全部面向专利，商标章节零主题可挂。八键按 tmeg 自身章节体系设立：
  //      下编（商标审查审理编）实体标准 → 41~47；上编（形式审查和事务工作编）程序事务 → 48。
  //    追加在末尾，既有 key 与数组序号一律不动（同 2026-08-11/08-12 两次扩类的约定）。
  //    kw 选词已对专利 7 部规范正文做过误命中体检：凡在专利语料出现 >5 次的候选词一律剔除
  //    （'国际注册' 43 次、'形式审查' 31 次、'电子申请' 10 次均已弃用），保留词多为
  //    商标法域专名（马德里/驰名商标/集体商标…），跨到 trademark-law 等商标域命中系预期行为。
  {
    key: 'tmDistinctiveness',
    name: '商标显著特征',
    kw: ['显著特征', '显著性', '固有显著性', '缺乏显著特征', '经过使用取得显著特征',
      '通用名称', '仅直接表示', '三维标志', '颜色组合', '声音商标'],
  },
  {
    key: 'tmAbsoluteGrounds',
    name: '商标禁用与不良影响',
    kw: ['不得作为商标使用', '不良影响', '欺骗性', '误导公众', '民族歧视', '社会主义道德风尚',
      '禁用条款', '县级以上行政区划', '公众知晓的外国地名', '绝对理由'],
  },
  {
    key: 'tmSimilarity',
    name: '商标近似与混淆判断',
    kw: ['近似商标', '商标近似', '类似商品', '类似服务', '类似群', '尼斯分类',
      '混淆误认', '混淆可能性', '隔离观察', '要部比对', '相关公众'],
  },
  {
    key: 'tmWellKnown',
    name: '驰名商标',
    kw: ['驰名商标', '摹仿', '按需认定', '被动保护'],
  },
  {
    key: 'tmCollectiveGI',
    name: '集体商标证明商标与地理标志',
    kw: ['集体商标', '证明商标', '地理标志', '使用管理规则', '集体成员', '生产地域范围'],
  },
  {
    key: 'tmBadFaith',
    name: '恶意注册与在先权利',
    kw: ['不以使用为目的', '恶意注册', '抢注', '囤积', '不正当手段',
      '在先权利', '有一定影响', '字号', '姓名权', '肖像权'],
  },
  {
    key: 'tmUseRevocation',
    name: '商标使用与撤销',
    kw: ['商标使用', '连续三年不使用', '撤三', '撤销注册商标', '使用证据', '自行改变注册商标'],
  },
  {
    key: 'tmFormalProc',
    name: '商标形式审查与注册事务',
    kw: ['商标注册申请', '商标图样', '声音样本', '商标异议', '商标评审', '审查意见书',
      '商标续展', '商标转让', '使用许可备案', '质权登记', '商标公告', '商标档案',
      '商标代理机构', '商品服务分类', '区分表', '图形要素分类',
      '马德里', '领土延伸', '后期指定'],
  },
  // —— 以下 49~54 为 2026-08-30 阶段5.11 波F 商标细分扩类：5.9 波1 把《商标审查审理指南》
  //    全量重提取（218 → 895 片），新增商标词 475 个，原 8 个商标主题只吃住其中 25.1%，
  //    上编五个部分（分类要素／变更处分／马德里／异议评审／费用档案）几乎无主题可挂。
  //    按 tmeg 自身 44 章体系补 5 个细粒度主题 + 1 个兜底键，仍全部尾部追加、既有 key 与序号不动。
  //    kw 沿用 2026-08-23 定下的选词纪律：凡在专利 7 部规范正文高频出现的候选词一律不取
  //    （'国际注册' 43 次、'受让人'、'被许可人'、'质权登记' 等泛用词均已弃用，
  //     改由 data/term-topic-decisions.json 的章节投票决策承接），只留商标法域专名。
  {
    key: 'tmMadrid',
    name: '马德里商标国际注册',
    kw: ['马德里商标国际注册', '领土延伸申请', '原属局', '国际注册簿', '国际注册后续业务',
      '国际续展', '国际转让', '国际删减', '国际注销', '国际放弃', '国际变更', '国际更正',
      '国际部分转让', '国际部分注销', '缔约方', '基础注册', '基础商标'],
  },
  {
    key: 'tmChangeAssign',
    name: '商标变更与处分类申请',
    kw: ['商标变更', '变更类申请', '处分类申请', '核准转让', '注册商标转让', '注册商标续展',
      '宽展期', '宽展费', '出质商标', '许可备案', '商标更正申请', '一并变更', '部分注销'],
  },
  {
    key: 'tmClassification',
    name: '商品服务与检索要素分类',
    // 「检索要素」裸词故意不取：二级子串会把专利审查指南的「基本检索要素」从 16-分类与检索
    //   抢过来（kw 越长越优先），只取带「商标／文字／图形」限定的长词面。
    kw: ['商品分类原则', '服务分类原则', '类别标题', '类别注释', '标准名称',
      '商标检索要素', '文字检索要素分类', '图形要素编码', '颜色要素编码', '商标图形要素国际分类', '维也纳分类',
      '汉字分卡', '拼音分卡', '英文分卡', '意译分卡', '字头分卡', '数字分卡'],
  },
  {
    key: 'tmOppositionReview',
    name: '商标异议与评审',
    kw: ['异议形式审查', '评审形式审查', '被异议商标', '被异议人', '异议人', '异议理由',
      '异议期限', '异议申请书', '异议理由书', '评审申请', '评审范围', '评审程序',
      '系争商标', '引证商标', '初步审定公告'],
  },
  {
    key: 'tmFeeArchive',
    name: '商标费用送达与档案',
    kw: ['商标规费', '缴费通知书', '缴费码', '缴费期限', '原通道退款', '不予退款',
      '商标注册档案', '商标注册簿', '电子档案', '纸质档案', '商标电子申请',
      '电子商标注册证', '商标数字证书', '商标网上服务系统', '视为送达', '电子送达'],
  },
  // 商标兜底键：manualOnly，只作章节投票/人工决策的落点（tmeg 概述章、指南说明等无实体主题
  //   可挂的出处），不参与自动归类；呈现上仍算「综合类」，计入 ≤12% 验收口径。
  { key: 'tmMisc', name: '商标综合', kw: [], manualOnly: true },
  // —— 以下 55~72 为 2026-08-30 阶段5.11 波F 四法域扩类：5.9 波2 首次纳入著作权、竞争法、
  //    植物新品种与集成电路布图、知识产权综合程序四个法域共 8 部法律法规（384 片），
  //    新增词 222 个，而原 48 个主题全部面向专利与商标，四法域词条落类率仅 0.5%。
  //    按各部法律自身的章节体系设 18 个细粒度主题，收编进新增的第 24~27 组（见下方分组表）。
  //    kw 选词回避与专利/商标语料共用的泛词（'登记'、'转让'、'许可'、'证据'、'赔偿' 等），
  //    覆盖不足的部分由章节投票决策补齐。
  {
    key: 'cprWorks',
    name: '作品与著作权归属',
    kw: ['作品的种类', '独创性', '演绎作品', '合作作品', '汇编作品', '视听作品', '职务作品',
      '委托作品', '民间文学艺术作品', '署名推定', '作品登记', '身份不明的作品', '著作权人'],
  },
  {
    key: 'cprRightsLimit',
    name: '著作权内容与权利限制',
    kw: ['发表权', '署名权', '修改权', '保护作品完整权', '复制权', '发行权', '出租权',
      '展览权', '表演权', '放映权', '广播权', '信息网络传播权', '摄制权', '改编权',
      '翻译权', '汇编权', '合理使用', '法定许可', '权利的保护期', '人身权保护期'],
  },
  {
    key: 'cprContract',
    name: '著作权许可与转让合同',
    kw: ['许可使用合同', '权利转让合同', '专有使用权', '专有出版权', '著作权出质登记',
      '付酬标准', '图书出版合同', '合同备案'],
  },
  {
    key: 'cprNeighboring',
    name: '与著作权有关的权利',
    kw: ['邻接权', '与著作权有关的权利', '表演者', '录音录像制作者', '广播组织',
      '版式设计', '录音制品', '录像制品', '转载摘编', '重印再版', '职务表演'],
  },
  {
    key: 'cprProtection',
    name: '著作权保护与侵权责任',
    kw: ['技术措施', '权利管理信息', '避开技术措施', '侵权行为的民事责任',
      '损害公共利益', '著作权行政查处', '著作权集体管理组织'],
  },
  {
    key: 'cmpUnfairActs',
    name: '不正当竞争行为',
    kw: ['不正当竞争', '混淆行为', '商业贿赂', '虚假宣传', '引人误解的商业宣传',
      '网络不正当竞争', '商业诋毁', '有奖销售', '刷单炒信', '流量劫持',
      '商业信誉', '商品声誉', '平台规则', '平台内经营者'],
  },
  {
    key: 'cmpTradeSecret',
    name: '商业秘密',
    kw: ['商业秘密', '保密措施', '不为公众所知悉', '商业价值', '技术信息', '经营信息',
      '侵犯商业秘密'],
  },
  {
    key: 'cmpMonopolyConduct',
    name: '垄断协议与滥用市场支配地位',
    kw: ['垄断协议', '横向垄断协议', '纵向垄断协议', '市场支配地位', '滥用市场支配地位',
      '相关市场', '轴辐协议', '安全港', '排除、限制竞争', '滥用行政权力', '行政性垄断',
      '协同行为'],
  },
  {
    key: 'cmpConcentration',
    name: '经营者集中',
    kw: ['经营者集中', '集中申报', '申报标准', '附加限制性条件', '控制权', '停钟'],
  },
  {
    key: 'cmpEnforcement',
    name: '竞争执法与法律责任',
    kw: ['反垄断执法机构', '涉嫌垄断行为的调查', '经营者承诺', '宽大制度',
      '公平竞争审查', '监督检查部门', '行业自律'],
  },
  {
    key: 'pvGrantCondition',
    name: '品种权授予条件',
    // 「一致性／稳定性」单取风险过高（与专利化学、撰写规范语料大面积撞词），只取合并长词面与
    //   「特异性」这一品种法专名。
    //   「国家植物品种保护名录」故意不取：二级反向包含（kw 含词条名）会把专利审查指南的
    //   「植物品种」（专利法第 25 条不授予专利权的客体）从 04-可专利客体 抢过来。
    kw: ['新颖性、特异性、一致性和稳定性', '特异性', '品种名称', '植物新品种',
      '授予品种权的条件', '品种保护名录'],
  },
  {
    key: 'pvApplicationExam',
    name: '品种权申请与审查批准',
    // 「初步审查／实质审查」故意不取：与专利审查程序完全同名，做二级子串会把专利词整批吸走。
    kw: ['品种权的申请', '品种权申请', '品种权公告', '繁殖材料', '测试机构', '品种权申请日',
      '品种权受理'],
  },
  {
    key: 'pvRightTermination',
    name: '品种权内容期限与终止',
    // 「强制许可」故意不取：专利法第六章同名制度，取之会把专利词吸进品种权组。
    kw: ['品种权', '品种权人', '实质性派生品种', '品种权的期限', '品种权终止', '品种权无效',
      '农民自繁自用', '品种权的归属'],
  },
  {
    key: 'icLayoutDesign',
    name: '集成电路布图设计',
    kw: ['布图设计', '布图设计专有权', '集成电路', '布图设计登记', '独创性布图设计',
      '反向工程', '含有该布图设计的集成电路'],
  },
  {
    key: 'prcEvidence',
    name: '举证与证据保全',
    kw: ['诚信举证', '举证责任', '证据保全', '妨害证据保全', '域外证据', '公证认证',
      '合法来源抗辩', '确认不侵权之诉', '书证提出命令', '举证妨碍',
      '初步证据', '有专门知识的人'],
  },
  {
    key: 'prcCustoms',
    name: '海关知识产权保护',
    kw: ['海关知识产权保护', '知识产权海关备案', '侵权嫌疑货物', '扣留侵权嫌疑货物',
      '通关放行', '担保金', '进出口货物收发货人'],
  },
  {
    key: 'prcPreservation',
    name: '保全措施与诉讼程序',
    kw: ['行为保全', '诉前保全', '诉前证据保全', '财产保全', '技术调查官',
      '知识产权法庭', '案件管辖', '先行判决'],
  },
  {
    key: 'prcLiability',
    name: '侵权责任与损害赔偿',
    kw: ['惩罚性赔偿', '法定赔偿', '赔偿数额', '故意侵权', '情节严重',
      '侵权获利', '许可使用费的倍数', '维权合理开支'],
  },
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
  // —— 商标段（组号 23-01 ~ 23-14）：2026-08-30 阶段5.11 波H 由原单组 gTrademark 拆分而来 ——
  //   沿革：2026-08-23 商标入库时单设 23-商标审查审理 一组收编八个 tm* 主题；波F 又往 members
  //   里追加 5 个细分主题 + tmMisc 兜底键，使该组独吞 587 词——占全表 1743 词的三分之一，
  //   与专利 22 组「一主题一目录」的粒度严重不对等（专利最大组 67 词）。波F 当时不拆的理由是
  //   「零 slug 变更」硬约束；波H 经用户拍板放行 587 个词条页的 slug 变更，故在此拆为 14 组，
  //   目录粒度与专利段同构（每个 tm* 主题各占一个目录，含兜底键 tmMisc → 商标综合）。
  //
  //   为何用「23-NN」子编号而不顺延新号段：拆组只许动商标段——专利 22 组（01~22）、
  //   四法域四组（24~27）与 99-综合 的目录名与 slug 一律零变更。若把 14 组顺延到 28~41，
  //   商标段会被四法域组从中劈开（目录树呈 …22、24~27、28~41），语序错乱；占用 23 号段的
  //   两级编号则使 14 个商标目录在 22 与 24 之间连续排布，且不迁动任何非商标组。
  //   排序正确性：Explorer 的 sortNodes 先比首段数字（均为 23）、再用 numeric 整理器比整段
  //   字面（"23-01-…" < "23-02-…"），build-quartz-md 总目录同样按 numeric localeCompare 排，
  //   两处均按子编号定序，不退化为拼音序。
  { key: 'gTmDistinctiveness', no: '23-01', name: '商标显著特征', members: ['tmDistinctiveness'] },
  { key: 'gTmAbsoluteGrounds', no: '23-02', name: '商标禁用与不良影响', members: ['tmAbsoluteGrounds'] },
  { key: 'gTmSimilarity', no: '23-03', name: '商标近似与混淆判断', members: ['tmSimilarity'] },
  { key: 'gTmWellKnown', no: '23-04', name: '驰名商标', members: ['tmWellKnown'] },
  { key: 'gTmCollectiveGI', no: '23-05', name: '集体商标证明商标与地理标志', members: ['tmCollectiveGI'] },
  { key: 'gTmBadFaith', no: '23-06', name: '恶意注册与在先权利', members: ['tmBadFaith'] },
  { key: 'gTmUseRevocation', no: '23-07', name: '商标使用与撤销', members: ['tmUseRevocation'] },
  { key: 'gTmFormalProc', no: '23-08', name: '商标形式审查与注册事务', members: ['tmFormalProc'] },
  { key: 'gTmMadrid', no: '23-09', name: '马德里商标国际注册', members: ['tmMadrid'] },
  { key: 'gTmChangeAssign', no: '23-10', name: '商标变更与处分类申请', members: ['tmChangeAssign'] },
  { key: 'gTmClassification', no: '23-11', name: '商品服务与检索要素分类', members: ['tmClassification'] },
  { key: 'gTmOppositionReview', no: '23-12', name: '商标异议与评审', members: ['tmOppositionReview'] },
  { key: 'gTmFeeArchive', no: '23-13', name: '商标费用送达与档案', members: ['tmFeeArchive'] },
  // tmMisc 是 manualOnly 兜底键（tmeg 概述章等无实体主题可挂的出处），独立成目录而非并入
  //   99-综合：其 12 个词全部出自《商标审查审理指南》，落在商标段比落在跨法域的综合组更可检。
  { key: 'gTmMisc', no: '23-14', name: '商标综合', members: ['tmMisc'] },
  // —— 以下 24~27 组为 2026-08-30 阶段5.11 波F 四法域扩类：5.9 波2 纳入的著作权、竞争法、
  //    品种布图、综合程序四个法域各立一组，与「商标单设一组」同理——四者与专利分属不同法律
  //    体系，混入既有专利组会让目录语义失真。四组一律追加在尾部，既有 1~23 组序号与 key 不动，
  //    存量词条的目录路径逐字不变。
  //    2026-08-30 波H：商标段由 1 组拆为 14 组后，数组下标不再等于组号，故四组各自写明 no，
  //    把 24~27 钉死（下方 FROZEN_GROUP_NO 另有守卫），目录名与 slug 与波G 逐字一致。
  {
    key: 'gCopyright',
    no: 24,
    name: '著作权与邻接权',
    members: ['cprWorks', 'cprRightsLimit', 'cprContract', 'cprNeighboring', 'cprProtection'],
  },
  {
    key: 'gCompetition',
    no: 25,
    name: '反不正当竞争与反垄断',
    members: ['cmpUnfairActs', 'cmpTradeSecret', 'cmpMonopolyConduct', 'cmpConcentration',
      'cmpEnforcement'],
  },
  {
    key: 'gPlantIcLayout',
    no: 26,
    name: '植物新品种与集成电路布图',
    members: ['pvGrantCondition', 'pvApplicationExam', 'pvRightTermination', 'icLayoutDesign'],
  },
  {
    key: 'gProcedureGeneral',
    no: 27,
    name: '知识产权综合程序',
    members: ['prcEvidence', 'prcCustoms', 'prcPreservation', 'prcLiability'],
  },
];

// 组号（目录 NN- 前缀）：默认取数组下标 +1，写了 no 字段者以 no 为准。
//   2026-08-30 波H 引入显式 no：商标段拆为 14 组后必须占用 23 号段的两级编号
//   （23-01…23-14），下标与组号不再一一对应；非商标组一律写死既有组号以免随下标漂移。
export const groupNoOf = (g, i) => g.no ?? i + 1;

// 冻结表：波H 之前既有的 26 组组号（专利 22 + 四法域 4）逐一钉死。
//   任何改动使这些组的目录前缀变化，都会让存量词条页 slug 迁移、外部链接与 smoke 硬编码
//   路径失效，故在模块加载期即断言，不留到构建期才发现。
const FROZEN_GROUP_NO = {
  gNovelty: 1, gInventiveness: 2, gUtilityUnity: 3, gSubjectMatter: 4, gClaims: 5,
  gDescription: 6, gGeneticResources: 7, gAmendment: 8, gPriority: 9, gDesign: 10,
  gCompound: 11, gProcReception: 12, gProcSubstantive: 13, gProcGrant: 14, gProcAffairs: 15,
  gClassificationSearch: 16, gReexam: 17, gInvalidation: 18, gPct: 19, gInfringement: 20,
  gInventorship: 21, gFee: 22,
  gCopyright: 24, gCompetition: 25, gPlantIcLayout: 26, gProcedureGeneral: 27,
};

// 细粒度 topicKey → { key, name, no }（no 为组号，供目录 NN- 前缀使用）
const TERM_GROUP_OF = new Map();
const seenGroupNo = new Map();
TERM_TOPIC_GROUPS.forEach((g, i) => {
  const no = groupNoOf(g, i);
  if (seenGroupNo.has(String(no))) {
    throw new Error(`TERM_TOPIC_GROUPS 组号重复：${no}（${seenGroupNo.get(String(no))} / ${g.key}）`);
  }
  seenGroupNo.set(String(no), g.key);
  if (FROZEN_GROUP_NO[g.key] !== undefined && FROZEN_GROUP_NO[g.key] !== no) {
    throw new Error(`组号被改动：${g.key} 应为 ${FROZEN_GROUP_NO[g.key]}，实为 ${no}——该组目录与词条 slug 必须逐字不变`);
  }
  for (const m of g.members) {
    if (TERM_GROUP_OF.has(m)) {
      throw new Error(`TERM_TOPIC_GROUPS 成员重复收编：${m}（${TERM_GROUP_OF.get(m).name} / ${g.name}）`);
    }
    TERM_GROUP_OF.set(m, { key: g.key, name: g.name, no });
  }
});
for (const k of Object.keys(FROZEN_GROUP_NO)) {
  if (!TERM_TOPIC_GROUPS.some((g) => g.key === k)) {
    throw new Error(`冻结组「${k}」已从 TERM_TOPIC_GROUPS 消失：其词条目录会整体迁移，不允许`);
  }
}
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
