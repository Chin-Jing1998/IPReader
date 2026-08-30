// 图谱总览专页宿主组件（W3）：仅在生成器产出的 0-图谱总览/index 页渲染，
// 挂 sharedPageComponents.afterBody（全站注入，非目标页返回 null、零开销），
// 布局：顶部玻璃工具条两行（① 中国｜法域标签｜搜索定位｜重置视图+退出阅读 ② 域图例 + 术语层）
//      左侧全量图画布（renderGraph 复用，nodeClickMode:"panel"，点击不跳转）
//      画布左上角浮动目录抽屉（阶段5.7 波B：法域→书→章→节三层，点行即 selectNode 定位）
//      右侧玻璃侧栏阅读面板（标题面包屑/简介/详解/原文/相关知识点，交互见 graphexplorer.inline.ts）
// @ts-ignore
import script from "./scripts/graphexplorer.inline"
import styles from "./styles/graphexplorer.scss"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { D3Config } from "./Graph"
import { GRAPH_EXCLUDE, GRAPH_SLUG, SETTINGS_EXCLUDE, GRAPH_HIDDEN_BOOKS } from "../util/appPages"
import { FIELD_ALL, FIELD_TABS, SECTION_GROUPS, groupsOfField } from "../util/graphSections"

// 宿主页 slug 取 appPages.GRAPH_SLUG（阶段5.3 批 B4）：此处原为本地字面量
// `const HOST_SLUG = "0-图谱总览/index"`，与 appPages 早已存在的同值常量、以及
// explorer.inline.ts 新增的目录联动门控构成三处字面量，改 slug 时极易漏改其一。
// 现统一引用同一常量，消费方清单见 appPages.GRAPH_SLUG 注释。

/**
 * 专页全量图配置：
 * - depth -1 渲染全部节点；zoom/drag 开启；enableRadial 径向布局避免大图散射；
 * - nodeClickMode "panel"：点击节点派发 graphnodeselect 事件给侧栏，不做页面跳转；
 * - scale 初值取小，首屏尽量呈现全景；中文标签字号与全局图一致；
 * - termLayer "hidden" 默认隐藏术语层（骨架图先行，三态钮可切换）；
 *   zoomToFit 布局成形后自动整图入框；excludeSlugs 剔除链接全站的宿主页
 *   与独立设置页（应用页非阅读页，常量见 quartz/util/appPages.ts），并追加
 *   GRAPH_HIDDEN_BOOKS（阶段5.1 摘出 SECTION_GROUPS 的 5 部文献，同一常量、
 *   与 quartz.layout.ts 的 globalGraph 配置一致，避免两处漂移；页内局部图刻意
 *   不排除，理由见 appPages.GRAPH_HIDDEN_BOOKS 的适用范围说明）。
 */
const explorerGraphConfig: D3Config = {
  drag: true,
  zoom: true,
  depth: -1,
  scale: 0.5,
  repelForce: 0.6,
  centerForce: 0.2,
  linkDistance: 30,
  fontSize: 0.55,
  opacityScale: 1,
  showTags: false,
  removeTags: [],
  focusOnHover: true,
  enableRadial: true,
  nodeClickMode: "panel",
  termLayer: "hidden",
  zoomToFit: true,
  excludeSlugs: [GRAPH_EXCLUDE, SETTINGS_EXCLUDE, ...GRAPH_HIDDEN_BOOKS],
}

// 域图例（v17）：项定义迁往 util/graphSections.ts 的 SECTION_GROUPS，与
// graph.inline.ts 的着色／显隐取键、graphexplorer.inline.ts 的切换逻辑同源——
// 三处共用一张组表，杜绝「颜色按法域分组、图例点击按单部文献生效」的错位。
//
// 图例点不再内联写死色值（D2）：色值真源是主题变量 --graph-section-1..14
// （custom.scss 六主题 × light/dark 覆盖块），图例点仅带 data-section（值为**组号**），
// 由 graphexplorer.scss 的 `.ge-legend-dot[data-section="N"]` 取变量上色——
// 与节点着色同源，主题切换时图例随 CSS 即时变色。
//
// 分三段渲染：
//   main 段  主干七书，各一项，可点切换（v12 行为不变）；
//   ext  段  扩展入库 76 部按法域归的 7 组，各一项，可点切换；段首另有「扩展」总控
//            （data-section-group="ext"），一次切换 7 组全体，三态：全显/部分隐/全隐；
//   term 段  术语，由术语层三态钮单独控制，故为不可点击的 span——data-section 只落在
//            其图例点上、不落在项本身，避免被 `.ge-legend-item[data-section]` 误绑。
// 段间以 .ge-legend-sep 发丝线切分；容器 flex-wrap，窄屏折行（版面测算见设计方案 §3-2）。
const MAIN_ITEMS = SECTION_GROUPS.filter((g) => g.tier === "main")
const EXT_ITEMS = SECTION_GROUPS.filter((g) => g.tier === "ext")
const TERM_ITEM = SECTION_GROUPS.find((g) => g.tier === "term")!

// 扩展段规模文案（阶段5.3 批 B2）：组数与部数一律构建期从组表算，不写死数字——
// 此处曾写死「7 个扩展法域（76 部文献）」，与 graphexplorer.inline.ts 内同样写死的
// 「6 个扩展法域（80 部文献）」在两轮改组后各自滞后到不同的错值。改为两侧同源派生后，
// SSR 初始 title 与脚本 syncGroupCtl 运行期回写的 title 恒等，改组表即两处同步更新。
const EXT_BOOK_COUNT = EXT_ITEMS.reduce((n, g) => n + g.prefixes.length, 0)
const EXT_SCALE_TEXT = `${EXT_ITEMS.length} 个扩展法域（${EXT_BOOK_COUNT} 部文献）`

// 国家/标签层级导航行（C-4；阶段5.11 波J 多选化）：工具条首行，粗粒度导航，
// 与其下的图例行分工——
//   本行  「中国 → 六法域标签」两级：点击把非术语组切成「只看已激活的这些法域」，
//         多枚可同选（再点一次取消），点「全部」或取空即回全域；
//   图例行 组级微调：单组显隐、扩展段控三态（沿用 v17 行为，一字未改）。
// 国家层本期只有中国一枚静态徽标，但仍以 .ge-country-list 容器 + data-country
// 承载，将来接入他国法域时只需往该容器追加同形制节点，不必再动布局。
// 标签钮共七枚：「全部」（data-field 取哨兵 FIELD_ALL）+ 六法域（data-field 取法域名），
// 交互脚本按 `[data-field]` 统一枚举，SSR 与脚本的钩子取值同源于 util/graphSections.ts。
// 初始态：无任何组被隐藏 ⇒ 「全部」高亮，与 graphexplorer.inline.ts 挂载时的
// syncAll() 反解结果一致（SSR 与首帧同步态不闪烁）。
const FIELD_TAB_ITEMS: ReadonlyArray<{ field: string; label: string; title: string }> = [
  { field: FIELD_ALL, label: "全部", title: "显示全部法域（术语层仍由术语层三态钮控制）" },
  ...FIELD_TABS.map((field) => ({
    field,
    label: field,
    title: `筛选「${field}」法域（${groupsOfField(field).length} 个域组）：可与其他法域同选，再点一次取消`,
  })),
]

const GraphExplorer: QuartzComponent = ({ fileData }: QuartzComponentProps) => {
  if (fileData.slug !== GRAPH_SLUG) {
    return null
  }
  return (
    <div class="graph-explorer">
      {/* 顶部玻璃工具条（两行；阶段5.11 波K 由四行压到两行）：
          第一行 .ge-fieldnav —— 中国徽标 ｜ 法域标签 ｜ 搜索定位 ｜ 重置视图 + 退出阅读；
          第二行 —— 域图例 + 术语层三态钮。
          四段之间一律用既有的 .ge-fieldnav-sep 发丝竖线分隔，视觉语言只此一种。 */}
      <div class="ge-toolbar">
        {/* 工具条首行（整行独占）：波K 之前只有「国家 → 法域标签」两段，右侧大片留白；
            现把搜索定位段与按钮段一并收进来，工具条因此少两行、画布等量增高。
            类名沿用 .ge-fieldnav 不改——smoke 步 32 的就绪探针与多处样式钩子都取它，
            改名是纯粹的连带风险，语义扩展在此注释交代即可。 */}
        <div class="ge-fieldnav">
          <div class="ge-country-list" role="group" aria-label="国家/地区">
            <span
              class="ge-country ge-country--tier1 active"
              data-country="CN"
              aria-current="true"
              title="第一级：法域范围（当前仅收录中国）"
            >
              <i class="ge-country-mark" aria-hidden="true"></i>
              中国
            </span>
          </div>
          <span class="ge-fieldnav-sep" aria-hidden="true"></span>
          <div class="ge-field-tabs" role="group" aria-label="法域标签">
            {FIELD_TAB_ITEMS.map((tab, i) => (
              <button
                class={i === 0 ? "ge-field-tab active" : "ge-field-tab"}
                type="button"
                data-field={tab.field}
                aria-pressed={i === 0 ? "true" : "false"}
                title={tab.title}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <span class="ge-fieldnav-sep" aria-hidden="true"></span>
          {/* 搜索定位段：placeholder 取短式「节点名称…」——首行分段后输入框只有约
              13rem，长提示会被截断成半句 */}
          <div class="ge-search">
            <input
              class="ge-search-input"
              type="text"
              placeholder="节点名称…"
              aria-label="按节点名称搜索定位"
            />
            <button class="ge-search-btn" type="button">
              定位
            </button>
            <span class="ge-search-status" aria-live="polite"></span>
          </div>
          <span class="ge-fieldnav-sep" aria-hidden="true"></span>
          {/* 按钮段：重置视图常驻，退出阅读只在阅读模式现身（CSS 门控）。
              分隔线置于本段**之前**，故退出阅读隐藏时本段仍有重置视图垫底，
              不会留下一条无所指的孤线。 */}
          <div class="ge-actions">
            <button class="ge-reset" type="button" title="恢复全景视图并清空侧栏">
              重置视图
            </button>
            {/* 退出阅读（阶段5.11 波K-3 逃生口，硬约束）：
                本页在阅读模式下把左栏整条 display:none（栅格退化单列、画布吃满整宽），
                而阅读模式的原切换钮 .readermode 正在左栏内——一旦进入就再无可见控件
                可退出（本页无快捷键、标题条也无该控件）。故在按钮段补这一枚。
                仅 html[reader-mode="on"] 时显示，门控写在 graphexplorer.scss，
                SSR 恒渲染、不做 JS 插入，避免首帧闪入。点击行为见 graphexplorer.inline.ts
                ——必须转派给原按钮，不得直写 html 属性。 */}
            <button
              class="ge-readerexit"
              type="button"
              title="退出阅读模式，恢复左侧目录栏"
              aria-label="退出阅读模式"
            >
              退出阅读
            </button>
          </div>
        </div>
        <div class="ge-legend" aria-label="知识域图例">
          {MAIN_ITEMS.map((item) => (
            <button
              class="ge-legend-item"
              type="button"
              data-section={item.id}
              aria-pressed="false"
              title={`点击隐藏/显示「${item.label}」的节点与连接`}
            >
              <i class="ge-legend-dot" data-section={item.id}></i>
              {item.label}
            </button>
          ))}
          <span class="ge-legend-sep" aria-hidden="true"></span>
          <button
            class="ge-legend-groupctl"
            type="button"
            data-section-group="ext"
            aria-pressed="true"
            title={`一次隐藏全部 ${EXT_SCALE_TEXT}，只留主干七书骨架`}
          >
            扩展
          </button>
          {EXT_ITEMS.map((item) => (
            <button
              class="ge-legend-item ge-legend-item--ext"
              type="button"
              data-section={item.id}
              aria-pressed="false"
              title={`点击隐藏/显示「${item.label}」的节点与连接`}
            >
              <i class="ge-legend-dot" data-section={item.id}></i>
              {item.label}
            </button>
          ))}
          <span class="ge-legend-sep" aria-hidden="true"></span>
          <span class="ge-legend-item">
            <i class="ge-legend-dot" data-section={TERM_ITEM.id}></i>
            {TERM_ITEM.label}
          </span>
          {/* 术语层三态分段钮：默认隐藏（与 explorerGraphConfig.termLayer 一致），
              绑定见 graphexplorer.inline.ts。
              位置（阶段5.11 波K 用户复核后定案）：**紧跟「● 术语」图例项**，同处
              图例段末尾——控件与它所控的那一项相邻，读者不必在行首行尾之间来回找。
              原「术语层」前缀字样随之删除：左邻的图例项文字已经是「术语」，再写一遍
              是同义重复；无障碍语义由本容器的 role=group + aria-label 承担，未削弱。
              ⚠️ 刻意**不**在此加 .ge-legend-sep：graphexplorer.inline.ts 的 legendSeps
              以 `.ge-legend > .ge-legend-sep` 取数并按下标 [0]=主干|扩展、[1]=扩展|术语
              消费，smoke 步 28 另有 `sepHidden.length === 2` 硬断言，多加一条即两处同时失配。 */}
          <div class="ge-termlayer" role="group" aria-label="术语层显示模式">
            <span class="ge-term-group">
              <button
                class="ge-term-btn active"
                type="button"
                data-term-mode="hidden"
                aria-pressed="true"
              >
                隐藏
              </button>
              <button
                class="ge-term-btn"
                type="button"
                data-term-mode="dimmed"
                aria-pressed="false"
              >
                弱化
              </button>
              <button class="ge-term-btn" type="button" data-term-mode="shown" aria-pressed="false">
                显示
              </button>
            </span>
          </div>
        </div>
      </div>
      {/* 主体：左画布（renderGraph 渲染入此 div）+ 目录抽屉 + 右玻璃侧栏 */}
      <div class="ge-body">
        <div class="ge-canvas" data-cfg={JSON.stringify(explorerGraphConfig)}></div>
        {/* 目录导航抽屉（阶段5.7 波B-B2）：画布左上角的浮动抽屉，
            「法域 → 书 → 章 → 节」三层，点目录行等同图内 selectNode 定位。
            DOM 位置刻意挂在 `.ge-body` 内、`.ge-canvas` **之后**、`.ge-panel` 之前：
            放进 .ge-canvas 会被 createGraphInstance 的 removeAllChildren 与 crossfade
            的 stale 快照静默删除（图谱每次重建都清空该容器）；挂在这里则由
            graphexplorer.scss 的绝对定位脱流覆盖到画布上，既不参与 flex 分宽、
            也不触发 .ge-canvas 的 ResizeObserver（波A-A3 装的那只）。
            树体是空壳，由 graphexplorer.inline.ts 在首次点开时惰性填充——
            89 行（6 法域 + 83 书）DOM 只在用户真的要用目录时才产生，
            不点则图谱首开成本一分不付。 */}
        <div class="ge-toc">
          <button
            class="ge-toc-toggle"
            type="button"
            aria-expanded="false"
            aria-controls="ge-toc-drawer"
            title="打开目录导航：按「法域 → 书 → 章 → 节」定位到图内节点"
          >
            <i class="ge-toc-toggle-icon" aria-hidden="true"></i>
            目录
          </button>
          <div class="ge-toc-drawer" id="ge-toc-drawer" hidden>
            <div class="ge-toc-head">
              <span class="ge-toc-heading">目录导航</span>
              {/* 清空(N)（阶段5.10 波C-b）：多选态下才现身，hidden 与文案里的 N
                  由 graphexplorer.inline.ts 的 syncTocClear 维护。初始无选中故 hidden */}
              <button
                class="ge-toc-clear"
                type="button"
                hidden
                title="清空当前多选的全部节点（与点击画布空白处同义）"
              >
                清空(0)
              </button>
              {/* 波C-c：语义由「点目录项后不自动收起」升为**常开锁**——
                  开启后鼠标移出抽屉也不再自动收起，故文案改「常开」；
                  localStorage 键 graph-toc-pinned 保持不变（老用户的偏好继续生效） */}
              <button
                class="ge-toc-pin"
                type="button"
                aria-pressed="false"
                title="常开：抽屉保持展开，鼠标移出也不自动收起（该选择会被记住）"
              >
                常开
              </button>
              <button class="ge-toc-close" type="button" title="收起目录">
                收起
              </button>
            </div>
            <div class="ge-toc-tree" role="tree" aria-label="法规目录导航"></div>
          </div>
        </div>
        <aside class="ge-panel">
          {/* 初始空态：提示点击节点；选中节点后由 inline 脚本填充 ge-panel-content */}
          <div class="ge-panel-empty">
            <p>点击图中任意节点，在此阅读该知识点的简介、详解与原文。</p>
            <p>亦可在上方输入节点名称定位。</p>
          </div>
          <div class="ge-panel-content" hidden></div>
        </aside>
      </div>
    </div>
  )
}

GraphExplorer.css = styles
GraphExplorer.afterDOMLoaded = script

export default (() => GraphExplorer) satisfies QuartzComponentConstructor
