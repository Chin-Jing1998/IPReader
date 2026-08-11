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
  setTheme(e.matches ? "dark" : "light")
  // 系统外观翻转同样换底色：不补这一报，system 模式下主进程窗口底色会停在翻转前那一侧
  reportDesktopTheme("system")
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
  const seq = ++themeSeq
  void reportDesktopTheme(mode).then((dark) => {
    if (dark === undefined) return
    if (seq !== themeSeq) return // 期间用户又切了模式，丢弃陈旧结果
    if (readThemeMode() !== "system") return // 仅 system 模式消费权威态
    const next = dark ? "dark" : "light"
    if (readSavedTheme() !== next) setTheme(next) // 幂等守卫：同值不再派发 themechange
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

// ---------- UI 绑定（nav 后） ----------
//
// 两个独立 if 块：快捷钮每页都有，设置页控件仅设置页有——
// 任一块的元素缺失不得影响另一块（v8 的单块 early-return 曾把两者绑成一荣俱荣）。

document.addEventListener("nav", () => {
  // ── 块一：左栏明暗快捷钮 ──────────────────────────────
  const toggle = document.querySelector<HTMLElement>(".kb-theme-toggle")
  if (toggle) {
    // 读当前实际亮暗取反 → 落固定值（脱离「跟随系统」）→ 全链路应用。
    // 日/月图标显隐纯 CSS 驱动（:root[saved-theme] 选择器），此处不写 JS。
    const onToggleClick = () => {
      const next: ThemeMode = readSavedTheme() === "dark" ? "light" : "dark"
      const s = loadSettings()
      s.themeMode = next
      saveSettings(s)
      applyThemeMode(next)
      syncSettingsPage()
    }
    toggle.addEventListener("click", onToggleClick)
    window.addCleanup(() => toggle.removeEventListener("click", onToggleClick))
  }

  // ── 块二：设置页控件（事件委托） ──────────────────────
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
          applyThemeMode(s.themeMode)
          syncSettingsPage()
        }
        return
      }
      if (key === "style") {
        if (STYLE_KEYS.has(value)) {
          const s = loadSettings()
          s.style = value as StyleKey
          saveSettings(s)
          applyStyle(s.style)
          syncSettingsPage()
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

    syncSettingsPage()
  }
})

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
 * 设置页不存在时静默返回——快捷钮改主题后也调它，两条路径共用一份回显逻辑。
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
