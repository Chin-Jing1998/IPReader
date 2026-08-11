import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import test, { describe } from "node:test"
import { fileURLToPath } from "node:url"
import { contrastRatio, deltaE2000, hexToLab, hexToRgb, rgbToLab, type Rgb } from "./color"

const here = dirname(fileURLToPath(import.meta.url))
const customStyles = readFileSync(resolve(here, "../styles/custom.scss"), "utf8")
const settingsStyles = readFileSync(resolve(here, "../components/styles/settings.scss"), "utf8")
const quartzConfig = readFileSync(resolve(here, "../../quartz.config.ts"), "utf8")
const desktopMain = readFileSync(resolve(here, "../../../desktop/main.cjs"), "utf8")

describe("色彩数学：sRGB→CIELAB、CIEDE2000 与 WCAG 对比度", () => {
  test("纯白落在 CIELAB 原点白，纯黑明度为 0", () => {
    // Arrange & Act
    const white = hexToLab("#ffffff")
    const black = hexToLab("#000000")

    // Assert：sRGB 基色矩阵各行之和即 D65 白点，故白色 a/b 应为 0
    assert.ok(Math.abs(white.L - 100) < 0.1, `纯白 L* 为 ${white.L}，偏离 100 超过 0.1`)
    assert.ok(Math.abs(white.a) < 0.1, `纯白 a* 为 ${white.a}，偏离 0 超过 0.1`)
    assert.ok(Math.abs(white.b) < 0.1, `纯白 b* 为 ${white.b}，偏离 0 超过 0.1`)
    assert.ok(Math.abs(black.L) < 0.01, `纯黑 L* 为 ${black.L}，偏离 0 超过 0.01`)
  })

  test("hexToLab 等价于 hexToRgb 与 rgbToLab 的组合", () => {
    // Arrange
    const hex = "#8c5a3c"

    // Act & Assert：三个导出共用同一条换算链，组合结果必须逐位一致
    assert.deepEqual(rgbToLab(hexToRgb(hex)), hexToLab(hex))
    assert.deepEqual(hexToRgb(hex), { r: 140, g: 90, b: 60 })
    assert.throws(() => hexToRgb("#12345"), /不是合法的 #rrggbb 颜色值/)
  })

  test("同色的 CIEDE2000 色差为 0", () => {
    // Arrange
    const lab = hexToLab("#f6f1e7")

    // Act & Assert
    assert.equal(deltaE2000(lab, lab), 0)
  })

  // Sharma et al. (2005) 为 CIEDE2000 发布的补充测试集。第 4 对的公布值是
  // 1.0000（不是 2.0425，后者是第 1 对的值），此处按原始数据取值。
  // 选取的四对分别覆盖：低彩度蓝紫区（RT 旋转项）、跨零彩度的 G 因子补偿、
  // 大色差、以及 h̄' 落在 275° 附近使 RT 达到量级峰值的情形。
  const sharmaCases = [
    {
      title: "第 1 对：蓝紫区低彩度，G 因子与 RT 同时生效",
      lab1: { L: 50, a: 2.6772, b: -79.7751 },
      lab2: { L: 50, a: 0, b: -82.7485 },
      expected: 2.0425,
    },
    {
      title: "第 4 对：a* 跨零，色相角折返处理",
      lab1: { L: 50, a: -1.3802, b: -84.2814 },
      lab2: { L: 50, a: 0, b: -82.7485 },
      expected: 1.0,
    },
    {
      title: "第 17 对：大色差，SL/SC/SH 权重同时偏离 1",
      lab1: { L: 50, a: 2.5, b: 0 },
      lab2: { L: 73, a: 25, b: -18 },
      expected: 27.1492,
    },
    {
      title: "第 29 对：h̄' 约 291°，RT 旋转项贡献显著",
      lab1: { L: 22.7233, a: 20.0904, b: -46.694 },
      lab2: { L: 23.0331, a: 14.973, b: -42.5619 },
      expected: 2.0373,
    },
  ]

  for (const { title, lab1, lab2, expected } of sharmaCases) {
    test(`CIEDE2000 对齐 Sharma 标准测试集——${title}`, () => {
      // Act
      const distance = deltaE2000(lab1, lab2)

      // Assert
      assert.ok(
        Math.abs(distance - expected) < 0.01,
        `期望 ${expected}，实得 ${distance.toFixed(4)}`,
      )
      // 色差是对称量，交换两色不改变结果
      assert.ok(Math.abs(deltaE2000(lab2, lab1) - distance) < 1e-12, "色差在交换参数后改变")
    })
  }

  test("纯黑与纯白的 WCAG 对比度为 21 且与参数顺序无关", () => {
    // Act
    const ratio = contrastRatio("#000000", "#ffffff")
    const swapped = contrastRatio("#ffffff", "#000000")

    // Assert
    assert.ok(Math.abs(ratio - 21) < 0.01, `期望 21，实得 ${ratio}`)
    assert.equal(swapped, ratio)
    // 任取一对非极端色再验一次对称性，排除「只在极值处对称」的实现
    assert.equal(contrastRatio("#f6f1e7", "#3a3226"), contrastRatio("#3a3226", "#f6f1e7"))
  })
})

// ============================================================
// 调色板门：W3 custom.scss 落地前预期失败
// 期望值先行——本组按 W3 定稿的六套亮态底色写死断言，而 custom.scss /
// settings.scss / quartz.config.ts 目前仍是旧色值，故本组现在必然见红。
// 见红即门在生效，不得为了转绿去改被读取的四个文件，也不得把期望值改回旧值；
// W3 统一改色落地后本组自然转绿。
// ============================================================

const THEMES = ["xuanzhi", "shuimo", "qingci", "zhulin", "mushan", "xuanye"] as const
type ThemeName = (typeof THEMES)[number]

/** W3 定稿的六套亮态底色。 */
const EXPECTED_LIGHT: Record<ThemeName, string> = {
  xuanzhi: "#feefe5",
  shuimo: "#ecf5f8",
  qingci: "#e3f7f4",
  zhulin: "#eff5e8",
  mushan: "#f8effb",
  xuanye: "#ebf0ff",
}

/** 六色两两至少要拉开的 CIEDE2000 色差，低于此值换主题时肉眼难辨。 */
const MIN_PALETTE_DELTA_E = 5.0

/** 亮态底色的明度窗口：低于下限显脏，高于上限接近纯白、失去纸感。 */
const MIN_PALETTE_LIGHTNESS = 94.0
const MAX_PALETTE_LIGHTNESS = 96.5

/** 各前景色压在同主题 --light 上的 WCAG 对比度下限。 */
const CONTRAST_FLOORS = [
  ["dark", 7],
  ["darkgray", 4.5],
  ["gray", 3],
  ["secondary", 3],
  ["tertiary", 3],
] as const

interface ThemePalette {
  light: string
  dark: string
  darkgray: string
  gray: string
  secondary: string
  tertiary: string
}

/** 取自定义属性的值；property 后紧跟冒号，故 --light 不会误命中 --lightgray。 */
function readCustomProperty(block: string, property: string, source: string): string {
  const matched = new RegExp(`--${property}:\\s*([^;]+);`).exec(block)
  assert.ok(matched, `${source} 缺少 --${property}`)
  return matched[1].trim()
}

/**
 * 取某套主题的亮态块。选择器后必须紧跟 `{`，因此
 * `:root[data-style="X"][saved-theme="dark"]` 与 `:root[data-style="X"] article`
 * 都不会被匹配；块以行首 `}` 收尾，嵌套的 `&:not(...)` 块因缩进不会提前截断。
 */
function readLightThemeBlock(theme: ThemeName): string {
  const matched = new RegExp(`:root\\[data-style="${theme}"\\][ \\t]*\\{([\\s\\S]*?)\\n\\}`).exec(
    customStyles,
  )
  assert.ok(matched, `custom.scss 未找到 ${theme} 的亮态主题块`)
  assert.doesNotMatch(matched[0], /saved-theme="dark"\]\s*\{/, `${theme} 的亮态块混入了暗态选择器`)
  return matched[1]
}

function readThemePalette(theme: ThemeName): ThemePalette {
  const block = readLightThemeBlock(theme)
  const source = `custom.scss ${theme} 亮态块`
  return {
    light: readCustomProperty(block, "light", source),
    dark: readCustomProperty(block, "dark", source),
    darkgray: readCustomProperty(block, "darkgray", source),
    gray: readCustomProperty(block, "gray", source),
    secondary: readCustomProperty(block, "secondary", source),
    tertiary: readCustomProperty(block, "tertiary", source),
  }
}

/** 取 settings.scss 中该主题色板卡的 --swatch-light。 */
function readSwatchLight(theme: ThemeName): string {
  const matched = new RegExp(
    `\\[data-value="${theme}"\\][^{]*\\{([^}]*--swatch-light[^}]*)\\}`,
  ).exec(settingsStyles)
  assert.ok(matched, `settings.scss 未找到 ${theme} 的色板块`)
  return readCustomProperty(matched[1], "swatch-light", `settings.scss ${theme} 色板块`)
}

describe("调色板门：W3 custom.scss 落地前预期失败", () => {
  for (const theme of THEMES) {
    test(`custom.scss 中 ${theme} 的 --light 等于定稿值 ${EXPECTED_LIGHT[theme]}`, () => {
      // Act
      const actual = readThemePalette(theme).light

      // Assert：期望值先行，改色未落地时此条即为门的红灯
      assert.equal(actual, EXPECTED_LIGHT[theme])
    })
  }

  test("六套亮态底色两两 CIEDE2000 色差不低于 5.0（15 组）", () => {
    // Arrange
    const palette = THEMES.map((theme) => ({ theme, light: readThemePalette(theme).light }))

    // Act
    const violations: string[] = []
    for (let i = 0; i < palette.length; i++) {
      for (let j = i + 1; j < palette.length; j++) {
        const distance = deltaE2000(hexToLab(palette[i].light), hexToLab(palette[j].light))
        if (distance < MIN_PALETTE_DELTA_E) {
          violations.push(
            `${palette[i].theme}(${palette[i].light}) ↔ ${palette[j].theme}(${palette[j].light}) = ${distance.toFixed(2)}`,
          )
        }
      }
    }

    // Assert
    assert.deepEqual(
      violations,
      [],
      `以下配对色差低于 ${MIN_PALETTE_DELTA_E}：\n${violations.join("\n")}`,
    )
  })

  test(`六套亮态底色的 L* 落在 [${MIN_PALETTE_LIGHTNESS}, ${MAX_PALETTE_LIGHTNESS}]`, () => {
    // Act
    const violations = THEMES.map((theme) => {
      const light = readThemePalette(theme).light
      return { theme, light, lightness: hexToLab(light).L }
    })
      .filter(
        ({ lightness }) => lightness < MIN_PALETTE_LIGHTNESS || lightness > MAX_PALETTE_LIGHTNESS,
      )
      .map(({ theme, light, lightness }) => `${theme}(${light}) L*=${lightness.toFixed(2)}`)

    // Assert
    assert.deepEqual(violations, [], `以下底色明度越界：\n${violations.join("\n")}`)
  })

  for (const theme of THEMES) {
    test(`${theme} 亮态五档前景色压在 --light 上的对比度达标`, () => {
      // Arrange
      const palette = readThemePalette(theme)

      // Act & Assert
      for (const [property, floor] of CONTRAST_FLOORS) {
        const ratio = contrastRatio(palette.light, palette[property])
        assert.ok(
          ratio >= floor,
          `${theme} 的 --${property}(${palette[property]}) 压在 --light(${palette.light}) 上仅 ${ratio.toFixed(2)}:1，低于 ${floor}:1`,
        )
      }
    })
  }

  for (const theme of THEMES) {
    test(`settings.scss 中 ${theme} 的 --swatch-light 与 custom.scss 同源`, () => {
      // Act
      const swatch = readSwatchLight(theme)
      const light = readThemePalette(theme).light

      // Assert
      assert.equal(swatch, light, `${theme} 色板卡与主题底色不一致`)
    })
  }

  test("quartz.config.ts 的 lightMode.light 与宣纸底色一致", () => {
    // Arrange
    const block = /lightMode:\s*\{([\s\S]*?)\}/.exec(quartzConfig)
    assert.ok(block, "quartz.config.ts 未找到 lightMode 配置块")

    // Act
    const matched = /\blight:\s*"(#[0-9a-fA-F]{3,8})"/.exec(block[1])
    assert.ok(matched, "quartz.config.ts 的 lightMode 缺少 light 色值")

    // Assert
    assert.equal(matched[1], readThemePalette("xuanzhi").light)
  })

  test("desktop/main.cjs 的 DEFAULT_BG.light 与宣纸底色一致", () => {
    // Arrange
    const block = /DEFAULT_BG\s*=\s*\{([^}]*)\}/.exec(desktopMain)
    assert.ok(block, "main.cjs 未找到 DEFAULT_BG")

    // Act
    const matched = /\blight:\s*["'](#[0-9a-fA-F]{3,8})["']/.exec(block[1])
    assert.ok(matched, "main.cjs 的 DEFAULT_BG 缺少 light 色值")

    // Assert
    assert.equal(matched[1], readThemePalette("xuanzhi").light)
  })
})

// ============================================================
// v12 色彩组：玻璃族 token、弹窗底色与素描描边重算
//
// 期望值先行——本组把六套亮态的玻璃族、弹窗底色、悬停洗色、素描描边按下述口径
// 重算后写死在 V12_EXPECTED，custom.scss 当前仍是 v10/v11 旧值，故「读到的值等于
// 常量表」一类断言现在必然见红。见红即门在生效：不得为转绿去改被读取的
// custom.scss 之外的期望值，也不得放松下方的色相锁 / 层次差 / 彩度比阈值。
//
// —— 计算口径（CIELCh，D65；L = CIELAB L*，C = √(a*² + b*²)，h = atan2(b*, a*) 折度）——
// 逐亮态块以 --light 为基准，--lightgray 与 --secondary 为附加输入：
//   1. 玻璃三元组 G（一个不透明 rgb 喂四个 alpha 档 .78/.86/.92/.55）：
//      h 锁 --light；C = clamp(C(light) × 1.30, 6, 11)；L = L(light) + 0.6。
//   2. --popover-bg P：h 锁 --light；C = C(light) × 0.90；L = L(light) + 2.2；alpha .98 沿用。
//   3. --glass-hover-wash H：h 锁 --light；C = clamp(C(lightgray) × 1.15, 5, 9)；
//      L 锁死 L(lightgray)；alpha .55 沿用。
//   4. --glass-bg-solid：G 以 .86 alpha 合成在 --light 上的不透明等价色（每通道四舍五入）。
//   5. --glass-overlay-fallback：h 锁；C = C(light) × 0.60；L = L(light) + 1.2；alpha .55 沿用。
//   6. --popover-border（新 token）：rgb 取本块 --secondary，alpha 0.26。
//   7. --page-art 根 stroke：同主题亮暗两版的 L* 向中点收窄 35%（h 与 C 各自不变），
//      故新 |ΔL*| 恰为原值的 0.65 倍。art 是本轮唯一涉及暗态块的计算，其余 token 暗态不动。
// LCh → Lab → sRGB 越出色域时保 L 与 h、按比例削 C 至入域。8bit 量化不取逐通道朴素
// 四舍五入——朴素取整在低彩度档最大引入 4.7° 色相漂移，与「色相锁」直接冲突；改为在
// ±5 邻域内取「|Δh| 最小、同分再取 CIEDE2000 最近」且 ΔL/ΔC 仍落在下方断言带内的整数三元组。
//
// —— 口径偏差实况（落值任务须一并知悉）——
// A. sRGB 色域顶封：宣纸 / 木衫 / 玄夜三块的 --light 已贴近其色相方向上的色域边界，
//    抬 L 后可用彩度反而收缩，C = C(light) × 1.30（G）与 × 0.90（P）在 sRGB 内不可达：
//      宣纸 G 需 9.70 / 可用 7.00，P 需 6.72 / 可用 4.15；
//      木衫 G 需 9.03 / 可用 8.66，P 需 6.25 / 可用 5.15；
//      玄夜 G 需 10.22 / 可用 6.94，P 需 7.07 / 可用 4.51。
//    按口径削 C 入域后，这三块的彩度比落在 0.86–1.24（G）与 0.59–0.75（P），冲出
//    [1.25,1.35] 与 [0.85,0.95] 带；其中宣纸与玄夜的玻璃甚至比 --light 更淡，与「玻璃
//    比底色更有色温」的设计意图相反。这是 sRGB 的硬约束而非取值失误，故彩度比断言
//    对这些块改判「等于实际可达比值（±0.02）」——门仍能挡住后续漂移，只是不再要求 1.30。
// B. clamp 生效：水墨 C(light) = 3.45，× 1.30 = 4.49 低于下限 6，G 被抬到 6.00，彩度比
//    1.65，按口径豁免彩度比带；悬停洗色的 C 下限 5 在水墨 / 青瓷 / 木衫 / 玄夜四块生效
//    （该档本就只断言明度锁，无彩度比要求）。
// C. 色相锁个别放宽：水墨弹窗档在 ΔL ∈ [1.8,2.6] 且彩度比 ∈ [0.85,0.95] 的可行域内穷举
//    全部 8bit 三元组，最小可达 |Δh| = 2.79°（水墨 --light 彩度 3.45 为六套最低，此档
//    C ≈ 3.14，一个 8bit 步进的横向位移约 0.153，反正切恰为 2.79°）。该项按口径允许的
//    上限放宽到 3.0°，其余 23 项一律 2.0°。
// D. custom.scss 现状核对：四个玻璃 token 在六个亮态块中确为「同 rgb 异 alpha」，
//    alpha 依次为 .78/.86/.92/.55，--popover-bg .98、--glass-hover-wash .55、
//    --glass-overlay-fallback .55，与口径预设一致；--page-art 的十六进制 stroke 全局
//    只出现一处且在根 <svg> 上（内层 path 只带 stroke-width / stroke-opacity）。
//    --popover-border 与 --popover-shadow 目前全文件零处定义，属本轮新增。
// ============================================================

/** 玻璃三元组喂给的四个 alpha 档，沿用 custom.scss 现值，本轮不改。 */
const V12_GLASS_ALPHAS = [
  ["glass-bg", "0.78"],
  ["glass-bg-thick", "0.86"],
  ["glass-scrim", "0.92"],
  ["glass-inner-bg", "0.55"],
] as const

/** 合成对比度门用到的三档 alpha（与上表同源，单列一份便于合成计算读取）。 */
const V12_ALPHA_THICK = 0.86
const V12_ALPHA_INNER = 0.55
const V12_ALPHA_POPOVER = 0.98

interface V12Values {
  /** --glass-bg / -thick / -scrim / -inner-bg 共用的不透明 rgb，形如 "R, G, B"。 */
  glassRgb: string
  popoverBg: string
  hoverWash: string
  bgSolid: string
  overlayFallback: string
  popoverBorder: string
  artStrokeLight: string
  artStrokeDark: string
}

// ==== v12 色彩组定稿值（单一计算源——custom.scss 落值任务逐字抄录此表）====
// 每个字符串可直接粘贴进对应 CSS 声明的右值；glassRgb 需自行包成
// rgba(<glassRgb>, <alpha>) 分别写入四个玻璃 token。
const V12_EXPECTED: Record<ThemeName, V12Values> = {
  xuanzhi: {
    glassRgb: "255, 241, 232",
    popoverBg: "rgba(255, 246, 240, 0.98)",
    hoverWash: "rgba(226, 214, 206, 0.55)",
    bgSolid: "#fff1e8",
    overlayFallback: "rgba(252, 243, 237, 0.55)",
    popoverBorder: "rgba(140, 90, 60, 0.26)",
    artStrokeLight: "#976446",
    artStrokeDark: "#bc8a61",
  },
  shuimo: {
    glassRgb: "233, 248, 253",
    popoverBg: "rgba(243, 251, 254, 0.98)",
    hoverWash: "rgba(208, 220, 224, 0.55)",
    bgSolid: "#e9f8fc",
    overlayFallback: "rgba(241, 247, 249, 0.55)",
    popoverBorder: "rgba(64, 96, 108, 0.26)",
    artStrokeLight: "#4c6b77",
    artStrokeDark: "#7197a4",
  },
  qingci: {
    glassRgb: "224, 250, 246",
    popoverBg: "rgba(235, 253, 250, 0.98)",
    hoverWash: "rgba(208, 221, 219, 0.55)",
    bgSolid: "#e0faf6",
    overlayFallback: "rgba(237, 250, 248, 0.55)",
    popoverBorder: "rgba(61, 112, 104, 0.26)",
    artStrokeLight: "#477971",
    artStrokeDark: "#65a096",
  },
  zhulin: {
    glassRgb: "239, 247, 230",
    popoverBg: "rgba(245, 251, 239, 0.98)",
    hoverWash: "rgba(217, 222, 211, 0.55)",
    bgSolid: "#eff7e6",
    overlayFallback: "rgba(245, 248, 241, 0.55)",
    popoverBorder: "rgba(74, 124, 70, 0.26)",
    artStrokeLight: "#51844d",
    artStrokeDark: "#74a36c",
  },
  mushan: {
    glassRgb: "251, 240, 255",
    popoverBg: "rgba(253, 246, 255, 0.98)",
    hoverWash: "rgba(221, 215, 223, 0.55)",
    bgSolid: "#fbf0fe",
    overlayFallback: "rgba(248, 242, 250, 0.55)",
    popoverBorder: "rgba(109, 90, 142, 0.26)",
    artStrokeLight: "#766297",
    artStrokeDark: "#9582bc",
  },
  xuanye: {
    glassRgb: "238, 242, 255",
    popoverBg: "rgba(243, 246, 255, 0.98)",
    hoverWash: "rgba(213, 216, 225, 0.55)",
    bgSolid: "#eef2ff",
    overlayFallback: "rgba(240, 243, 252, 0.55)",
    popoverBorder: "rgba(74, 93, 138, 0.26)",
    artStrokeLight: "#576997",
    artStrokeDark: "#8296be",
  },
}

/** 色相锁默认阈值；水墨弹窗档因 8bit 网格顶封另行放宽（见文件头偏差 C）。 */
const V12_HUE_LOCK_TOLERANCE = 2.0
const V12_HUE_LOCK_TOLERANCE_SHUIMO_POPOVER = 3.0

/** 层次差窗口：玻璃略提亮、弹窗再提一档、悬停洗色与 --lightgray 等明度。 */
const V12_GLASS_LIGHTNESS_RISE = [0.3, 1.0] as const
const V12_POPOVER_LIGHTNESS_RISE = [1.8, 2.6] as const
const V12_HOVER_LIGHTNESS_TOLERANCE = 0.4

/** 彩度比标准带。 */
const V12_GLASS_CHROMA_BAND = [1.25, 1.35] as const
const V12_POPOVER_CHROMA_BAND = [0.85, 0.95] as const

/**
 * 彩度比豁免表：null 表示走标准带；数值表示该块因色域顶封或 clamp 生效而
 * 只能到达的实际比值（见文件头偏差 A / B），断言改为「等于该值 ±0.02」。
 */
const V12_CHROMA_RATIO_OVERRIDE: Record<
  ThemeName,
  { glass: number | null; popover: number | null }
> = {
  xuanzhi: { glass: 0.915, popover: 0.592 },
  shuimo: { glass: 1.649, popover: null },
  qingci: { glass: null, popover: null },
  zhulin: { glass: null, popover: null },
  mushan: { glass: 1.242, popover: 0.753 },
  xuanye: { glass: 0.863, popover: 0.598 },
}
const V12_CHROMA_RATIO_OVERRIDE_TOLERANCE = 0.02

/** 合成底上的对比度下限（合成底非纯 --light，故弹窗档自 7 放宽到 6）。 */
const V12_NAV_ON_THICK_FLOOR = 4.5
const V12_DARKGRAY_ON_INNER_FLOOR = 4.5
const V12_DARK_ON_POPOVER_FLOOR = 6
const V12_TEXT_HIGHLIGHT_FLOOR = 4.5

/** v12 之前（v9 定稿）同主题亮暗两版 --page-art 根 stroke 的 |ΔL*|，收窄门的基准。 */
const V12_ART_ORIGINAL_DELTA_L: Record<ThemeName, number> = {
  xuanzhi: 22.5531,
  shuimo: 25.9229,
  qingci: 21.8641,
  zhulin: 18.1095,
  mushan: 19.0467,
  xuanye: 27.0387,
}

/** 收窄 35% 后新旧 |ΔL*| 之比理论上恰为 0.65，量化误差留在 [0.55, 0.75] 内。 */
const V12_ART_DELTA_L_RATIO_BAND = [0.55, 0.75] as const

/** 描边压在本态 --light 上必须拉开的明度差，低于此值素描糊进底色。 */
const V12_ART_MIN_LIGHTNESS_GAP = 40

/** custom.scss 至少要有的 --popover-shadow 定义处数（:root 亮暗各一）。 */
const V12_MIN_POPOVER_SHADOW_DEFINITIONS = 2

interface Lch {
  L: number
  C: number
  h: number
}

/** CIELAB → CIELCh：色相角折到 [0, 360)。 */
function lchOf(hex: string): Lch {
  const { L, a, b } = hexToLab(hex)
  const angle = (Math.atan2(b, a) * 180) / Math.PI
  return { L, C: Math.hypot(a, b), h: angle >= 0 ? angle : angle + 360 }
}

/** 两个色相角的最短夹角，取值 [0, 180]。 */
function hueGap(hue1: number, hue2: number): number {
  const raw = Math.abs(hue1 - hue2) % 360
  return raw > 180 ? 360 - raw : raw
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

/** 把 rgb 三通道拼成常量表里的 "R, G, B" 形态，供逐位比对。 */
function rgbTriplet({ r, g, b }: Rgb): string {
  return `${r}, ${g}, ${b}`
}

/** 解析 rgba(r, g, b, a)；alpha 保留原始字符串，避免 0.55 与 .55 被判等。 */
function parseRgbaValue(value: string, label: string): { rgb: Rgb; alpha: string } {
  const matched = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/.exec(value.trim())
  assert.ok(matched, `${label} 不是 rgba(r, g, b, a) 形态：${value}`)
  return {
    rgb: { r: Number(matched[1]), g: Number(matched[2]), b: Number(matched[3]) },
    alpha: matched[4],
  }
}

/** 解析 #rrggbb 与 #rrggbbaa 两种形态——--textHighlight 是后者。 */
function parseHexColor(value: string, label: string): { rgb: Rgb; alpha: number } {
  const matched = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value.trim())
  assert.ok(matched, `${label} 不是 #rrggbb 或 #rrggbbaa：${value}`)
  return {
    rgb: hexToRgb(`#${matched[1]}`),
    alpha: matched[2] === undefined ? 1 : Number.parseInt(matched[2], 16) / 255,
  }
}

/** alpha 合成：X ∘ Y = alpha·X + (1−alpha)·Y 逐通道，四舍五入回 8bit（与浏览器一致）。 */
function compositeOver(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return {
    r: Math.round(alpha * top.r + (1 - alpha) * bottom.r),
    g: Math.round(alpha * top.g + (1 - alpha) * bottom.g),
    b: Math.round(alpha * top.b + (1 - alpha) * bottom.b),
  }
}

/** 取自定义属性；缺失时返回 null，便于「值等于常量表」一条把整块差异一次报全。 */
function readOptionalCustomProperty(block: string, property: string): string | null {
  const matched = new RegExp(`--${property}:\\s*([^;]+);`).exec(block)
  return matched ? matched[1].trim() : null
}

/** 取某套主题的暗态块。art 收窄是本轮唯一需要读暗态的计算。 */
function readDarkThemeBlock(theme: ThemeName): string {
  const matched = new RegExp(
    `:root\\[data-style="${theme}"\\]\\[saved-theme="dark"\\][ \\t]*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(customStyles)
  assert.ok(matched, `custom.scss 未找到 ${theme} 的暗态主题块`)
  return matched[1]
}

/** 解出 --page-art 的 data-URI 正文与根 <svg> 上的 stroke 色值。 */
function readPageArt(block: string, label: string): { decoded: string; rootStroke: string } {
  const raw = readOptionalCustomProperty(block, "page-art")
  assert.ok(raw, `${label} 缺少 --page-art`)

  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    assert.fail(`${label} 的 --page-art 不是合法的百分号编码，decodeURIComponent 抛错`)
  }

  const rootMatch = /<svg[^>]*\sstroke='(#[0-9a-fA-F]{6})'/.exec(decoded)
  assert.ok(rootMatch, `${label} 的 --page-art 根 <svg> 上取不到十六进制 stroke`)
  return { decoded, rootStroke: rootMatch[1].toLowerCase() }
}

describe("v12 色彩组门：custom.scss 落值前预期失败", () => {
  for (const theme of THEMES) {
    test(`${theme} 玻璃四档 token 同 rgb 异 alpha，alpha 沿用现值`, () => {
      // Arrange
      const block = readLightThemeBlock(theme)

      // Act
      const parsed = V12_GLASS_ALPHAS.map(([property, alpha]) => {
        const value = readOptionalCustomProperty(block, property)
        assert.ok(value, `${theme} 亮态块缺少 --${property}`)
        return {
          property,
          expectedAlpha: alpha,
          ...parseRgbaValue(value, `${theme} --${property}`),
        }
      })

      // Assert：四者的 rgb 必须逐位相等，alpha 各自沿用既定档位
      const triplets = parsed.map(({ rgb }) => rgbTriplet(rgb))
      assert.deepEqual(
        triplets,
        Array.from({ length: triplets.length }, () => triplets[0]),
        `${theme} 玻璃四档 rgb 不一致：${parsed.map((p) => `--${p.property}=${rgbTriplet(p.rgb)}`).join(" / ")}`,
      )
      assert.deepEqual(
        parsed.map(({ alpha }) => alpha),
        parsed.map(({ expectedAlpha }) => expectedAlpha),
        `${theme} 玻璃四档 alpha 偏离既定值`,
      )
    })
  }

  for (const theme of THEMES) {
    test(`${theme} 玻璃族与弹窗六值等于 v12 定稿值`, () => {
      // Arrange
      const block = readLightThemeBlock(theme)
      const glass = readOptionalCustomProperty(block, "glass-bg")
      assert.ok(glass, `${theme} 亮态块缺少 --glass-bg`)

      // Act
      const actual = {
        glassRgb: rgbTriplet(parseRgbaValue(glass, `${theme} --glass-bg`).rgb),
        popoverBg: readOptionalCustomProperty(block, "popover-bg") ?? "<未定义>",
        hoverWash: readOptionalCustomProperty(block, "glass-hover-wash") ?? "<未定义>",
        bgSolid: readOptionalCustomProperty(block, "glass-bg-solid") ?? "<未定义>",
        overlayFallback: readOptionalCustomProperty(block, "glass-overlay-fallback") ?? "<未定义>",
        popoverBorder: readOptionalCustomProperty(block, "popover-border") ?? "<未定义>",
      }

      // Assert：期望值先行，落值前此条即为门的红灯
      const { artStrokeLight: _light, artStrokeDark: _dark, ...expected } = V12_EXPECTED[theme]
      assert.deepEqual(actual, expected)
    })
  }

  for (const theme of THEMES) {
    test(`${theme} 玻璃 / 弹窗 / 悬停 / 兜底四档色相锁死 --light`, () => {
      // Arrange
      const block = readLightThemeBlock(theme)
      const light = readCustomProperty(block, "light", `custom.scss ${theme} 亮态块`)
      const baseHue = lchOf(light).h

      // Act
      const samples = [
        ["glass-bg", V12_HUE_LOCK_TOLERANCE],
        [
          "popover-bg",
          theme === "shuimo" ? V12_HUE_LOCK_TOLERANCE_SHUIMO_POPOVER : V12_HUE_LOCK_TOLERANCE,
        ],
        ["glass-hover-wash", V12_HUE_LOCK_TOLERANCE],
        ["glass-overlay-fallback", V12_HUE_LOCK_TOLERANCE],
      ] as const

      // Assert
      for (const [property, tolerance] of samples) {
        const value = readOptionalCustomProperty(block, property)
        assert.ok(value, `${theme} 亮态块缺少 --${property}`)
        const { rgb } = parseRgbaValue(value, `${theme} --${property}`)
        const gap = hueGap(lchOf(rgbToHex(rgb)).h, baseHue)
        assert.ok(
          gap <= tolerance,
          `${theme} 的 --${property}(${value}) 色相偏离 --light(${light}) ${gap.toFixed(2)}°，超出 ${tolerance}°`,
        )
      }
    })
  }

  for (const theme of THEMES) {
    test(`${theme} 玻璃 / 弹窗 / 悬停三档的明度层次差在窗口内`, () => {
      // Arrange
      const block = readLightThemeBlock(theme)
      const source = `custom.scss ${theme} 亮态块`
      const light = lchOf(readCustomProperty(block, "light", source))
      const lightgray = lchOf(readCustomProperty(block, "lightgray", source))
      const read = (property: string) => {
        const value = readOptionalCustomProperty(block, property)
        assert.ok(value, `${theme} 亮态块缺少 --${property}`)
        return lchOf(rgbToHex(parseRgbaValue(value, `${theme} --${property}`).rgb))
      }

      // Act
      const glassRise = read("glass-bg").L - light.L
      const popoverRise = read("popover-bg").L - light.L
      const hoverDrift = Math.abs(read("glass-hover-wash").L - lightgray.L)

      // Assert
      assert.ok(
        glassRise >= V12_GLASS_LIGHTNESS_RISE[0] && glassRise <= V12_GLASS_LIGHTNESS_RISE[1],
        `${theme} 玻璃比 --light 提亮 ${glassRise.toFixed(3)}，越出 [${V12_GLASS_LIGHTNESS_RISE.join(", ")}]`,
      )
      assert.ok(
        popoverRise >= V12_POPOVER_LIGHTNESS_RISE[0] &&
          popoverRise <= V12_POPOVER_LIGHTNESS_RISE[1],
        `${theme} 弹窗比 --light 提亮 ${popoverRise.toFixed(3)}，越出 [${V12_POPOVER_LIGHTNESS_RISE.join(", ")}]`,
      )
      assert.ok(
        hoverDrift <= V12_HOVER_LIGHTNESS_TOLERANCE,
        `${theme} 悬停洗色与 --lightgray 差 ${hoverDrift.toFixed(3)}，超出 ${V12_HOVER_LIGHTNESS_TOLERANCE}`,
      )
    })
  }

  for (const theme of THEMES) {
    test(`${theme} 玻璃与弹窗对 --light 的彩度比达标`, () => {
      // Arrange
      const block = readLightThemeBlock(theme)
      const light = lchOf(readCustomProperty(block, "light", `custom.scss ${theme} 亮态块`))
      const override = V12_CHROMA_RATIO_OVERRIDE[theme]
      const read = (property: string) => {
        const value = readOptionalCustomProperty(block, property)
        assert.ok(value, `${theme} 亮态块缺少 --${property}`)
        return lchOf(rgbToHex(parseRgbaValue(value, `${theme} --${property}`).rgb)).C / light.C
      }

      // Act
      const checks = [
        ["glass-bg", read("glass-bg"), override.glass, V12_GLASS_CHROMA_BAND],
        ["popover-bg", read("popover-bg"), override.popover, V12_POPOVER_CHROMA_BAND],
      ] as const

      // Assert：色域顶封 / clamp 生效的块改判「等于实际可达比值」（见文件头偏差 A、B）
      for (const [property, ratio, exempt, band] of checks) {
        if (exempt === null) {
          assert.ok(
            ratio >= band[0] && ratio <= band[1],
            `${theme} 的 --${property} 彩度比 ${ratio.toFixed(3)}，越出 [${band.join(", ")}]`,
          )
          continue
        }
        assert.ok(
          Math.abs(ratio - exempt) <= V12_CHROMA_RATIO_OVERRIDE_TOLERANCE,
          `${theme} 的 --${property} 彩度比 ${ratio.toFixed(3)}，偏离色域/clamp 顶封值 ${exempt} 超过 ${V12_CHROMA_RATIO_OVERRIDE_TOLERANCE}`,
        )
      }
    })
  }

  for (const theme of THEMES) {
    test(`${theme} 导航 / 右栏 / 弹窗三处合成底上的对比度达标`, () => {
      // Arrange
      const block = readLightThemeBlock(theme)
      const source = `custom.scss ${theme} 亮态块`
      const light = hexToRgb(readCustomProperty(block, "light", source))
      const readRgb = (property: string) => {
        const value = readOptionalCustomProperty(block, property)
        assert.ok(value, `${theme} 亮态块缺少 --${property}`)
        return parseRgbaValue(value, `${theme} --${property}`).rgb
      }
      const glass = readRgb("glass-bg-thick")
      const inner = readRgb("glass-inner-bg")
      const popover = readRgb("popover-bg")

      // Act：X ∘ Y = alpha·X + (1−alpha)·Y
      const thickOnLight = compositeOver(glass, V12_ALPHA_THICK, light)
      const innerOnThick = compositeOver(inner, V12_ALPHA_INNER, thickOnLight)
      const popoverOnLight = compositeOver(popover, V12_ALPHA_POPOVER, light)
      const gates = [
        ["nav-fg", "thick∘light", thickOnLight, V12_NAV_ON_THICK_FLOOR],
        ["darkgray", "inner∘(thick∘light)", innerOnThick, V12_DARKGRAY_ON_INNER_FLOOR],
        ["dark", "popover∘light", popoverOnLight, V12_DARK_ON_POPOVER_FLOOR],
      ] as const

      // Assert
      for (const [property, description, background, floor] of gates) {
        const foreground = readCustomProperty(block, property, source)
        const ratio = contrastRatio(foreground, rgbToHex(background))
        assert.ok(
          ratio >= floor,
          `${theme} 的 --${property}(${foreground}) 压在 ${description}(${rgbToHex(background)}) 上仅 ${ratio.toFixed(2)}:1，低于 ${floor}:1`,
        )
      }
    })
  }

  for (const theme of THEMES) {
    test(`${theme} 亮暗两态的 --textHighlight 合成后仍托得住 --dark`, () => {
      // Arrange
      const blocks = [
        ["亮态", readLightThemeBlock(theme)],
        ["暗态", readDarkThemeBlock(theme)],
      ] as const

      // Act & Assert：--textHighlight 是 #rrggbbaa 八位形态，需先拆出 alpha 再合成
      for (const [state, block] of blocks) {
        const source = `custom.scss ${theme} ${state}块`
        const light = hexToRgb(readCustomProperty(block, "light", source))
        const dark = readCustomProperty(block, "dark", source)
        const highlight = parseHexColor(
          readCustomProperty(block, "textHighlight", source),
          `${theme} ${state} --textHighlight`,
        )
        const background = compositeOver(highlight.rgb, highlight.alpha, light)
        const ratio = contrastRatio(dark, rgbToHex(background))
        assert.ok(
          ratio >= V12_TEXT_HIGHLIGHT_FLOOR,
          `${theme} ${state} --dark(${dark}) 压在 textHighlight∘light(${rgbToHex(background)}) 上仅 ${ratio.toFixed(2)}:1，低于 ${V12_TEXT_HIGHLIGHT_FLOOR}:1`,
        )
      }
    })
  }

  test(`custom.scss 定义 --popover-shadow 不少于 ${V12_MIN_POPOVER_SHADOW_DEFINITIONS} 处`, () => {
    // Act：只数「--popover-shadow:」这种定义处，var(--popover-shadow) 的引用不计
    const definitions = customStyles.match(/--popover-shadow\s*:/g) ?? []

    // Assert
    assert.ok(
      definitions.length >= V12_MIN_POPOVER_SHADOW_DEFINITIONS,
      `custom.scss 只有 ${definitions.length} 处 --popover-shadow 定义，:root 亮暗两态各需一处`,
    )
  })

  for (const theme of THEMES) {
    test(`${theme} 的 --page-art 亮暗两版可解析且根 stroke 已按 35% 收窄`, () => {
      // Arrange
      const lightBlock = readLightThemeBlock(theme)
      const darkBlock = readDarkThemeBlock(theme)
      const expected = V12_EXPECTED[theme]

      // Act
      const lightArt = readPageArt(lightBlock, `${theme} 亮态块`)
      const darkArt = readPageArt(darkBlock, `${theme} 暗态块`)

      // Assert：先验 SVG 结构，再验描边取值，最后验两版的明度间距
      for (const [state, art] of [
        ["亮态", lightArt],
        ["暗态", darkArt],
      ] as const) {
        assert.match(art.decoded, /<svg[\s>]/, `${theme} ${state} --page-art 解码后缺少 <svg 头`)
        assert.match(
          art.decoded,
          /viewBox\s*=\s*'[^']+'/,
          `${theme} ${state} --page-art 解码后缺少 viewBox`,
        )
      }
      assert.equal(lightArt.rootStroke, expected.artStrokeLight, `${theme} 亮态描边不等于定稿值`)
      assert.equal(darkArt.rootStroke, expected.artStrokeDark, `${theme} 暗态描边不等于定稿值`)

      const strokeGap = Math.abs(hexToLab(lightArt.rootStroke).L - hexToLab(darkArt.rootStroke).L)
      const original = V12_ART_ORIGINAL_DELTA_L[theme]
      const [lower, upper] = V12_ART_DELTA_L_RATIO_BAND
      assert.ok(
        strokeGap >= original * lower && strokeGap <= original * upper,
        `${theme} 亮暗描边 |ΔL*| = ${strokeGap.toFixed(3)}，越出收窄窗口 [${(original * lower).toFixed(3)}, ${(original * upper).toFixed(3)}]（原值 ${original}）`,
      )

      for (const [state, block, art] of [
        ["亮态", lightBlock, lightArt],
        ["暗态", darkBlock, darkArt],
      ] as const) {
        const source = `custom.scss ${theme} ${state}块`
        const gap = Math.abs(
          hexToLab(art.rootStroke).L - hexToLab(readCustomProperty(block, "light", source)).L,
        )
        assert.ok(
          gap >= V12_ART_MIN_LIGHTNESS_GAP,
          `${theme} ${state}描边(${art.rootStroke}) 与本态 --light 只差 ${gap.toFixed(2)} L*，低于 ${V12_ART_MIN_LIGHTNESS_GAP}`,
        )
      }
    })
  }
})
