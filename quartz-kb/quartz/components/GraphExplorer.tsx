// 图谱总览专页宿主组件（W3）：仅在生成器产出的 0-图谱总览/index 页渲染，
// 挂 sharedPageComponents.afterBody（全站注入，非目标页返回 null、零开销），
// 布局：顶部玻璃工具条（搜索定位 + 域图例 + 重置视图）
//      左侧全量图画布（renderGraph 复用，nodeClickMode:"panel"，点击不跳转）
//      右侧玻璃侧栏阅读面板（标题面包屑/简介/详解/原文/相关知识点，交互见 graphexplorer.inline.ts）
// @ts-ignore
import script from "./scripts/graphexplorer.inline"
import styles from "./styles/graphexplorer.scss"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { D3Config } from "./Graph"

// 宿主页 slug，与生成器（W1）产出的 content/0-图谱总览/index.md 对应
const HOST_SLUG = "0-图谱总览/index"

/**
 * 专页全量图配置：
 * - depth -1 渲染全部节点；zoom/drag 开启；enableRadial 径向布局避免大图散射；
 * - nodeClickMode "panel"：点击节点派发 graphnodeselect 事件给侧栏，不做页面跳转；
 * - scale 初值取小，首屏尽量呈现全景；中文标签字号与全局图一致；
 * - termLayer "hidden" 默认隐藏术语层（骨架图先行，三态钮可切换）；
 *   zoomToFit 布局成形后自动整图入框；excludeSlugs 剔除链接全站的宿主页
 *   （与 quartz.layout.ts 的 globalGraph 配置一致）。
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
  excludeSlugs: ["0-图谱总览/"],
}

// 域图例：与 graph.inline.ts 的 SECTION_COLORS 一致（七部工具书 + 术语靛蓝）。
// v12：七部文档域项为可点击按钮（data-section 对应 slug 顶层数字前缀），
// 点击切换该域全部节点与连接关系的隐藏/显示；术语（9-）由术语层三态钮
// 单独控制，此处保持纯展示。
const LEGEND_ITEMS: Array<{ label: string; color: string; section?: string }> = [
  { label: "专利法", color: "#d1495b", section: "1" },
  { label: "实施细则", color: "#e07b39", section: "2" },
  { label: "审查指南", color: "#b8860b", section: "3" },
  { label: "侵权判定", color: "#4c9f70", section: "4" },
  { label: "机械撰写", color: "#2a9d8f", section: "5" },
  { label: "化学撰写", color: "#4381c1", section: "6" },
  { label: "答复OA", color: "#8e6bbf", section: "7" },
  { label: "术语", color: "#3f51b5" },
]

const GraphExplorer: QuartzComponent = ({ fileData }: QuartzComponentProps) => {
  if (fileData.slug !== HOST_SLUG) {
    return null
  }
  return (
    <div class="graph-explorer">
      {/* 顶部玻璃工具条：搜索定位 + 域图例 + 重置视图 */}
      <div class="ge-toolbar">
        <div class="ge-search">
          <input
            class="ge-search-input"
            type="text"
            placeholder="输入节点名称，回车定位…"
            aria-label="按节点名称搜索定位"
          />
          <button class="ge-search-btn" type="button">
            定位
          </button>
          <span class="ge-search-status" aria-live="polite"></span>
        </div>
        <div class="ge-legend" aria-label="知识域图例">
          {LEGEND_ITEMS.map((item) =>
            item.section !== undefined ? (
              <button
                class="ge-legend-item"
                type="button"
                data-section={item.section}
                aria-pressed="false"
                title={`点击隐藏/显示「${item.label}」的节点与连接`}
              >
                <i class="ge-legend-dot" style={`background-color: ${item.color}`}></i>
                {item.label}
              </button>
            ) : (
              <span class="ge-legend-item">
                <i class="ge-legend-dot" style={`background-color: ${item.color}`}></i>
                {item.label}
              </span>
            ),
          )}
        </div>
        {/* 术语层三态分段钮：默认隐藏（与 explorerGraphConfig.termLayer 一致），
            绑定见 graphexplorer.inline.ts */}
        <div class="ge-termlayer" role="group" aria-label="术语层显示模式">
          <span class="ge-termlayer-label">术语层</span>
          <span class="ge-term-group">
            <button
              class="ge-term-btn active"
              type="button"
              data-term-mode="hidden"
              aria-pressed="true"
            >
              隐藏
            </button>
            <button class="ge-term-btn" type="button" data-term-mode="dimmed" aria-pressed="false">
              弱化
            </button>
            <button class="ge-term-btn" type="button" data-term-mode="shown" aria-pressed="false">
              显示
            </button>
          </span>
        </div>
        <button class="ge-reset" type="button" title="恢复全景视图并清空侧栏">
          重置视图
        </button>
      </div>
      {/* 主体：左画布（renderGraph 渲染入此 div）+ 右玻璃侧栏 */}
      <div class="ge-body">
        <div class="ge-canvas" data-cfg={JSON.stringify(explorerGraphConfig)}></div>
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
