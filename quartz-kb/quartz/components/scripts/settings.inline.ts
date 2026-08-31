// 设置（v9）：主题模式（浅/深/跟随系统）· 界面主题（六套古风 × 亮暗两态）· 批注保存目录。
//
// 加载时机：beforeDOMLoaded（head 内，随 SettingsButton 注入）——启动即落 saved-theme
// 与 data-style，避免首帧闪烁；UI 事件在 nav 后绑定（沿用 quartz 内置 Darkmode 组件
// （已删除）的装载模式）。
// 状态桶：localStorage kb-settings:v1（键名不升版：升版会连带丢掉 annoDir）。
//
// ⚠️ 生命周期纪律（bug#1 本体，勿再犯）：
//   prescript.js 带 data-persist，全会话仅执行一次 —— 模块级监听器不得进 nav cleanup。
// 具体到本文件：systemMedia（跟随系统的 matchMedia 监听）的摘与挂完全归 applyThemeMode
// 一处管理（模块级单例，每次调用先摘旧、system 分支再装新）。v8 曾在 nav cleanup 里
// 摘除它却无人重挂，导致「跟随系统」在首次 SPA 导航后永久失效。nav cleanup 只允许摘除
// 该次 nav 内绑定的 UI 监听器。
//
// 主题兼容协议：应用主题时写 saved-theme 属性 + localStorage("theme") 并派发 themechange
// 事件（detail 带 theme 与 style）——图谱 / mermaid / comments 均监听该事件重绘；
// 切换界面主题同样派发，且属性先落、事件后发：监听方在同步回调里 getComputedStyle
// 取色，顺序反了会读到上一套主题的色值。
//
// 切换的「同帧」纪律（v13，见下方 commitTheme 与 custom.scss 第十七节）：
// 一切**运行期**的主题写入（设置页明暗段 / 主题卡 / 跟随系统翻转 /
// IPC 权威态纠正）必须经 commitTheme 提交，绝不直接调 applyThemeMode / applyStyle
// / setTheme —— 直接调等于绕开整页叠化，那一次切换会退回「各区域各自渐变」的观感。
// 唯一例外是文件末尾的首帧应用块（此时页面尚在首屏渲染，叠化只会让启动闪一下）。

type ThemeMode = "light" | "dark" | "system"
type StyleKey = "xuanzhi" | "shuimo" | "qingci" | "zhulin" | "mushan" | "xuanye"

type KbSettings = {
  themeMode: ThemeMode
  style: StyleKey
  annoDir: string
}

const SETTINGS_KEY = "kb-settings:v1"
const STYLE_KEYS: ReadonlySet<string> = new Set([
  "xuanzhi",
  "shuimo",
  "qingci",
  "zhulin",
  "mushan",
  "xuanye",
])

// v8 五套旧风格 → v9 六套古风主题的就地迁移（键名不升版，故在 loadSettings 读时映射）。
// 取近似原则：纸感归宣纸、冷灰归水墨、蓝调归玄夜、紫调归暮山；未知值一律回落宣纸。
const LEGACY_STYLE: Readonly<Record<string, StyleKey>> = {
  default: "xuanzhi",
  paper: "xuanzhi",
  ink: "shuimo",
  ocean: "xuanye",
  midnight: "mushan",
  graphite: "shuimo",
}

const DEFAULTS: KbSettings = {
  themeMode: "system",
  style: "xuanzhi",
  annoDir: "",
}

function normalizeStyle(v: unknown): StyleKey {
  if (typeof v !== "string") {
    return DEFAULTS.style
  }
  if (STYLE_KEYS.has(v)) {
    return v as StyleKey
  }
  return LEGACY_STYLE[v] ?? DEFAULTS.style
}

function normalizeMode(v: unknown): ThemeMode {
  return v === "light" || v === "dark" || v === "system" ? v : DEFAULTS.themeMode
}

function loadSettings(): KbSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) {
      return { ...DEFAULTS }
    }
    // v8 的 fonts 字段读时直接忽略（字体设置已删除），下次 saveSettings 自然落掉
    const p = JSON.parse(raw) as Partial<KbSettings>
    return {
      themeMode: normalizeMode(p.themeMode),
      style: normalizeStyle(p.style),
      annoDir: typeof p.annoDir === "string" ? p.annoDir : "",
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveSettings(s: KbSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    // 配额写满静默：设置不落盘不阻塞使用
  }
}

// 暴露给 annotate.inline.ts：读取批注保存目录（落盘触发时用）
const kbSettingsApi = {
  getAnnoDir: (): string => loadSettings().annoDir,
}
;(window as unknown as { kbSettings?: typeof kbSettingsApi }).kbSettings = kbSettingsApi

// ---------- 桌面壳桥接 ----------

type DesktopBridge = {
  // preload.cjs 侧恒为 true / process.platform === 'darwin'；两项在此均为可选，
  // 旧产物与浏览器环境下取到 undefined 即自动降级（不落 data-desktop、不显标题条）
  isDesktop?: boolean
  isMac?: boolean
  setThemeSource?: (mode: string, bgColor: string) => void
  // 新壳（invoke 往返）：主进程落定 nativeTheme.themeSource 后回传权威
  // shouldUseDarkColors，用于消除「跟随系统」的双跳（bug#2）；旧壳上恒为 undefined。
  applyThemeSource?: (mode: string, bgColor: string) => Promise<{ dark: boolean } | undefined>
  chooseAnnoDir?: () => Promise<string | null>
  // 更新检查（v9，仅新壳）：旧壳与浏览器环境下四项均为 undefined，
  // 关于页的更新区块因此保持 hidden，不会露出点了没反应的按钮。
  getUpdateConfig?: () => Promise<{ version: string; autoCheck: boolean; releasesUrl: string }>
  setAutoCheckUpdate?: (enabled: boolean) => Promise<{ autoCheck: boolean }>
  checkUpdate?: () => Promise<UpdateResult>
  openReleases?: (url?: string) => Promise<boolean>
  getMcpInfo?: () => Promise<McpInfo>
  copyText?: (text: string) => Promise<boolean>
}

type McpInfo = {
  available: boolean
  serverPath: string
  execPath: string
  platform: string
}

type UpdateResult = {
  status: "update" | "latest" | "error"
  current: string
  latest?: string
  url?: string
  notes?: string
  message: string
}

function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { desktop?: DesktopBridge }).desktop
}

/**
 * 把「主题模式 + 当前主题实际底色」报给 Electron 主进程（bug#2 渲染侧）。
 * 原生窗口底色是「网页首帧渲染前」与「关窗合成间隙」用户唯一看得见的颜色，
 * 不同步就会在深色主题下关窗白闪。
 * bgColor 必须是 trim 过的 hex：getComputedStyle 的返回值带前导空格，
 * 主进程侧按 hex 正则校验，不合格（含 rgb() 形式）会被静默丢弃。
 * 首帧可行性：index.css 的 link 排在 prescript 之前且阻塞渲染，此时变量已可读。
 *
 * 返回值：新壳走 applyThemeSource（invoke 往返）时解析为主进程回传的权威亮暗态；
 * 旧壳、浏览器环境与 invoke 失败一律解析为 undefined，调用方据此跳过纠正逻辑。
 */
function reportDesktopTheme(mode: ThemeMode): Promise<boolean | undefined> {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--light").trim()
  const bridge = desktopBridge()
  if (bridge?.applyThemeSource) {
    // catch 不可省：主进程未注册对应 handler 时 invoke 会 reject，
    // 吞掉后行为等同旧壳的单向 send（仍双跳，但不抛未处理拒绝）。
    return bridge
      .applyThemeSource(mode, bg)
      .then((r) => r?.dark)
      .catch(() => undefined)
  }
  bridge?.setThemeSource?.(mode, bg)
  return Promise.resolve(undefined)
}

// ---------- 当前态读取（DOM 即事实源，避免与 localStorage 二次同步） ----------

function readSavedTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("saved-theme") === "dark" ? "dark" : "light"
}

function readThemeMode(): ThemeMode {
  return normalizeMode(document.documentElement.dataset.themeMode)
}

function readStyleKey(): StyleKey {
  return normalizeStyle(document.documentElement.dataset.style)
}

function dispatchThemeChange(theme: "light" | "dark", style: StyleKey): void {
  const event: CustomEventMap["themechange"] = new CustomEvent("themechange", {
    detail: { theme, style },
  })
  document.dispatchEvent(event)
}

// ---------- 整页同帧叠化（View Transitions） ----------
//
// 【为什么必须有这一层】用户诉求：明暗切换时全页所有区域同一时刻、同一节奏完成变色。
// 单靠 custom.scss 第七节的 260ms 过渡清单做不到。实测（Electron 43 / Chromium 150、
// 宣纸亮→暗、正文页、rAF 逐帧采 computed style）修前各区域落定时刻：
//   ·  24ms 瞬变：art 底纹（body background-image 不可过渡）、术语链接文字色；
//   · 287ms：140ms 交互档（正文内链文字、目录树条目、词条链接下划线）；
//   · 341ms：260ms 暗色档的「面」（body 底、左栏玻璃 ::before、右栏卡、标题条底）；
//   · 566ms：正文段落 / 面包屑文字 / 标题条文字；582ms：页面标题 h1；
//   · 589ms：局部图画布（PixiJS 自己的交叉淡入）。
// 跨度约 565ms ≈ 目标窗口的 2.2 倍，正是用户所说「每个区域单独切换变色」。
// 其中 566–582ms 那一族不是清单漏项：Web Animations API 实证显示，祖先（body /
// article）与后代同时过渡 color 时，后代的 CSSTransition 被**逐帧重建**（同一元素
// 一次切换内新建 5–7 个过渡对象），要等祖先落定后才真正跑完整一轮 260ms，实际收敛
// ≈ 2×260ms。对照实验：把 body/article 的过渡清单去掉 color 后，h1 / article p /
// .kb-titlebar 立刻回到「1 个过渡对象、292ms 落定」。改清单治不了这一层——除非让
// 祖先不再过渡文字色，那又会把祖先自己的文字变成瞬变，只是把错位挪了个位置。
//
// 【解法】把主题写入包进 document.startViewTransition：旧态整页快照与新态整页快照
// 做一次 260ms opacity 叠化（伪元素时长/缓动在 custom.scss 第十七节对齐
// --duration-theme / --ease-in-out），所有区域按定义同帧同节奏。
// 【关键：新快照必须拍到终态】写入回调内同步给 <html> 落 data-kb-vt，第十七节据此
// 以 !important 抑制全部 transition，使新快照拍到的是终值而非中间色。不加这一步实测
// **更糟**：Chromium 的 ::view-transition-new(root) 是活的，叠化期两张快照几近同色，
// 画面到 240ms 才动、331ms 一次性硬切（比现状的分段渐变更像"卡一下再跳"）。
// 【渐进增强】无 startViewTransition、prefers-reduced-motion、或首帧未就绪时一律直写，
// 原样退回既有 260ms 清单（第七节）与第八节的 80ms 降级档，两条路径都要保持可用。

type ViewTransitionLike = {
  finished: Promise<void>
  updateCallbackDone: Promise<void>
  skipTransition: () => void
}
type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionLike
}

// UI 就绪门：首帧（prescript 在 head 内执行，body 尚不存在）与首帧的 IPC 权威态纠正
// 一律直写不叠化——那时页面还在首屏渲染，叠一层整页交叉淡入等于启动时闪一下。
// nav 首次触发即置 true（SPA 导航后保持 true，属性挂在 <html> 上不随 body 形变丢失）。
let uiReady = false

// 重入护栏（连点切换）：Chromium 实测在前一次未决时再起一次，前后两个 finished 均
// resolve、不抛异常，视觉上是前一次被截断、后一次接管。令牌的作用不是拦截第二次，
// 而是保证 data-kb-vt 只由**最后一次**的清理逻辑摘除——否则前一次的 double-rAF
// 回调会在后一次正在捕获新快照时把抑制态摘掉，后一次的新快照就拍到中间色。
let vtToken = 0
let activeVT: ViewTransitionLike | null = null

/**
 * 主题写入的唯一提交口：把 mutate 包进整页叠化。
 * mutate 内的一切 DOM 写入（属性、themechange 派发、设置页回显）都落在同一次样式
 * 更新里，故新快照是原子终态；调用方不得在 commitTheme 之外另做与主题相关的写入
 * ——那部分会被算进「旧快照」，观感上先于叠化瞬变一下。
 */
function commitTheme(mutate: () => void): void {
  const doc = document as ViewTransitionDocument
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  if (!uiReady || reduceMotion || typeof doc.startViewTransition !== "function") {
    mutate()
    return
  }
  // 显式跳过前一次：不依赖「后起者自动作废前者」的实现细节，行为可预期
  activeVT?.skipTransition()
  const token = ++vtToken
  const release = (): void => {
    // 令牌守卫：更晚的一次切换已接管抑制态，交给它摘（见上方重入护栏注）
    if (token !== vtToken) {
      return
    }
    delete document.documentElement.dataset.kbVt
  }
  const vt = doc.startViewTransition(() => {
    // 抑制与写入同处一次样式更新：新快照因此拍到终态
    document.documentElement.dataset.kbVt = "1"
    mutate()
  })
  activeVT = vt
  // 双 rAF 后摘抑制：此刻新快照已拍定，且各属性早已是终值，摘除不产生任何值变化，
  // 故不会触发一轮迟到的 260ms 过渡（实测 computed style 全程 1 步、落定 ≈40ms）。
  vt.updateCallbackDone.then(
    () => requestAnimationFrame(() => requestAnimationFrame(release)),
    release,
  )
  const clear = (): void => {
    if (activeVT === vt) {
      activeVT = null
    }
    release()
  }
  vt.finished.then(clear, clear)
}

// ---------- 主题模式 ----------

function setTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("saved-theme", theme)
  try {
    localStorage.setItem("theme", theme)
  } catch {
    // ignore
  }
  dispatchThemeChange(theme, readStyleKey())
}

let systemMedia: MediaQueryList | null = null

// 模块级单调令牌，严禁进 nav cleanup（同 systemMedia，见文件头纪律）：
// 每次 applyThemeMode 自增一次，用于丢弃 IPC 往返期间已被后续切换作废的陈旧权威态。
let themeSeq = 0

function onSystemChange(e: MediaQueryListEvent): void {
  // 走统一提交口：跟随系统的外观翻转与手动切换共用同一次整页叠化（坑 e）
  commitTheme(() => {
    setTheme(e.matches ? "dark" : "light")
    // 系统外观翻转同样换底色：不补这一报，system 模式下主进程窗口底色会停在翻转前那一侧
    reportDesktopTheme("system")
  })
}

function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.dataset.themeMode = mode
  // 监听器生命周期单点（见文件头纪律）：先摘旧，仅 system 分支再装新
  if (systemMedia !== null) {
    systemMedia.removeEventListener("change", onSystemChange)
    systemMedia = null
  }
  if (mode === "system") {
    systemMedia = window.matchMedia("(prefers-color-scheme: dark)")
    systemMedia.addEventListener("change", onSystemChange)
    // 首选即时值：Electron 下 themeSource 若仍停在上一次的强制值，
    // prefers-color-scheme 此刻报的就是那个旧值，由下方权威态纠正一次（bug#2）。
    setTheme(systemMedia.matches ? "dark" : "light")
  } else {
    setTheme(mode)
  }
  // 上报并消费主进程回传的权威亮暗态。三重守卫：令牌（丢弃陈旧往返结果）、
  // 模式（仅 system 需要权威态）、幂等（同值不再派发 themechange）。
  //
  // ⚠️ 顺序红线（v13）：本函数整体必须由 commitTheme 包裹调用，绝不可反过来把
  // commitTheme 塞进 setTheme 内部。塞进去的话上面那次 setTheme 会被推迟到叠化回调
  // （约 40ms 后）执行，而 IPC 往返可能先于它落定，下面的 readSavedTheme() 就会读到
  // 写入前的旧值，幂等守卫失效、多写一次 saved-theme —— 即 bug#2 的双跳复发
  // （smoke 步骤 24 正是该竞态的回归门）。
  const seq = ++themeSeq
  void reportDesktopTheme(mode).then((dark) => {
    if (dark === undefined) return
    if (seq !== themeSeq) return // 期间用户又切了模式，丢弃陈旧结果
    if (readThemeMode() !== "system") return // 仅 system 模式消费权威态
    const next = dark ? "dark" : "light"
    // 幂等守卫：同值不再派发 themechange；确需纠正时也走叠化（它是一次真实的亮暗变更）
    if (readSavedTheme() !== next) commitTheme(() => setTheme(next))
  })
}

// ---------- 界面主题 ----------

// 只落属性、不派发不上报：拆出来供首帧使用（首帧需要 data-style 先于上报落定，
// 见下方首帧块）。写入保持原子（单条语句，无中间态）。
function writeStyle(style: StyleKey): void {
  document.documentElement.dataset.style = style
}

function applyStyle(style: StyleKey): void {
  writeStyle(style)
  // 属性先落、事件后发（监听方同步取色）；detail.style 供图谱区分「换风格」与「换亮暗」
  dispatchThemeChange(readSavedTheme(), style)
  // 换主题即换底色，原生窗口背景需同步，否则关窗仍闪上一套主题的底；
  // 此处只需换底色、不消费权威亮暗态，故保持 fire-and-forget
  void reportDesktopTheme(readThemeMode())
}

// ---------- 首帧应用（head 内尽早执行，避免闪烁） ----------

// 冷启动防御：v8 在运行期向 head 注入过 <style id="kb-font-override">（无 data-persist，
// 首次导航即静默失效），该机制已连根删除——此处清一次可能残留的实例。
document.getElementById("kb-font-override")?.remove()

// 桌面自绘标题条的总门（需求⑥）：首帧即落 html[data-desktop]，让 38px 顶部偏移
// 与首屏一同渲染——放到 DOM 就绪后再落会让整页内容下沉一次，视觉上是明显的跳动。
// 属性写在 <html> 而非 <body>：micromorph 只形变 body，<html> 上的属性全会话存活，
// 与 data-style / saved-theme 同机制，故本处一次性写入即可，无需在 nav 时重放。
// 仅 macOS 生效（hiddenInset 是 darwin 专有窗口形态，见 desktop/main.cjs）。
{
  const bridge = desktopBridge()
  if (bridge?.isDesktop && bridge.isMac) {
    document.documentElement.dataset.desktop = "true"
  }
}

const initial = loadSettings()
// 次序不可调换：applyThemeMode 内的上报要读 getComputedStyle 的 --light 当底色，
// data-style 未落时取到的恒为 CSS 基线的宣纸色而非用户真实主题。
// 首帧只上报一次，且必须在 data-style 落定之后。
writeStyle(initial.style)
applyThemeMode(initial.themeMode)
// 首帧不走 applyStyle（即不派发 themechange）：此刻尚无监听方——
// graph / mermaid / comments 均在 nav 后绑定，绑定时自取当前态。
// 首帧同样不走 commitTheme：uiReady 此刻恒为 false（nav 未触发），即便误调也会自动
// 直写；写在这里的直调是「有意为之」而非漏改——首屏渲染中叠一层整页交叉淡入
// 只会让启动闪一下。applyThemeMode 内那条 IPC 权威态纠正若在 nav 之前落定，
// 同样按 uiReady 门直写（system 模式冷启动的常见路径），不产生启动叠化。

// ---------- UI 绑定（nav 后） ----------
//
// 设置页控件仅设置页有，故整块包在 if 内；uiReady 的置位必须在 if 之外——
// 元素缺失不得连累它（v8 的单块 early-return 曾把不相干的绑定绑成一荣俱荣）。
//
// v14：左栏明暗快捷钮已删除（用户裁决），原「块一」的点击绑定连同其
//「取反 → 落固定值 → 脱离跟随系统」专属分支一并移除。运行期改主题的入口
// 现只剩两条，且都保持既有实现不变：设置页分段控件 / 主题卡（下方块内），
// 与「跟随系统」下的 onSystemChange 翻转；两条仍共用 commitTheme 这一提交口。

document.addEventListener("nav", () => {
  // 首帧之后的一切主题写入都走整页叠化（见 commitTheme 的 uiReady 注）。
  // 置于 nav 回调最前：下方 if 块的元素缺失都不得影响这一句。
  uiReady = true

  // ── 设置页控件（事件委托） ────────────────────────────
  const page = document.querySelector<HTMLElement>(".kb-settings-page")
  if (page) {
    const chooseDir = async (): Promise<void> => {
      const bridge = desktopBridge()
      if (!bridge?.chooseAnnoDir) {
        return
      }
      const dir = await bridge.chooseAnnoDir()
      if (dir) {
        const s = loadSettings()
        s.annoDir = dir
        saveSettings(s)
        syncSettingsPage()
      }
    }

    const onPanelClick = (e: Event) => {
      const target = e.target as HTMLElement
      // 抽屉分类钮先分流：它只带 data-pane（右侧面板用的是 data-pane-id，不会误命中），
      // 与 [data-setting] 一族互斥，命中即切面板并结束本次派发。
      const cat = target.closest<HTMLElement>("[data-pane]")
      if (cat?.dataset.pane) {
        switchPane(page, cat.dataset.pane)
        return
      }
      const settingEl = target.closest<HTMLElement>("[data-setting]")
      if (!settingEl) {
        return
      }
      const key = settingEl.dataset.setting
      const value = settingEl.dataset.value ?? ""
      if (key === "themeMode") {
        if (value === "light" || value === "dark" || value === "system") {
          const s = loadSettings()
          s.themeMode = value
          saveSettings(s)
          commitTheme(() => {
            applyThemeMode(s.themeMode)
            syncSettingsPage()
          })
        }
        return
      }
      if (key === "style") {
        if (STYLE_KEYS.has(value)) {
          const s = loadSettings()
          s.style = value as StyleKey
          saveSettings(s)
          // 主题间切换同样叠化：错位的成因（祖先/后代同属性过渡逐帧重建）与明暗切换
          // 完全同源，六套主题的九色全量重定义使其幅度同样可见。两条路径共用一个提交口，
          // 也避免「明暗同步、换主题仍各自为政」的观感割裂。
          commitTheme(() => {
            applyStyle(s.style)
            syncSettingsPage()
          })
        }
        return
      }
      if (key === "chooseDir") {
        void chooseDir()
        return
      }
      if (key === "openAnno") {
        // 事件名不在 CustomEventMap 联合内，detail 置空对象以匹配签名
        document.dispatchEvent(new CustomEvent("kb-anno-open-drawer", { detail: {} }))
        return
      }
      if (key === "checkUpdate") {
        void runUpdateCheck(page)
        return
      }
      if (key === "copyMcp") {
        void copyMcpCommand(page, settingEl)
        return
      }
      if (key === "autoCheckUpdate") {
        // checkbox 的 click 已把 checked 翻好（键盘空格同样走 click），直接读即可
        const box = settingEl as HTMLInputElement
        void desktopBridge()
          ?.setAutoCheckUpdate?.(box.checked)
          .then((r) => {
            if (r) box.checked = r.autoCheck
          })
          .catch(() => {
            // 主进程未注册 handler（旧壳）：回滚勾选态，不给出「已开启」的假象
            box.checked = !box.checked
          })
      }
    }

    page.addEventListener("click", onPanelClick)
    window.addCleanup(() => page.removeEventListener("click", onPanelClick))
    // CSS 降级门：本标记落定前两个 pane 全显（无 JS 时设置项不至于藏一半），
    // 落定后才由 is-active 单独控制显隐。
    page.dataset.panesReady = ""

    // ── 返回钮：确有历史时升级为无刷新后退 ────────────────
    // 锚上的 href 已是完整兜底（SSR 直出，指向首页）；此处只做「有历史则回来路页」的增强，
    // 任何一条放行分支都退回 href 的原生语义，不会把用户卡在设置页。
    const back = page.querySelector<HTMLAnchorElement>(".kb-settings-back")
    if (back) {
      const onBack = (e: MouseEvent) => {
        // 非左键或带修饰键：保留浏览器原生语义（新标签页 / 新窗口 / 下载），一律放行
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
          return
        }
        // 无历史（深链直达 / 新窗口首屏即设置页）：放行 href，由 SPA 路由跳首页
        if (window.history.length <= 1) {
          return
        }
        e.preventDefault()
        // stopPropagation 必须：spa.inline.ts 在 window 冒泡层按 closest("a") 拦截站内链接，
        // 锚上监听先于它执行，唯有在此阻断冒泡，才不会被它接管成「前进到首页」。
        e.stopPropagation()
        // popstate 由 spa.inline.ts 既有路由接住，无刷新返回上一页
        window.history.back()
      }
      back.addEventListener("click", onBack)
      window.addCleanup(() => back.removeEventListener("click", onBack))
    }

    void initUpdatePanel(page)
    void initMcpPanel(page)
    syncSettingsPage()
  }
})

/**
 * MCP 接入区块：命令里的两处路径取自主进程（打包/开发、mac/Windows 各不相同，
 * 静态页写死必错），服务文件不存在时整节保持隐藏——老安装包没有这份资源，
 * 与其给出一条配不通的命令，不如不显示。
 */
async function initMcpPanel(page: HTMLElement): Promise<void> {
  const block = page.querySelector<HTMLElement>("[data-mcp-block]")
  if (!block) {
    return
  }
  const fallback = page.querySelector<HTMLElement>("[data-mcp-fallback]")
  const bridge = desktopBridge()
  if (!bridge?.getMcpInfo) {
    return
  }
  try {
    const info = await bridge.getMcpInfo()
    if (!info.available) {
      return
    }
    for (const [target, cmd] of Object.entries(buildMcpCommands(info))) {
      const el = block.querySelector<HTMLElement>(`[data-mcp-cmd="${target}"]`)
      if (el) {
        el.textContent = cmd
      }
    }
    const pathEl = block.querySelector<HTMLElement>("[data-mcp-path]")
    if (pathEl) {
      pathEl.textContent = info.serverPath
    }
    // 命令区与降级说明互斥：两者同时可见会让人以为服务既可用又不可用
    block.removeAttribute("hidden")
    fallback?.setAttribute("hidden", "")
  } catch {
    // 维持 SSR 初态：命令区隐藏、降级说明可见
  }
}

/**
 * 生成两种客户端的接入命令。
 * Windows 路径含反斜杠：TOML 的双引号字符串会把 \\U 之类当转义序列，故一律用
 * 单引号字面量字符串；shell 侧则统一用双引号包裹，容纳路径中可能出现的空格。
 */
function buildMcpCommands(info: McpInfo): Record<string, string> {
  const q = (s: string) => `"${s}"`
  const toml = (s: string) => `'${s}'`
  return {
    claude:
      `claude mcp add ipreader -e ELECTRON_RUN_AS_NODE=1 -- ` +
      `${q(info.execPath)} ${q(info.serverPath)}`,
    codex: [
      "[mcp_servers.ipreader]",
      `command = ${toml(info.execPath)}`,
      `args = [${toml(info.serverPath)}]`,
      "startup_timeout_sec = 30",
      "",
      "[mcp_servers.ipreader.env]",
      'ELECTRON_RUN_AS_NODE = "1"',
    ].join("\n"),
  }
}

/** 复制对应命令，并在按钮上给一次短暂的「已复制」回执 */
async function copyMcpCommand(page: HTMLElement, btn: HTMLElement): Promise<void> {
  const target = btn.dataset.mcpTarget
  const code = page.querySelector<HTMLElement>(`[data-mcp-cmd="${target}"]`)
  const bridge = desktopBridge()
  if (!code?.textContent || !bridge?.copyText) {
    return
  }
  const done = await bridge.copyText(code.textContent).catch(() => false)
  const original = btn.dataset.label ?? btn.textContent ?? ""
  btn.dataset.label = original
  btn.textContent = done ? "已复制" : "复制失败"
  window.setTimeout(() => {
    btn.textContent = btn.dataset.label ?? original
  }, 1600)
}

/**
 * 关于页的更新区块：确认桌面壳具备更新能力后才摘 hidden 显示出来，
 * 同时用主进程的权威版本号覆写静态页里的那一行（免得静态页忘记同步而说谎），
 * 并回显「启动时自动检查」的当前状态（该状态存主进程侧的 window-state.json）。
 * 任何一步失败都保持隐藏——宁可不显示，也不显示一个按不动的按钮。
 */
async function initUpdatePanel(page: HTMLElement): Promise<void> {
  const block = page.querySelector<HTMLElement>("[data-update-block]")
  if (!block) {
    return
  }
  const bridge = desktopBridge()
  if (!bridge?.getUpdateConfig || !bridge.checkUpdate) {
    return
  }
  try {
    const cfg = await bridge.getUpdateConfig()
    const ver = page.querySelector<HTMLElement>("[data-update-version]")
    if (ver && cfg.version) {
      ver.textContent = `v${cfg.version}`
    }
    const box = block.querySelector<HTMLInputElement>('[data-setting="autoCheckUpdate"]')
    if (box) {
      box.checked = cfg.autoCheck === true
    }
    block.removeAttribute("hidden")
  } catch {
    // 保持 hidden
  }
}

/** 手动检查一次，把结果写进状态行；发现新版时状态行内附一个前往下载的按钮 */
async function runUpdateCheck(page: HTMLElement): Promise<void> {
  const bridge = desktopBridge()
  const status = page.querySelector<HTMLElement>("[data-update-status]")
  const btn = page.querySelector<HTMLButtonElement>('[data-setting="checkUpdate"]')
  if (!bridge?.checkUpdate || !status) {
    return
  }
  if (btn) {
    btn.disabled = true
  }
  status.textContent = "正在检查…"
  status.dataset.state = "checking"
  try {
    const r = await bridge.checkUpdate()
    status.textContent = r.message
    status.dataset.state = r.status
    if (r.status === "update") {
      const go = document.createElement("button")
      go.type = "button"
      go.className = "kb-update-go"
      go.textContent = "前往下载"
      go.addEventListener("click", () => {
        void bridge.openReleases?.(r.url)
      })
      status.append(" ", go)
    }
  } catch {
    status.textContent = "检查失败，请稍后重试"
    status.dataset.state = "error"
  } finally {
    if (btn) {
      btn.disabled = false
    }
  }
}

/**
 * 抽屉分类切换：左栏分类钮（.kb-settings-cat[data-pane]）与右栏面板
 * （.kb-settings-pane[data-pane-id]）同步 is-active，分类钮另同步 aria-selected。
 * 纯瞬时 UI 态，刻意不落 localStorage（kb-settings:v1 结构不动）——
 * 每次进设置页都回到 SSR 默认的 appearance。
 */
function switchPane(page: HTMLElement, pane: string): void {
  for (const el of page.querySelectorAll<HTMLElement>(".kb-settings-cat")) {
    const on = el.dataset.pane === pane
    el.classList.toggle("is-active", on)
    el.setAttribute("aria-selected", on ? "true" : "false")
  }
  for (const el of page.querySelectorAll<HTMLElement>(".kb-settings-pane")) {
    el.classList.toggle("is-active", el.dataset.paneId === pane)
  }
}

/**
 * 设置页回显：选中态（is-active + aria-checked）与批注目录文本。
 * 设置页不存在时静默返回：调用点虽都在 `if (page)` 内，chooseDir 却是 await
 * 原生目录选择框之后才回调的——用户在选择期间 SPA 导航离开设置页时，这一句
 * 就是唯一的兜底（v14 删除左栏快捷钮后，该守卫的理由只剩这一条，故就地注明）。
 */
function syncSettingsPage(): void {
  const page = document.querySelector<HTMLElement>(".kb-settings-page")
  if (!page) {
    return
  }
  const s = loadSettings()
  for (const b of page.querySelectorAll<HTMLElement>('[data-setting="themeMode"]')) {
    const on = b.dataset.value === s.themeMode
    b.classList.toggle("is-active", on)
    b.setAttribute("aria-checked", on ? "true" : "false")
  }
  for (const b of page.querySelectorAll<HTMLElement>('[data-setting="style"]')) {
    const on = b.dataset.value === s.style
    b.classList.toggle("is-active", on)
    b.setAttribute("aria-checked", on ? "true" : "false")
  }
  const dir = page.querySelector<HTMLElement>("[data-setting-dir]")
  if (dir) {
    const hasDesktop = desktopBridge() !== undefined
    dir.textContent = s.annoDir ? s.annoDir : hasDesktop ? "未设置" : "未设置（仅桌面端可用）"
  }
}
