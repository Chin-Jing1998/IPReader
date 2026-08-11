// 标注存储（v7 需求7）：localStorage 读写与导入导出，纯数据层、不碰 DOM。
//
// 键设计沿用 explorer 的 fileTree 单键 JSON 先例，但按页分桶——读一页只解析
// 一桶，且天然支持整体导出。桶键含 slug（中文），localStorage 对键名无限制。
//
// 重要前提：localStorage 按 origin 隔离。桌面端因此把本地服务钉在固定端口
// 47821（desktop/server.cjs），端口一变这里的数据就整体访问不到。

import type { TextSelector } from "./annotate-anchor"

export type AnnotationKind = "highlight" | "underline" | "note"
export type ColorKey = "yellow" | "green" | "blue" | "pink"

export type Annotation = {
  id: string
  slug: string
  kind: AnnotationKind
  color: ColorKey
  note: string
  selector: TextSelector
  createdAt: string
  updatedAt: string
}

const KEY_PREFIX = "kb-anno:v1:page:"
const EXPORT_FORMAT = "patent-kb-annotations"
const EXPORT_VERSION = 1

function keyOf(slug: string): string {
  return KEY_PREFIX + slug
}

/** 生成本地唯一 id（不依赖 crypto，Electron 43（Chromium 13x）下亦可用） */
export function newId(): string {
  return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 读某页标注；解析失败一律当空，绝不让坏数据阻断页面 */
export function load(slug: string): Annotation[] {
  try {
    const raw = localStorage.getItem(keyOf(slug))
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Annotation[]) : []
  } catch {
    return []
  }
}

/**
 * 写某页标注。
 * @returns 是否写入成功——配额写满时返回 false，调用方须提示用户导出备份，
 *   且不可丢弃内存中的数据。
 */
export function save(slug: string, list: Annotation[]): boolean {
  try {
    if (list.length === 0) {
      localStorage.removeItem(keyOf(slug))
    } else {
      localStorage.setItem(keyOf(slug), JSON.stringify(list))
    }
    return true
  } catch {
    return false
  }
}

/** 全部标注（导出与跨页统计用） */
export function loadAll(): Annotation[] {
  const out: Annotation[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k === null || !k.startsWith(KEY_PREFIX)) {
      continue
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(k) ?? "[]")
      if (Array.isArray(parsed)) {
        out.push(...(parsed as Annotation[]))
      }
    } catch {
      // 单页坏数据跳过，不影响其余页
    }
  }
  return out
}

export type ExportFile = {
  format: string
  version: number
  exportedAt: string
  annotations: Annotation[]
}

export function buildExport(list: Annotation[]): ExportFile {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    annotations: list,
  }
}

// 导入是本模块唯一的外部数据入口（用户手选的 JSON 文件）。逐字段验型不是形式主义：
//   · 未验的 id 会被插进 annotate.inline.ts 的 CSS 选择器字符串，含双引号即让
//     querySelector 抛 DOMException，抽屉的点击与定位就此中断；
//   · exact 为空串会让 annotate-anchor 的 bestIn 对每个块跑 text.length+1 次循环，
//     配合大量条目足以让页面卡死；
//   · 无条数上限则可批量写入任意 slug 的桶，把 origin 的 localStorage 配额撑爆。
const KINDS: ReadonlySet<string> = new Set(["highlight", "underline", "note"])
const COLORS: ReadonlySet<string> = new Set(["yellow", "green", "blue", "pink"])
// id 由 newId() 生成，形如 a<base36>；限定字符集即可挡住选择器注入
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
// 单次导入条数上限。全站 2217 页、每页数十条已属极重度使用，超出即视为异常文件
const MAX_IMPORT = 5000

function isValidSelector(s: unknown): s is TextSelector {
  if (!s || typeof s !== "object") return false
  const v = s as Record<string, unknown>
  const start = v.start
  const end = v.end
  return (
    Number.isInteger(v.blockIndex) &&
    (v.blockIndex as number) >= 0 &&
    typeof v.blockTag === "string" &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 0 &&
    (end as number) > (start as number) &&
    typeof v.exact === "string" &&
    (v.exact as string).length > 0 &&
    typeof v.prefix === "string" &&
    typeof v.suffix === "string"
  )
}

function isValidAnnotation(a: unknown): a is Annotation {
  if (!a || typeof a !== "object") return false
  const v = a as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    ID_PATTERN.test(v.id) &&
    typeof v.slug === "string" &&
    (v.slug as string).length > 0 &&
    typeof v.kind === "string" &&
    KINDS.has(v.kind as string) &&
    typeof v.color === "string" &&
    COLORS.has(v.color as string) &&
    typeof v.note === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string" &&
    isValidSelector(v.selector)
  )
}

/**
 * 导入并按 id 归并：同 id 取 updatedAt 较新者，异 id 追加。
 * 版本不符一律拒绝——宁可报错也不猜测性解析。
 * 单条不合规则跳过并计入 skipped，不因一条坏数据丢掉整份文件。
 */
export function applyImport(raw: unknown): { added: number; updated: number; skipped: number } {
  const file = raw as ExportFile
  if (!file || file.format !== EXPORT_FORMAT || file.version !== EXPORT_VERSION) {
    throw new Error("文件格式不符，需为本站导出的批注 JSON")
  }
  if (!Array.isArray(file.annotations)) {
    throw new Error("文件内容损坏：缺少 annotations 列表")
  }
  if (file.annotations.length > MAX_IMPORT) {
    throw new Error(`条目过多：${file.annotations.length} 条，单次上限 ${MAX_IMPORT} 条`)
  }

  let skipped = 0
  const bySlug = new Map<string, Annotation[]>()
  for (const a of file.annotations) {
    if (!isValidAnnotation(a)) {
      skipped++
      continue
    }
    const list = bySlug.get(a.slug) ?? []
    list.push(a)
    bySlug.set(a.slug, list)
  }

  let added = 0
  let updated = 0
  for (const [slug, incoming] of bySlug) {
    const existing = load(slug)
    const index = new Map(existing.map((a) => [a.id, a]))
    for (const a of incoming) {
      const prev = index.get(a.id)
      if (!prev) {
        index.set(a.id, a)
        added++
      } else if (a.updatedAt > prev.updatedAt) {
        index.set(a.id, a)
        updated++
      }
    }
    save(slug, Array.from(index.values()))
  }
  return { added, updated, skipped }
}
