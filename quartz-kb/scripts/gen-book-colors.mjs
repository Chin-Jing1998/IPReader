#!/usr/bin/env node
// ============================================================
// 书级图谱色板生成器（阶段5.1 批 G-2）
// ============================================================
// 用途：把图谱节点配色从「组级 15 色」细化到「书级 88 色」，同时统一微调组代表色
// （图例色点）并补齐新组 15。纯 Node、零第三方依赖，OKLab/OKLCh ↔ sRGB 转换与
// sRGB 色域求解均在本文件内实现。
//
// 确定性：全程无随机数、无时间戳、无文件系统枚举（书目清单取自 graphSections.ts
// 源码文本 + 本文件的寄养表），贪心与坐标下降的平局一律取更小的候选下标，
// 同一输入重跑输出逐字节一致。
//
// 用法（工作目录任意，路径按本文件位置解析）：
//   node scripts/gen-book-colors.mjs            # 只打印可辨性报告
//   node scripts/gen-book-colors.mjs --emit     # 额外打印将写入的代码块
//   node scripts/gen-book-colors.mjs --write    # 回写 custom.scss 与 graphSections.ts
// 回写后跑一次 `npx prettier --write` 覆盖这两个文件。
//
// 回写落点（三处，均幂等——组色一律从本文件 BASELINE_SECTION_COLORS 基线重算，
// 绝不在已调过的值上二次叠加）：
//   ① quartz/styles/custom.scss  哨兵 `// >>> gen-book-colors:light|dark` 之间的
//      --graph-book-<前缀> 全局变量块（各 88 行）；
//   ② quartz/styles/custom.scss  六主题 × light/dark 共 12 块内的
//      --graph-section-1..15（组代表色微调 + 新增 15）；
//   ③ quartz/util/graphSections.ts  哨兵 `// >>> gen-book-colors:ts` 之间的
//      BOOK_COLORS 常量（88 键）。
//
// 分配策略（三层）：
//   ① 色相 = 法域。每组占一段色相带；带界取相邻组锚点色相之差按两侧书数加权劈分，
//      书多的组自动占更宽的带。组内第 k 本书落在第 (k+0.5)/n 处，两端各留半格，
//      使「跨组相邻两书」的色相间距与「组内相邻两书」同量级。
//   ② 明度/彩度 = 组内区分。9 级明度 × 3 级彩度 = 27 档点阵（奇数彩度列的明度抬
//      半步，构成六方排列）；彩度取**绝对值**并按色相带做可用性过滤，装不下的档
//      直接不参与该组指派（比例式彩度会在窄色域段把三档压扁，实测把组内最小色差
//      压到 0.025）。
//   ③ 指派 = 两段确定性优化。候选 = 可用档 × 7 个色相微偏移；先按固定顺序贪心
//      取「与已放置色的最小距离」最大者，再跑软罚坐标下降 Σ max(0, TARGET − ΔEok)²，
//      最后跑一段直接抬「全局最小色差」的打磨（见 polish 注释）。两段均只接受严格
//      变优，故单调收敛、与遍历顺序无关。**light 与 dark 共用同一份指派** —— 同一本书
//      在明暗两态是同一档的深浅变体，不会「亮态深而暗态浅」地跳档。
//
// 沿革（阶段5.2 批 Q-2）：ORPHAN_HOST 摘除 5（机械撰写）/ 6（化学撰写）——
// 二者随 SECTION_GROUPS 召回为独立 main 组，各自成为单书组，直接取组代表色、
// 不再降饱和寄养；91（专利质量评价指南）作为 id10（专利扩展）组的正常成员参与
// 分配。总书数由 87 增至 88。
// ============================================================

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCSS_PATH = resolve(HERE, "../quartz/styles/custom.scss")
const TS_PATH = resolve(HERE, "../quartz/util/graphSections.ts")

// ============================================================
// 一、色彩数学：sRGB ↔ OKLab / OKLCh（Björn Ottosson 原始矩阵）
// ============================================================

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

function linearRgbToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToLinearRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const DEG = Math.PI / 180

function hexToOklch(hex) {
  const [L, a, b] = hexToOklab(hex)
  let h = Math.atan2(b, a) / DEG
  if (h < 0) h += 360
  return { L, C: Math.hypot(a, b), h }
}

function hexToOklab(hex) {
  const n = parseInt(hex.slice(1), 16)
  return linearRgbToOklab(
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
  )
}

const oklchToOklab = ({ L, C, h }) => [L, C * Math.cos(h * DEG), C * Math.sin(h * DEG)]

/** OKLCh 是否落在 sRGB 内（留 1e-6 数值容差，抵消三次方与矩阵乘的舍入） */
function inGamut(lch) {
  const [r, g, b] = oklabToLinearRgb(...oklchToOklab(lch))
  return r >= -1e-6 && r <= 1 + 1e-6 && g >= -1e-6 && g <= 1 + 1e-6 && b >= -1e-6 && b <= 1 + 1e-6
}

/** 给定 (L, h) 在 sRGB 内可达的最大彩度：24 次二分 */
function maxChroma(L, h) {
  let lo = 0
  let hi = 0.45
  if (inGamut({ L, C: hi, h })) return hi
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (inGamut({ L, C: mid, h })) lo = mid
    else hi = mid
  }
  return lo
}

function oklchToHex(lch) {
  // 先按 (L, h) 顶封彩度再取整：裁剪若发生在 8bit 量化之后会带出色相漂移
  const C = Math.min(lch.C, maxChroma(lch.L, lch.h))
  const [r, g, b] = oklabToLinearRgb(...oklchToOklab({ L: lch.L, C, h: lch.h }))
  const ch = (v) => {
    const n = Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255)
    return n.toString(16).padStart(2, "0")
  }
  return `#${ch(r)}${ch(g)}${ch(b)}`
}

const dist = (A, B) => Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2])

/**
 * ΔEok：OKLab 空间欧氏距离。OKLab 以感知均匀为设计目标，大色块的 JND ≈ 0.02。
 * 图谱节点是 3.5–13px 的小圆点（小视角下辨色能力下降），故本报告按 0.040 作为
 * 「可稳定区分」的工作阈值，即 JND 的 2 倍。一律按**量化后的 hex** 计算，不按
 * 理论 OKLCh 值 —— 上屏的是量化结果。
 */
const deltaE = (hexA, hexB) => dist(hexToOklab(hexA), hexToOklab(hexB))

// ============================================================
// 二、输入
// ============================================================

/** 六套主题 × light/dark 的组代表色**基线**（微调前实况，逐字抄自 custom.scss）。
 *  硬编码而非从文件读取，是为了让 --write 幂等：任何一次重跑都从这张基线表重算，
 *  不会在已调过的值上二次叠加色相旋转。每行 14 个值，依次对应组号 1..14。 */
const BASELINE_SECTION_COLORS = {
  "xuanzhi:light":
    "be5e66 b6684f 9d7a37 578e6d 498f84 5984b1 8a73af a66b8b 687bc4 76863f 488c40 3b7e8f 844c92 4d43a6",
  "xuanzhi:dark":
    "d6747b ca805a b38f4d 6ca482 5ea499 6e99c8 a088c5 bc80a0 7c90dc 92a557 5aa552 7abbcc aa62bb 6d62d2",
  "shuimo:light":
    "bb6168 b06e46 9b7b3d 5a8e6e 4d8e84 5c84af 8a74ac a46c8b 697cc1 768543 4b8b44 3f7d8d 824e8f 4f46a2",
  "shuimo:dark":
    "d3767c c7835b b19052 6fa383 62a399 7099c5 9f88c2 ba81a0 7d91d8 93a45a 5da455 7ebaca a764b8 6e64cd",
  "qingci:light":
    "c45963 b76938 a0792a 51906b 3a8f8f 5484b7 8c71b3 a9688c 657acc 758835 408f37 2e798b 874997 493db0",
  "qingci:dark":
    "dc6f78 ce7e4e b68e42 66a67f 52a5a4 6999cd a186ca c07da2 798fe3 92a64e 54a84a 6db9cc ae5ec2 6a5eda",
  "zhulin:light":
    "c75662 ba6833 a17922 4e916a 3a9185 5184b9 8c70b6 ab678d 6479cf 74882f 3b9032 308094 8a479a 473ab5",
  "zhulin:dark":
    "df6c76 d17d49 b88e3c 63a67e 51a69a 6699d0 a185cd c27ca2 788fe7 91a74a 50a846 6ebed2 b05cc5 695cde",
  "mushan:light":
    "c45963 b76938 a0792a 51906b 3f9085 5484b7 956dad a9688c 657acc 758835 408f37 337f92 834992 463ab1",
  "mushan:dark":
    "dc6f78 ce7e4e b68e42 66a67f 56a69a 6999cd aa83c4 c07da2 798fe3 92a64e 54a84a 73bdd0 ab5ebe 675adc",
  "xuanye:light":
    "c85561 bb6731 a2781e 4c9169 379185 5084bb 8c6fb7 ac668d 6f75d0 73892c 39912f 2d8095 8a459c 473abf",
  "xuanye:dark":
    "e16b76 d27c47 b88d38 62a77e 4fa79a 6599d2 a284ce c37ba3 808ce8 91a747 4ea944 6cbfd4 b15bc7 6b5ee3",
}
const baselineHex = (themeKey, id) =>
  "#" + BASELINE_SECTION_COLORS[themeKey].split(" ")[Number(id) - 1]

/**
 * 组代表色微调表（本批第 3 项）：消除最刺眼的近似组对。
 * 逐块施加同一组增量（dh 色相旋转°、dL 明度增量、kC 彩度倍率），
 * 六套主题各自的明度/彩度包络原样保留，色相顺序跨主题不变的既有约定不受影响。
 * 组 9（术语层）不动 —— 它由三态钮独管，且不是任何书的宿主。
 * 组 5/6 已于阶段5.2 批 Q-2 随 SECTION_GROUPS 召回为 main 组（各自单书组，
 * n===1 分支下书色直接取代表色，见下方 buildBooks）：6 沿用基线值不调；
 * 5 的基线值（G-1 摘除期间保留的变量占位、原主干色）与 4 撞色破阈值，
 * 故仅对 5 施加色相旋转，详见其表项注释。
 */
const GROUP_TUNE = {
  1: { dh: -3, dL: 0, kC: 1.12 }, // 专利法：玫红→绯红并加饱和，拉开 1–2 / 1–8
  2: { dh: 9, dL: -0.04, kC: 1.0 }, // 实施细则：橙褐→赭橙并压暗，主消 1–2（原最差对 0.0471）
  3: { dh: 2, dL: 0.04, kC: 0.92 }, // 审查指南：暗金提亮减饱和，消 3–10、2–3
  4: { dh: 5, dL: 0, kC: 1.15 }, // 侵权判定：绿加饱和，消 4–10
  5: { dh: 12, dL: 0, kC: 1.0 }, // 机械撰写：与 4 基线色相邻过近顺时针旋转拉开（未调时 4–5 破阈值 0.0328）
  6: { dh: 0, dL: 0, kC: 1.0 }, // 化学撰写：阶段5.2 召回为 main 组，单书直取代表色，不调
  7: { dh: 8, dL: 0.036, kC: 1.08 }, // 答复OA：紫提亮外移，消 7–9（术语靛蓝）/ 7–13
  8: { dh: -3, dL: 0, kC: 1.22 }, // 商标：品红加饱和，消 1–8 / 7–8
  9: { dh: 0, dL: 0, kC: 1.0 }, // 术语层，不动
  10: { dh: -3, dL: -0.01, kC: 1.02 }, // 专利扩展：秋香微压暗，消 3–10 / 4–10 / 10–11
  11: { dh: 3, dL: -0.045, kC: 1.0 }, // 品种布图：草绿压暗，消 4–11（微调过程中一度恶化到 0.041）
  12: { dh: 0, dL: 0, kC: 1.22 }, // 竞争法：湖青加饱和（原 C 仅 0.072，偏灰）
  13: { dh: 2, dL: 0, kC: 1.0 }, // 著作权：堇紫微移
  14: { dh: -4, dL: 0, kC: 1.0 }, // 综合程序：青莲微移，离开术语靛蓝
}

/** 新组 15（商标审查审理指南）：由同主题的**已微调**组 8（商标）派生，
 *  故必然落在该主题的商标红系族内；靠「压暗 + 加饱和 + 顺时针 12°」与 8 区分。 */
const SECTION_15_FROM_8 = { dh: 12, dL: -0.092, kC: 1.15 }

/**
 * 五部「已无组」文献的寄养表（G-1 从 SECTION_GROUPS 摘除，但内容目录仍在，
 * 页内局部图仍会渲染，故必须有颜色）。按原法域归入邻近组的色相带，
 * 并统一乘 ORPHAN_CHROMA 降饱和，以示「非重点、已移出图例」。
 *
 * 沿革（阶段5.2 批 Q-2）：原寄养于此的 5（机械撰写）、6（化学撰写）已随
 * SECTION_GROUPS 召回为独立 main 组，退出本表——恢复各自组锚点色相与正常
 * 饱和（不再乘 ORPHAN_CHROMA），本表由七部收窄为五部。
 */
const ORPHAN_HOST = {
  63: "14", // 规范性文件制定管理办法 → 综合程序色系
  79: "14", // 知识产权强国建设纲要 → 综合程序色系
  87: "14", // 国家知识产权局规章制定程序规定 → 综合程序色系
  89: "14", // 知识产权保护和运用十五五规划 → 综合程序色系
  90: "14", // GB 国家标准清单 → 综合程序色系
}
const ORPHAN_CHROMA = 0.72

/** 术语层不是书、不进书级色板；但它是**上屏的节点色**，必须作为固定障碍点
 *  参与全局最小色差核算，否则会生成与术语靛蓝撞色的书。 */
const TERM_GROUP_ID = "9"

// ---- 色阶点阵 ----
// 9 级明度 × 3 级彩度 = 27 档；奇数彩度列的明度抬升半步（stagger），点阵呈六方
// 排列而非正交网格，同等档数下最近邻距离更大。
// 档数是实测调出来的：6 级明度时全局最小色差 0.0389、9 级 0.0426、10 级反降到
// 0.0414（档间距被压得比色相带能补偿的还小）。明度上下限亦有实证约束——
// light 顶到 0.77（再高在亮底上发飘）、dark 底到 0.49（再低在暗底上发闷）。
const LADDER = {
  light: { L: [0.41, 0.455, 0.5, 0.545, 0.59, 0.635, 0.68, 0.725, 0.77], stagger: 0.0225 },
  dark: { L: [0.49, 0.53, 0.57, 0.61, 0.65, 0.69, 0.73, 0.77, 0.81], stagger: 0.02 },
}
/** 三级彩度取绝对值（不按可用上限的比例），配合下方可用性过滤 */
const C_ABS = [0.155, 0.108, 0.062]
/** 可用彩度相对 sRGB 边界的留白：贴边色在 8bit 量化后易出现色相跳动 */
const GAMUT_USE = 0.94
/** 色相微偏移（相对本书槽宽的比例，7 档）：给指派多一个自由度；|偏移| ≤ 0.42 槽，
 *  故组内书的色相顺序仍与前缀顺序单调一致，相邻两书也不会互换位置。 */
const HUE_OFFSETS = [-0.42, -0.28, -0.14, 0, 0.14, 0.28, 0.42]
/** 色相带内的采样点数：判定某档在**整条带**上都装得进 sRGB */
const BAND_SAMPLES = 9
/**
 * 软罚阶段的目标色差：低于此值的色对按 (TARGET − ΔE)² 计罚。取 0.045 略高于
 * 小圆点工作阈值 0.040。刻意不取更大值：TARGET 抬高会把罚分摊到几百对「本来就
 * 够开」的色上，反而挤占最差那几对的改进余地（实测 0.045→0.0429、
 * 0.065→0.0388、0.072→0.0296）。真正的下限由其后的 polish 阶段负责抬。
 */
const TARGET = 0.045
/** 两段优化各自的最大扫描轮数（无改善即提前收敛；实测软罚 5 轮、打磨 1 轮到底） */
const MAX_SWEEPS = 40

// ============================================================
// 三、读入组表 → 88 书归属
// ============================================================

function parseSectionGroups(tsSource) {
  const start = tsSource.indexOf("export const SECTION_GROUPS")
  if (start < 0) throw new Error("graphSections.ts 中找不到 SECTION_GROUPS")
  const body = tsSource.slice(start, tsSource.indexOf("\n]", start))
  const groups = []
  const re = /id:\s*"(\d+)"[\s\S]*?label:\s*"([^"]+)"[\s\S]*?prefixes:\s*\[([^\]]*)\]/g
  let m
  while ((m = re.exec(body)) !== null) {
    groups.push({
      id: m[1],
      label: m[2],
      prefixes: m[3]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number),
    })
  }
  if (groups.length === 0) throw new Error("SECTION_GROUPS 解析结果为空")
  return groups
}

/** 组号 → { label, books }（书 = 目录前缀；术语组剔除，寄养书并入宿主组） */
function buildFamilies(groups) {
  const families = new Map()
  for (const g of groups) {
    if (g.id === TERM_GROUP_ID) continue
    families.set(g.id, { id: g.id, label: g.label, books: [...g.prefixes] })
  }
  for (const [prefix, host] of Object.entries(ORPHAN_HOST)) {
    const fam = families.get(host)
    if (!fam) throw new Error(`寄养表指向不存在的组 ${host}`)
    fam.books.push(Number(prefix))
  }
  for (const fam of families.values()) fam.books.sort((a, b) => a - b)
  return families
}

// ============================================================
// 四、组代表色（微调后）与色相带
// ============================================================

const rotate = (h, dh) => (((h + dh) % 360) + 360) % 360

/** 某主题块内组 id 微调后的色值；id 15 由同块的组 8 派生 */
function tunedSectionHex(themeKey, id) {
  if (id === "15") {
    const base = hexToOklch(tunedSectionHex(themeKey, "8"))
    return oklchToHex({
      L: base.L + SECTION_15_FROM_8.dL,
      C: base.C * SECTION_15_FROM_8.kC,
      h: rotate(base.h, SECTION_15_FROM_8.dh),
    })
  }
  const t = GROUP_TUNE[Number(id)]
  const base = hexToOklch(baselineHex(themeKey, id))
  if (!t) return oklchToHex(base)
  return oklchToHex({ L: base.L + t.dL, C: base.C * t.kC, h: rotate(base.h, t.dh) })
}

/**
 * 色相带划分。锚点取「宣纸 light」微调后组色的 OKLCh 色相 —— 书级色板全站共用
 * 一套、不随主题变，故只能取一套锚点，宣纸是默认主题。
 * 相邻锚点之间的空档按两侧书数加权劈分，书多的组自动占更宽的带。
 */
function buildHueBands(families) {
  const anchors = [...families.values()]
    .map((f) => ({
      id: f.id,
      n: f.books.length,
      h: hexToOklch(tunedSectionHex("xuanzhi:light", f.id)).h,
    }))
    .sort((a, b) => a.h - b.h)
  const bands = new Map()
  for (let i = 0; i < anchors.length; i++) {
    const prev = anchors[(i - 1 + anchors.length) % anchors.length]
    const cur = anchors[i]
    const next = anchors[(i + 1) % anchors.length]
    const gapPrev = (cur.h - prev.h + 360) % 360
    const gapNext = (next.h - cur.h + 360) % 360
    const left = gapPrev * (cur.n / (cur.n + prev.n))
    const right = gapNext * (cur.n / (cur.n + next.n))
    bands.set(cur.id, { start: rotate(cur.h, -left), width: left + right, anchorHue: cur.h })
  }
  return bands
}

// ============================================================
// 五、色阶点阵
// ============================================================

const N_L = LADDER.light.L.length
const TIER_COUNT = N_L * C_ABS.length

/** 第 tier 档在给定色相下的 OKLCh；档号 = 彩度级 × 明度级数 + 明度级 */
function tierLch(mode, tier, hue) {
  const lad = LADDER[mode]
  const li = tier % N_L
  const ci = Math.floor(tier / N_L)
  return { L: lad.L[li] + (ci % 2 === 1 ? lad.stagger : 0), C: C_ABS[ci], h: hue }
}

/** 档位在本组色相带全程、且 light 与 dark 两套明度梯都装得进 sRGB */
function availableTiers(band) {
  const out = []
  for (let t = 0; t < TIER_COUNT; t++) {
    let ok = true
    for (const mode of ["light", "dark"]) {
      const { L, C } = tierLch(mode, t, 0)
      for (let i = 0; i < BAND_SAMPLES && ok; i++) {
        const h = rotate(band.start, (i / (BAND_SAMPLES - 1)) * band.width)
        if (C > maxChroma(L, h) * GAMUT_USE) ok = false
      }
    }
    if (ok) out.push(t)
  }
  // 极端窄色域兜底：至少放行最低彩度那一列
  if (out.length === 0) for (let li = 0; li < N_L; li++) out.push((C_ABS.length - 1) * N_L + li)
  return out
}

// ============================================================
// 六、指派：确定性贪心 + 坐标下降（light / dark 共用同一份指派）
// ============================================================

const MODES = ["light", "dark"]

function buildBooks(families, bands) {
  const books = []
  for (const fam of families.values()) {
    const band = bands.get(fam.id)
    const n = fam.books.length
    const avail = availableTiers(band)
    fam.books.forEach((prefix, k) => {
      const isOrphan = Object.prototype.hasOwnProperty.call(ORPHAN_HOST, String(prefix))
      const slot = band.width / n
      const hue0 = rotate(band.start, (k + 0.5) * slot)
      const cands = []
      if (n === 1) {
        // 单书组：书色直接沿用该组微调后的代表色（主干七书历史色不变）
        cands.push({
          hex: {
            light: tunedSectionHex("xuanzhi:light", fam.id),
            dark: tunedSectionHex("xuanzhi:dark", fam.id),
          },
        })
      } else {
        for (const t of avail) {
          for (const off of HUE_OFFSETS) {
            const hue = rotate(hue0, off * slot)
            const hex = {}
            for (const mode of MODES) {
              const lch = tierLch(mode, t, hue)
              hex[mode] = oklchToHex({
                L: lch.L,
                C: lch.C * (isOrphan ? ORPHAN_CHROMA : 1),
                h: hue,
              })
            }
            cands.push({ hex, tier: t, off })
          }
        }
      }
      for (const c of cands) {
        c.lab = {}
        for (const mode of MODES) c.lab[mode] = hexToOklab(c.hex[mode])
      }
      books.push({ prefix, groupId: fam.id, label: fam.label, isOrphan, hue0, cands, pick: 0 })
    })
  }
  return books
}

/** 一个候选相对「已定色集合」的软罚与最小色差（两套色板求和 / 取最小） */
function scoreAgainst(cand, fixedLabs) {
  let pen = 0
  let min = Infinity
  for (const mode of MODES) {
    const A = cand.lab[mode]
    for (const B of fixedLabs[mode]) {
      const d = dist(A, B)
      if (d < min) min = d
      if (d < TARGET) pen += (TARGET - d) * (TARGET - d)
    }
  }
  return { pen, min: min === Infinity ? 1 : min }
}

function assign(books, obstacles) {
  // ---- 贪心初始化：固定顺序逐本放置，取「与已放置色最小距离」最大的候选 ----
  const placed = {
    light: [...obstacles.light.map(hexToOklab)],
    dark: [...obstacles.dark.map(hexToOklab)],
  }
  for (const b of books) {
    let best = 0
    let bestMin = -1
    for (let i = 0; i < b.cands.length; i++) {
      const { min } = scoreAgainst(b.cands[i], placed)
      if (min > bestMin + 1e-12) {
        bestMin = min
        best = i
      }
    }
    b.pick = best
    for (const mode of MODES) placed[mode].push(b.cands[best].lab[mode])
  }

  // ---- 坐标下降：逐本在「其余全部书 + 术语层色」固定的前提下重挑 ----
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let changed = false
    for (const b of books) {
      const fixed = {
        light: [...obstacles.light.map(hexToOklab)],
        dark: [...obstacles.dark.map(hexToOklab)],
      }
      for (const o of books) {
        if (o === b) continue
        for (const mode of MODES) fixed[mode].push(o.cands[o.pick].lab[mode])
      }
      const cur = scoreAgainst(b.cands[b.pick], fixed)
      let best = b.pick
      let bestPen = cur.pen
      let bestMin = cur.min
      for (let i = 0; i < b.cands.length; i++) {
        if (i === b.pick) continue
        const s = scoreAgainst(b.cands[i], fixed)
        if (
          s.pen < bestPen - 1e-12 ||
          (Math.abs(s.pen - bestPen) <= 1e-12 && s.min > bestMin + 1e-12)
        ) {
          best = i
          bestPen = s.pen
          bestMin = s.min
        }
      }
      if (best !== b.pick) {
        b.pick = best
        changed = true
      }
    }
    if (!changed) return sweep + 1
  }
  return MAX_SWEEPS
}

/**
 * 收尾打磨：软罚阶段优化的是「全部近距色对之和」，抬不动被单独一对卡住的下限。
 * 本阶段直接对**报告口径的全局最小色差**做爬山 —— 逐本重挑，取
 * max( 不含本书的全局最小 , 本书与其余全部色的最小 ) 最大者，只接受严格变优。
 * 「不含本书的全局最小」是本书移动无法影响的天花板，故该目标与真正的全局最小
 * 同增同减；严格变优 ⇒ 单调不降 ⇒ 必然终止且与遍历顺序无关。
 */
function polish(books, obstacles) {
  const obsLab = { light: obstacles.light.map(hexToOklab), dark: obstacles.dark.map(hexToOklab) }
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let changed = false
    for (const b of books) {
      // ① 不含 b 的全局最小（含术语层障碍点）
      let excl = Infinity
      for (let i = 0; i < books.length; i++) {
        if (books[i] === b) continue
        for (const mode of MODES) {
          const A = books[i].cands[books[i].pick].lab[mode]
          for (let j = i + 1; j < books.length; j++) {
            if (books[j] === b) continue
            const d = dist(A, books[j].cands[books[j].pick].lab[mode])
            if (d < excl) excl = d
          }
          for (const O of obsLab[mode]) {
            const d = dist(A, O)
            if (d < excl) excl = d
          }
        }
      }
      // ② 逐候选评「本书与其余全部色的最小」
      const others = { light: [...obsLab.light], dark: [...obsLab.dark] }
      for (const o of books) {
        if (o === b) continue
        for (const mode of MODES) others[mode].push(o.cands[o.pick].lab[mode])
      }
      const minOf = (cand) => {
        let m = Infinity
        for (const mode of MODES)
          for (const B of others[mode]) {
            const d = dist(cand.lab[mode], B)
            if (d < m) m = d
          }
        return m
      }
      const score = (cand) => Math.min(excl, minOf(cand))
      let best = b.pick
      let bestScore = score(b.cands[b.pick])
      for (let i = 0; i < b.cands.length; i++) {
        const s = score(b.cands[i])
        if (s > bestScore + 1e-12) {
          best = i
          bestScore = s
        }
      }
      if (best !== b.pick) {
        b.pick = best
        changed = true
      }
    }
    if (!changed) return sweep + 1
  }
  return MAX_SWEEPS
}

// ============================================================
// 七、代码块生成
// ============================================================

function scssBookBlock(books, mode) {
  return [...books]
    .sort((a, b) => a.prefix - b.prefix)
    .map(
      (b) =>
        `  --graph-book-${b.prefix}: ${b.cands[b.pick].hex[mode]}; // ${b.label}${b.isOrphan ? "·寄养" : ""}`,
    )
    .join("\n")
}

function tsBookColors(books) {
  const rows = [...books]
    .sort((a, b) => a.prefix - b.prefix)
    .map(
      (b) =>
        `  "${b.prefix}": { light: "${b.cands[b.pick].hex.light}", dark: "${b.cands[b.pick].hex.dark}" },`,
    )
    .join("\n")
  return `export const BOOK_COLORS: Record<string, { light: string; dark: string }> = {\n${rows}\n}`
}

// ============================================================
// 八、回写
// ============================================================

function spliceSentinel(text, tag, body) {
  const open = `// >>> gen-book-colors:${tag}`
  const close = `// <<< gen-book-colors:${tag}`
  const i = text.indexOf(open)
  const j = text.indexOf(close)
  if (i < 0 || j < 0) throw new Error(`找不到哨兵 ${tag}`)
  return (
    text.slice(0, text.indexOf("\n", i) + 1) +
    body +
    "\n" +
    text.slice(text.lastIndexOf("\n", j) + 1)
  )
}

/**
 * 六主题 × light/dark 共 12 块内的 --graph-section-1..15 重写（首跑顺带补出 15）。
 * 幂等要点有二：① 色值一律由 BASELINE_SECTION_COLORS 基线 + 增量算出，不读文件里
 * 的现值，故不会二次叠加；② 补 15 之前先看下一行是不是已有的 15 声明，已有则只
 * 改值不插行 —— 缺了这一步，每跑一次就多插一行 15（首版即栽在这里）。
 */
function patchSectionVars(scss) {
  const lines = scss.split("\n")
  const out = []
  let themeKey = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const head = line.match(/^:root\[data-style="(\w+)"\](\[saved-theme="dark"\])?\s*\{/)
    if (head) themeKey = `${head[1]}:${head[2] ? "dark" : "light"}`
    else if (/^\}/.test(line)) themeKey = null
    const decl = themeKey && line.match(/^(\s*)--graph-section-(\d+):\s*#[0-9a-f]{6};(.*)$/)
    if (!decl) {
      out.push(line)
      continue
    }
    const [, indent, id, tail] = decl
    out.push(`${indent}--graph-section-${id}: ${tunedSectionHex(themeKey, id)};${tail}`)
    const has15 = /^\s*--graph-section-15:/.test(lines[i + 1] ?? "")
    if (id === "14" && !has15) {
      out.push(
        `${indent}--graph-section-15: ${tunedSectionHex(themeKey, "15")}; // 15 绛红：商标审查指南`,
      )
    }
  }
  return out.join("\n")
}

// ============================================================
// 九、报告
// ============================================================

function printReport(books, families, bands, obstacles, sweeps, polishSweeps) {
  console.log(
    `软罚坐标下降 ${sweeps} 轮 + 最小色差打磨 ${polishSweeps} 轮（各自上限 ${MAX_SWEEPS}）`,
  )
  for (const mode of MODES) {
    const pairs = []
    for (let i = 0; i < books.length; i++) {
      for (let j = i + 1; j < books.length; j++) {
        pairs.push({
          a: books[i],
          b: books[j],
          d: dist(books[i].cands[books[i].pick].lab[mode], books[j].cands[books[j].pick].lab[mode]),
          same: books[i].groupId === books[j].groupId,
        })
      }
    }
    pairs.sort((x, y) => x.d - y.d)
    const hexOf = (b) => b.cands[b.pick].hex[mode]

    console.log(`\n=== ${mode} 色板可辨性（ΔEok = OKLab 欧氏距离，按量化后 hex 计）`)
    console.log(`    88 书；工作阈值 0.040（大色块 JND≈0.020，小圆点从严取 2 倍）`)
    console.log("--- 各组组内最小成对色差 ---")
    for (const fam of families.values()) {
      const band = bands.get(fam.id)
      const inGroup = pairs.filter((p) => p.same && p.a.groupId === fam.id)
      const tag = inGroup.length ? `组内 min ΔEok = ${inGroup[0].d.toFixed(4)}` : "单书组，无组内对"
      console.log(
        `  组 ${fam.id.padStart(2)} ${fam.label.padEnd(6)} n=${String(fam.books.length).padStart(2)}` +
          `  色相带 ${band.start.toFixed(1)}° 起 宽 ${band.width.toFixed(1)}°  ${tag}`,
      )
    }
    const intra = pairs.filter((p) => p.same)
    const inter = pairs.filter((p) => !p.same)
    console.log("--- 汇总 ---")
    console.log(
      `  组内最小色差（全体组取最小）  ΔEok = ${intra[0].d.toFixed(4)}   前缀 ${intra[0].a.prefix}-${intra[0].b.prefix}`,
    )
    console.log(
      `  跨组最小色差                  ΔEok = ${inter[0].d.toFixed(4)}   前缀 ${inter[0].a.prefix}-${inter[0].b.prefix}`,
    )
    console.log(`  全局最小色差（88 书两两）     ΔEok = ${pairs[0].d.toFixed(4)}`)
    console.log(
      `  低于工作阈值 0.040 的色对数   ${pairs.filter((p) => p.d < 0.04).length} / ${pairs.length}`,
    )
    console.log("  最差三对：")
    for (const p of pairs.slice(0, 3)) {
      console.log(
        `    ${p.a.prefix}(${hexOf(p.a)}) ${p.a.label} – ${p.b.prefix}(${hexOf(p.b)}) ${p.b.label}` +
          `  ΔEok=${p.d.toFixed(4)}  ${p.same ? "同组" : "跨组"}`,
      )
    }
    let om = { d: Infinity }
    for (const b of books)
      for (const o of obstacles[mode]) {
        const d = deltaE(hexOf(b), o)
        if (d < om.d) om = { d, b, o }
      }
    console.log(
      `  与术语层色 ${obstacles[mode].join(",")} 最近的书：${om.b.prefix} ΔEok=${om.d.toFixed(4)}`,
    )
  }

  console.log("\n=== 组代表色微调（宣纸 light 口径；14 块施加同一增量）")
  for (const id of ["1", "2", "3", "4", "5", "6", "7", "8", "10", "11", "12", "13", "14", "15"]) {
    const before = id === "15" ? "（新增）" : baselineHex("xuanzhi:light", id)
    console.log(`  组 ${id.padStart(2)}  ${before} → ${tunedSectionHex("xuanzhi:light", id)}`)
  }
  const legend = ["1", "2", "3", "4", "5", "6", "7", "8", "10", "11", "12", "13", "14", "15", "9"]
  for (const [tag, key] of [
    ["light", "xuanzhi:light"],
    ["dark", "xuanzhi:dark"],
  ]) {
    const before = []
    const after = []
    for (let i = 0; i < legend.length; i++)
      for (let j = i + 1; j < legend.length; j++) {
        if (legend[i] !== "15" && legend[j] !== "15")
          before.push([
            deltaE(baselineHex(key, legend[i]), baselineHex(key, legend[j])),
            legend[i],
            legend[j],
          ])
        after.push([
          deltaE(tunedSectionHex(key, legend[i]), tunedSectionHex(key, legend[j])),
          legend[i],
          legend[j],
        ])
      }
    before.sort((a, b) => a[0] - b[0])
    after.sort((a, b) => a[0] - b[0])
    console.log(
      `  ${tag} 组代表色最小对：微调前 ${before[0][0].toFixed(4)} [${before[0][1]}–${before[0][2]}]` +
        ` → 微调后 ${after[0][0].toFixed(4)} [${after[0][1]}–${after[0][2]}]`,
    )
  }
}

// ============================================================
// 十、入口
// ============================================================

const argv = process.argv.slice(2)
const tsSource = readFileSync(TS_PATH, "utf8")
const families = buildFamilies(parseSectionGroups(tsSource))
const bands = buildHueBands(families)
const obstacles = {
  light: [tunedSectionHex("xuanzhi:light", TERM_GROUP_ID)],
  dark: [tunedSectionHex("xuanzhi:dark", TERM_GROUP_ID)],
}
const books = buildBooks(families, bands)
if (books.length !== 88) throw new Error(`书数应为 88，实得 ${books.length}`)
const sweeps = assign(books, obstacles)
const polishSweeps = polish(books, obstacles)

printReport(books, families, bands, obstacles, sweeps, polishSweeps)

const scssLight = scssBookBlock(books, "light")
const scssDark = scssBookBlock(books, "dark")
const tsBlock = tsBookColors(books)

if (argv.includes("--emit")) {
  console.log("\n----- SCSS light -----\n" + scssLight)
  console.log("\n----- SCSS dark -----\n" + scssDark)
  console.log("\n----- TS -----\n" + tsBlock)
}

if (argv.includes("--write")) {
  let scss = readFileSync(SCSS_PATH, "utf8")
  scss = spliceSentinel(scss, "light", scssLight)
  scss = spliceSentinel(scss, "dark", scssDark)
  scss = patchSectionVars(scss)
  writeFileSync(SCSS_PATH, scss)
  writeFileSync(TS_PATH, spliceSentinel(tsSource, "ts", tsBlock))
  console.log(`\n已回写 ${SCSS_PATH}`)
  console.log(`已回写 ${TS_PATH}`)
  console.log(
    "接着执行：npx prettier --write quartz/styles/custom.scss quartz/util/graphSections.ts",
  )
}
