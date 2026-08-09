import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore
import script from "./scripts/settings.inline"
import style from "./styles/settings.scss"
import { classNames } from "../util/lang"

/**
 * 设置面板（v8）：主题模式（浅/深/跟随系统）· 界面风格（6 套 × 亮暗两态）·
 * 字体定制（左侧栏/标题/正文）· 标记批注保存位置。
 *
 * 本组件只输出按钮与面板空壳，交互与状态由 settings.inline.ts 在浏览器侧接管。
 * 主页面亮暗切换按钮（Darkmode）已从布局移除，统一收敛到本面板。
 * 中文文案硬编码在此（不动 quartz/i18n，先例：GraphExplorer、PageNav）。
 */
const Settings: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  return (
    <div class={classNames(displayClass, "kb-settings")}>
      <button class="kb-settings-btn" type="button" aria-label="设置" title="设置">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* 居中模态：遮罩磨砂 + 面板（Apple 规范） */}
      <div class="kb-settings-overlay" hidden>
        <div class="kb-settings-panel" role="dialog" aria-label="设置" aria-modal="true">
          <header class="kb-settings-head">
            <h3>设置</h3>
            <button class="kb-settings-close" type="button" aria-label="关闭">
              ×
            </button>
          </header>
          <div class="kb-settings-body">
          <section class="kb-settings-sec">
            <h4>主题模式</h4>
            <p class="kb-settings-desc">选择界面亮暗；「跟随系统」将随操作系统外观自动切换。</p>
            <div class="kb-settings-seg" role="radiogroup" aria-label="主题模式">
              <button type="button" data-setting="themeMode" data-value="light">
                浅色
              </button>
              <button type="button" data-setting="themeMode" data-value="dark">
                深色
              </button>
              <button type="button" data-setting="themeMode" data-value="system">
                跟随系统
              </button>
            </div>
          </section>

          <section class="kb-settings-sec">
            <h4>界面风格</h4>
            <p class="kb-settings-desc">每套风格含浅色与深色两套配色，随主题模式切换。</p>
            <div class="kb-settings-styles" role="radiogroup" aria-label="界面风格">
              <button type="button" data-setting="style" data-value="default">
                <span class="kb-style-swatch kb-style-default" aria-hidden="true" />
                默认
              </button>
              <button type="button" data-setting="style" data-value="paper">
                <span class="kb-style-swatch kb-style-paper" aria-hidden="true" />
                纸张
              </button>
              <button type="button" data-setting="style" data-value="ink">
                <span class="kb-style-swatch kb-style-ink" aria-hidden="true" />
                水墨
              </button>
              <button type="button" data-setting="style" data-value="ocean">
                <span class="kb-style-swatch kb-style-ocean" aria-hidden="true" />
                海洋
              </button>
              <button type="button" data-setting="style" data-value="midnight">
                <span class="kb-style-swatch kb-style-midnight" aria-hidden="true" />
                午夜
              </button>
              <button type="button" data-setting="style" data-value="graphite">
                <span class="kb-style-swatch kb-style-graphite" aria-hidden="true" />
                石墨
              </button>
            </div>
          </section>

          <section class="kb-settings-sec">
            <h4>字体设置</h4>
            <p class="kb-settings-desc">左侧栏、标题与正文可分别定制；「默认」表示使用系统默认字体。</p>
            <label class="kb-settings-field">
              <span>左侧栏</span>
              <select data-setting="font-left">
                <option value="">默认（默认）</option>
                <option value="pingfang">苹方</option>
                <option value="songti">宋体</option>
                <option value="heiti">黑体</option>
                <option value="kaiti">楷体</option>
                <option value="fangsong">仿宋</option>
                <option value="mono">等宽</option>
              </select>
            </label>
            <label class="kb-settings-field">
              <span>标题</span>
              <select data-setting="font-header">
                <option value="">默认（默认）</option>
                <option value="pingfang">苹方</option>
                <option value="songti">宋体</option>
                <option value="heiti">黑体</option>
                <option value="kaiti">楷体</option>
                <option value="fangsong">仿宋</option>
                <option value="mono">等宽</option>
              </select>
            </label>
            <label class="kb-settings-field">
              <span>正文</span>
              <select data-setting="font-body">
                <option value="">默认（默认）</option>
                <option value="pingfang">苹方</option>
                <option value="songti">宋体</option>
                <option value="heiti">黑体</option>
                <option value="kaiti">楷体</option>
                <option value="fangsong">仿宋</option>
                <option value="mono">等宽</option>
              </select>
            </label>
          </section>

          <section class="kb-settings-sec">
            <h4>标记批注保存位置</h4>
            <p class="kb-settings-desc">
              下划线、高亮与笔记将自动保存为该目录下的 Markdown 文件：按标记所在章节命名，高亮与划线保留格式，笔记以脚注形式保留在整段下方。
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
          </div>
        </div>
      </div>
    </div>
  )
}

Settings.beforeDOMLoaded = script
Settings.css = style

export default (() => Settings) satisfies QuartzComponentConstructor
