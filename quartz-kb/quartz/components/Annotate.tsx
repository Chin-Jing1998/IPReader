import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore
import script from "./scripts/annotate.inline"
import style from "./styles/annotate.scss"
import { classNames } from "../util/lang"

/**
 * 选中文本标注（v7 需求7）：复制 / 高亮 / 下划线 / 笔记。
 *
 * 本组件只输出三件空壳——选区工具条、批注抽屉、唤起抽屉的按钮，
 * 内容全部由 annotate.inline.ts 在浏览器侧填充。
 * 图谱总览页是画布应用、正文只有一句导语，不渲染。
 *
 * 中文文案硬编码在此（不动 quartz/i18n，先例：GraphExplorer、PageNav）。
 */
const Annotate: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  if (fileData.slug === "0-图谱总览/index") {
    return null
  }
  return (
    <div class={classNames(displayClass, "kb-anno")}>
      {/* 选区工具条：定位由 floating-ui 写 transform，初始隐藏。
          提示与笔记输入都内联在此——alert/prompt 是阻塞式弹窗，
          在桌面端会弹出原生模态框，打断阅读且无法在无人值守时验证。 */}
      <div class="kb-anno-toolbar" hidden>
        <div class="kb-anno-acts">
          <button type="button" data-act="copy" title="复制所选文字">
            复制
          </button>
          <button type="button" data-act="underline" title="给所选文字加下划线">
            划线
          </button>
          <button type="button" data-act="note" title="为所选文字写笔记">
            笔记
          </button>
          <span class="kb-anno-sep" />
          <button type="button" data-act="color" data-color="yellow" title="黄色高亮" />
          <button type="button" data-act="color" data-color="green" title="绿色高亮" />
          <button type="button" data-act="color" data-color="blue" title="蓝色高亮" />
          <button type="button" data-act="color" data-color="pink" title="粉色高亮" />
        </div>
        <div class="kb-anno-compose" hidden>
          <textarea class="kb-anno-input" rows={2} placeholder="写下你的笔记，⌘/Ctrl+Enter 保存" />
          <div class="kb-anno-compose-acts">
            <button type="button" data-act="note-save">
              保存
            </button>
            <button type="button" data-act="note-cancel">
              取消
            </button>
          </div>
        </div>
        <p class="kb-anno-tip" hidden />
      </div>

      {/* 标记右键菜单：仅经 contextmenu 唤起，定位在鼠标处 */}
      <div class="kb-anno-ctxmenu" hidden>
        <button type="button" data-ctx="remove">删除该批注</button>
        <button type="button" data-ctx="close">取消</button>
      </div>

      {/* 悬浮笔记预览：mouseenter 后延迟出现 */}
      <div class="kb-anno-tip-pop" hidden />

      {/* 笔记气泡：左键点击笔记标记弹出 */}
      <div class="kb-anno-pop" hidden>
        <header class="kb-anno-pop-head">
          <h4>笔记</h4>
          <button class="kb-anno-pop-close" type="button" aria-label="关闭">
            ×
          </button>
        </header>
        <div class="kb-anno-pop-body" />
        <p class="kb-anno-pop-quote" />
      </div>

      {/* 批注抽屉改由设置面板的「批注管理」经 kb-anno-open-drawer 事件唤起 */}

      <aside class="kb-anno-drawer" hidden>
        <header class="kb-anno-head">
          <h3>本页批注</h3>
          <button class="kb-anno-close" type="button" aria-label="关闭">
            ×
          </button>
        </header>
        <div class="kb-anno-list" />
        <p class="kb-anno-drawer-tip" hidden />
        <footer class="kb-anno-foot">
          <button type="button" data-act="dump">
            导出全部
          </button>
          <label class="kb-anno-import-label">
            导入
            <input class="kb-anno-import" type="file" accept="application/json" hidden />
          </label>
        </footer>
      </aside>
    </div>
  )
}

Annotate.css = style
Annotate.afterDOMLoaded = script

export default (() => Annotate) satisfies QuartzComponentConstructor
