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

      {/* 唤起批注抽屉；位置在回顶 FAB 上方，见 annotate.scss */}
      <button class="kb-anno-fab" type="button" aria-label="本页批注" title="本页批注">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>

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
