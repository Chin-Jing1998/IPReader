// 规范域注册表 + 自动发现
//   把项目根目录下"含 _index.md + 主 md"的每个规范目录视作一个"域"（domain）。
//   数据管线（parse-domains / extract-edges / compute-layout / build-content-shell）据此把
//   多部规范合并进同一张星图：每个域 = 一个星系。
//   设计目标：用户日后在根目录补上新规范目录（如 implementation-rules/），无需改代码，重跑脚本即自动并入。
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// site/scripts → site → patent-kb → 专利知识库（外层仓根，七书切片目录所在）
export function projectRoot(scriptsDir) {
  return join(scriptsDir, '..', '..', '..');
}

// 已知规范的元数据（数组顺序 = 星系/图例的默认排序；guideline 居首=中央星系）。
//   special:'guideline' 走特例解析（不加前缀、保留 部/章/节/小节 与 826 校验）。
//   special:'tmeg-guideline' 走《商标审查审理指南》语义特例解析（源 md 编/部分/章同为 H1，
//     按标题文字判类＋章/条正文一级、二级编号切分重建 part/chapter/section/subsection 树，
//     813 节点校验、语义深度上限 6（阶段5.2 W-1），详见 parse-domains.mjs 头注与 parseTmegGuideline 注释块）。
//   lawName 非空者，其"第X条"标题节点会被赋 lawKey，供跨域 lawref 连线锚定。
//
// 沿革（2026-08-30 阶段5.11 波O · 书目归档下线）：经用户勾选定案，12 部低检索价值文献
//   （编号 51/53/63/72/74/75/77/79/82/87/89/90，见下方各条的「波O 下线」注释）自本表摘除，
//   书目 88 → 76。摘除形态为**注释保留而非物理删行**：条目原文逐字留在原位，恢复时取消
//   注释即可，与「〔已剔除〕ip-interps-amendment-2020」的裁决剔除写法同源。
//   语料源文件同步 mv 至 PatentReader/_archive/（语料仓非 git，那里是唯一副本），
//   恢复方法、下线缘由与书级色板存档见该目录的 _说明.md。
//   ⚠ 摘条目与归档语料必须同做：只摘条目而语料仍在根目录，discoverDomains 的自动发现段
//   会把它当「未知域」重新纳入（前缀由 prefixFromKey 现编）；只归档语料而不摘条目，
//   isDomainDir 判假、条目空转，但下游 BOOKS/graphSections 的登记会与实际域集脱钩。
//   ⚠ 已知并接受的连带降级：53（trademark-printing-2004）的条文原被在库的 69
//   《商标一般违法判断标准》实引（law-citations 内 12 条 lawref + 5 条 colaw）。
//   施工前实测报出该依赖后，用户拍板「接受引用降级」，53 照常下线——69 正文中
//   「《商标印制管理办法》第X条」自此退化为纯文本（lawKey 注册表随本表收缩而不再命中，
//   非悬空链、不报错），法条溯源少 12 处。
export const KNOWN_DOMAINS = [
  { key: 'examination-guideline', title: '专利审查指南', short: '审查指南', prefix: '', special: 'guideline', country: 'CN', field: '专利', docType: 'D5' },
  { key: 'patent-law', title: '中华人民共和国专利法', short: '专利法', prefix: 'law', lawName: '专利法', country: 'CN', field: '专利', docType: 'D1' },
  { key: 'implementation-rules', title: '专利法实施细则', short: '实施细则', prefix: 'rule', lawName: '专利法实施细则', country: 'CN', field: '专利', docType: 'D2' },
  { key: 'infringement-guide', title: '专利侵权判定指南', short: '侵权判定', prefix: 'infr', country: 'CN', field: '专利', docType: 'D5' },
  { key: 'mechanical-drafting-rules', title: '机械领域申请文件撰写规范', short: '机械撰写', prefix: 'mech', country: 'CN', field: '专利', docType: 'D5' },
  { key: 'chemistry-drafting-rules', title: '化学领域申请文件撰写规范', short: '化学撰写', prefix: 'chem', country: 'CN', field: '专利', docType: 'D5' },
  { key: 'oa-response-guide', title: '答复审查意见指南', short: '答复指引', prefix: 'oa', country: 'CN', field: '专利', docType: 'D5' },
  // ---- 入库批次一「04 司法解释」26 件（2026-08-22）：按通过/发布日期升序 ----
  //   阶段 3（2026-08-22）已按条号自洽判据（设计方案 S1）为其中 23 件补充 lawName；
  //   ipc-digest-2022／ipc-digest-2023 为案例要旨汇编，无「第X条」条文体例，不设 lawName。
  { key: 'plant-variety-interp-2001', title: '最高人民法院关于审理植物新品种纠纷案件若干问题的解释', short: '品种解释', prefix: 'pv01', lawName: '最高人民法院关于审理植物新品种纠纷案件若干问题的解释', country: 'CN', field: '品种布图', docType: 'D4' },
  { key: 'patent-dispute-rules', title: '最高人民法院关于审理专利纠纷案件适用法律问题的若干规定', short: '专利纠纷', prefix: 'pdr', lawName: '最高人民法院关于审理专利纠纷案件适用法律问题的若干规定', country: 'CN', field: '专利', docType: 'D4' },
  { key: 'tm-jurisdiction-interp', title: '最高人民法院关于审理商标案件有关管辖和法律适用范围问题的解释', short: '商标管辖', prefix: 'tmjur', lawName: '最高人民法院关于审理商标案件有关管辖和法律适用范围问题的解释', country: 'CN', field: '商标', docType: 'D4' },
  { key: 'tm-civil-interp', title: '最高人民法院关于审理商标民事纠纷案件适用法律若干问题的解释', short: '商标民事', prefix: 'tmciv', lawName: '最高人民法院关于审理商标民事纠纷案件适用法律若干问题的解释', country: 'CN', field: '商标', docType: 'D4' },
  { key: 'copyright-civil-interp', title: '最高人民法院关于审理著作权民事纠纷案件适用法律若干问题的解释', short: '著作权', prefix: 'cprt', lawName: '最高人民法院关于审理著作权民事纠纷案件适用法律若干问题的解释', lawAlias: '著作权解释', country: 'CN', field: '著作权', docType: 'D4' },
  { key: 'plant-variety-rules-1', title: '最高人民法院关于审理侵害植物新品种权纠纷案件具体应用法律问题的若干规定', short: '品种规定一', prefix: 'pvr1', lawName: '最高人民法院关于审理侵害植物新品种权纠纷案件具体应用法律问题的若干规定', country: 'CN', field: '品种布图', docType: 'D4' },
  { key: 'wellknown-tm-interp', title: '最高人民法院关于审理涉及驰名商标保护的民事纠纷案件应用法律若干问题的解释', short: '驰名商标', prefix: 'wktm', lawName: '最高人民法院关于审理涉及驰名商标保护的民事纠纷案件应用法律若干问题的解释', country: 'CN', field: '商标', docType: 'D4' },
  { key: 'patent-infringe-interp-1', title: '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释', short: '侵权解释一', prefix: 'pii1', lawName: '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释', country: 'CN', field: '专利', docType: 'D4' },
  { key: 'tm-amend-jurisdiction-interp', title: '最高人民法院关于商标法修改决定施行后商标案件管辖和法律适用问题的解释', short: '商标新法', prefix: 'tmamd', lawName: '最高人民法院关于商标法修改决定施行后商标案件管辖和法律适用问题的解释', country: 'CN', field: '商标', docType: 'D4' },
  { key: 'ip-court-jurisdiction-2014', title: '最高人民法院关于北京、上海、广州知识产权法院案件管辖的规定', short: '知产法院', prefix: 'ipcj', lawName: '最高人民法院关于北京、上海、广州知识产权法院案件管辖的规定', country: 'CN', field: '综合程序', docType: 'D4' },
  { key: 'patent-infringe-interp-2', title: '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）', short: '侵权解释二', prefix: 'pii2', lawName: '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）', country: 'CN', field: '专利', docType: 'D4' },
  { key: 'tm-grant-validity-rules', title: '最高人民法院关于审理商标授权确权行政案件若干问题的规定', short: '商标确权', prefix: 'tmgv', lawName: '最高人民法院关于审理商标授权确权行政案件若干问题的规定', country: 'CN', field: '商标', docType: 'D4' },
  { key: 'ip-injunction-rules-2018', title: '最高人民法院关于审查知识产权纠纷行为保全案件适用法律若干问题的规定', short: '行为保全', prefix: 'ipinj', lawName: '最高人民法院关于审查知识产权纠纷行为保全案件适用法律若干问题的规定', country: 'CN', field: '综合程序', docType: 'D4' },
  { key: 'ip-tribunal-rules-2018', title: '最高人民法院关于知识产权法庭若干问题的规定', short: '知产法庭', prefix: 'iptrb', lawName: '最高人民法院关于知识产权法庭若干问题的规定', country: 'CN', field: '综合程序', docType: 'D4' },
  { key: 'tech-investigator-rules-2019', title: '最高人民法院关于技术调查官参与知识产权案件诉讼活动的若干规定', short: '技术调查官', prefix: 'tinv', lawName: '最高人民法院关于技术调查官参与知识产权案件诉讼活动的若干规定', country: 'CN', field: '综合程序', docType: 'D4' },
  { key: 'trade-secret-civil-rules-2020', title: '最高人民法院关于审理侵犯商业秘密民事案件适用法律若干问题的规定', short: '商业秘密', prefix: 'tsec', lawName: '最高人民法院关于审理侵犯商业秘密民事案件适用法律若干问题的规定', country: 'CN', field: '竞争法', docType: 'D4' },
  { key: 'patent-grant-validity-rules-1', title: '最高人民法院关于审理专利授权确权行政案件适用法律若干问题的规定（一）', short: '授权确权一', prefix: 'pgv1', lawName: '最高人民法院关于审理专利授权确权行政案件适用法律若干问题的规定（一）', country: 'CN', field: '专利', docType: 'D4' },
  { key: 'ip-evidence-rules-2020', title: '最高人民法院关于知识产权民事诉讼证据的若干规定', short: '证据规定', prefix: 'ipev', lawName: '最高人民法院关于知识产权民事诉讼证据的若干规定', country: 'CN', field: '综合程序', docType: 'D4' },
  // 〔已剔除〕ip-interps-amendment-2020（法释〔2020〕19 号修改十八件决定，原 prefix amd18、dir 28）——
  //   与既往两次裁决排除的「修改决定/对照表」同属修正案元文档，修正内容已体现在入库的 18 件修正后合并文本中，
  //   且其罗列各法名与条号的正文构成法条直达检索噪声源。清洗语料与 manifest 保留，manifest 该条已标注「已裁决剔除·内容重复」。
  { key: 'plant-variety-rules-2', title: '最高人民法院关于审理侵害植物新品种权纠纷案件具体应用法律问题的若干规定（二）', short: '品种规定二', prefix: 'pvr2', lawName: '最高人民法院关于审理侵害植物新品种权纠纷案件具体应用法律问题的若干规定（二）', country: 'CN', field: '品种布图', docType: 'D4' },
  { key: 'unfair-competition-interp-2022', title: '最高人民法院关于适用《中华人民共和国反不正当竞争法》若干问题的解释', short: '反法解释', prefix: 'ucl', lawName: '最高人民法院关于适用《中华人民共和国反不正当竞争法》若干问题的解释', country: 'CN', field: '竞争法', docType: 'D4' },
  { key: 'ipc-digest-2022', title: '最高人民法院知识产权法庭裁判要旨摘要（2022）', short: '要旨2022', prefix: 'dg22', country: 'CN', field: '综合程序', docType: 'D4' },
  { key: 'antitrust-civil-interp-2024', title: '最高人民法院关于审理垄断民事纠纷案件适用法律若干问题的解释', short: '垄断解释', prefix: 'amon', lawName: '最高人民法院关于审理垄断民事纠纷案件适用法律若干问题的解释', country: 'CN', field: '竞争法', docType: 'D4' },
  { key: 'ipc-digest-2023', title: '最高人民法院知识产权法庭裁判要旨摘要（2023）', short: '要旨2023', prefix: 'dg23', country: 'CN', field: '综合程序', docType: 'D4' },
  { key: 'ip-criminal-interp-2025', title: '最高人民法院、最高人民检察院关于办理侵犯知识产权刑事案件适用法律若干问题的解释', short: '刑事解释', prefix: 'ipcrm', lawName: '最高人民法院、最高人民检察院关于办理侵犯知识产权刑事案件适用法律若干问题的解释', country: 'CN', field: '综合程序', docType: 'D4' },
  { key: 'punitive-damages-interp', title: '最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释', short: '惩罚赔偿', prefix: 'pund', lawName: '最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释', country: 'CN', field: '综合程序', docType: 'D4' },
  // ---- 入库批次二「01 法律与行政法规」15 件（2026-08-22）：按通过/公布日期升序 ----
  //   title 字段仍存官方全称、不带年份；年份后缀自阶段5.3 起由 resolveDomainTitles 依 _index.md
  //   frontmatter（经 book-meta.json）运行期派生，效力全貌另由各书根页『效力信息』小节承载
  //   （原承载体『公布与施行』节点已于阶段5.3 删除）；
  //   阶段 3（2026-08-22）已为本批全部 15 件补充 lawName（取官方全称去「中华人民共和国」前缀，设计方案 S2）。
  //   其中商标法（2026 修订）与集成电路布图设计保护条例（2026 修订）为「尚未施行」文本，效力状态见各域 _index.md。
  { key: 'ic-layout-rules-2001', title: '集成电路布图设计保护条例实施细则', short: '布图细则', prefix: 'icldr', lawName: '集成电路布图设计保护条例实施细则', country: 'CN', field: '品种布图', docType: 'D3' },
  { key: 'defense-patent-regulations-2004', title: '国防专利条例', short: '国防专利', prefix: 'dfpr', lawName: '国防专利条例', country: 'CN', field: '专利', docType: 'D2' },
  { key: 'network-dissemination-regulations-2013', title: '信息网络传播权保护条例', short: '网络传播', prefix: 'ndpr', lawName: '信息网络传播权保护条例', country: 'CN', field: '著作权', docType: 'D2' },
  { key: 'copyright-law-rules-2013', title: '中华人民共和国著作权法实施条例', short: '著作权条例', prefix: 'cplr', lawName: '著作权法实施条例', country: 'CN', field: '著作权', docType: 'D2' },
  { key: 'software-protection-regulations-2013', title: '计算机软件保护条例', short: '软件条例', prefix: 'cspr', lawName: '计算机软件保护条例', country: 'CN', field: '著作权', docType: 'D2' },
  { key: 'copyright-collective-mgmt-2013', title: '著作权集体管理条例', short: '集体管理', prefix: 'ccm', lawName: '著作权集体管理条例', country: 'CN', field: '著作权', docType: 'D2' },
  { key: 'trademark-law-rules-2014', title: '中华人民共和国商标法实施条例', short: '商标条例', prefix: 'tmlr', lawName: '商标法实施条例', country: 'CN', field: '商标', docType: 'D2' },
  { key: 'customs-ip-protection-2018', title: '中华人民共和国知识产权海关保护条例', short: '海关保护', prefix: 'cusr', lawName: '知识产权海关保护条例', country: 'CN', field: '综合程序', docType: 'D2' },
  { key: 'patent-agency-regulations-2018', title: '专利代理条例', short: '专利代理', prefix: 'pagr', lawName: '专利代理条例', country: 'CN', field: '专利', docType: 'D2' },
  { key: 'copyright-law-2020', title: '中华人民共和国著作权法', short: '著作权法', prefix: 'cpl', lawName: '著作权法', country: 'CN', field: '著作权', docType: 'D1' },
  { key: 'anti-monopoly-law-2022', title: '中华人民共和国反垄断法', short: '反垄断法', prefix: 'aml', lawName: '反垄断法', country: 'CN', field: '竞争法', docType: 'D1' },
  { key: 'plant-variety-regulations-2025', title: '中华人民共和国植物新品种保护条例', short: '品种条例', prefix: 'pvpr', lawName: '植物新品种保护条例', country: 'CN', field: '品种布图', docType: 'D2' },
  { key: 'anti-unfair-competition-2025', title: '中华人民共和国反不正当竞争法', short: '反不正当', prefix: 'aucl', lawName: '反不正当竞争法', country: 'CN', field: '竞争法', docType: 'D1' },
  { key: 'trademark-law-2026', title: '中华人民共和国商标法', short: '商标法', prefix: 'tml', lawName: '商标法', country: 'CN', field: '商标', docType: 'D1' },
  { key: 'ic-layout-regulations-2026', title: '集成电路布图设计保护条例', short: '布图条例', prefix: 'icld', lawName: '集成电路布图设计保护条例', country: 'CN', field: '品种布图', docType: 'D2' },
  // ---- 入库批次三「02 部门规章与规范性文件」25 件（2026-08-22）：按通过/发布日期升序 ----
  //   title 用官方全称、不带年份后缀；结构类型混合：章条 11、flat 11、公告体 1、指引体 2；
  //   其中专利优先审查管理办法已于 2026-09-01 施行，现行有效。
  //   阶段 3（2026-08-22）已为其中 22 件补充 lawName；fee-adjustment-notice-2024／
  //   patent-payment-guide-2026／patent-ic-fee-manual-2026 为公告与操作指引，无「第X条」条文体例，不设 lawName。
  // 〔波O 下线·51〕{ key: 'work-registration-1994', title: '作品自愿登记试行办法', short: '作品登记', prefix: 'wkreg', lawName: '作品自愿登记试行办法', country: 'CN', field: '著作权', docType: 'D3' },
  { key: 'software-copyright-registration-2002', title: '计算机软件著作权登记办法', short: '软件登记', prefix: 'swreg', lawName: '计算机软件著作权登记办法', country: 'CN', field: '著作权', docType: 'D3' },
  // 〔波O 下线·53〕{ key: 'trademark-printing-2004', title: '商标印制管理办法', short: '商标印制', prefix: 'tmprt', lawName: '商标印制管理办法', country: 'CN', field: '商标', docType: 'D3' },
  { key: 'customs-ip-measures-2009', title: '中华人民共和国海关关于《中华人民共和国知识产权海关保护条例》的实施办法', short: '海关办法', prefix: 'cusm', lawName: '海关关于《中华人民共和国知识产权海关保护条例》的实施办法', country: 'CN', field: '综合程序', docType: 'D3' },
  { key: 'copyright-penalty-2009', title: '著作权行政处罚实施办法', short: '著权处罚', prefix: 'cppen', lawName: '著作权行政处罚实施办法', country: 'CN', field: '著作权', docType: 'D3' },
  { key: 'patent-marking-2012', title: '专利标识标注办法', short: '专利标识', prefix: 'pmark', lawName: '专利标识标注办法', country: 'CN', field: '专利', docType: 'D3' },
  { key: 'compulsory-license-2012', title: '专利实施强制许可办法', short: '强制许可', prefix: 'cmpl', lawName: '专利实施强制许可办法', country: 'CN', field: '专利', docType: 'D3' },
  { key: 'trademark-review-rules-2014', title: '商标评审规则', short: '商标评审', prefix: 'tmrev', lawName: '商标评审规则', country: 'CN', field: '商标', docType: 'D3' },
  { key: 'wellknown-tm-recognition-2014', title: '驰名商标认定和保护规定', short: '驰名认定', prefix: 'wktmr', lawName: '驰名商标认定和保护规定', country: 'CN', field: '商标', docType: 'D3' },
  { key: 'biomaterial-deposit-2015', title: '用于专利程序的生物材料保藏办法', short: '生物保藏', prefix: 'biod', lawName: '用于专利程序的生物材料保藏办法', country: 'CN', field: '专利', docType: 'D3' },
  { key: 'patent-enforcement-2015', title: '专利行政执法办法', short: '行政执法', prefix: 'penf', lawName: '专利行政执法办法', country: 'CN', field: '专利', docType: 'D3' },
  { key: 'fee-reduction-2016', title: '专利收费减缴办法', short: '收费减缴', prefix: 'fered', lawName: '专利收费减缴办法', country: 'CN', field: '专利', docType: 'D3' },
  // 〔波O 下线·63〕{ key: 'cnipa-normative-docs-2016', title: '国家知识产权局规范性文件制定和管理办法', short: '规范文件', prefix: 'nrmd', lawName: '国家知识产权局规范性文件制定和管理办法', country: 'CN', field: '综合程序', docType: 'D3' },
  { key: 'patent-agency-admin-2019', title: '专利代理管理办法', short: '代理管理', prefix: 'pagm', lawName: '专利代理管理办法', country: 'CN', field: '专利', docType: 'D3' },
  { key: 'patent-attorney-exam-2019', title: '专利代理师资格考试办法', short: '资格考试', prefix: 'paex', lawName: '专利代理师资格考试办法', country: 'CN', field: '专利', docType: 'D3' },
  { key: 'trademark-filing-conduct-2019', title: '规范商标申请注册行为若干规定', short: '申请规范', prefix: 'tmfil', lawName: '规范商标申请注册行为若干规定', country: 'CN', field: '商标', docType: 'D3' },
  { key: 'trademark-infringement-standard-2020', title: '商标侵权判断标准', short: '侵权标准', prefix: 'tmis', lawName: '商标侵权判断标准', country: 'CN', field: '商标', docType: 'D3' },
  { key: 'major-patent-adjudication-2021', title: '重大专利侵权纠纷行政裁决办法', short: '行政裁决', prefix: 'mpadj', lawName: '重大专利侵权纠纷行政裁决办法', country: 'CN', field: '专利', docType: 'D3' },
  { key: 'trademark-violation-standard-2021', title: '商标一般违法判断标准', short: '违法标准', prefix: 'tmvs', lawName: '商标一般违法判断标准', country: 'CN', field: '商标', docType: 'D3' },
  { key: 'trademark-agency-supervision-2022', title: '商标代理监督管理规定', short: '商标代理', prefix: 'tmagy', lawName: '商标代理监督管理规定', country: 'CN', field: '商标', docType: 'D3' },
  { key: 'ip-abuse-competition-2023', title: '禁止滥用知识产权排除、限制竞争行为规定', short: '滥用规定', prefix: 'ipabc', lawName: '禁止滥用知识产权排除、限制竞争行为规定', country: 'CN', field: '竞争法', docType: 'D3' },
  // 〔波O 下线·72〕{ key: 'fee-adjustment-notice-2024', title: '国家知识产权局关于调整部分专利收费标准和减缴政策的公告', short: '收费调整', prefix: 'fadj', country: 'CN', field: '专利', docType: 'D3' },
  { key: 'priority-examination-2026', title: '专利优先审查管理办法', short: '优先审查', prefix: 'prex', lawName: '专利优先审查管理办法', country: 'CN', field: '专利', docType: 'D3' },
  // 〔波O 下线·74〕{ key: 'patent-payment-guide-2026', title: '专利缴费操作指引', short: '缴费指引', prefix: 'payg', country: 'CN', field: '专利', docType: 'D5' },
  // 〔波O 下线·75〕{ key: 'patent-ic-fee-manual-2026', title: '专利和集成电路布图设计缴费服务指南', short: '缴费指南', prefix: 'feem', country: 'CN', field: '专利', docType: 'D5' },
  // ---- 入库批次四（收尾）15 件（2026-08-22）：按发布/施行日期升序，GB 清单为元数据索引域置末 ----
  //   title 用官方全称。本批含业务指南 2、政策纲要/规划 2、公布令 1、案例汇编 1、元数据索引 1。
  //   四批累计 80 件全量入库完成：7 部原书 + 25 司法解释 + 15 法律法规 + 25 部门规章 + 15 收尾 = 87 域
  //   （2026-08-24 阶段5.2 批次 Q-1 召回《专利质量评价指南》后为 88 域，见文末批次五注释）。
  //   阶段 3（2026-08-22）已为其中 7 件补充 lawName；阶段 5 波A（2026-08-23）修复 copyright-pledge-
  //   registration-2011 的伪「第十三条」割裂缺陷后为其补设 lawName（第 8 件）；trademark-exam-guide-2021
  //   （按商标法条文解读、条号重复缺号，非本域条文）仍按判据 2 排除，其余 6 件为业务指南/政策纲要/公布令/
  //   案例汇编/元数据索引，无「第X条」条文体例，均不设 lawName。
  { key: 'copyright-pledge-registration-2011', title: '著作权质权登记办法', short: '质权登记', prefix: 'cppl', lawName: '著作权质权登记办法', country: 'CN', field: '著作权', docType: 'D3' },
  // 〔波O 下线·77〕{ key: 'text-work-remuneration-2014', title: '使用文字作品支付报酬办法', short: '报酬办法', prefix: 'remun', lawName: '使用文字作品支付报酬办法', country: 'CN', field: '著作权', docType: 'D3' },
  { key: 'patent-adjudication-manual-2019', title: '专利侵权纠纷行政裁决办案指南', short: '办案指南', prefix: 'padm', country: 'CN', field: '专利', docType: 'D5' },
  // 〔波O 下线·79〕{ key: 'ip-power-outline-2021', title: '知识产权强国建设纲要（2021－2035年）', short: '强国纲要', prefix: 'ipout', country: 'CN', field: '综合程序', docType: 'D6' },
  { key: 'trademark-exam-guide-2021', title: '商标审查审理指南', short: '商标审查', prefix: 'tmeg', special: 'tmeg-guideline', country: 'CN', field: '商标', docType: 'D5' },
  { key: 'patent-filing-conduct-2023', title: '规范申请专利行为的规定', short: '规范申请', prefix: 'pfc', lawName: '规范申请专利行为的规定', country: 'CN', field: '专利', docType: 'D3' },
  // 〔波O 下线·82〕{ key: 'exam-guideline-decree-2023', title: '国家知识产权局令第78号（发布《专利审查指南》）', short: '指南发布令', prefix: 'egd', country: 'CN', field: '专利', docType: 'D6' },
  { key: 'collective-cert-trademark-2023', title: '集体商标、证明商标注册和管理规定', short: '集体商标', prefix: 'cctm', lawName: '集体商标、证明商标注册和管理规定', country: 'CN', field: '商标', docType: 'D3' },
  { key: 'gi-product-protection-2023', title: '地理标志产品保护办法', short: '地理标志', prefix: 'gipp', lawName: '地理标志产品保护办法', country: 'CN', field: '商标', docType: 'D3' },
  { key: 'patent-adjudication-mediation-2024', title: '专利纠纷行政裁决和调解办法', short: '裁决调解', prefix: 'padmd', lawName: '专利纠纷行政裁决和调解办法', country: 'CN', field: '专利', docType: 'D3' },
  { key: 'admin-reconsideration-2024', title: '国家知识产权局行政复议规程', short: '行政复议', prefix: 'adrc', lawName: '国家知识产权局行政复议规程', country: 'CN', field: '综合程序', docType: 'D3' },
  // 〔波O 下线·87〕{ key: 'rulemaking-procedure-2024', title: '国家知识产权局规章制定程序规定', short: '规章程序', prefix: 'rmkp', lawName: '国家知识产权局规章制定程序规定', country: 'CN', field: '综合程序', docType: 'D3' },
  { key: 'ipc-digest-2024', title: '最高人民法院知识产权法庭裁判要旨摘要（2024）', short: '要旨2024', prefix: 'dg24', country: 'CN', field: '综合程序', docType: 'D4' },
  // 〔波O 下线·89〕{ key: 'ip-plan-15th-2026', title: '知识产权保护和运用“十五五”规划', short: '十五五', prefix: 'plan15', country: 'CN', field: '综合程序', docType: 'D6' },
  // 〔波O 下线·90〕{ key: 'gb-standards-index', title: '知识产权相关 GB/T 国家标准清单与在线预览入口', short: 'GB清单', prefix: 'gbstd', country: 'CN', field: '综合程序', docType: 'D6' },
  // ---- 入库批次五（召回）1 件（2026-08-24 阶段5.2 批次 Q-1）：第 88 部书 ----
  //   《专利质量评价指南》：15 章 199 条撰写质量评价规则，语料自 skills-package/quality-evaluation 迁入
  //   项目根 quality-evaluation/（两处此后独立演化）。体例为「章（H1）/条（H2）」两级，走通用解析。
  //   不设 lawName：其「第X条」是评价规则条款、非法条，不应参与跨域 lawref 锚定；「第X条 · 条旨」
  //   拼接依赖波A 已与 lawName 解耦的恒解析 titles 机制（parse-domains.mjs:365-378），无需 lawName。
  { key: 'quality-evaluation', title: '专利质量评价指南', short: '质量评价', prefix: 'qeval', country: 'CN', field: '专利', docType: 'D5' },
];

// 六标签（field）与 D1–D6 文献类型（docType）词表（阶段5 波C 新增）：
//   country/field/docType 三字段的取值域，供本文件与下游校验脚本（如 mcp/scripts/check-taxonomy.mjs）共用。
export const DOC_TYPES = { D1: '法律', D2: '行政法规', D3: '部门规章与规范性文件', D4: '司法解释与裁判规则', D5: '审查与实务指引', D6: '政策文件与标准索引' };
export const FIELDS = ['专利', '商标', '著作权', '竞争法', '品种布图', '综合程序'];

const KNOWN_BY_KEY = new Map(KNOWN_DOMAINS.map((d) => [d.key, d]));

// 目录是否为合格规范域：存在 _index.md 且存在至少一个非 _index 的 .md（主文件）
function mainMdOf(dir, key) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const mds = files.filter((f) => f.endsWith('.md') && f !== '_index.md');
  if (!mds.length) return null;
  // 优先与目录同名的主文件；否则取首个非 _index 的 .md
  const same = mds.find((f) => f === `${key}.md`);
  return join(dir, same || mds.sort()[0]);
}

function isDomainDir(root, name) {
  if (name === 'site' || name.startsWith('.') || name.startsWith('_')) return false;
  const dir = join(root, name);
  let st;
  try {
    st = statSync(dir);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;
  if (!existsSync(join(dir, '_index.md'))) return false;
  return !!mainMdOf(dir, name);
}

function prefixFromKey(key) {
  // 未知规范的默认前缀：取字母数字、截断，保证命名空间 id 不与 guideline 冲突
  const p = key.replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase();
  return p || 'doc';
}

// 发现并返回域列表：先按 KNOWN_DOMAINS 顺序纳入存在者，再追加根目录下其余合格规范目录。
//   每项：{ key, dir, mainMd, prefix, title, short, special?, lawName? }
export function discoverDomains(root) {
  const out = [];
  const seen = new Set();

  for (const meta of KNOWN_DOMAINS) {
    if (!isDomainDir(root, meta.key)) continue;
    const dir = join(root, meta.key);
    out.push({ ...meta, dir, mainMd: mainMdOf(dir, meta.key) });
    seen.add(meta.key);
  }

  let names = [];
  try {
    names = readdirSync(root).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (seen.has(name) || !isDomainDir(root, name)) continue;
    const dir = join(root, name);
    out.push({
      key: name,
      title: name,
      short: name.slice(0, 6),
      prefix: prefixFromKey(name),
      dir,
      mainMd: mainMdOf(dir, name),
    });
    seen.add(name);
  }

  return out;
}

// ============ 书名年份后缀派生（阶段5.3 批次 W3／D3）============
// 需求来源：书名注明施行年份，便于用户不点开文档即可判断"这是哪一年的版本"。
// KNOWN_DOMAINS[].title 静态字面量本身**保持官方全称、不带年份**（P9 check-taxonomy 等下游
// 对该字面量的等值比较依赖其原样不变），年份后缀改在运行期由 resolveDomainTitles 派生、
// 不回写 KNOWN_DOMAINS，调用方（parse-domains.mjs 的 breadcrumb、build-quartz-md.mjs／
// mcp/scripts/build-data.mjs 的 DOMAIN_META）各自按需消费其返回的新数组。
//
// 取值链（四级，严格顺序，命中即停，全部依据见下）：
//   ① dom.title 本身已含四位数字（/\d{4}/，如「…摘要（2022）」「…纲要（2021－2035年）」）
//      → 不加后缀，避免「（2022）（2022年施行）」式重复。全库实测恰 4 域：
//      ipc-digest-2022 / ipc-digest-2023 / ipc-digest-2024 / ip-power-outline-2021。
//   ② bookMeta[key].effectiveDate 能解析出四位年份（/(19|20)\d{2}/ 首个匹配）
//      → 后缀「（YYYY年施行）」——施行日期是用户最关心的"这份文本现在是否生效、何时生效"。
//   ③ 否则 bookMeta[key].issuedYear 能解析出四位年份（同一正则）
//      → 后缀「（YYYY年发布）」——公告/操作指引/裁判要旨类文档常无「施行」概念，
//      只有发布年份（全库实测恰 2 域：examination-guideline「2025年发布」、
//      infringement-guide「2017年发布」）。
//   ④ 否则不加后缀（bookMeta 缺该键、字段为空串、或两字段均解析不出四位年份）。
//
// **刻意不设 adoptedDate 兜底**：以 patent-dispute-rules 为例，其 adoptedDate 为
// 「2001年6月19日」（最高法审判委员会通过日），但该域入库语料是「（2020修正）」现行版本
// （title 已带此字样），若在②③之外再兜底 adoptedDate 会产出「…若干规定（2020修正）
// （2001年施行）」——通过日与现行文本实际施行年份相悖，反而误导用户对"这是哪一年生效的
// 版本"的判断。宁可落 ④ 不加后缀，也不用可能失真的兜底值；书名之外，各书根页「效力信息」
// 小节仍完整展示 adoptedDate 等全量沿革字段，不因本函数不取用而丢失信息。
//
// 沿革：阶段5.3 批次 W3（D3）新增。此前 title 一律裸官方全称（见上方 KNOWN_DOMAINS 批次二
// 注释的历史裁定），效力信息仅由 _index.md front matter 与曾经存在的「公布与施行」正文节点
// 承载——该节点已于阶段5.3 批次 W1 前置摘除，效力全貌改由各书根页「效力信息」小节承载，
// 书名年份后缀是对"用户扫一眼书名即知版本年份"这一诉求的补充，两者不冲突。
const TITLE_YEAR_RE = /\d{4}/;
const META_YEAR_RE = /(19|20)\d{2}/;

function firstYear(s) {
  if (!s) return null;
  const m = META_YEAR_RE.exec(String(s));
  return m ? m[0] : null;
}

/**
 * 派生带年份后缀的书名：返回新数组，不改 list 内的原对象（亦不触碰 KNOWN_DOMAINS 本身）。
 * 每项在原字段基础上新增：
 *   - officialTitle：原 title（官方全称，逐字不变，供需要"裸标题"的场景取用）；
 *   - title：officialTitle 或"officialTitle + 年份后缀"（取值链见上方头注）。
 * @param {Record<string, {effectiveDate?:string, issuedYear?:string}>} bookMeta
 *   data/book-meta.json 的解析结果（键＝域 key），通常整份传入即可，多余键自动忽略。
 * @param {Array<{key:string,title:string}>} [list=KNOWN_DOMAINS] 待派生的域元数据列表；
 *   默认整份 KNOWN_DOMAINS，亦可传 discoverDomains() 的返回值（逐项 spread 保留 dir/mainMd 等）。
 */
export function resolveDomainTitles(bookMeta, list = KNOWN_DOMAINS) {
  const bm = bookMeta || {};
  return list.map((dom) => {
    const officialTitle = dom.title;
    let title = officialTitle;
    if (!TITLE_YEAR_RE.test(officialTitle)) {
      const meta = bm[dom.key];
      const effYear = meta ? firstYear(meta.effectiveDate) : null;
      if (effYear) {
        title = `${officialTitle}（${effYear}年施行）`;
      } else {
        const issuedYear = meta ? firstYear(meta.issuedYear) : null;
        if (issuedYear) title = `${officialTitle}（${issuedYear}年发布）`;
      }
    }
    return { ...dom, officialTitle, title };
  });
}

export { KNOWN_BY_KEY };
