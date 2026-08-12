import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/settings.scss"
import { FullSlug, resolveRelative } from "../util/path"
import { SETTINGS_SLUG } from "../util/appPages"

/**
 * 独立设置页正文（v9，需求⑤）：仅在 content/设置/index 页渲染，
 * 挂 sharedPageComponents.afterBody（全站注入，非目标页返回 null、零开销），
 * 判定模式照 GraphExplorer 的 HOST_SLUG 先例。
 *
 * v10 改抽屉式双栏：左侧抽屉（返回钮 + 分类导航）+ 右侧面板区。旧形态的页头
 * （返回钮 + 「设置」大标题）与三分区平铺已删除——设置页沉浸布局本就隐掉了面包屑
 * 与页头三件，再挂一个大标题只是重复且扎眼；分区改由抽屉分类切换，不再一屏平铺。
 *
 * 三个分类：外观（主题模式 + 界面主题）· 批注（标记批注保存位置）·
 * 关于（图谱总览与专利库使用说明 + 联系方式）。
 * 服务端直出即以「外观」为激活态（分类钮与面板各带 is-active、aria-selected="true"），
 * 故首帧无闪跳、无 JS 时亦有正确初态。
 *
 * 本组件只输出空壳，回显与交互由 settings.inline.ts 在浏览器侧接管；
 * 该脚本随 SettingsButton（每页都有）以 beforeDOMLoaded 注入，此处只挂 css
 * （componentResources 以 Set 收集 css，与 SettingsButton 挂同一字符串自动去重）。
 * 中文文案硬编码在此（不动 quartz/i18n，先例：GraphExplorer、PageNav）。
 */

// 六套主题卡：键与 custom.scss 的 [data-style="…"] 覆盖块、settings.inline.ts
// 的 StyleKey 三处同名；色板 hex 是各套 --light/--dark/--secondary 的副本，
// 供卡片预览用（见 settings.scss 的 --swatch-* 定义，改主题色须两处同改）。
const THEME_CARDS: ReadonlyArray<{ key: string; name: string; desc: string }> = [
  { key: "xuanzhi", name: "宣纸", desc: "远山淡影" },
  { key: "shuimo", name: "水墨", desc: "山水泼墨" },
  { key: "qingci", name: "青瓷", desc: "缠枝莲纹" },
  { key: "zhulin", name: "竹林", desc: "竹枝疏影" },
  { key: "mushan", name: "暮山", desc: "群山暮霭" },
  { key: "xuanye", name: "玄夜", desc: "星月夜山" },
]

const SettingsPage: QuartzComponent = ({ fileData }: QuartzComponentProps) => {
  if (fileData.slug !== SETTINGS_SLUG) {
    return null
  }
  return (
    <div class="kb-settings-page">
      {/*
        左抽屉：返回入口在上、分类导航在下，与右侧面板区共用一条栅格基线。

        返回钮写成 `<a href>` 而非 `<button>`，是**服务端兜底**：href 指向首页，
        三条边界——① 脚本未执行（无 JS / 脚本报错）、② 深链直达设置页（新窗口首屏即本页）、
        ③ history.length ≤ 1 ——均由浏览器原生跳转（站内链接则由 SPA 路由接管）回首页，
        不依赖任何运行时状态。settings.inline.ts 仅在**确有历史**时把它升级为
        history.back()（preventDefault + stopPropagation），回到用户真正的来路页。
        该升级按 `.kb-settings-back` 取节点，故 class / href / 内部 svg 结构在本次
        改版中逐字保留，仅换了所处位置（页头 → 抽屉首行）。
      */}
      <aside class="kb-settings-drawer">
        <a
          class="kb-settings-back"
          href={resolveRelative(fileData.slug!, "index" as FullSlug)}
          aria-label="返回"
          title="返回"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M15 5.5 8.2 12l6.8 6.5" />
          </svg>
          <span>返回</span>
        </a>
        <nav class="kb-settings-cats" role="tablist" aria-label="设置分类">
          <button
            class="kb-settings-cat is-active"
            type="button"
            role="tab"
            aria-selected="true"
            data-pane="appearance"
          >
            外观
          </button>
          <button
            class="kb-settings-cat"
            type="button"
            role="tab"
            aria-selected="false"
            data-pane="anno"
          >
            批注
          </button>
          <button
            class="kb-settings-cat"
            type="button"
            role="tab"
            aria-selected="false"
            data-pane="about"
          >
            关于
          </button>
        </nav>
      </aside>

      {/*
        面板区：每个分类一个 .kb-settings-pane，分区（.kb-settings-sec）内部结构
        与平铺版逐字一致，只是外面套了一层面板。非激活面板的收起由 settings.scss
        的 `[data-panes-ready]` 门控——脚本绑定成功才落该属性，无 JS 时三个面板
        同时可见，内容零丢失。
      */}
      <div class="kb-settings-panes">
        <section class="kb-settings-pane is-active" data-pane-id="appearance">
          <section class="kb-settings-sec">
            <h2>主题模式</h2>
            <p class="kb-settings-desc">选择界面亮暗；「跟随系统」将随操作系统外观自动切换。</p>
            <div class="kb-settings-seg" role="radiogroup" aria-label="主题模式">
              <button
                type="button"
                role="radio"
                aria-checked="false"
                data-setting="themeMode"
                data-value="light"
              >
                浅色
              </button>
              <button
                type="button"
                role="radio"
                aria-checked="false"
                data-setting="themeMode"
                data-value="dark"
              >
                深色
              </button>
              <button
                type="button"
                role="radio"
                aria-checked="false"
                data-setting="themeMode"
                data-value="system"
              >
                跟随系统
              </button>
            </div>
          </section>

          <section class="kb-settings-sec">
            <h2>界面主题</h2>
            <p class="kb-settings-desc">
              六套古风配色，每套含浅色与深色两态，随主题模式切换；页面底色、各栏字体与图谱配色一并跟随。
            </p>
            <div class="kb-theme-grid" role="radiogroup" aria-label="界面主题">
              {THEME_CARDS.map((t) => (
                <button
                  class="kb-theme-card"
                  type="button"
                  role="radio"
                  aria-checked="false"
                  data-setting="style"
                  data-value={t.key}
                >
                  <span class="kb-theme-preview" aria-hidden="true"></span>
                  <span class="kb-theme-name">{t.name}</span>
                  <span class="kb-theme-desc">{t.desc}</span>
                </button>
              ))}
            </div>
          </section>
        </section>

        <section class="kb-settings-pane" data-pane-id="anno">
          <section class="kb-settings-sec">
            <h2>标记批注保存位置</h2>
            <p class="kb-settings-desc">
              下划线、高亮与笔记将自动保存为该目录下的 Markdown
              文件：按标记所在章节命名，高亮与划线保留格式，笔记以脚注形式保留在整段下方。
            </p>
            <p class="kb-settings-dir" data-setting-dir>
              未设置（仅桌面端可用）
            </p>
            <div class="kb-settings-row">
              <button type="button" data-setting="chooseDir">
                选择目录
              </button>
              <button type="button" data-setting="openAnno">
                批注管理
              </button>
            </div>
          </section>
        </section>

        {/*
          「关于」面板：纯静态展示，无交互控件。
          switchPane（settings.inline.ts）按 data-pane/data-pane-id 通配，无需任何脚本改动；
          邮箱锚点走浏览器原生 mailto（SPA 路由对非本源 URL 早退 + data-router-ignore 双保险），
          由 Electron 外部协议链路唤起系统邮件客户端，页面原地不动（desktop/main.cjs 有显式分支）。
        */}
        <section class="kb-settings-pane" data-pane-id="about">
          <section class="kb-settings-sec">
            <h2>图谱总览使用说明</h2>
            <p class="kb-settings-desc">
              「图谱总览」页把七部规范与术语组织为一张知识图谱：节点颜色代表所属文献，节点大小代表层级（书目最大、章节居中、小节与术语最小），节点标签随画面放大逐渐显现。
            </p>
            <div class="kb-settings-guide">
              <h3>视图操作</h3>
              <ul>
                <li>
                  滚轮缩放画面（0.05–4 倍）；按住空白处拖拽平移；点击「重置视图」一键回到全景。
                </li>
                <li>节点可直接拖拽调整位置，力导布局会实时回弹重排。</li>
              </ul>
              <h3>选中与联动阅读</h3>
              <ul>
                <li>
                  单击节点选中：相关节点保持常亮、其余变暗，右侧面板同步展示该知识点的简介、原文与相关知识点（变暗的节点不响应单击）。
                </li>
                <li>
                  双击任意节点把选中切换到它；点击空白处清除选中；悬停节点时其邻居高亮、其余淡出。
                </li>
              </ul>
              <h3>搜索与图例</h3>
              <ul>
                <li>顶部搜索框输入节点名称，回车或点击「定位」：目标节点描边高亮并平移居中。</li>
                <li>图例共 8 项（七部文献与术语），点击任一项可隐藏 / 恢复该类全部节点。</li>
                <li>术语层有独立三态开关：隐藏 / 弱化 / 显示，默认隐藏以突出文献骨架。</li>
              </ul>
              <h3>页内局部图</h3>
              <ul>
                <li>
                  每个章节页右栏另有局部关联图，仅显示与当前页直接相连的节点，点击即跳转对应页面。
                </li>
              </ul>
            </div>
          </section>

          <section class="kb-settings-sec">
            <h2>专利库使用说明</h2>
            <p class="kb-settings-desc">
              本库收录七部规范全文共 2077 页：专利法 82 条、实施细则 149 条、审查指南 6 部 38
              章、侵权判定指南 153
              条、机械与化学案件撰写规范、审查意见答复指引。全部内容完全离线，运行期不发出任何网络请求，无遥测、无账号。
            </p>
            <div class="kb-settings-guide">
              <h3>全文搜索</h3>
              <ul>
                <li>
                  <kbd>Ctrl/⌘ + K</kbd> 打开全文搜索（标题与正文），<kbd>Ctrl/⌘ + Shift + K</kbd>{" "}
                  切换为标签搜索。
                </li>
                <li>
                  <kbd>↑</kbd> <kbd>↓</kbd> 选择结果，<kbd>Enter</kbd> 打开，右侧实时预览命中位置。
                </li>
              </ul>
              <h3>批注</h3>
              <ul>
                <li>
                  选中正文文字即弹出工具条：复制、四色高亮（黄 / 绿 / 蓝 / 粉）、划线、笔记；笔记以{" "}
                  <kbd>⌘/Ctrl + Enter</kbd> 保存。
                </li>
                <li>
                  批注按页保存在本机，不上传任何服务器。在「批注」分类中可设置保存目录（桌面端自动落盘为
                  Markdown 文件），或打开批注管理抽屉，在抽屉底部整体导出 / 导入 JSON。
                </li>
              </ul>
              <h3>阅读辅助</h3>
              <ul>
                <li>
                  键盘翻页：<kbd>←</kbd> <kbd>→</kbd> 或 <kbd>[</kbd> <kbd>]</kbd> 切换上一节 /
                  下一节。
                </li>
                <li>
                  右下角进度环显示本页阅读进度，点击平滑回到顶部；左栏目录树自动定位当前小节。
                </li>
              </ul>
              <h3>术语与引用</h3>
              <ul>
                <li>
                  关键词索引收录 851 个术语词条，按 23
                  个主题分组；词条页含释义、出处、相关法条与相关术语。
                </li>
                <li>正文中的术语与法条引用（如「专利法第22条」）自动成链，点击即可跳转原文。</li>
              </ul>
            </div>
          </section>

          <section class="kb-settings-sec">
            <h2>联系作者</h2>
            <p class="kb-settings-desc">
              使用中遇到问题、发现内容错漏，或有功能建议，欢迎邮件联系。
            </p>
            <div class="kb-about-card">
              <p class="kb-about-row">
                <span class="kb-about-label">姓名</span>
                <span>张京京</span>
              </p>
              <p class="kb-about-row">
                <span class="kb-about-label">邮箱</span>
                <a
                  class="kb-about-mail"
                  href="mailto:zhangjingjing962464@gmail.com"
                  data-router-ignore
                >
                  zhangjingjing962464@gmail.com
                </a>
              </p>
            </div>
          </section>
        </section>
      </div>
    </div>
  )
}

SettingsPage.css = style

export default (() => SettingsPage) satisfies QuartzComponentConstructor
