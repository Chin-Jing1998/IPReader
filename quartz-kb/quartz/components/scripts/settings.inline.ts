// 设置（v8）：主题模式（浅/深/系统）· 界面风格（6 套 × 亮暗两态）· 字体定制 · 批注保存目录。
//
// 加载时机：beforeDOMLoaded（head 内）——启动即应用主题/风格/字体，避免首帧闪烁；
// UI 事件在 nav 后绑定（与 darkmode.inline 同一装载模式）。
// 状态桶：localStorage kb-settings:v1。
//
// 主题兼容协议：应用主题时继续写 saved-theme 属性 + localStorage("theme") 并派发
// themechange 事件——mermaid / 图谱 / comments 均监听该事件重绘。
// 原 Darkmode 按钮与系统监听已从 darkmode.inline.ts 移除，控制权统一在本脚本。

type ThemeMode = "light" | "dark" | "system"
type StyleKey = "default" | "paper" | "ink" | "ocean" | "midnight" | "graphite"
type FontKey = "pingfang" | "songti" | "heiti" | "kaiti" | "fangsong" | "mono"

type KbSettings = {
  themeMode: ThemeMode
  style: StyleKey
  fonts: { left: FontKey | ""; header: FontKey | ""; body: FontKey | "" }
  annoDir: string
}

const SETTINGS_KEY = "kb-settings:v1"
const STYLE_KEYS: ReadonlySet<string> = new Set(["default", "paper", "ink", "ocean", "midnight", "graphite"])
const FONT_KEYS: ReadonlySet<string> = new Set(["pingfang", "songti", "heiti", "kaiti", "fangsong", "mono"])

// 字体栈与 quartz.config.ts 的 typography 及 custom.scss 的楷体/仿宋栈保持一致
const FONT_STACKS: Record<FontKey, string> = {
  pingfang:
    '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  songti: '"Songti SC", "SimSun", "STSong", "Noto Serif CJK SC", serif',
  heiti: '"Heiti SC", "STHeiti", "SimHei", "Noto Sans CJK SC", sans-serif',
  kaiti: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif',
  fangsong: '"STFangsong", "FangSong", "FangSong_GB2312", "Noto Serif CJK SC", serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "PingFang SC", monospace',
}

const DEFAULTS: KbSettings = {
  themeMode: "system",
  style: "default",
  fonts: { left: "", header: "", body: "" },
  annoDir: "",
}

function loadSettings(): KbSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) {
      return { ...DEFAULTS, fonts: { ...DEFAULTS.fonts } }
    }
    const p = JSON.parse(raw) as Partial<KbSettings>
    const fonts = (p.fonts ?? {}) as Partial<KbSettings["fonts"]>
    return {
      themeMode:
        p.themeMode === "light" || p.themeMode === "dark" || p.themeMode === "system"
          ? p.themeMode
          : DEFAULTS.themeMode,
      style: STYLE_KEYS.has(p.style as string) ? (p.style as StyleKey) : DEFAULTS.style,
      fonts: {
        left: FONT_KEYS.has(fonts.left as string) ? (fonts.left as FontKey) : "",
        header: FONT_KEYS.has(fonts.header as string) ? (fonts.header as FontKey) : "",
        body: FONT_KEYS.has(fonts.body as string) ? (fonts.body as FontKey) : "",
      },
      annoDir: typeof p.annoDir === "string" ? p.annoDir : "",
    }
  } catch {
    return { ...DEFAULTS, fonts: { ...DEFAULTS.fonts } }
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

// ---------- 主题模式 ----------

function setTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("saved-theme", theme)
  try {
    localStorage.setItem("theme", theme)
  } catch {
    // ignore
  }
  const event: CustomEventMap["themechange"] = new CustomEvent("themechange", {
    detail: { theme },
  })
  document.dispatchEvent(event)
}

let systemMedia: MediaQueryList | null = null
function onSystemChange(e: MediaQueryListEvent): void {
  setTheme(e.matches ? "dark" : "light")
}

function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.dataset.themeMode = mode
  if (systemMedia !== null) {
    systemMedia.removeEventListener("change", onSystemChange)
    systemMedia = null
  }
  if (mode === "system") {
    systemMedia = window.matchMedia("(prefers-color-scheme: dark)")
    systemMedia.addEventListener("change", onSystemChange)
    setTheme(systemMedia.matches ? "dark" : "light")
  } else {
    setTheme(mode)
  }
  // Electron 原生窗口/标题栏/Dock 图标联动（desktop/main.cjs 已实现 light/dark/system）
  const desktop = (window as unknown as { desktop?: { setThemeSource?: (m: string) => void } })
    .desktop
  desktop?.setThemeSource?.(mode)
}

// ---------- 界面风格 ----------

function applyStyle(style: StyleKey): void {
  document.documentElement.dataset.style = style
}

// ---------- 字体 ----------

const FONT_OVERRIDE_ID = "kb-font-override"

function applyFonts(fonts: KbSettings["fonts"]): void {
  let css = ""
  if (fonts.left) {
    css += `--leftFont:${FONT_STACKS[fonts.left as FontKey]};`
  }
  if (fonts.header) {
    css += `--headerFont:${FONT_STACKS[fonts.header as FontKey]};`
  }
  if (fonts.body) {
    css += `--bodyFont:${FONT_STACKS[fonts.body as FontKey]};`
  }
  let el = document.getElementById(FONT_OVERRIDE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement("style")
    el.id = FONT_OVERRIDE_ID
    document.head.appendChild(el)
  }
  el.textContent = css ? `:root{${css}}` : ""
}

// ---------- 首帧应用（head 内尽早执行，避免闪烁） ----------

const initial = loadSettings()
applyThemeMode(initial.themeMode)
applyStyle(initial.style)
applyFonts(initial.fonts)

// ---------- UI 绑定（nav 后） ----------

document.addEventListener("nav", () => {
  const btn = document.querySelector<HTMLElement>(".kb-settings-btn")
  const overlay = document.querySelector<HTMLElement>(".kb-settings-overlay")
  const panel = overlay?.querySelector<HTMLElement>(".kb-settings-panel")
  const closeBtn = panel?.querySelector<HTMLElement>(".kb-settings-close")
  if (!btn || !overlay || !panel) {
    return
  }

  // 遮罩挂到 body：按钮留在 left 栏（sticky z-1 创建层叠上下文），若遮罩
  // 留在栏内，fixed z-850 会被限制在该上下文、盖不住正文 sticky z-50 的标题。
  // 每次 nav 幂等执行（micromorph 换页后组件树重建，遮罩回到原位再迁移）。
  if (overlay.parentElement !== document.body) {
    document.body.appendChild(overlay)
  }

  const open = () => {
    overlay.hidden = false
    syncUI()
  }
  const close = () => {
    overlay.hidden = true
  }
  const toggle = () => (overlay.hidden ? open() : close())
  btn.addEventListener("click", toggle)
  closeBtn?.addEventListener("click", close)

  // 点击遮罩空白处关闭（面板内部点击不冒泡到遮罩目标判定）
  const onOverlayClick = (e: MouseEvent) => {
    if (e.target === overlay) {
      close()
    }
  }
  overlay.addEventListener("click", onOverlayClick)

  // Esc 关闭（与批注右键菜单的 Esc 互不冲突：两者均监听 document keydown）
  const onOverlayKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !overlay.hidden) {
      close()
    }
  }
  document.addEventListener("keydown", onOverlayKey)

  function syncUI(): void {
    const s = loadSettings()
    for (const b of panel!.querySelectorAll<HTMLElement>('[data-setting="themeMode"]')) {
      b.classList.toggle("is-active", b.dataset.value === s.themeMode)
    }
    for (const b of panel!.querySelectorAll<HTMLElement>('[data-setting="style"]')) {
      b.classList.toggle("is-active", b.dataset.value === s.style)
    }
    for (const sel of panel!.querySelectorAll<HTMLSelectElement>("select[data-setting]")) {
      const key = sel.dataset.setting ?? ""
      if (key === "font-left") sel.value = s.fonts.left
      else if (key === "font-header") sel.value = s.fonts.header
      else if (key === "font-body") sel.value = s.fonts.body
    }
    const dir = panel!.querySelector<HTMLElement>("[data-setting-dir]")
    if (dir) {
      const hasDesktop = (window as unknown as { desktop?: unknown }).desktop !== undefined
      dir.textContent = s.annoDir ? s.annoDir : hasDesktop ? "未设置" : "未设置（仅桌面端可用）"
    }
  }

  const onPanelClick = (e: Event) => {
    const target = e.target as HTMLElement
    const settingEl = target.closest<HTMLElement>("[data-setting]")
    if (settingEl) {
      const key = settingEl.dataset.setting
      const value = settingEl.dataset.value ?? ""
      if (key === "themeMode") {
        if (value === "light" || value === "dark" || value === "system") {
          const s = loadSettings()
          s.themeMode = value as ThemeMode
          saveSettings(s)
          applyThemeMode(s.themeMode)
          syncUI()
        }
        return
      }
      if (key === "style") {
        if (STYLE_KEYS.has(value)) {
          const s = loadSettings()
          s.style = value as StyleKey
          saveSettings(s)
          applyStyle(s.style)
          syncUI()
        }
        return
      }
      if (key === "chooseDir") {
        void chooseDir()
        return
      }
      if (key === "openAnno") {
        close()
        // 事件名不在 CustomEventMap 联合内，detail 置空对象以匹配签名
        document.dispatchEvent(new CustomEvent("kb-anno-open-drawer", { detail: {} }))
        return
      }
      return
    }
    const sel = target.closest<HTMLSelectElement>("select[data-setting]")
    if (sel) {
      // select 的变更经 change 事件处理（onPanelChange），此处兜底忽略
      return
    }
  }

  const onPanelChange = (e: Event) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("select[data-setting]")
    if (!sel) {
      return
    }
    const s = loadSettings()
    const v = (FONT_KEYS.has(sel.value) ? sel.value : "") as FontKey | ""
    if (sel.dataset.setting === "font-left") s.fonts.left = v
    else if (sel.dataset.setting === "font-header") s.fonts.header = v
    else if (sel.dataset.setting === "font-body") s.fonts.body = v
    saveSettings(s)
    applyFonts(s.fonts)
  }

  async function chooseDir(): Promise<void> {
    const desktop = (window as unknown as {
      desktop?: { chooseAnnoDir?: () => Promise<string | null> }
    }).desktop
    if (!desktop?.chooseAnnoDir) {
      return
    }
    const dir = await desktop.chooseAnnoDir()
    if (dir) {
      const s = loadSettings()
      s.annoDir = dir
      saveSettings(s)
      syncUI()
    }
  }

  panel.addEventListener("click", onPanelClick)
  panel.addEventListener("change", onPanelChange)
  window.addCleanup(() => {
    btn.removeEventListener("click", toggle)
    closeBtn?.removeEventListener("click", close)
    overlay.removeEventListener("click", onOverlayClick)
    document.removeEventListener("keydown", onOverlayKey)
    panel.removeEventListener("click", onPanelClick)
    panel.removeEventListener("change", onPanelChange)
    if (systemMedia !== null) {
      systemMedia.removeEventListener("change", onSystemChange)
      systemMedia = null
    }
  })
})
