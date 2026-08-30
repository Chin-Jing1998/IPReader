import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/settings.scss"
import { FullSlug, joinSegments, pathToRoot, resolveRelative } from "../util/path"
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
 * 四个分类：外观（主题模式 + 界面主题）· 批注（标记批注保存位置）·
 * MCP（接入 AI 助手的命令，按本机真实路径生成）·
 * 关于（产品信息与项目归属、检查更新、联系反馈 + 图谱与专利库使用说明）。
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
            data-pane="mcp"
          >
            MCP
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
          「MCP」面板：安装包内附一份打包好的 MCP 服务（Resources/mcp/server.mjs），
          接上之后 Claude Code、Codex 等 agent 就能直接检索这 76 部法规与实务文献。
          命令里的两处路径由 settings.inline.ts 从主进程取真实值填入——打包与开发两种
          形态、mac 与 Windows 两种平台，路径各不相同，在静态页里写死必错其三。

          两块内容互斥显示：服务可用时展示命令区（摘 data-mcp-block 的 hidden 并给
          data-mcp-fallback 补上 hidden），否则维持 SSR 初态——即只显示降级说明。
          这样 Web 形态与老安装包看到的是「此功能需桌面端」，而非一片空白或一条配不通的命令。
        */}
        <section class="kb-settings-pane" data-pane-id="mcp">
          <section class="kb-settings-sec kb-mcp" data-mcp-block hidden>
            <h2>接入 AI 助手</h2>
            <p class="kb-settings-desc">
              本应用内附一个 MCP 服务，接上之后，Claude Code、Codex 等支持 MCP 的 AI
              工具就能直接在这 76
              部法规与实务文献里检索、读原文、查术语、按条号溯源——不必再手动翻阅。
              复制下面对应的命令执行一次即可，无须另装 Node，也无须下载任何东西。
            </p>

            <div class="kb-mcp-cmds">
              <div class="kb-mcp-cmd">
                <div class="kb-mcp-cmd-head">
                  <span class="kb-mcp-cmd-name">Claude Code</span>
                  <button type="button" data-setting="copyMcp" data-mcp-target="claude">
                    复制命令
                  </button>
                </div>
                <code class="kb-mcp-code" data-mcp-cmd="claude"></code>
                <p class="kb-mcp-hint">
                  粘进终端执行一次即可，之后在会话里用 /mcp 可查看连接状态。
                </p>
              </div>

              <div class="kb-mcp-cmd">
                <div class="kb-mcp-cmd-head">
                  <span class="kb-mcp-cmd-name">Codex CLI</span>
                  <button type="button" data-setting="copyMcp" data-mcp-target="codex">
                    复制配置
                  </button>
                </div>
                <code class="kb-mcp-code" data-mcp-cmd="codex"></code>
                <p class="kb-mcp-hint">
                  粘贴进 <code>~/.codex/config.toml</code>。其他支持 MCP 的工具（如腾讯
                  WorkBuddy）在其 MCP 管理界面按同样的命令与参数填写即可。
                </p>
              </div>
            </div>

            <h3>可用的七个工具</h3>
            <ul>
              <li>
                <strong>search_kb</strong> ——
                全文检索，返回命中页面的标题、所属书目、层级路径与命中片段
              </li>
              <li>
                <strong>read_node</strong> —— 按节点读取正文原文，长文自动分页续读
              </li>
              <li>
                <strong>browse_toc</strong> —— 按层级浏览目录树
              </li>
              <li>
                <strong>lookup_term</strong> —— 查术语：释义、在各书中的出处、关联法条与相关术语
              </li>
              <li>
                <strong>find_law</strong> —— 按条号直达法条原文，并列出引用该条的全部章节
              </li>
              <li>
                <strong>related_nodes</strong> —— 取知识图谱关联，按边类型分组
              </li>
              <li>
                <strong>list_books</strong> —— 内容清单与规模
              </li>
            </ul>
            <p class="kb-mcp-note">
              该服务同样离线运行：它与 AI
              工具之间走进程管道，不开端口、不发网络请求，检索全部在本机完成。 服务文件位于{" "}
              <code class="kb-mcp-path" data-mcp-path></code>。
            </p>
          </section>

          <section class="kb-settings-sec" data-mcp-fallback>
            <h2>接入 AI 助手</h2>
            <p class="kb-settings-desc">
              桌面端内附一个 MCP 服务，接上之后，Claude Code、Codex 等支持 MCP 的 AI
              工具就能直接在这 76 部法规与实务文献里检索、读原文、查术语、按条号溯源。
              接入命令会按你这台电脑的实际路径生成，届时一键复制即可。
            </p>
            <p class="kb-settings-desc">当前环境未检测到该服务，请在桌面端应用中打开本页。</p>
          </section>
        </section>

        {/*
          「关于」面板：纯静态展示，唯一可交互的是赞赏码的原生 <details>（零脚本）。
          switchPane（settings.inline.ts）按 data-pane/data-pane-id 通配，无需任何脚本改动；
          两枚邮箱锚点走浏览器原生 mailto（SPA 路由对非本源 URL 早退 + data-router-ignore 双保险），
          由 Electron 外部协议链路唤起系统邮件客户端，页面原地不动（desktop/main.cjs 有显式分支）。
        */}
        <section class="kb-settings-pane" data-pane-id="about">
          {/*
            应用信息卡与联系卡并排（.kb-about-grid，移动端降单列）：两者同为
            「元信息」性质、内容都短，各自独占一整行时右侧会留下大片空白。
            并排的是两个完整的 .kb-settings-sec 而非两张裸卡——各自的 h2 与
            说明段随之留在自己的列内，分区语义不被打散；下方两份长篇使用说明
            仍按原样整幅铺开。
          */}
          <div class="kb-about-grid">
            <section class="kb-settings-sec">
              <h2>关于 IPReader</h2>
              <p class="kb-settings-desc">
                IPReader
                是面向知识产权实务的本地优先知识库桌面应用，将法规、司法解释与实务规范组织为可检索、可追溯、可批注的阅读工具。
                本项目由张京京独立设计、开发与维护；项目中使用的第三方软件、AI
                工具、协议客户端和构建环境仅作为工具或运行环境，不构成共同作者、共同权利人或项目维护者。
              </p>
              <div class="kb-about-card">
                <p class="kb-about-row">
                  <span class="kb-about-label">作者</span>
                  <span>张京京</span>
                </p>
                <p class="kb-about-row">
                  <span class="kb-about-label">版本</span>
                  {/* 桌面端由 settings.inline.ts 以 app.getVersion() 覆写，避免静态页版本信息滞后 */}
                  <span data-update-version>v1.5.6</span>
                </p>
                <p class="kb-about-row">
                  <span class="kb-about-label">内容</span>
                  <span>中国六大法域 76 部文献 · 5,963 个正文页</span>
                </p>
                <p class="kb-about-row">
                  <span class="kb-about-label">索引</span>
                  <span>1,743 个术语 · 7,706 个图谱节点</span>
                </p>
                <p class="kb-about-row">
                  <span class="kb-about-label">许可</span>
                  <span>代码 MIT · 内容许可见 CONTENT_LICENSE</span>
                </p>
              </div>

              {/*
                更新检查是应用唯一可能联网的功能，默认隐藏、默认关闭。
                hidden 由 settings.inline.ts 在确认 window.desktop.checkUpdate 存在后摘除；
                Web 形态下不显示点了无反应的按钮，桌面端则由主进程返回真实版本与开关状态。
              */}
              <div class="kb-update" data-update-block hidden>
                <div class="kb-settings-row">
                  <button type="button" data-setting="checkUpdate">
                    检查更新
                  </button>
                </div>
                <p class="kb-update-status" data-update-status aria-live="polite"></p>
                <label class="kb-update-auto">
                  <input type="checkbox" data-setting="autoCheckUpdate" />
                  <span>启动时自动检查更新</span>
                </label>
                <p class="kb-update-note">
                  仅向 GitHub 查询版本号，不下载任何文件，也不会自动安装。关闭此项则应用完全不联网。
                </p>
              </div>
            </section>

            <section class="kb-settings-sec">
              <h2>联系与反馈</h2>
              <p class="kb-settings-desc">
                如果发现内容错漏、链接失效或功能问题，请提供文献名称、章节路径和可复现步骤；功能建议也可通过以下方式提交。
              </p>
              {/*
                电话、微信与 QQ 保持纯文本，避免在离线应用中产生无效外部导航。
                邮箱锚点使用 data-router-ignore，交由系统邮件客户端处理；第一个邮箱地址
                是 smoke.cjs 的稳定探针，顺序不可调换。
              */}
              <div class="kb-about-card">
                <p class="kb-about-row">
                  <span class="kb-about-label">姓名</span>
                  <span>张京京</span>
                </p>
                <p class="kb-about-row">
                  <span class="kb-about-label">电话</span>
                  <span>18291402342</span>
                </p>
                <p class="kb-about-row">
                  <span class="kb-about-label">微信</span>
                  <span>China_Jing1998</span>
                </p>
                <p class="kb-about-row">
                  <span class="kb-about-label">QQ</span>
                  <span>3480989683</span>
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
                <p class="kb-about-row">
                  <span class="kb-about-label">邮箱</span>
                  <a
                    class="kb-about-mail"
                    href="mailto:zhangjingjing962464@icloud.com"
                    data-router-ignore
                  >
                    zhangjingjing962464@icloud.com
                  </a>
                </p>
              </div>

              <details class="kb-about-donate">
                <summary>请我喝杯咖啡</summary>
                <img
                  class="kb-about-donate-qr"
                  src={joinSegments(pathToRoot(fileData.slug!), "static/donate-alipay.jpg")}
                  alt="支付宝收款码"
                  width="180"
                  height="270"
                />
              </details>
            </section>
          </div>

          <section class="kb-settings-sec">
            <h2>图谱总览使用说明</h2>
            <p class="kb-settings-desc">
              「图谱总览」页把全库文献与术语组织为一张知识图谱：图谱节点按所属文献逐书着色，图例分组与显隐切换仍按法域归组进行，节点大小代表层级（书目最大、章节居中、小节与术语最小），节点标签随画面放大逐渐显现。5
              部程序政策类文件（规范性文件制定管理办法、规章制定程序规定、强国纲要、十五五规划、GB
              标准清单）不在图谱视图中显示，正文 / 目录 / 搜索不受影响。工具条首行另有「中国 →
              六法域标签」导航行，用于按法域整体筛选画面；其下的图例行仍可在此基础上继续做组级微调。
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
              <h3>法域标签行、搜索与图例</h3>
              <ul>
                <li>
                  工具条首行为「中国 →
                  法域标签」两级导航：国家层当前仅收录「中国」一枚，其下并列七枚标签——「全部」，以及专利、商标、著作权、竞争法、品种布图、综合程序六大法域。
                </li>
                <li>
                  点击任一法域标签，画面即只保留该法域的文献节点、其余暂时隐去，并自动复位视图回到全景；点「全部」恢复全部法域。标签行只做法域级筛选，术语层不受其影响，仍由术语层三态开关单独控制；筛选之后，下方图例可继续做单组显隐等组级微调。
                </li>
                <li>顶部搜索框输入节点名称，回车或点击「定位」：目标节点描边高亮并平移居中。</li>
                <li>
                  图例共 15 项：主干七部文献各一项，扩展入库的 76
                  部按法域归为七项——专利扩展、商标、商标审查指南、著作权、竞争法、品种布图（植物新品种与集成电路布图设计）、综合程序（跨法域的诉讼与执法程序、裁判要旨、刑事、海关、政策文件），末位为术语。点击任一项可隐藏
                  / 恢复该项全部节点。
                </li>
                <li>
                  扩展七项前另有「扩展」段控：点击一次隐藏全部 76
                  部扩展文献、只留主干七书骨架，再点一次恢复；单独点选其中某几项后，段控显示为虚线框（部分隐藏）。
                </li>
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
              本库收录 76 部文献全文。主干七部为：专利法 82 条、实施细则 149 条、审查指南 6 部 38
              章、侵权判定指南 153
              条、机械与化学案件撰写规范、审查意见答复指引；另有司法解释与最高人民法院知识产权法庭裁判要旨
              26 部，法律、行政法规、部门规章与规范性文件 43 部。
            </p>
            <div class="kb-settings-guide">
              <h3>目录导航</h3>
              <ul>
                <li>
                  左栏知识库目录按「中国 → 权利类型 → 文件归类」三级分组呈现：76
                  部文献先归入专利、商标、著作权、竞争法、品种布图、综合程序六类权利类型，各类之下再按法律、行政法规、部门规章与规范性文件、司法解释与裁判规则、审查与实务指引五类文件归类排列（第六类「政策文件与标准索引」现无在库文献，该层不显示）。
                </li>
                <li>
                  分组层本身只承担展开与收起，不指向具体页面；点击最末一层的文献条目才进入正文。
                </li>
              </ul>
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
                  关键词索引收录 1743 个术语词条，按 41
                  个主题分组；词条页含释义、出处、相关法条与相关术语。
                </li>
                <li>正文中的术语与法条引用（如「专利法第22条」）自动成链，点击即可跳转原文。</li>
              </ul>
            </div>
          </section>
        </section>
      </div>
    </div>
  )
}

SettingsPage.css = style

export default (() => SettingsPage) satisfies QuartzComponentConstructor
