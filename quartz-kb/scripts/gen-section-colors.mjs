// gen-section-colors.mjs —— 域组色板中「波L 新增组号 16–30」的生成器（阶段5.11 波L）
//
// 分工（与既有 gen-book-colors.mjs 互补，两者互不覆盖）：
//   gen-book-colors.mjs  生成**书级**色 --graph-book-<前缀> 与 BOOK_COLORS，
//                        并生成组级色 --graph-section-1..15 的基线；
//   本脚本               只生成组级色 --graph-section-16..30。这 15 个组号是波L 把
//                        6 个跨文种扩展组按 (法域, 文种) 拆开后新增的，其色值一律
//                        **由母组色派生**，故本脚本以「既有 1–15 不动」为前提，
//                        每块只往后追加 15 个变量。
//
// 为什么不并入 gen-book-colors.mjs：那个脚本按「组内第 k 本书落在 (k+0.5)/n 色相处」
// 分配书色，组一拆 n 就变、全库书色重排（波O 已为此破例手工摘键）。本脚本刻意只碰
// 组级色的 16–30，对书级色与 1–15 零影响，可以随时重跑而不动既有配色。
//
// 算法：母色邻域内的 max-min 避让搜索（确定性，无随机数）。
//   对每个新组，按组号升序，在其母组色的 HSL 邻域里取一点：
//     邻域   ΔH ∈ [-24°, +24°] 步长 3°；ΔL ∈ [-18%, +18%] 步长 2%（L 钳制 [22%, 80%]）；
//            S × [0.55 … 1.15] 步长 0.1（钳制 [8%, 100%]）；且与母色的 RGB 距离 ≤ 110
//            （越界即判为脱离母色系，不再是「同法域同色系」）。
//     取法   最大化 score = min(到本块已确定的全部色的 RGB 距离) − 0.05 × 到母色的距离。
//            前项保证可辨，后项在可辨度相同的候选里优先靠近母色（同色系观感）。
//     顺序   组号升序（16 → 30），先定的色成为后定者的避让对象，故结果与顺序绑定、
//            但完全确定；重跑得同一结果。
//   基线门槛：原 15 色在 12 个主题块内的两两最小 RGB 距离为 24–37。本算法产出的
//   30 色最小距离同为 24–37（逐块实测），即**扩到 30 色后可辨度与原 15 色持平**。
//
// 母组对应（被拆前的原组 → 新组号）：
//   10 专利·规章 → 16/17/18　8 商标·规章 → 19/20/21　13 著权·法规 → 22/23/24
//   12 竞争·司解 → 25/26　　11 品图·司解 → 27/28　　14 综合·司解 → 29/30
//
// 用法：
//   node scripts/gen-section-colors.mjs            # 只打印，不落盘
//   node scripts/gen-section-colors.mjs --check    # 比对两处产物是否与计算一致（CI 用，不一致 exit 1）
//   node scripts/gen-section-colors.mjs --write    # 回写 custom.scss 与 graph.inline.ts
//   写盘后执行：npx prettier --write quartz/styles/custom.scss quartz/components/scripts/graph.inline.ts
//
// 产物两处：
//   ① quartz/styles/custom.scss —— 六主题 × 明暗 12 块，各块的 --graph-section-16..30
//      （紧跟该块的 --graph-section-15 之后）；
//   ② quartz/components/scripts/graph.inline.ts —— SECTION_COLORS_FALLBACK 的 16–30 键，
//      哨兵 `// >>> gen-section-colors:fallback` 与 `// <<< gen-section-colors:fallback` 之间。
//      该表是 CSS 变量读不到时的兜底，基色是它自己的中性基线 1–15（与主题块不同），
//      故两处色值不相等，各自独立跑同一套算法。
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCSS_PATH = resolve(HERE, "../quartz/styles/custom.scss")
const TS_PATH = resolve(HERE, "../quartz/components/scripts/graph.inline.ts")

/** 母组 → 其派生出的新组号（顺序即贪心顺序内的相对次序，实际按组号升序统一排） */
const DERIVE = {
  10: ["16", "17", "18"],
  8: ["19", "20", "21"],
  13: ["22", "23", "24"],
  12: ["25", "26"],
  11: ["27", "28"],
  14: ["29", "30"],
}
/** 新组号 → 母组号 */
const MOM_OF = Object.fromEntries(
  Object.entries(DERIVE).flatMap(([mom, kids]) => kids.map((k) => [k, mom])),
)
/** 新组号 → 注释里的中文标注 */
const LABELS = {
  16: "专利·法规",
  17: "专利·司解",
  18: "专利·指引",
  19: "商标·法律",
  20: "商标·法规",
  21: "商标·司解",
  22: "著权·法律",
  23: "著权·规章",
  24: "著权·司解",
  25: "竞争·法律",
  26: "竞争·规章",
  27: "品图·法规",
  28: "品图·规章",
  29: "综合·法规",
  30: "综合·规章",
}
const NEW_IDS = Object.keys(MOM_OF).sort((a, b) => Number(a) - Number(b))

// ---------- 色彩工具（与 gen-book-colors.mjs 各自独立，本脚本只用 HSL/RGB） ----------
const hexToRgb = (h) => {
  const m = h.trim().replace("#", "")
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]
}
const rgbToHex = ([r, g, b]) => {
  const c = (v) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0")
  return `#${c(r)}${c(g)}${c(b)}`
}
function rgbToHsl([r, g, b]) {
  ;((r /= 255), (g /= 255), (b /= 255))
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  const d = max - min
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      default:
        h = ((r - g) / d + 4) / 6
    }
  }
  return [h * 360, s, l]
}
function hslToRgb([h, s, l]) {
  h = (((h % 360) + 360) % 360) / 360
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}
const rgbDist = (a, b) => {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

// ---------- 搜索参数（改这里即改配色，改后须重跑并复核门槛） ----------
const DH_STEPS = (() => {
  const out = []
  for (let d = -24; d <= 24; d += 3) out.push(d)
  return out
})()
const DL_STEPS = (() => {
  const out = []
  for (let d = -18; d <= 18; d += 2) out.push(d / 100)
  return out
})()
const KS_STEPS = [0.55, 0.65, 0.75, 0.85, 0.95, 1.05, 1.15]
const L_MIN = 0.22
const L_MAX = 0.8
const MAX_MOM_DIST = 110
const MOM_PULL = 0.05
const clampL = (l) => Math.max(L_MIN, Math.min(L_MAX, l))

/**
 * 给定一块里已有的 1–15，算出该块的 16–30。
 * @param {Record<string,string>} base 组号 → 十六进制色值（至少含 1–15）
 * @returns {Record<string,string>} 新组号 → 十六进制色值
 */
function deriveBlock(base) {
  const placed = { ...base }
  const added = {}
  for (const id of NEW_IDS) {
    const momHex = base[MOM_OF[id]]
    if (!momHex) throw new Error(`缺母组 ${MOM_OF[id]} 的色值，无法派生组 ${id}`)
    const [h, s, l] = rgbToHsl(hexToRgb(momHex))
    let best = null
    for (const dh of DH_STEPS) {
      for (const dl of DL_STEPS) {
        for (const ks of KS_STEPS) {
          const cand = rgbToHex(
            hslToRgb([h + dh, Math.max(0.08, Math.min(1, s * ks)), clampL(l + dl)]),
          )
          const dmom = rgbDist(cand, momHex)
          if (dmom > MAX_MOM_DIST) continue
          let nearest = Infinity
          for (const v of Object.values(placed)) {
            const d = rgbDist(cand, v)
            if (d < nearest) nearest = d
          }
          const score = nearest - dmom * MOM_PULL
          if (best === null || score > best.score) best = { cand, score }
        }
      }
    }
    if (best === null) throw new Error(`组 ${id} 在母色邻域内找不到候选，请放宽 MAX_MOM_DIST`)
    placed[id] = best.cand
    added[id] = best.cand
  }
  return added
}

/** 一块内全部色值的两两最小距离（可辨度指标） */
function minPairDist(vals) {
  const ids = Object.keys(vals)
  let m = Infinity
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = rgbDist(vals[ids[i]], vals[ids[j]])
      if (d < m) m = d
    }
  }
  return m
}

// ---------- 产物 ①：custom.scss 的 12 块 ----------
/** 定位 12 个主题块：以 `--graph-section-15:` 行为锚，向上收集该块的 1–15 */
function readScssBlocks(lines) {
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const anchor = lines[i].match(/^(\s*)--graph-section-15:\s*(#[0-9a-f]{6});/)
    if (!anchor) continue
    const vals = {}
    for (let j = i; j >= 0 && j > i - 40; j--) {
      const mm = lines[j].match(/^\s*--graph-section-(\d+):\s*(#[0-9a-f]{6});/)
      if (mm && Number(mm[1]) <= 15) vals[mm[1]] = mm[2]
    }
    for (let n = 1; n <= 15; n++) {
      if (!vals[String(n)]) throw new Error(`第 ${i + 1} 行所在主题块缺 --graph-section-${n}`)
    }
    // 锚点行之后已存在的 16–30（重跑时要整体替换掉）
    let tailEnd = i
    while (tailEnd + 1 < lines.length) {
      const mm = lines[tailEnd + 1].match(/^\s*--graph-section-(\d+):\s*(#[0-9a-f]{6});/)
      if (!mm || Number(mm[1]) < 16) break
      tailEnd += 1
    }
    blocks.push({ anchorLine: i, tailEnd, indent: anchor[1], vals })
  }
  if (blocks.length !== 12) throw new Error(`期望 12 个主题块，实得 ${blocks.length}`)
  return blocks
}

const scssLines = readFileSync(SCSS_PATH, "utf8").split("\n")
const scssBlocks = readScssBlocks(scssLines)
const scssReport = []
for (const b of scssBlocks) {
  b.added = deriveBlock(b.vals)
  scssReport.push(Math.round(minPairDist({ ...b.vals, ...b.added })))
}
const baselineReport = scssBlocks.map((b) => Math.round(minPairDist(b.vals)))

// ---------- 产物 ②：graph.inline.ts 的兜底表 ----------
const TS_BEGIN = "// >>> gen-section-colors:fallback"
const TS_END = "// <<< gen-section-colors:fallback"
const tsSource = readFileSync(TS_PATH, "utf8")
function readTsBaseline() {
  const start = tsSource.indexOf("const SECTION_COLORS_FALLBACK")
  if (start < 0) throw new Error("graph.inline.ts 中找不到 SECTION_COLORS_FALLBACK")
  const vals = {}
  for (const m of tsSource.slice(start, start + 4000).matchAll(/"(\d+)":\s*"(#[0-9a-f]{6})"/g)) {
    if (Number(m[1]) <= 15) vals[m[1]] = m[2]
  }
  for (let n = 1; n <= 15; n++) {
    if (!vals[String(n)]) throw new Error(`SECTION_COLORS_FALLBACK 缺键 ${n}`)
  }
  return vals
}
const tsBase = readTsBaseline()
const tsAdded = deriveBlock(tsBase)

// ---------- 输出 ----------
const mode = process.argv.includes("--write")
  ? "write"
  : process.argv.includes("--check")
    ? "check"
    : "print"

const scssTextOf = (b) =>
  NEW_IDS.map(
    (id) =>
      `${b.indent}--graph-section-${id}: ${b.added[id]}; // ${id} ${LABELS[id]}（母 ${MOM_OF[id]}）`,
  )
const tsText = NEW_IDS.map(
  (id) => `  "${id}": "${tsAdded[id]}", // ${LABELS[id]}（母 ${MOM_OF[id]}）`,
).join("\n")

console.log("原 15 色各块最小色差：", baselineReport.join(", "))
console.log("新 30 色各块最小色差：", scssReport.join(", "))
console.log(
  scssReport.every((v, i) => v >= Math.min(24, baselineReport[i]))
    ? "✓ 扩到 30 色后可辨度不低于基线门槛（24）"
    : "✗ 有主题块的可辨度跌破基线门槛，请调搜索参数后重跑",
)

if (mode === "print") {
  console.log("\n—— custom.scss 首块示例 ——")
  console.log(scssTextOf(scssBlocks[0]).join("\n"))
  console.log("\n—— graph.inline.ts 兜底表 ——")
  console.log(tsText)
  console.log("\n（未落盘。加 --write 回写，加 --check 只校验。）")
  process.exit(0)
}

// 回写 / 校验：scss 从后往前，行号不失效
let out = [...scssLines]
let scssDirty = false
for (const b of [...scssBlocks].sort((x, y) => y.anchorLine - x.anchorLine)) {
  const want = scssTextOf(b)
  const got = out.slice(b.anchorLine + 1, b.tailEnd + 1)
  if (got.join("\n") !== want.join("\n")) scssDirty = true
  out.splice(b.anchorLine + 1, b.tailEnd - b.anchorLine, ...want)
}
const tsBeginIdx = tsSource.indexOf(TS_BEGIN)
const tsEndIdx = tsSource.indexOf(TS_END)
if (tsBeginIdx < 0 || tsEndIdx < 0) {
  throw new Error(`graph.inline.ts 中找不到哨兵 ${TS_BEGIN} / ${TS_END}`)
}
const tsHead = tsSource.slice(0, tsBeginIdx + TS_BEGIN.length)
const tsTail = tsSource.slice(tsEndIdx)
const tsNext = `${tsHead}\n${tsText}\n  ${tsTail}`
const tsDirty = tsNext !== tsSource

if (mode === "check") {
  if (!scssDirty && !tsDirty) {
    console.log("✓ --check 通过：两处产物与计算结果逐字一致")
    process.exit(0)
  }
  console.error(
    `✗ --check 失败：${scssDirty ? "custom.scss " : ""}${tsDirty ? "graph.inline.ts " : ""}与计算结果不一致，请重跑 --write`,
  )
  process.exit(1)
}

writeFileSync(SCSS_PATH, out.join("\n"))
writeFileSync(TS_PATH, tsNext)
console.log(`已回写：custom.scss（12 块 × 15 变量）、graph.inline.ts（兜底表 15 键）`)
console.log(
  "接着执行：npx prettier --write quartz/styles/custom.scss quartz/components/scripts/graph.inline.ts",
)
