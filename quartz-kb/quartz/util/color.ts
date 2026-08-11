// 本模块只放色彩空间换算与色差/对比度的纯函数（零依赖、不触碰 DOM，可被
// `tsx --test` 直接单测），供「调色板一致性门」在构建期校验主题色值使用：
// 1. hexToRgb / rgbToLab / hexToLab——sRGB 十六进制到 CIELAB（D65）的换算链；
// 2. deltaE2000——CIEDE2000 完整实现，用于判定六套主题底色两两是否足够可辨；
// 3. contrastRatio——WCAG 2.x 相对亮度对比度，用于判定文字色压在底色上是否达标。
// 三者共用同一条 sRGB 线性化（srgbToLinear），避免两套阈值漂移。

/** sRGB 三通道，取值 0-255 的整数。 */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** CIELAB 三分量：L 为 0-100 的明度，a 与 b 分别是红绿、黄蓝对立色轴。 */
export interface Lab {
  L: number
  a: number
  b: number
}

const HEX_PATTERN = /^#?([0-9a-fA-F]{6})$/

// sRGB 传递函数的分段阈值。WCAG 2.x 正文写作 0.03928（沿袭早期 sRGB 草案），
// 与 IEC 61966-2-1 的 0.04045 只在通道字节值 10 这一点上分歧，导致的相对亮度
// 偏差小于 3e-6，对 4.5:1 / 7:1 一类判定无影响，故此处统一取 0.04045。
const SRGB_LINEAR_THRESHOLD = 0.04045

// D65 二度视场参考白（sRGB 基色矩阵各行之和恰为该白点，故纯白 a*=b*=0）。
const D65_WHITE_X = 0.95047
const D65_WHITE_Y = 1.0
const D65_WHITE_Z = 1.08883

// CIE 标准的 Lab 分段常量：ε=(6/29)^3，κ=(29/3)^3。
const LAB_EPSILON = 216 / 24389
const LAB_KAPPA = 24389 / 27

// CIEDE2000 中反复出现的 25^7，提前算好避免在循环里重复求幂。
const POW_25_7 = 25 ** 7

// CIEDE2000 的三个加权参数，图文场景取参考条件 kL = kC = kH = 1。
const K_LIGHTNESS = 1
const K_CHROMA = 1
const K_HUE = 1

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI
}

/** sRGB 单通道（0-255）反伽马到线性光。 */
function srgbToLinear(channel: number): number {
  const normalized = channel / 255
  return normalized <= SRGB_LINEAR_THRESHOLD
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

/** CIELAB 的分段立方根函数 f(t)。 */
function labTransfer(ratio: number): number {
  return ratio > LAB_EPSILON ? Math.cbrt(ratio) : (LAB_KAPPA * ratio + 16) / 116
}

/**
 * 解析 #rrggbb（`#` 可省略）为 0-255 的三通道。
 * 非法输入直接抛错——色值来自样式文件与配置，静默回落只会把错值带进后续判定。
 */
export function hexToRgb(hex: string): Rgb {
  const matched = HEX_PATTERN.exec(hex.trim())
  if (!matched) {
    throw new Error(`不是合法的 #rrggbb 颜色值：${hex}`)
  }

  const packed = Number.parseInt(matched[1], 16)
  return { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff }
}

/** sRGB → 线性光 → CIEXYZ(D65) → CIELAB。 */
export function rgbToLab({ r, g, b }: Rgb): Lab {
  const linearR = srgbToLinear(r)
  const linearG = srgbToLinear(g)
  const linearB = srgbToLinear(b)

  const x = (0.4124564 * linearR + 0.3575761 * linearG + 0.1804375 * linearB) / D65_WHITE_X
  const y = (0.2126729 * linearR + 0.7151522 * linearG + 0.072175 * linearB) / D65_WHITE_Y
  const z = (0.0193339 * linearR + 0.119192 * linearG + 0.9503041 * linearB) / D65_WHITE_Z

  const fx = labTransfer(x)
  const fy = labTransfer(y)
  const fz = labTransfer(z)

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/** hexToRgb 与 rgbToLab 的组合：直接由 #rrggbb 得到 CIELAB。 */
export function hexToLab(hex: string): Lab {
  return rgbToLab(hexToRgb(hex))
}

/** 由 b* 与补偿后的 a'* 求色相角 h'，归一到 [0, 360)；两者同为 0 时按标准取 0。 */
function hueAngle(b: number, aPrime: number): number {
  if (b === 0 && aPrime === 0) {
    return 0
  }

  const angle = toDegrees(Math.atan2(b, aPrime))
  return angle >= 0 ? angle : angle + 360
}

/** 色相差 Δh'，按标准折算到 (-180, 180]；任一彩度为 0 时无色相差可言。 */
function hueDifference(hue1: number, hue2: number, chromaProduct: number): number {
  if (chromaProduct === 0) {
    return 0
  }

  const difference = hue2 - hue1
  if (Math.abs(difference) <= 180) {
    return difference
  }
  return difference > 180 ? difference - 360 : difference + 360
}

/** 平均色相 h̄'，跨 0°/360° 接缝时按标准做 ±360 修正。 */
function meanHue(hue1: number, hue2: number, chromaProduct: number): number {
  const sum = hue1 + hue2
  if (chromaProduct === 0) {
    return sum
  }
  if (Math.abs(hue1 - hue2) <= 180) {
    return sum / 2
  }
  return sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2
}

/** RT 旋转项：补偿蓝紫区（h̄' 约 275°）高彩度下色相与彩度的交互失配。 */
function rotationTerm(meanChroma: number, meanHueAngle: number): number {
  const deltaTheta = 30 * Math.exp(-(((meanHueAngle - 275) / 25) ** 2))
  const chromaFactor = 2 * Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + POW_25_7))
  return -Math.sin(toRadians(2 * deltaTheta)) * chromaFactor
}

/**
 * CIEDE2000 色差（CIE 142-2001）。含 G 因子对 a* 的低彩度补偿、h' 与 Δh' 的
 * 接缝处理、色相权重 T 项以及蓝紫区的 RT 旋转项，非简化 ΔE76。
 * 加权参数取参考条件 kL = kC = kH = 1。
 */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const chroma1 = Math.hypot(lab1.a, lab1.b)
  const chroma2 = Math.hypot(lab2.a, lab2.b)
  const chromaMean = (chroma1 + chroma2) / 2
  const g = 0.5 * (1 - Math.sqrt(chromaMean ** 7 / (chromaMean ** 7 + POW_25_7)))

  const aPrime1 = (1 + g) * lab1.a
  const aPrime2 = (1 + g) * lab2.a
  const chromaPrime1 = Math.hypot(aPrime1, lab1.b)
  const chromaPrime2 = Math.hypot(aPrime2, lab2.b)
  const chromaProduct = chromaPrime1 * chromaPrime2

  const hue1 = hueAngle(lab1.b, aPrime1)
  const hue2 = hueAngle(lab2.b, aPrime2)
  const deltaHueAngle = hueDifference(hue1, hue2, chromaProduct)

  const deltaLightness = lab2.L - lab1.L
  const deltaChroma = chromaPrime2 - chromaPrime1
  const deltaHue = 2 * Math.sqrt(chromaProduct) * Math.sin(toRadians(deltaHueAngle / 2))

  const lightnessMean = (lab1.L + lab2.L) / 2
  const chromaPrimeMean = (chromaPrime1 + chromaPrime2) / 2
  const hueMean = meanHue(hue1, hue2, chromaProduct)

  const t =
    1 -
    0.17 * Math.cos(toRadians(hueMean - 30)) +
    0.24 * Math.cos(toRadians(2 * hueMean)) +
    0.32 * Math.cos(toRadians(3 * hueMean + 6)) -
    0.2 * Math.cos(toRadians(4 * hueMean - 63))

  const lightnessOffset = (lightnessMean - 50) ** 2
  const sL = 1 + (0.015 * lightnessOffset) / Math.sqrt(20 + lightnessOffset)
  const sC = 1 + 0.045 * chromaPrimeMean
  const sH = 1 + 0.015 * chromaPrimeMean * t

  const lightnessTerm = deltaLightness / (K_LIGHTNESS * sL)
  const chromaTerm = deltaChroma / (K_CHROMA * sC)
  const hueTerm = deltaHue / (K_HUE * sH)
  const rt = rotationTerm(chromaPrimeMean, hueMean)

  return Math.sqrt(lightnessTerm ** 2 + chromaTerm ** 2 + hueTerm ** 2 + rt * chromaTerm * hueTerm)
}

/** WCAG 2.x 相对亮度：线性光三通道按 0.2126 / 0.7152 / 0.0722 加权。 */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/**
 * WCAG 2.x 对比度 (L1 + 0.05) / (L2 + 0.05)，L1 取两色中较亮者，
 * 故结果恒 ≥ 1 且与参数顺序无关。纯黑对纯白为 21。
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const luminance1 = relativeLuminance(hex1)
  const luminance2 = relativeLuminance(hex2)
  const lighter = Math.max(luminance1, luminance2)
  const darker = Math.min(luminance1, luminance2)
  return (lighter + 0.05) / (darker + 0.05)
}
