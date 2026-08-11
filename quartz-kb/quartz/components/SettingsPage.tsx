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
 * 两个分类：外观（主题模式 + 界面主题）· 批注（标记批注保存位置）。
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
        </nav>
      </aside>

      {/*
        面板区：每个分类一个 .kb-settings-pane，分区（.kb-settings-sec）内部结构
        与平铺版逐字一致，只是外面套了一层面板。非激活面板的收起由 settings.scss
        的 `[data-panes-ready]` 门控——脚本绑定成功才落该属性，无 JS 时两个面板
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
      </div>
    </div>
  )
}

SettingsPage.css = style

export default (() => SettingsPage) satisfies QuartzComponentConstructor
