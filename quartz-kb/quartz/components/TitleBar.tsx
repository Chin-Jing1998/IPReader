import { QuartzComponent, QuartzComponentConstructor } from "./types"
import style from "./styles/titlebar.scss"

/**
 * 自绘标题条（桌面端 macOS `titleBarStyle: 'hiddenInset'`）。
 *
 * 系统标题栏在 hiddenInset 下不再绘制标题文本、页面内容延伸至窗口顶端，
 * 故应用名需由页面自绘一条固定条带补上；条带颜色随主题走 CSS 变量，
 * 这正是系统标题栏做不到的（需求⑥）。
 *
 * **始终 SSR 渲染，显隐全部交给 CSS**：静态构建期无法探知运行平台，
 * 无从在 SSR 阶段决定该不该输出这段 DOM。因此本组件无条件输出，
 * 由 `html[data-desktop]`（Electron + macOS 时于首帧写入，见 settings.inline.ts）
 * 与非移动端断点共同门控 `display`；浏览器打开同一份产物时门控不成立，
 * 标题条保持 `display: none`，对网页版零影响。
 *
 * 文本来源单一：`cfg.pageTitle` 与 `desktop/main.cjs` 里 BrowserWindow 的
 * `title` 同源（后者另有 `page-title-updated` 拦截固定窗口标题），
 * 两处显示因而恒等，不随 SPA 跳转漂移。
 *
 * `aria-hidden`：这是窗口 chrome 的视觉补齐件，非页面内容；站点标题已由
 * PageTitle 与 <title> 向辅助技术暴露，此处重复朗读只会造成冗余。
 */
// 标题条文字与应用名（productName=PatentReader）对齐，刻意不取 cfg.pageTitle——
// 显示名统一后二者当前同值，但窗口 chrome 应跟随应用身份而非站点配置：
// 独立常量保证将来 pageTitle 再调整时窗口标题不随动。
const APP_DISPLAY_NAME = "PatentReader"

const TitleBar: QuartzComponent = () => (
  <div class="kb-titlebar" aria-hidden="true">
    <span class="kb-titlebar-text">{APP_DISPLAY_NAME}</span>
  </div>
)

TitleBar.css = style

export default (() => TitleBar) satisfies QuartzComponentConstructor
