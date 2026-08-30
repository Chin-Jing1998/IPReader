import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/explorer.scss"

// @ts-ignore
import script from "./scripts/explorer.inline"
import { classNames } from "../util/lang"
import { i18n } from "../i18n"
import { FileTrieNode } from "../util/fileTrie"
import OverflowListFactory from "./OverflowList"
import { concatenateResources } from "../util/resources"

type OrderEntries = "sort" | "filter" | "map"

export interface Options {
  title?: string
  folderDefaultState: "collapsed" | "open"
  folderClickBehavior: "collapse" | "link"
  useSavedState: boolean
  /**
   * 默认展开的目录层级数（F5）：folderDefaultState 为 "collapsed" 时，
   * 深度 ≤ openLevels 的文件夹初始展开（深度 = slug 段数，顶层目录为 1）。
   * 仅在无 localStorage 保存态（fileTree-v2）时生效；缺省 0 = 维持全折叠旧行为。
   * 深度口径为渲染树层级——启用合成分组层后，第 1 层是「0-图谱总览 / 中国 /
   * 9-关键词索引」，书目录落在第 4 层（详见 explorer.inline.ts 的 defaultCollapsed）。
   */
  openLevels?: number
  sortFn: (a: FileTrieNode, b: FileTrieNode) => number
  filterFn: (node: FileTrieNode) => boolean
  mapFn: (node: FileTrieNode) => void
  order: OrderEntries[]
}

// ==== patent-kb: sortFn / filterFn / mapFn 已不再传给浏览器 ====
// 上游把这三个函数 toString() 写进 data-data-fns，由 explorer.inline.ts 用
// new Function 还原，迫使产物的 CSP 必须放行 'unsafe-eval'。现改为在
// explorer.inline.ts 内直接实现（sortNodes / keepNode），那里是唯一真相；
// 此处保留字段仅为满足 Options 类型与上游结构，其取值不再有任何运行时作用。
// ==== /patent-kb ====
const defaultOptions: Options = {
  folderDefaultState: "collapsed",
  folderClickBehavior: "link",
  useSavedState: true,
  mapFn: (node) => {
    return node
  },
  sortFn: (a, b) => {
    // Sort order: folders first, then files. Sort folders and files alphabeticall
    if ((!a.isFolder && !b.isFolder) || (a.isFolder && b.isFolder)) {
      // numeric: true: Whether numeric collation should be used, such that "1" < "2" < "10"
      // sensitivity: "base": Only strings that differ in base letters compare as unequal. Examples: a ≠ b, a = á, a = A
      return a.displayName.localeCompare(b.displayName, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    }

    if (!a.isFolder && b.isFolder) {
      return 1
    } else {
      return -1
    }
  },
  filterFn: (node) => node.slugSegment !== "tags",
  order: ["filter", "map", "sort"],
}

export type FolderState = {
  path: string
  collapsed: boolean
}

let numExplorers = 0
export default ((userOpts?: Partial<Options>) => {
  const opts: Options = { ...defaultOptions, ...userOpts }
  const { OverflowList, overflowListAfterDOMLoaded } = OverflowListFactory()

  const Explorer: QuartzComponent = ({ cfg, displayClass }: QuartzComponentProps) => {
    const id = `explorer-${numExplorers++}`

    return (
      <div
        class={classNames(displayClass, "explorer")}
        data-behavior={opts.folderClickBehavior}
        data-collapsed={opts.folderDefaultState}
        data-savestate={opts.useSavedState}
        data-open-levels={opts.openLevels ?? 0}
        data-data-fns={JSON.stringify({ order: opts.order })}
      >
        <button
          type="button"
          class="explorer-toggle mobile-explorer hide-until-loaded"
          data-mobile={true}
          aria-controls={id}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="lucide-menu"
          >
            <line x1="4" x2="20" y1="12" y2="12" />
            <line x1="4" x2="20" y1="6" y2="6" />
            <line x1="4" x2="20" y1="18" y2="18" />
          </svg>
        </button>
        {/*
          patent-kb（阶段5.8）：标题钮与动作组同处一行。**移动端汉堡钮刻意留在
          .explorer 的直接子层**（上方那枚）——explorer.scss 的
          `.hide-until-loaded ~ .explorer-content` 依赖它与内容区是兄弟，
          包进本容器即会打断该选择器。
        */}
        <div class="explorer-header">
          <button
            type="button"
            class="title-button explorer-toggle desktop-explorer"
            data-mobile={false}
            aria-expanded={true}
          >
            <h2>{opts.title ?? i18n(cfg.locale).components.explorer.title}</h2>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="5 8 14 8"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="fold"
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          {/*
            三枚钮 SSR 即 disabled，由 explorer.inline.ts 的 refreshHeaderActionState
            按各自判据放开——「脚本活着」才是它们可用的前提（无 JS 时点了不会有任何反应）。
            判据（阶段5.11）：收起钮＝树上尚有展开项；展开还原钮＝存在收起前快照；
            「恢复默认排序」＝存在自定义序，且另受 CSS 的 [data-has-custom-order] 门控，
            无自定义序时整枚不显示（display 控制，禁用 hidden 属性——目录树里的 hidden
            是法域过滤的专用信号）。
          */}
          <div class="explorer-actions">
            <button
              type="button"
              class="explorer-action explorer-action-collapse"
              disabled
              aria-disabled="true"
              title="全部收起（再点一次连当前页所在层级一起收起）"
              aria-label="全部收起"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="lucide-chevrons-up"
              >
                <polyline points="17 11 12 6 7 11"></polyline>
                <polyline points="17 18 12 13 7 18"></polyline>
              </svg>
            </button>
            {/*
              阶段5.11：一键收起的退路。位置固定在收起钮之后、恢复默认钮之前
              （恢复默认恒为动作组末位，且多数时候整枚隐藏）。
            */}
            <button
              type="button"
              class="explorer-action explorer-action-expand"
              disabled
              aria-disabled="true"
              title="展开还原（还原到收起前的展开状态）"
              aria-label="展开还原"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="lucide-chevrons-down"
              >
                <polyline points="7 6 12 11 17 6"></polyline>
                <polyline points="7 13 12 18 17 13"></polyline>
              </svg>
            </button>
            <button
              type="button"
              class="explorer-action explorer-action-reset"
              disabled
              aria-disabled="true"
              title="恢复默认排序（只清排序，不动展开状态）"
              aria-label="恢复默认排序"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="lucide-rotate-ccw"
              >
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
                <path d="M3 3v5h5"></path>
              </svg>
              <span class="explorer-action-confirm">确认恢复？</span>
            </button>
          </div>
        </div>
        <div id={id} class="explorer-content" aria-expanded={false} role="group">
          <OverflowList class="explorer-ul" />
        </div>
        <template id="template-file">
          <li>
            <a href="#"></a>
          </li>
        </template>
        <template id="template-folder">
          <li>
            <div class="folder-container">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="5 8 14 8"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="folder-icon"
              >
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
              <div>
                <button class="folder-button">
                  <span class="folder-title"></span>
                </button>
              </div>
            </div>
            <div class="folder-outer">
              <ul class="content"></ul>
            </div>
          </li>
        </template>
        {/*
          patent-kb（阶段5.8）：同级重排手柄。**刻意不并入 template-folder**——
          全库 1,395 个文件夹行里只有约 119 行开放重排（合成分组层的三层子项），
          其余 1,276 行若各带一枚手柄，等于凭空多出上千个节点与上千次事件绑定。
          由 explorer.inline.ts 的 attachDragHandle 对可重排行按需 clone。
          形态约束（对表冒烟既有断言）：必须是 button 而非 <a>（合成节点内 <a> 数
          恒为 0），不得带 .folder-title 类（标题取值按该类选择），且恒为
          .folder-container 的最后一个子元素（container 与 folder-outer 之间零插入）。
          tabindex=-1 + aria-hidden：拖拽是纯指针增强，键盘与读屏用户不受影响，
          Tab 序里也不该凭空多出上百个停靠点。
        */}
        <template id="template-drag-handle">
          <button type="button" class="explorer-drag-handle" tabindex={-1} aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="16"
              viewBox="0 0 10 16"
              fill="currentColor"
              class="drag-grip"
            >
              <circle cx="3" cy="3" r="1.1" />
              <circle cx="7" cy="3" r="1.1" />
              <circle cx="3" cy="8" r="1.1" />
              <circle cx="7" cy="8" r="1.1" />
              <circle cx="3" cy="13" r="1.1" />
              <circle cx="7" cy="13" r="1.1" />
            </svg>
          </button>
        </template>
      </div>
    )
  }

  Explorer.css = style
  Explorer.afterDOMLoaded = concatenateResources(script, overflowListAfterDOMLoaded)
  return Explorer
}) satisfies QuartzComponentConstructor
