import { QuartzComponent, QuartzComponentConstructor } from "./types"
// @ts-ignore
import script from "./scripts/pageChrome.inline"

/**
 * 页面 chrome 的零渲染脚本宿主：正文影子滚动条。
 *（v11 曾同时承担页头滚动收缩，经用户验收裁决撤销。）
 *
 * 本组件不产出任何 DOM——轨道（.kb-pagescroll）由 pageChrome.inline.ts 在 nav 时
 * 注入 body、并在 addCleanup 中摘除（micromorph 只形变 body，SSR 出的轨道会与
 * 换页 diff 冲突，故不能在此渲染）。组件的唯一职责是把脚本挂进产物。
 *
 * 无 css：轨道/thumb 外观、原生滚动条槽宽归零全部落在
 * quartz/styles/custom.scss 第十五节。
 *
 * 页面维度的排除（移动端、图谱总览页、设置页）在脚本内按运行期条件判定，
 * 不在此处做 SSR 分支——静态构建期无从探知视口宽度。
 */
const PageChrome: QuartzComponent = () => null

PageChrome.afterDOMLoaded = script

export default (() => PageChrome) satisfies QuartzComponentConstructor
