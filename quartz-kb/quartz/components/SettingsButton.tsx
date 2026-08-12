import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore
import script from "./scripts/settings.inline"
import style from "./styles/settings.scss"
import { classNames } from "../util/lang"
import { FullSlug, resolveRelative } from "../util/path"
import { SETTINGS_SLUG } from "../util/appPages"

/**
 * 左栏快捷区（v9）：齿轮设置入口，与搜索 / 阅读模式同排。
 *
 * 齿轮是 `<a>` 而非 `<button>`：设置由 v8 的居中模态改为独立设置页
 * （content/设置/index.md + SettingsPage），跳转交给 SPA 路由——
 * spa.inline.ts 对点击目标做 `closest("a")` 拦截，本站内链天然走无刷新导航，
 * 无需在 settings.inline.ts 里写任何跳转代码。
 *
 * 明暗快捷钮已删除（v14 用户裁决）：左栏不再提供明暗翻转入口，明暗模式的
 * 唯一入口是设置页抽屉内的分段控件（浅色 / 深色 / 跟随系统，见 SettingsPage）。
 * 随之删除的还有 settings.inline.ts 的「块一」点击绑定与 settings.scss 的
 * 日/月图标显隐规则——快捷区现只剩齿轮一枚，容器类名 kb-quick 保留不变
 *（它是「快捷区」而非「三钮区」，custom.scss 第十四节仍按同一套几何统一齿轮
 * 与阅读模式钮）。
 *
 * 本组件承载 settings.inline.ts 的 beforeDOMLoaded——它同时是全站主题的
 * 首帧应用者，必须随「每页都有」的组件注入（SettingsPage 只在设置页渲染，
 * 挂不得）。中文文案硬编码在此（不动 quartz/i18n，先例：GraphExplorer、PageNav）。
 */
const SettingsButton: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  return (
    <div class={classNames(displayClass, "kb-quick")}>
      <a
        class="kb-settings-btn"
        href={resolveRelative(fileData.slug!, SETTINGS_SLUG as FullSlug)}
        aria-label="设置"
        title="设置"
      >
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
      </a>
    </div>
  )
}

SettingsButton.beforeDOMLoaded = script
SettingsButton.css = style

export default (() => SettingsButton) satisfies QuartzComponentConstructor
