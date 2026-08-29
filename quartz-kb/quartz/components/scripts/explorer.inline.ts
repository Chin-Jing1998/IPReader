// 本文件是**全站共享**的侧栏目录树脚本：每一页都会加载并执行。
// 阶段5.4 反转（批 D1）：图谱总览页目录点击恢复 SPA 直达文档（与文档站一致），
// 阶段5.3 批 B4 的「点条目→图内定位」联动随之撤销；法域过滤联动（kb:graphfield）
// 保留，仍以 `getFullSlug(window) === GRAPH_SLUG` 门控（见文末 patent-kb 联动区块），
// 非图谱页既不绑定监听器、也不写任何属性，目录树行为与 DOM 与 B4 之前逐字一致。
// 图谱页另启用独立折叠态存储键与「书下 3 层默认展开」规则（见 FOLDER_STATE_STORAGE_KEY
// 一带注释），文档站 fileTree-v2 零读零写、零污染。过滤事件契约登记在 util/graphInteraction.ts。
import { FileTrieNode } from "../../util/fileTrie"
import {
  FullSlug,
  getFullSlug,
  joinSegments,
  pathToRoot,
  resolveRelative,
  simplifySlug,
} from "../../util/path"
import { ContentDetails } from "../../plugins/emitters/contentIndex"
import { computeThumbGeometry, hasScrollableContent } from "../../util/scrollInteraction"
import { GRAPH_SLUG } from "../../util/appPages"
import { FIELD_ALL } from "../../util/graphSections"
import { GRAPH_FIELD_EVENT, type GraphFieldDetail } from "../../util/graphInteraction"
import {
  EXPLORER_ORDER_STORAGE_KEY,
  EXPLORER_SYNTHETIC_PREFIX,
  applyOrderToItems,
  hasCustomOrder,
  isOrderableParentKey,
  parseOrderTable,
  serializeOrderTable,
  withParentOrder,
  type ExplorerOrderTable,
} from "../../util/explorerOrder"

type MaybeHTMLElement = HTMLElement | undefined

interface ParsedOptions {
  folderClickBehavior: "collapse" | "link"
  folderDefaultState: "collapsed" | "open"
  useSavedState: boolean
  /** 默认展开的目录层级数（F5）：深度 ≤ openLevels 的文件夹无保存态时初始展开；0 = 全折叠旧行为 */
  openLevels: number
  /**
   * 运行期字段（不入 data-* 属性，由 setupExplorer 按当前页写入；阶段5.4 批 D1）：
   * 图谱页的默认展开深度上限。深度口径为渲染树深度（根直接子 = 1）：
   * 1=图谱总览/中国/关键词索引、2=field、3=docType、4=书、5=编部/章、6=章(编部下)/文件——
   * 上限取 6 即「书下 3 层可见」（书本身、其子、其孙全展开），depth>6 的条文层折叠。
   * 非图谱页为 undefined，defaultCollapsed 回落 openLevels 原逻辑。
   * 保存态优先级不变：currentExplorerState 有该节点记录时 defaultCollapsed 根本不会被调用。
   */
  graphExpandToDepth?: number
  sortFn: (a: FileTrieNode, b: FileTrieNode) => number
  filterFn: (node: FileTrieNode) => boolean
  mapFn: (node: FileTrieNode) => void
  order: "sort" | "filter" | "map"[]
}

type FolderState = {
  path: string
  collapsed: boolean
}

/**
 * 无 localStorage 保存态时的初始折叠判定（F5）：
 * folderDefaultState 为 "collapsed" 且深度超出 openLevels 才折叠——
 * openLevels: 1 时顶层目录默认展开、二级及更深仍折叠；openLevels: 0 保持旧全折叠行为。
 *
 * 深度口径为**渲染树深度**（根的直接子节点为 1），不再由 slug 段数反推（C-3）：
 * 合成分组层（中国 / 权利类型 / 文件归类）没有对应 slug，而其下的书目录 slug 仍只有
 * 一段——若沿用 slug 段数，88 部书会全部落在 openLevels: 1 的展开档内，一旦展开某个
 * 归类节点就会把整本书的章节铺开。未启用分组时渲染树与 slug 层级逐层一致，判定结果
 * 与旧实现完全相同。
 */
// ==== patent-kb: 消除 new Function ====
// 上游把 Explorer.tsx 的三个函数 toString() 塞进 data 属性，再在浏览器侧 eval 回来，
// 这使产物必须放行 CSP 的 'unsafe-eval'。它们本就是编译期固定的三段逻辑，
// 绕这一趟字符串没有换来任何灵活性，故直接内联。
// 顺带解掉了 quartz.layout.ts 上那两条脆弱约束：函数必须是纯函数、且体内不得定义
// 具名内部函数（否则 esbuild 的 keep-names 会注入运行期未定义的 __name 包装）。

/**
 * 目录树排序：文件夹在前；同类先比 slug 段的数字前缀，再按 zh-CN 语序比整段。
 *
 * 比较键与 `quartz/util/docOrder.ts` 的 `compareDocOrderSegment` 同源
 *（同 collator 参数 "zh-CN" + numeric + sensitivity:"base"），保证目录树顺序与
 * PageNav「上一节/下一节」翻页链一致。此前兜底键取 displayName（frontmatter 标题）
 * 而翻页链取 slug 段，本库文件名多为书代号前缀（law-/term-/chem- 等，不以数字开头）
 * 使兜底分支必然触发，实测 106 个目录中 16 个两侧顺序不一致（需求⑪）。
 *
 * displayName 仅在 slugSegment 缺失时回退——trie 根以下节点的 slugSegment 恒存在，
 * 该回退只是防御性写法，不构成第二套语序。
 * 「文件夹优先」规则保留：实测本库无「同级既有子目录又有非 index 文档」的混排目录，
 * 该分支不会与 docOrder 的逐段比较产生分歧。
 *
 * 阶段5.8 补记——本函数给出的是**默认显示序**，不是最终显示序：
 * 合成分组层的三层子项（法域行 / docType 行 / 书目行）可被用户拖拽重排，
 * 结果存在 kb-explorer-order:v1（util/explorerOrder.ts），由 applyCustomOrder 在
 * 再父化之后叠加到渲染树上。**PageNav 的「上一节/下一节」翻页链不读该表**
 *（util/docOrder.ts 的 byDocumentOrder 恒按文档逻辑序），即拖拽只改「找书的顺序」，
 * 不改「读文的顺序」。本函数与 docOrder 的比较键同源这一条因此仍然成立：
 * 两者仍是同一套默认序，自定义序是叠加在目录树一侧的呈现层覆盖。
 */
const explorerCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" })

function sortNodes(a: FileTrieNode, b: FileTrieNode): number {
  if (a.isFolder !== b.isFolder) {
    return a.isFolder ? -1 : 1
  }
  // 内容目录形如「1-专利法/…」、文件形如「3-2-xxx.md」，数字前缀即文档序
  const aKey = a.slugSegment || a.displayName || ""
  const bKey = b.slugSegment || b.displayName || ""
  const aMatch = aKey.match(/^(\d+)/)
  const bMatch = bKey.match(/^(\d+)/)
  const na = aMatch ? parseInt(aMatch[1], 10) : Number.MAX_SAFE_INTEGER
  const nb = bMatch ? parseInt(bMatch[1], 10) : Number.MAX_SAFE_INTEGER
  if (na !== nb) {
    return na - nb
  }
  // numeric 使「1-2」<「1-10」按数值序；zh-CN 使无前缀项按中文语序
  return explorerCollator.compare(aKey, bKey)
}

/**
 * 不进侧栏目录树的节点：
 * - tags 合成目录（tags 页仍可经搜索与页内标签抵达）——沿用上游默认行为；
 * - 「设置」独立设置页（应用页而非阅读页，见 quartz/util/appPages.ts 的
 *   SETTINGS_SLUG/SETTINGS_EXCLUDE 约定；此处 filterFn 收到的是单个 slug 段，
 *   直接比字面量即可，无需切割 SETTINGS_EXCLUDE 前缀）。
 */
function keepNode(node: FileTrieNode): boolean {
  return node.slugSegment !== "tags" && node.slugSegment !== "设置"
}
// ==== /patent-kb ====

function defaultCollapsed(depth: number, opts: ParsedOptions): boolean {
  // 阶段5.4 批 D1：图谱页用独立的展开深度上限（书下 3 层可见，见 ParsedOptions
  // 的 graphExpandToDepth 注释）；其余页面维持 openLevels 原逻辑。保存态优先级不变。
  const expandToDepth = opts.graphExpandToDepth ?? opts.openLevels
  return opts.folderDefaultState === "collapsed" && depth > expandToDepth
}

// ==== patent-kb: 侧栏合成分组层「中国 → 权利类型 → 文件归类」（C-3）====
// 物理路径、slug、页面 id 一律不动：分组只发生在 trie 建好并排序之后的渲染树上，
// 把 87 个顶层书目录节点整体摘下、按 /static/taxonomy.json 的 country/field/docType
// 三级再父化，挂到三层「合成节点」下。合成节点没有对应页面，因此不可点击导航，
// 只能折叠/展开；taxonomy 取不到或键缺失时整层不建，目录树回落为现状平铺。

/** 分组数据源（相对站点根）。取数走相对路径，理由同 graphexplorer 的 fetchCard。 */
const TAXONOMY_PATH = "static/taxonomy.json"

/**
 * 合成节点折叠态的持久化键前缀。真实 slug 不含冒号，故与任何页面路径天然不冲突。
 * 阶段5.8：字面量迁往 util/explorerOrder.ts（那里的 isOrderableParentKey 以它为
 * 「可重排」的唯一判据），此处改为引用，杜绝两份真相。
 */
const SYNTHETIC_KEY_PREFIX = EXPLORER_SYNTHETIC_PREFIX

/**
 * 折叠态存储键。分组层把书目录从渲染树第 1 层推到第 4 层，旧键 `fileTree` 里
 * 沉淀的记录（各书清一色 collapsed:false，是 openLevels:1 平铺时代的默认值）
 * 会让每个归类一展开就把整本书的章节全铺出来，与「field 及以下默认折叠」相悖。
 * 树形已变，旧记录语义作废——换键即整体作废，比逐条甄别可靠。旧键不主动删除，
 * 以便回滚时旧版本仍能读回自己的状态。
 */
const FOLDER_STATE_STORAGE_KEY = "fileTree-v2"

/**
 * 图谱页独立折叠态存储键（阶段5.4 批 D1）。图谱页默认展开到渲染树第 6 层
 * （书下 3 层可见），与文档站「field 及以下默认折叠」的折叠习惯差异极大；若共用
 * fileTree-v2，图谱页首访就会把上千条展开记录写回文档站键，内容页再访问时整树铺开。
 * 故图谱页改读写本键：首访无键时全部节点按「深度 ≤6 默认展开」规则渲染
 *（GRAPH_EXPAND_TO_DEPTH）；手动折叠经 toggleFolder 落入 graph 键。
 * 文档站的 fileTree-v2 对图谱页零读零写，两侧状态互不可见、零污染。
 */
const GRAPH_FOLDER_STATE_STORAGE_KEY = "fileTree-graph"

/** 图谱页默认展开深度上限：渲染树 depth ≤ 6 展开（4=书，即书下 3 层可见），>6 折叠。 */
const GRAPH_EXPAND_TO_DEPTH = 6

// ==== patent-kb: 常设性能埋点 window.__explorerPerf（阶段5.6 目录树 DOM 复用）====
// 目录树是全站每次 SPA 导航的固定开销（约 7,400 个 li／1,395 个文件夹节点），
// 与页面渲染争同一条主线程。埋点常设而非临时插桩，理由同 graph.inline.ts 的
// __graphPerf：每一次归因都要求同口径数字。默认零输出、零 I/O，开销为每次导航
// 三次 performance.now()。localStorage 的 explorer-perf 置 "1" 时逐条 console.log。

type ExplorerPerfMark = {
  /** 本次导航落地页 slug */
  slug: string
  /**
   * 走的哪条路径：
   * build=全量重建（首次导航或缓存失效）｜reuse=复用已建 DOM 做增量更新｜
   * stale=取数返回时已被后一次导航接管，本次放弃（快速连点两页的竞态防护）。
   */
  mode: "build" | "reuse" | "stale"
  /** setupExplorer 入口（performance.now 绝对值，跨记录不可相减） */
  start: number
  /** setupExplorer 收尾 */
  end: number
  /** 派生：end - start，含 build 路径上 await fetchData/taxonomy 的微任务往返 */
  total: number
  /** 派生：await 之后的同步段（建树／增量更新／插入 DOM）；reuse 路径无 await，等于 total */
  sync: number
  /** 渲染树 li 总数（文件 + 文件夹 + 合成分组层） */
  items: number
  /** 文件夹节点数（含合成分组层） */
  folders: number
  /**
   * 本次是否重写了全部 <a href>。相对路径只随 pathToRoot(currentSlug) 变化，
   * 同深度页面互跳（条文页→条文页）时全树 href 原样正确，无需任何写入。
   */
  hrefRewritten: boolean
}

/** 保留的记录条数上限：够看清「首次导航 vs 后续导航」的对照，又不至于常驻内存 */
const EXPLORER_PERF_MAX_MARKS = 20

const explorerPerf: { marks: ExplorerPerfMark[] } = { marks: [] }

declare global {
  interface Window {
    /** 常设性能埋点存档：最近 20 次 setupExplorer 的耗时切片与规模量 */
    __explorerPerf?: { marks: ExplorerPerfMark[] }
  }
}
window.__explorerPerf = explorerPerf

function recordExplorerPerf(mark: ExplorerPerfMark) {
  explorerPerf.marks.push(mark)
  if (explorerPerf.marks.length > EXPLORER_PERF_MAX_MARKS) {
    explorerPerf.marks.shift()
  }
  let verbose = false
  try {
    verbose = localStorage.getItem("explorer-perf") === "1"
  } catch {
    // 隐私模式等禁用 localStorage 的环境：静默即可，埋点本身不受影响
  }
  if (verbose) {
    console.log(
      `[explorer] ${mark.mode} total=${mark.total.toFixed(1)}ms sync=${mark.sync.toFixed(1)}ms ` +
        `items=${mark.items} folders=${mark.folders} href=${mark.hrefRewritten} ${mark.slug}`,
    )
  }
}
// ==== /patent-kb ====

/**
 * 当前生效的折叠态存储键，每次 setupExplorer 开头按当前页刷新：
 * 图谱页置 GRAPH_FOLDER_STATE_STORAGE_KEY，其余页维持 FOLDER_STATE_STORAGE_KEY。
 * 读（setupExplorer）与写回（toggleFolder）都取该变量——toggleFolder 是独立事件回调，
 * 拿不到 setupExplorer 的局部上下文，读模块级变量即可：SPA 换页后该变量随新页的
 * setupExplorer 同步刷新，回调存活期间读到的一定是当前页的键，语义正确。
 */
let activeStorageKey = FOLDER_STATE_STORAGE_KEY

/** 权利类型（field）展示顺序；taxonomy 中出现的未知取值按首次出现顺序缀在其后。 */
const FIELD_ORDER = ["专利", "商标", "著作权", "竞争法", "品种布图", "综合程序"]

/** 文件归类（docType）展示顺序；标题取 taxonomy 的 docTypeName。 */
const DOCTYPE_ORDER = ["D1", "D2", "D3", "D4", "D5", "D6"]

/** 法域（country）展示顺序与显示名。当前 88 部书全为 CN，其余法域按首次出现顺序追加。 */
const COUNTRY_ORDER = ["CN"]
const COUNTRY_NAMES: Record<string, string> = { CN: "中国" }

interface TaxonomyEntry {
  country?: string
  field?: string
  docType?: string
  docTypeName?: string
}

type TaxonomyMap = Record<string, TaxonomyEntry>

interface SyntheticMeta {
  /** 稳定折叠键，形如 `synthetic:CN/专利/D1` */
  key: string
  /** 子树内是否包含当前页——合成层没有 slug，无法套用 folderIsPrefixOfCurrentSlug */
  containsCurrent: boolean
}

/**
 * 合成节点标记。节点每次 nav 重建，旧条目随之可回收，故用 WeakMap 而非 Map。
 * 之所以不往 FileTrieNode 上加字段：该类由 fileTrie.ts 定义，属本批不可改文件。
 */
const syntheticNodes = new WeakMap<FileTrieNode, SyntheticMeta>()

/** 分组表缓存：仅缓存成功结果，失败留待下次 nav 重试。 */
let taxonomyCache: TaxonomyMap | null = null

async function fetchTaxonomy(currentSlug: FullSlug): Promise<TaxonomyMap | null> {
  if (taxonomyCache) {
    return taxonomyCache
  }
  try {
    const res = await fetch(joinSegments(pathToRoot(currentSlug), TAXONOMY_PATH))
    if (!res.ok) {
      return null
    }
    const parsed: unknown = await res.json()
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    taxonomyCache = parsed as TaxonomyMap
    return taxonomyCache
  } catch {
    // 离线桌面壳中该文件随包分发，属本地请求；取不到即回落平铺，不打断目录渲染
    return null
  }
}

/** 顶层书目录名形如「12-商标案件管辖解释」，taxonomy 以其数字前缀为键。 */
function taxonomyKeyOf(slugSegment: string): string | null {
  const matched = slugSegment.match(/^(\d+)-/)
  return matched ? matched[1] : null
}

function createSyntheticNode(segments: string[], displayName: string): FileTrieNode {
  const node = new FileTrieNode(segments)
  node.isFolder = true
  node.displayName = displayName
  syntheticNodes.set(node, {
    key: SYNTHETIC_KEY_PREFIX + segments.join("/"),
    containsCurrent: false,
  })
  return node
}

/** 折叠态键：合成节点用稳定 key，真实目录仍用 slug（与旧 localStorage 记录兼容）。 */
function folderStateKey(node: FileTrieNode): string {
  return syntheticNodes.get(node)?.key ?? node.slug
}

/** 先按 preferred 给定次序取出其中存在的键，其余按 keys 原有顺序（书号升序）追加。 */
function orderedKeys(keys: string[], preferred: string[]): string[] {
  const present = new Set(keys)
  return [
    ...preferred.filter((key) => present.has(key)),
    ...keys.filter((key) => !preferred.includes(key)),
  ]
}

/** 与 createFolderNode 中真实目录的判据同源：书目录 slug 是否为当前页的前缀。 */
function nodeContainsCurrent(node: FileTrieNode, currentSlug: FullSlug): boolean {
  const simple = simplifySlug(node.slug)
  return simple === currentSlug.slice(0, simple.length)
}

/**
 * 再父化：把命中 taxonomy 的顶层书目录摘出，挂进 country → field → docType 三层合成节点。
 *
 * 在 sort 之后执行（而非「建树后、sort 前」）：sortNodes 只认 slug 段的数字前缀，
 * 合成节点没有数字前缀，会被排到 `9-关键词索引` 之后，与「0-图谱总览 → 中国 → 9-关键词索引」
 * 的目标顺序相悖；若为此在 sortNodes 里加合成节点分支，等于把两套排序键耦合进同一函数。
 * 排序后再父化则天然继承既有次序：书按数字前缀升序落进各归类，书内子树完全不动。
 *
 * @returns 是否真的建出了分组层（false 表示回落平铺）
 */
function regroupByTaxonomy(
  trie: FileTrieNode,
  taxonomy: TaxonomyMap,
  currentSlug: FullSlug,
): boolean {
  type DocTypeBucket = { label: string; books: FileTrieNode[]; containsCurrent: boolean }
  type FieldBucket = { docTypes: Map<string, DocTypeBucket>; containsCurrent: boolean }
  type CountryBucket = { fields: Map<string, FieldBucket>; containsCurrent: boolean }

  const countries = new Map<string, CountryBucket>()
  const rest: FileTrieNode[] = []
  // 分组层在顶层的落位：首部被收编的书原先所处的位置（本库即 0-图谱总览 之后、
  // 9-关键词索引 之前）。未收编任何书时为 -1，追加到末尾。
  let insertAt = -1
  let bookCount = 0

  for (const child of trie.children) {
    const key = child.isFolder ? taxonomyKeyOf(child.slugSegment ?? "") : null
    const entry = key === null ? undefined : taxonomy[key]
    // 缺 country/field/docType 任一维度即视为未归类，原样留在顶层——宁可少分组，
    // 不可让某部书从目录树里消失
    if (!entry || typeof entry !== "object" || !entry.country || !entry.field || !entry.docType) {
      rest.push(child)
      continue
    }

    if (insertAt < 0) {
      insertAt = rest.length
    }
    bookCount += 1

    const country = countries.get(entry.country) ?? { fields: new Map(), containsCurrent: false }
    countries.set(entry.country, country)
    const field = country.fields.get(entry.field) ?? { docTypes: new Map(), containsCurrent: false }
    country.fields.set(entry.field, field)
    const docType = field.docTypes.get(entry.docType) ?? {
      label: entry.docTypeName || entry.docType,
      books: [],
      containsCurrent: false,
    }
    field.docTypes.set(entry.docType, docType)
    docType.books.push(child)

    if (nodeContainsCurrent(child, currentSlug)) {
      country.containsCurrent = true
      field.containsCurrent = true
      docType.containsCurrent = true
    }
  }

  if (bookCount === 0) {
    return false
  }

  const groups: FileTrieNode[] = []
  for (const countryKey of orderedKeys([...countries.keys()], COUNTRY_ORDER)) {
    const country = countries.get(countryKey)!
    const countryNode = createSyntheticNode([countryKey], COUNTRY_NAMES[countryKey] ?? countryKey)
    syntheticNodes.get(countryNode)!.containsCurrent = country.containsCurrent

    for (const fieldKey of orderedKeys([...country.fields.keys()], FIELD_ORDER)) {
      const field = country.fields.get(fieldKey)!
      const fieldNode = createSyntheticNode([countryKey, fieldKey], fieldKey)
      syntheticNodes.get(fieldNode)!.containsCurrent = field.containsCurrent

      for (const docTypeKey of orderedKeys([...field.docTypes.keys()], DOCTYPE_ORDER)) {
        const docType = field.docTypes.get(docTypeKey)!
        const docTypeNode = createSyntheticNode([countryKey, fieldKey, docTypeKey], docType.label)
        syntheticNodes.get(docTypeNode)!.containsCurrent = docType.containsCurrent
        docTypeNode.children = docType.books
        fieldNode.children.push(docTypeNode)
      }

      countryNode.children.push(fieldNode)
    }

    groups.push(countryNode)
  }

  rest.splice(insertAt < 0 ? rest.length : Math.min(insertAt, rest.length), 0, ...groups)
  trie.children = rest
  return true
}

/**
 * 按渲染树遍历出全部目录节点的折叠键与显示深度（根的直接子节点为 1）。
 * 取代上游 `trie.getFolderPaths()`：后者只认 slug，既拿不到合成节点的稳定键，
 * 也给不出分组后的真实层级。未启用分组时两者结果等价（仅少一条恒不参与渲染的根条目）。
 */
function collectFolderStates(trie: FileTrieNode): Array<{ path: string; depth: number }> {
  const out: Array<{ path: string; depth: number }> = []
  const walk = (node: FileTrieNode, depth: number) => {
    for (const child of node.children) {
      if (!child.isFolder) {
        continue
      }
      out.push({ path: folderStateKey(child), depth })
      walk(child, depth + 1)
    }
  }
  walk(trie, 1)
  return out
}
// ==== /patent-kb ====

// ==== patent-kb: 目录树自定义排序（阶段5.8）====
// 纯逻辑（表结构/解析/部分排序合并/搬移）全在 util/explorerOrder.ts 并由单测钉死；
// 本文件只负责三件事：读写 localStorage、把表施加到渲染树、把可重排行标记出来。
//
// 可重排的判据只有一条：**父节点的折叠键以 `synthetic:` 开头**。合成分组层恰是
// 三层（国家 / 权利类型 / 文件归类），其子恰是开放重排的三层（法域行 / docType 行 /
// 书目行）；顶层三巨头的父是根、章节层的父是真实目录，两者据此天然锁死，
// 无需任何深度魔数。

/**
 * 顺序表的会话内缓存。整页加载时读一次即可：SPA 生命周期内只有拖拽与「恢复默认」
 * 会改它，两者都走 writeOrderTable / 置空缓存，故缓存与 localStorage 恒一致。
 * 多窗口并存时另一窗口的改动本窗口看不到（已知限制，与折叠态表同）。
 */
let orderTableCache: ExplorerOrderTable | null = null

function readOrderTable(): ExplorerOrderTable {
  if (orderTableCache) {
    return orderTableCache
  }
  let raw: string | null = null
  try {
    raw = localStorage.getItem(EXPLORER_ORDER_STORAGE_KEY)
  } catch {
    // 隐私模式等禁用 localStorage 的环境：按「无自定义序」处理，目录树照常渲染
  }
  orderTableCache = parseOrderTable(raw)
  return orderTableCache
}

function writeOrderTable(table: ExplorerOrderTable) {
  orderTableCache = table
  try {
    localStorage.setItem(EXPLORER_ORDER_STORAGE_KEY, serializeOrderTable(table))
  } catch {
    // 配额满/隐私模式：本会话内的内存缓存仍生效；抛出会中断拖拽收尾，留下
    // 半吊子的 is-dragging 类与全局禁选标记，比丢一次持久化严重得多
  }
}

/**
 * 把自定义序施加到渲染树。调用点唯一：regroupByTaxonomy 之后、collectFolderStates
 * 之前——前者造出合成层（此前根本没有可重排的父），后者与建树都依赖 children 的
 * 最终次序（folderStateKey 与深度都不受重排影响，但前序遍历的**顺序**必须与
 * 建树一致，否则 flatFolders 与 currentExplorerState 对不上）。
 *
 * 遍历只在合成层内下潜：遇到非合成节点（书目录及其以下）立即止步，
 * 故实际访问约 114 个节点，不会下潜到 7,400 个渲染节点。
 */
function applyCustomOrder(trie: FileTrieNode, table: ExplorerOrderTable) {
  if (!hasCustomOrder(table)) {
    return
  }
  const walk = (node: FileTrieNode) => {
    for (const child of node.children) {
      if (!child.isFolder) {
        continue
      }
      const key = folderStateKey(child)
      // 非合成节点：它的子项不开放重排，其整棵子树也不可能含合成节点，就此止步
      if (!isOrderableParentKey(key)) {
        continue
      }
      child.children = applyOrderToItems(child.children, table.parents[key], folderStateKey)
      walk(child)
    }
  }
  // 从根的直接子开始：根自身的子序（顶层三巨头）不开放重排，故不对 trie.children 施加
  walk(trie)
}
// ==== /patent-kb ====

// ==== patent-kb: 图谱总览页目录过滤联动（阶段5.3 批 B4 引入；阶段5.4 批 D1 反转）====
// B4 曾有两条链路。阶段5.4 反转后仅剩一条：
//   ① 定位（已撤销）：原为点目录条目 → 拦截跳转 → 派发 kb:graphlocate 在图内定位。
//      反转后目录点击恢复 SPA 直达文档——folderClickBehavior:'link' 下书名/章名
//      本就是 `<a data-for>`，spa.inline.ts 的 window 级 click 委托自然接管跳转，
//      与文档站行为一致，无需任何额外导航代码。
//   ② 过滤（保留）：收 kb:graphfield（detail.field 为法域名或哨兵 FIELD_ALL）
//      → 只显示该法域的 field 层分支，其余分支整支 hidden。
// 过滤事件契约（payload/方向/门控）登记在 util/graphInteraction.ts。
//
// 门控铁律：Explorer 是全站共享组件，以下函数一律先过 onGraphOverviewPage()。
// 非图谱页不绑定任何监听器、不写任何 hidden 属性——首页与内容页的目录树 DOM
// 与 B4 之前完全一致（smoke 步 27 跑在首页，断言的合成节点数、顶层 synthetic:CN、
// 「合成节点内 <a> 数 === 0」、六 field 行齐备四项因此原样成立）。

/** 当前页是否图谱总览专页。常量与 GraphExplorer.tsx 的宿主门控同源。 */
function onGraphOverviewPage(): boolean {
  return getFullSlug(window) === GRAPH_SLUG
}

/**
 * 从合成节点的折叠键中取 field 名，非 field 层一律返回 null。
 * 键形如 `synthetic:CN`（国家层，1 段）/ `synthetic:CN/专利`（field 层，2 段）/
 * `synthetic:CN/专利/D1`（docType 层，3 段）——**段数恰为 2** 才是 field 层。
 */
function fieldOfSyntheticKey(folderPath: string): string | null {
  if (!folderPath.startsWith(SYNTHETIC_KEY_PREFIX)) {
    return null
  }
  const segments = folderPath.slice(SYNTHETIC_KEY_PREFIX.length).split("/")
  return segments.length === 2 ? segments[1] : null
}

/**
 * 按法域收窄目录树：只动 field 层分支外层 `li` 的 `hidden` 属性。
 * FIELD_ALL（"*"）恢复全显。刻意不碰折叠态（currentExplorerState 与
 * localStorage 当前页生效键均不写——图谱页即 fileTree-graph，见 activeStorageKey）
 * ——过滤是**呈现**范围，与用户手动折叠的意图正交，切回「全部」后每个分支仍保持
 * 用户原本的展开/折叠状态。未被分组收编的顶层条目（0-图谱总览、9-关键词索引）
 * 不属任何 field 分支，恒显。
 */
function applyFieldBranchFilter(explorer: HTMLElement, field: string) {
  const containers = explorer.querySelectorAll<HTMLElement>(
    '.folder-container[data-synthetic="true"]',
  )
  for (const container of containers) {
    const branchField = fieldOfSyntheticKey(container.dataset.folderpath ?? "")
    if (branchField === null) {
      continue
    }
    const li = container.closest("li")
    if (li === null) {
      continue
    }
    li.hidden = !(field === FIELD_ALL || branchField === field)
  }
}

/**
 * 过滤联动的绑定入口，由 setupExplorer 在每棵目录树建好后调用一次。
 * （阶段5.4 批 D1：B4 的定位联动已整体撤销，本函数不再绑定任何 click 拦截。）
 * 监听器随 window.addCleanup 在下次 SPA 导航前摘除；目录树本身每次 nav 由
 * micromorph 复位回 SSR 空骨架后重建，故 hidden 属性亦不会跨页残留。
 */
function bindGraphLinkage(explorer: HTMLElement) {
  if (!onGraphOverviewPage()) {
    return
  }

  // 过滤联动。监听挂 document（派发方在图谱卡片分支，冒泡到不了 .explorer）。
  const onFieldChange = (ev: Event) => {
    // 二次门控：监听器虽随 cleanup 摘除，但 cleanup 的执行时机由 spa.inline 统一
    // 编排，此处再核一次当前页，杜绝「已离开图谱页却仍在改目录树」的任何时序缝隙
    if (!onGraphOverviewPage()) {
      return
    }
    const detail = (ev as CustomEvent<GraphFieldDetail>).detail
    if (typeof detail?.field !== "string") {
      return
    }
    applyFieldBranchFilter(explorer, detail.field)
  }
  document.addEventListener(GRAPH_FIELD_EVENT, onFieldChange)
  window.addCleanup(() => document.removeEventListener(GRAPH_FIELD_EVENT, onFieldChange))
}
// ==== /patent-kb ====

// ==== patent-kb: 目录自动定位（v6）====
// 当前项（文件行 a.active，兜底目录页 .folder-container.active）不在滚动器
// 可视区内时，将其滚动到居中；已可见则完全不动。只写内层滚动器 scrollTop，
// 绝不用 scrollIntoView（会连带滚动整个文档）。
let explorerLocatePending = false

// 需求⑨（滚动穿透）：此处原有 chainWheelToPage/bindPageWheelChaining 主动把侧栏
// 边界处的滚轮 preventDefault 后转发给正文（window.scrollTo）。该行为与用户要求
// 相反，已连同 util/scrollInteraction.ts 的 shouldChainWheelToPage 一并删除；
// 阻断改由 CSS `overscroll-behavior: contain` 承担（explorer/toc/backlinks 三处滚动器）。

// ==== patent-kb: 侧栏自绘 overlay 滚动条（需求③）====
// 旧做法（平时 scrollbar-width:none、滚动中切 thin）在 Electron 43 上双重失效：
// Chromium 121+ 一旦命中 `scrollbar-width`，该元素的全部 ::-webkit-scrollbar*
// 伪元素被整体忽略（无法渐隐），而切换槽宽本身会挤压侧栏内容并在滚停后回弹。
// 改为原生槽宽恒为 0（CSS 侧负责）＋ JS 注入一条绝对定位的 overlay 轨道：
// 轨道不占文档流宽度，滚动前后 scroller.clientWidth 完全相等。
// 一期只做「随滚动淡入、滚停淡出」，不做 thumb 拖拽。

/**
 * 真滚动器四选。`.sidebar` 自身 overflow 可见、永不产生滚动，已从旧清单剔除。
 * `.explorer-content` 与 `.explorer-ul` 是同一区域的嵌套双滚动器，经
 * hasScrollableContent 过滤后通常只剩内层 `.explorer-ul` 真滚；若两者同时溢出，
 * 会生成两条同右缘、同高度的重叠轨道（视觉上无差别），此处不额外去重。
 */
/**
 * 轨道宿主侧栏。与 custom.scss 第五节的原生槽归零/回落两条规则同一范围，
 * 该节的回落门控 `.sidebar:not([data-oscroll])` 消费下面写入的属性。
 */
const OVERLAY_SIDEBAR_SELECTOR = ".page > #quartz-body > .sidebar"

const OVERLAY_SCROLLER_SELECTOR = [
  ".page > #quartz-body > .sidebar.left .explorer-content",
  ".page > #quartz-body > .sidebar.left .explorer-ul",
  ".page > #quartz-body > .sidebar.right .toc-content",
  ".page > #quartz-body > .sidebar.right .backlinks > ul",
].join(", ")

/**
 * 与 `quartz/styles/variables.scss` 的 `$mobile`（`$breakpoints.mobile: 800px`）
 * 同值。移动端左栏退化为顶部横条、右栏横排于文末，overlay 轨道无稳定宿主，整体跳过。
 */
const OVERLAY_MOBILE_QUERY = "(max-width: 800px)"

/** 滚停后轨道淡出的延时，沿用旧 auto-hide 的 850ms 手感。 */
const OVERLAY_HIDE_DELAY = 850

/**
 * 布局变更后的轨道重算钩子：bindOverlayScrollbars 每次 nav 重写它，
 * cleanup 时复位为空操作（此时轨道 DOM 已随之移除）。
 */
let syncOverlayScrollbars: () => void = () => {}

function scheduleOverlayScrollbarSync() {
  requestAnimationFrame(() => syncOverlayScrollbars())
}

/**
 * 判溢出与算拇指几何都必须用这个「真内容」高度，不能直接用 scrollHeight。
 *
 * OverflowList.tsx 给每个 overflow 列表末尾追加一条 `li.overflow-end`，base.scss
 * 固定其高 0.5rem——它不承载内容，只为末项与底部渐隐留呼吸，却照样计入
 * scrollHeight。于是只要滚动器的可视高度落在「真实内容高度 + 占位高」的窗口内，
 * scrollHeight > clientHeight + 1 就恒成立：轨道照建、拇指照画，而全部真实条目
 * 都完整可见。实测反向链接卡在窗口高 812–818px 区间即如此（clientHeight
 * 307/309/311/313 对 scrollHeight 315，末条链接底缘仍在容器内 0.09–6.09px）。
 *
 * 占位高度现取而不写死常量：0.5rem 随根字号变化，且该条目并非每个滚动器都有
 *（左栏 .explorer-content 的占位在其子 ul 内，不是自己的末子节点）。
 */
function contentScrollHeight(scroller: HTMLElement): number {
  const tail = scroller.lastElementChild
  if (!tail?.classList.contains("overflow-end")) {
    return scroller.scrollHeight
  }
  return scroller.scrollHeight - tail.getBoundingClientRect().height
}

function bindOverlayScrollbars() {
  if (window.matchMedia(OVERLAY_MOBILE_QUERY).matches) {
    return
  }

  // 声明「侧栏滚动条呈现已由本脚本接管」，供 custom.scss 第五节的原生细槽回落
  // 门控（`.sidebar:not([data-oscroll])`）区分「脚本没跑」与「脚本跑了但判定无需
  // 轨道」。**必须写在建轨循环之前、且与是否真的建出轨道无关**：右栏多数页面无需
  // 轨道，若沿旧门控按「有没有 .kb-oscroll」判定，原生细槽会被整片放出来，为末尾
  // 那条 0.5rem 空占位画出 11px 宽、永不淡出的滚动条（实测 term-0084 页反链 3 条、
  // diff=1px 即如此）。
  // 幂等写入、不在 cleanup 中摘除，理由同 pageChrome.inline.ts 的 data-pagescroll：
  // 换页间隙摘除会让原生滚动条闪现。
  for (const sidebar of document.querySelectorAll<HTMLElement>(OVERLAY_SIDEBAR_SELECTOR)) {
    sidebar.dataset.oscroll = "on"
  }

  const syncFns: Array<() => void> = []

  for (const scroller of document.querySelectorAll<HTMLElement>(OVERLAY_SCROLLER_SELECTOR)) {
    // 轨道宿主取所在 .sidebar：glass-panel-host（custom.scss:153）已给它
    // position + isolation，既是绝对定位的包含块，又把轨道的 z-index 关在侧栏内。
    const sidebar = scroller.closest<HTMLElement>(".sidebar")
    if (!sidebar) {
      continue
    }
    if (
      !hasScrollableContent({
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        clientHeight: scroller.clientHeight,
        scrollHeight: contentScrollHeight(scroller),
      })
    ) {
      continue
    }

    const track = document.createElement("div")
    track.className = "kb-oscroll"
    track.setAttribute("aria-hidden", "true")
    const thumb = document.createElement("div")
    thumb.className = "kb-oscroll-thumb"
    track.appendChild(thumb)
    sidebar.appendChild(track)

    // 绝对定位的包含块是 .sidebar 的 padding box，而 getBoundingClientRect 给的是
    // border box，故差值需减去侧栏边框宽度（glass-panel-host 的 1px 描边）。
    // 边框宽度不随主题切换变化，创建时取一次即可，免去滚动中反复 getComputedStyle。
    const sidebarStyle = window.getComputedStyle(sidebar)
    const sidebarBorderTop = parseFloat(sidebarStyle.borderTopWidth) || 0
    const sidebarBorderRight = parseFloat(sidebarStyle.borderRightWidth) || 0

    /** 重算轨道盒与 thumb 几何；返回 thumb 当前是否应可见。 */
    const sync = (): boolean => {
      const sidebarRect = sidebar.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const trackHeight = scroller.clientHeight

      track.style.top = `${scrollerRect.top - sidebarRect.top - sidebarBorderTop}px`
      track.style.height = `${trackHeight}px`
      // 滚动器右缘与侧栏内边距右缘之间的距离，交由 CSS 决定轨道贴内容还是贴卡片边
      track.style.setProperty(
        "--kb-oscroll-right",
        `${sidebarRect.right - sidebarBorderRight - scrollerRect.right}px`,
      )

      // 与建轨判据同源：轨道一旦建成便常驻至换页，此后布局变化（窗口缩放、目录
      // 折叠、右栏 flex 余量再分配）若使真实内容不再溢出，必须由这里返回
      // visible: false 把拇指收回，故两处的 scrollHeight 口径必须一致。
      const geometry = computeThumbGeometry(
        {
          clientHeight: scroller.clientHeight,
          scrollHeight: contentScrollHeight(scroller),
          scrollTop: scroller.scrollTop,
        },
        trackHeight,
      )
      thumb.style.height = `${geometry.height}px`
      thumb.style.top = `${geometry.offset}px`
      if (!geometry.visible) {
        track.classList.remove("is-visible")
      }
      return geometry.visible
    }

    let hideTimer: number | undefined
    const showWhileScrolling = () => {
      // 每次滚动都整体重算：TOC 折叠、右栏卡片间 flex 余量再分配等无过渡的高度
      // 变化不会发出任何事件，整体重算使轨道自愈，无需额外的观察者。
      if (!sync()) {
        return
      }
      track.classList.add("is-visible")
      if (hideTimer !== undefined) {
        window.clearTimeout(hideTimer)
      }
      hideTimer = window.setTimeout(() => {
        track.classList.remove("is-visible")
        hideTimer = undefined
      }, OVERLAY_HIDE_DELAY)
    }

    // 目录折叠动画（.folder-outer 的 grid-template-rows，explorer.scss:150）落定后
    // scrollHeight 才是终值；该事件冒泡至滚动器，是最准确的重算时机。
    const syncAfterTransition = (evt: TransitionEvent) => {
      if (evt.propertyName === "grid-template-rows") {
        sync()
      }
    }

    scroller.addEventListener("scroll", showWhileScrolling, { passive: true })
    scroller.addEventListener("transitionend", syncAfterTransition)
    sync()
    syncFns.push(sync)

    // cleanup 在 prenav 之后、micromorph 形变 body 之前执行（spa.inline.ts:81-105），
    // 轨道必须在这一步自行摘除：它不存在于下一页的 HTML 中，留到 diff 阶段会被
    // micromorph 视作多余节点处理，并打乱 .sidebar 的子节点配对。
    window.addCleanup(() => {
      scroller.removeEventListener("scroll", showWhileScrolling)
      scroller.removeEventListener("transitionend", syncAfterTransition)
      if (hideTimer !== undefined) {
        window.clearTimeout(hideTimer)
      }
      track.remove()
    })
  }

  if (syncFns.length === 0) {
    return
  }

  syncOverlayScrollbars = () => syncFns.forEach((fn) => fn())
  const onResize = () => syncOverlayScrollbars()
  window.addEventListener("resize", onResize)
  window.addCleanup(() => {
    window.removeEventListener("resize", onResize)
    syncOverlayScrollbars = () => {}
  })
}
// ==== /patent-kb ====

function locateExplorerActive(scroller: HTMLElement) {
  const active =
    scroller.querySelector<HTMLElement>("a.active") ??
    scroller.querySelector<HTMLElement>(".folder-container.active")
  if (!active) {
    return
  }
  const sRect = scroller.getBoundingClientRect()
  const aRect = active.getBoundingClientRect()
  const isVisible = aRect.top >= sRect.top + 4 && aRect.bottom <= sRect.bottom - 4
  if (isVisible) {
    return
  }
  const target = scroller.scrollTop + (aRect.top - sRect.top) - (sRect.height - aRect.height) / 2
  scroller.scrollTop = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight))
}
// ==== /patent-kb ====

let currentExplorerState: Array<FolderState>
/**
 * currentExplorerState 的 path→collapsed 索引，与之在同一处同时构造、内容等价
 * （渲染树中折叠键唯一，故不存在「先到先得」与「后写覆盖」的分歧）。
 * 建树与增量更新都要按折叠键查取值，用它把原先的线性 find 降为 O(1)：
 * 1,383 个文件夹各查一遍原是 O(N²)。
 */
let explorerStateIndex = new Map<string, boolean>()
function toggleExplorer(this: HTMLElement) {
  const nearestExplorer = this.closest(".explorer") as HTMLElement
  if (!nearestExplorer) return
  // 用户手动切换后清掉自动折叠标记：桌面端复位逻辑不再打断用户意图
  delete nearestExplorer.dataset.autoCollapsed
  const explorerCollapsed = nearestExplorer.classList.toggle("collapsed")
  nearestExplorer.setAttribute(
    "aria-expanded",
    nearestExplorer.getAttribute("aria-expanded") === "true" ? "false" : "true",
  )

  if (!explorerCollapsed) {
    // Stop <html> from being scrollable when mobile explorer is open
    document.documentElement.classList.add("mobile-no-scroll")
  } else {
    document.documentElement.classList.remove("mobile-no-scroll")
  }
}

function toggleFolder(evt: MouseEvent) {
  evt.stopPropagation()
  const target = evt.target as MaybeHTMLElement
  if (!target) return

  // Check if target was svg icon or button
  const isSvg = target.nodeName === "svg"

  // corresponding <ul> element relative to clicked button/folder
  const folderContainer = (
    isSvg
      ? // svg -> div.folder-container
        target.parentElement
      : // button.folder-button -> div -> div.folder-container
        target.parentElement?.parentElement
  ) as MaybeHTMLElement
  if (!folderContainer) return
  const childFolderContainer = folderContainer.nextElementSibling as MaybeHTMLElement
  if (!childFolderContainer) return

  childFolderContainer.classList.toggle("open")

  // Collapse folder container
  const isCollapsed = !childFolderContainer.classList.contains("open")
  setFolderState(childFolderContainer, isCollapsed)

  const currentFolderState = currentExplorerState.find(
    (item) => item.path === folderContainer.dataset.folderpath,
  )
  if (currentFolderState) {
    currentFolderState.collapsed = isCollapsed
  } else {
    currentExplorerState.push({
      path: folderContainer.dataset.folderpath as FullSlug,
      collapsed: isCollapsed,
    })
  }
  // patent-kb（DOM 复用）：索引与 currentExplorerState 同步维护，二者恒等价。
  // 本次改动内没有「同一页内先折叠再读索引」的路径（索引只在 setupExplorer 内构造后
  // 即刻用完），此处同步是为不给后来者留下一个会悄悄读到旧值的半新半旧结构。
  explorerStateIndex.set(folderContainer.dataset.folderpath as string, isCollapsed)

  const stringifiedFileTree = JSON.stringify(currentExplorerState)
  // ==== patent-kb: 配额满时不得中断 nav 回调 ====
  // 写入键取 activeStorageKey（阶段5.4 批 D1）：该变量由 setupExplorer 在每次 nav
  // 时按当前页刷新——图谱页手动折叠落 fileTree-graph，其余页仍落 fileTree-v2，
  // 两侧折叠态互不可见、零污染。
  try {
    localStorage.setItem(activeStorageKey, stringifiedFileTree)
  } catch {
    // 目录展开状态丢失无妨；抛出则会中断本次 nav 中后续组件的初始化
  }
  // ==== /patent-kb ====

  // 折叠/展开改变目录树高度：下一帧先按动画首帧几何重算一次（避免整段动画期间
  // thumb 完全过期），动画落定后的精确值由滚动器上的 transitionend 补齐。
  scheduleOverlayScrollbarSync()

  // patent-kb（阶段5.8）：任一文件夹被手动展开后「全部已收起」即不再成立，
  // 一键收起钮须随之解除置灰
  refreshHeaderActionState()
}

// ==== patent-kb: 目录树 DOM 复用（SPA 生命周期内）====
// 背景：setupExplorer 原本在**每次** SPA 导航都对全量 contentIndex 重建 FileTrieNode 树，
// 再重建约 7,400 个 li／2–3 万 DOM 节点（实测同步段 124ms／次），是全站每次导航的固定税，
// 与页面渲染争同一条主线程。而 SPA 生命周期内这棵树的**结构**是恒定的：
//   · contentIndex 恒定——fetchData 由 renderPage.tsx 注入的 head 内联脚本以 spaPreserve
//     形态执行一次，SPA 导航只换 body、不重跑该脚本，故全站共享同一个已 resolve 的 Promise；
//   · 分组表恒定——taxonomyCache 模块级缓存；
//   · 排序/过滤/再父化全是纯函数，同一输入必得同一棵树（实测：同一页三次导航的目录树
//     innerHTML 散列逐位相同）。
// 逐导航真正会变的只有三样：
//   ① 每个 <a> 的相对 href（只随 pathToRoot(currentSlug) 变化——同深度页面互跳时连它也不变）；
//   ② .active 高亮的落点；
//   ③ 文件夹展开态（保存态 → 默认规则 → 当前页祖先链强制展开，三级判定与重建路径同一公式）。
// 故改为：首次导航建树并缓存整棵 DOM，其后逐导航只做上述三项 O(V) 增量更新，零 DOM 创建/销毁。
//
// 三项配套机制：
//   · prenav 摘树（detachExplorerTrees）——micromorph 把当前 body 与新页 SSR 空骨架逐节点
//     比对，7,400 个 li 全落在「多余节点」侧要被逐个删除；先摘下则两侧都只剩空骨架，这段
//     diff 成本一并归零，且摘下的节点连同其上的事件监听原样存活，下次导航直接挂回。
//   · 增量更新一律在**离体状态**下做——离体元素不参与样式解析，.folder-outer 上那条
//     0.3s 的 grid-template-rows 过渡（explorer.scss:150）不会被触发；挂回时是元素的首次
//     样式解析，同样不起过渡。故展开态变化保持与重建路径一样的「瞬时到位」，无动画。
//   · 折叠钮监听只在建树时绑定一次且**不**登记 window.addCleanup——节点跨导航存活，
//     若沿用「每次 nav 摘除、每次 nav 重绑」的旧写法，复用路径不再重绑，文件夹会失去
//     折叠能力。整棵树被作废重建时旧节点连同监听一起被丢弃，由 GC 回收。

/** 复用路径下单个文件夹节点的增量更新上下文；children 只收文件夹，与渲染树同构。 */
type FolderRecord = {
  /** .folder-outer —— open 类的落点 */
  outer: HTMLElement
  /** 折叠键：真实目录取 slug，合成分组层取 synthetic:… 稳定键（与 folderStateKey 同源） */
  path: string
  /** 渲染树深度（根的直接子为 1），defaultCollapsed 的入参 */
  depth: number
  /** 真实目录的 simplifySlug(path)；合成分组层为 null（没有 slug 可比前缀） */
  simple: string | null
  children: FolderRecord[]
}

/** 复用路径下单条链接的增量更新上下文。 */
type LinkRecord = {
  a: HTMLAnchorElement
  /** resolveRelative 的 target 实参（文件 slug 或目录 folderPath），慢路径回落用 */
  target: FullSlug
  /**
   * href 去掉 pathToRoot 前缀后的尾段，满足 href === pathToRoot(currentSlug) + tail。
   * 成立性来自 resolveRelative 的构造：joinSegments(root, simple) 恒以 root 开头，
   * 其后的部分只由 target 决定、与 root 无关。建树时逐条以 startsWith 实测校验，
   * 一旦有一条不成立即整棵树落 tailSafe=false，改走 resolveRelative 慢路径。
   */
  tail: string
}

/** 一棵已建好并缓存的目录树。 */
type ExplorerTree = {
  /** 顶层 li（不含 OverflowList 的 .overflow-end 占位） */
  roots: HTMLLIElement[]
  /** 前序遍历的全部文件夹记录，与 collectFolderStates 同序同内容 */
  flatFolders: FolderRecord[]
  /** 渲染树顶层的文件夹记录，增量更新的递归入口 */
  rootFolders: FolderRecord[]
  links: LinkRecord[]
  /** 全部 tail 均由 href 切片得出且可复原；false 时 href 走 resolveRelative 慢路径 */
  tailSafe: boolean
  /** slug → 该 slug 命中当前页时须打 .active 的元素（文件 <a> 与真实目录的 .folder-container） */
  activeBySlug: Map<string, HTMLElement[]>
  /** 上一次生效的 .active 元素 */
  active: HTMLElement[]
  /** 上一次的 pathToRoot(currentSlug)；与本次相同则全树 href 一个字都不用改 */
  root: string
  /** 合成分组层的外层 li：法域过滤只写这些 li 的 hidden，复用前须复位 */
  syntheticLis: HTMLLIElement[]
  /** 建树时的 opts 指纹，与本次不符即整树作废重建 */
  signature: string
  items: number
  folders: number
}

/**
 * 按 document.querySelectorAll("div.explorer") 的文档序索引缓存。本库两套布局
 * （defaultContentPageLayout / defaultListPageLayout）各只含一个 Explorer，实际恒为 1 条；
 * 数组形态是为了在多实例布局下各实例互不串用，索引不对齐时由 signature 兜底作废。
 */
let explorerTrees: Array<ExplorerTree | undefined> = []

/**
 * 每个 `.explorer` 实例本次导航的上下文（阶段5.8）。头部的「一键收起 / 恢复默认排序」
 * 两枚钮用具名回调绑定（同一函数引用天然去重，见 bindExplorerHeaderActions），
 * 回调里拿不到 setupExplorer 的局部变量，改由被点的钮 closest('.explorer') 反查本表。
 *
 * 与 explorerTrees 同索引，但**taxonomy 缺席时也登记**：那种情况下目录树回落平铺、
 * 本次建出的树刻意不进 explorerTrees 缓存（见其赋值处注释），若上下文也跟着缺席，
 * 一键收起就会在回落形态下整个失灵。此处存的是本次真实生效的那棵树的引用。
 */
type ExplorerContext = {
  explorer: HTMLElement
  ul: HTMLElement
  tree: ExplorerTree
  currentSlug: FullSlug
  opts: ParsedOptions
}
let explorerContexts: Array<ExplorerContext | undefined> = []

/**
 * 导航代次。setupExplorer 入口自增，await 恢复后若已被后一次导航接管即整体放弃本次
 * （快速连点两页的竞态防护）。放弃是安全的：接管方自己会把目录树挂回并按其落地页更新。
 */
let explorerNavGeneration = 0

/** 建树规模计数（埋点用）：每次全量重建前由 setupExplorer 归零。 */
let builtItems = 0
let builtFolders = 0

function pushActiveTarget(tree: ExplorerTree, slug: string, el: HTMLElement) {
  const existing = tree.activeBySlug.get(slug)
  if (existing) {
    existing.push(el)
  } else {
    tree.activeBySlug.set(slug, [el])
  }
}

/** 登记一条链接并切出与 root 无关的尾段（切不出即整树降级到慢路径）。 */
function registerLink(
  tree: ExplorerTree,
  a: HTMLAnchorElement,
  target: FullSlug,
  href: string,
  root: string,
) {
  if (!href.startsWith(root)) {
    tree.tailSafe = false
  }
  tree.links.push({ a, target, tail: href.slice(root.length) })
}

/**
 * 摘下全部缓存树。挂在 prenav：此时 spa.inline.ts 尚未执行 cleanup、也尚未 micromorph
 * 形变 body，正是把整棵树从 diff 面里拿走的窗口。摘下的是顶层 li（本库 3 个），O(1) 量级。
 */
function detachExplorerTrees() {
  for (const tree of explorerTrees) {
    if (!tree) continue
    for (const li of tree.roots) {
      li.remove()
    }
  }
}

// ==== patent-kb: 同级拖拽重排（阶段5.8）====
// 只在 data-orderable 行上生效（合成分组层的三层子项）。被拖行留在原位只淡化，
// 落点用伪元素指示线表示；指针抬起才做**一次** insertBefore，并从 DOM 反读
// 整段子键序写表（所见即所存）。取消（Esc / pointercancel / 窗口失焦 / 标签页隐藏 /
// SPA 导航）一律不动 DOM、不落盘。

/** 进入拖拽态的位移阈值：不到它就按「点了一下手柄」处理，零副作用 */
const DRAG_ENGAGE_THRESHOLD = 4
/** 贴滚动器上/下缘多少像素内启动自动滚动 */
const DRAG_AUTOSCROLL_EDGE = 28
const DRAG_AUTOSCROLL_MIN = 2
const DRAG_AUTOSCROLL_MAX = 14

type DragCandidate = {
  li: HTMLLIElement
  /**
   * 该行 **.folder-container 矩形**的垂直中点，换算到滚动器内容坐标系。
   * 严禁用 li 矩形：展开的书 li 高达数千像素，其中点落在书的正文条目堆里，
   * 命中判定会整段错位。
   */
  mid: number
}

type ExplorerDragState = {
  handle: HTMLElement
  container: HTMLElement
  li: HTMLLIElement
  parentUl: HTMLElement
  /** 落表用的父键，直接取自 data-orderable */
  parentKey: string
  scroller: HTMLElement
  /** pointerdown 时滚动器视口顶缘（clientY → 内容坐标的换算基准） */
  scrollerTop: number
  pointerId: number
  startX: number
  startY: number
  /** 位移是否已越过阈值。false 时抬指等同「什么都没发生」 */
  engaged: boolean
  /** 自身在同级完整列表（含自身）中的下标 */
  selfIndex: number
  /** 除自身外的同级行；顺序即 DOM 序 */
  others: DragCandidate[]
  /** 当前落点：移除自身后的插入下标，取值域 [0, others.length] */
  targetIndex: number
  /** 当前打着指示线类的行容器 */
  marked: HTMLElement | null
  clientY: number
  rafId: number | null
  autoScrollStep: number
}

let explorerDrag: ExplorerDragState | null = null

/** 取一行的可测量容器：可重排行恒有 .folder-container，回落到 li 只是防御。 */
function dragRowOf(li: HTMLElement): HTMLElement {
  return li.querySelector<HTMLElement>(":scope > .folder-container") ?? li
}

/**
 * 从 DOM 反读一个父 ul 的完整子键序（WYSIWYG）。整段写入而非增量补丁：
 * 语料增删改名后表里的陈旧键会在下一次拖拽时被自然冲掉，无需另做清理。
 */
function readChildKeys(parentUl: HTMLElement): string[] {
  const keys: string[] = []
  for (const child of Array.from(parentUl.children)) {
    if (child.tagName !== "LI" || child.classList.contains("overflow-end")) {
      continue
    }
    const container = child.querySelector<HTMLElement>(":scope > .folder-container")
    const key =
      container?.dataset.folderpath ??
      child.querySelector<HTMLAnchorElement>(":scope > a[data-for]")?.dataset.for
    if (key) {
      keys.push(key)
    }
  }
  return keys
}

/**
 * 手柄挂载。**监听在建树时绑一次且绝不 window.addCleanup**——纪律同折叠钮
 * （见 setupExplorer 里 folderButtons 的说明）：手柄随缓存树跨导航存活，
 * 若逐 nav 摘除，复用路径不再重绑，首次软导航后全站手柄哑火，而只测重建路径的
 * 用例会照常全绿（冒烟步 34-d 的软导航往返正是为抓这一类而设）。
 */
function attachDragHandle(container: HTMLElement) {
  const template = document.getElementById("template-drag-handle") as HTMLTemplateElement | null
  if (!template) {
    return
  }
  const clone = template.content.cloneNode(true) as DocumentFragment
  const handle = clone.querySelector<HTMLElement>(".explorer-drag-handle")
  if (!handle) {
    return
  }
  handle.addEventListener("pointerdown", onDragHandlePointerDown)
  // 必须是 .folder-container 的最后一个子元素：container 与其兄弟 .folder-outer
  // 之间零插入，toggleFolder 的 nextElementSibling 取法不受影响
  container.appendChild(handle)
}

function onDragHandlePointerDown(this: HTMLElement, ev: PointerEvent) {
  if (ev.button !== 0) {
    return
  }
  // preventDefault 掐掉原生拖影与文本选择；stopPropagation 使这次按下不外泄到
  // 折叠钮与 spa 的 window 级委托
  ev.preventDefault()
  ev.stopPropagation()
  const container = this.closest<HTMLElement>(".folder-container")
  const parentKey = container?.dataset.orderable
  if (!container || !parentKey) {
    return
  }
  const li = container.closest("li")
  const parentUl = li?.parentElement
  const scroller = container.closest<HTMLElement>(".explorer-ul")
  if (!li || !parentUl || !scroller) {
    return
  }
  // 上一次拖拽若因异常未收尾，先抹干净再开新的
  cancelExplorerDrag()
  try {
    this.setPointerCapture(ev.pointerId)
  } catch {
    // 刻意偏离 pageChrome.inline.ts 的裸调：合成 PointerEvent 没有真实指针，
    // Chromium 会抛 InvalidPointerId。捕获失败无碍——move/up 都挂在 window 上，
    // 事件照样冒泡收得到（冒烟的单轨合成事件即依赖这一点）。
  }

  // 全部同级行的几何在此**一次性**缓存：拖拽期间 DOM 不动、行高不变，
  // 逐次 getBoundingClientRect 只会白白触发上百次强制布局。
  const scrollerTop = scroller.getBoundingClientRect().top
  const scrollTop = scroller.scrollTop
  const others: DragCandidate[] = []
  let selfIndex = 0
  let index = 0
  for (const child of Array.from(parentUl.children)) {
    if (child.tagName !== "LI" || child.classList.contains("overflow-end")) {
      continue
    }
    if (child === li) {
      selfIndex = index
    } else {
      const rect = dragRowOf(child as HTMLElement).getBoundingClientRect()
      others.push({
        li: child as HTMLLIElement,
        mid: rect.top + rect.height / 2 - scrollerTop + scrollTop,
      })
    }
    index += 1
  }

  explorerDrag = {
    handle: this,
    container,
    li: li as HTMLLIElement,
    parentUl,
    parentKey,
    scroller,
    scrollerTop,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    engaged: false,
    selfIndex,
    others,
    targetIndex: selfIndex,
    marked: null,
    clientY: ev.clientY,
    rafId: null,
    autoScrollStep: 0,
  }

  window.addEventListener("pointermove", onExplorerDragMove)
  window.addEventListener("pointerup", onExplorerDragUp)
  window.addEventListener("pointercancel", onExplorerDragAbort)
  window.addEventListener("keydown", onExplorerDragKey)
  window.addEventListener("blur", onExplorerDragAbort)
  document.addEventListener("visibilitychange", onExplorerDragVisibility)
}

function onExplorerDragMove(ev: PointerEvent) {
  const drag = explorerDrag
  if (!drag) {
    return
  }
  drag.clientY = ev.clientY
  if (!drag.engaged) {
    if (
      Math.abs(ev.clientY - drag.startY) < DRAG_ENGAGE_THRESHOLD &&
      Math.abs(ev.clientX - drag.startX) < DRAG_ENGAGE_THRESHOLD
    ) {
      return
    }
    drag.engaged = true
    drag.container.classList.add("is-dragging")
    // 全局禁选 + 抓取光标（custom.scss 第五节，照 pagescroll-drag 先例）
    document.documentElement.dataset.explorerDrag = "on"
  }
  updateDragTarget(drag)
  updateDragAutoScroll(drag)
}

/** 按当前指针位置重算落点与指示线。自动滚动每帧也调它（滚动会改变相对位置）。 */
function updateDragTarget(drag: ExplorerDragState) {
  const y = drag.clientY - drag.scrollerTop + drag.scroller.scrollTop
  let index = drag.others.length
  for (let i = 0; i < drag.others.length; i++) {
    if (y < drag.others[i].mid) {
      index = i
      break
    }
  }
  drag.targetIndex = index
  clearDropMarker(drag)
  if (drag.others.length === 0) {
    return
  }
  // 越界自然被钳到同级首/尾：index 恒落在 [0, others.length]
  if (index < drag.others.length) {
    const row = dragRowOf(drag.others[index].li)
    row.classList.add("is-drop-before")
    drag.marked = row
  } else {
    const row = dragRowOf(drag.others[drag.others.length - 1].li)
    row.classList.add("is-drop-after")
    drag.marked = row
  }
}

function clearDropMarker(drag: ExplorerDragState) {
  if (drag.marked) {
    drag.marked.classList.remove("is-drop-before", "is-drop-after")
    drag.marked = null
  }
}

/**
 * 贴边自动滚动：**只写 scrollTop**，绝不用 scrollIntoView
 * （后者会连带滚动整个文档，见目录自动定位一节的同款纪律）。
 * 速度随入侵深度线性放大，每帧滚完立即重算落点。
 */
function updateDragAutoScroll(drag: ExplorerDragState) {
  const rect = drag.scroller.getBoundingClientRect()
  const topDepth = rect.top + DRAG_AUTOSCROLL_EDGE - drag.clientY
  const bottomDepth = drag.clientY - (rect.bottom - DRAG_AUTOSCROLL_EDGE)
  let step = 0
  if (topDepth > 0) {
    step = -dragAutoScrollSpeed(topDepth)
  } else if (bottomDepth > 0) {
    step = dragAutoScrollSpeed(bottomDepth)
  }
  drag.autoScrollStep = step
  if (step === 0) {
    if (drag.rafId !== null) {
      cancelAnimationFrame(drag.rafId)
      drag.rafId = null
    }
    return
  }
  if (drag.rafId !== null) {
    return
  }
  const tick = () => {
    const current = explorerDrag
    if (!current || !current.engaged || current.autoScrollStep === 0) {
      return
    }
    current.scroller.scrollTop += current.autoScrollStep
    updateDragTarget(current)
    current.rafId = requestAnimationFrame(tick)
  }
  drag.rafId = requestAnimationFrame(tick)
}

function dragAutoScrollSpeed(depth: number): number {
  const ratio = Math.min(depth / DRAG_AUTOSCROLL_EDGE, 1)
  return DRAG_AUTOSCROLL_MIN + (DRAG_AUTOSCROLL_MAX - DRAG_AUTOSCROLL_MIN) * ratio
}

function onExplorerDragUp() {
  const drag = explorerDrag
  if (!drag) {
    return
  }
  // 没越过阈值，或落点就是原位：一律零写盘、零 DOM 变更
  if (!drag.engaged || drag.targetIndex === drag.selfIndex) {
    cancelExplorerDrag()
    return
  }

  // ① DOM 落定：单次 insertBefore（末位时插到 OverflowList 的占位之前）
  if (drag.targetIndex < drag.others.length) {
    drag.parentUl.insertBefore(drag.li, drag.others[drag.targetIndex].li)
  } else {
    drag.parentUl.insertBefore(
      drag.li,
      drag.parentUl.querySelector<HTMLElement>(":scope > li.overflow-end"),
    )
  }

  // ② 顶层守卫：**当前恒不触发**（顶层行不带 data-orderable，压根拖不动），
  //    留着是为将来若开放顶层重排时不至于漏掉——tree.roots 是 ExplorerTree 里
  //    唯一顺序有语义的字段（摘树/挂树都按它走），DOM 改了它必须同步。
  if (drag.parentUl.classList.contains("explorer-ul")) {
    syncRootOrderFromDom(drag.parentUl)
  }

  // ③ 落表：从 DOM 反读整段（所见即所存）
  writeOrderTable(withParentOrder(readOrderTable(), drag.parentKey, readChildKeys(drag.parentUl)))

  cancelExplorerDrag()
  refreshHeaderActionState()
  // 行序变化不改总高度，但滚动器可能因自动滚动停在新位置，顺手对齐一次轨道几何
  scheduleOverlayScrollbarSync()
}

function syncRootOrderFromDom(ul: HTMLElement) {
  const order = Array.from(ul.children).filter(
    (el): el is HTMLLIElement => el.tagName === "LI" && !el.classList.contains("overflow-end"),
  )
  for (const tree of explorerTrees) {
    if (tree && tree.roots.some((li) => order.includes(li))) {
      tree.roots = order
    }
  }
}

function onExplorerDragKey(ev: KeyboardEvent) {
  if (ev.key === "Escape") {
    cancelExplorerDrag()
  }
}

function onExplorerDragAbort() {
  cancelExplorerDrag()
}

function onExplorerDragVisibility() {
  if (document.visibilityState === "hidden") {
    cancelExplorerDrag()
  }
}

/**
 * 收尾：摘指示线与拖拽类、释放指针捕获、摘掉本次拖拽期的全部监听、停 rAF、
 * 清全局禁选标记。**不动 DOM、不落盘**——落定路径自己先把这两件事做完再调它。
 * Esc / pointercancel / 窗口失焦 / 标签页隐藏 / SPA 导航五路共用本函数。
 */
function cancelExplorerDrag() {
  const drag = explorerDrag
  if (!drag) {
    return
  }
  explorerDrag = null
  if (drag.rafId !== null) {
    cancelAnimationFrame(drag.rafId)
  }
  clearDropMarker(drag)
  drag.container.classList.remove("is-dragging")
  delete document.documentElement.dataset.explorerDrag
  try {
    drag.handle.releasePointerCapture(drag.pointerId)
  } catch {
    // 从未捕获成功（合成事件）或指针已消失：无须处理
  }
  window.removeEventListener("pointermove", onExplorerDragMove)
  window.removeEventListener("pointerup", onExplorerDragUp)
  window.removeEventListener("pointercancel", onExplorerDragAbort)
  window.removeEventListener("keydown", onExplorerDragKey)
  window.removeEventListener("blur", onExplorerDragAbort)
  document.removeEventListener("visibilitychange", onExplorerDragVisibility)
}
// ==== /patent-kb ====

function createFileNode(
  currentSlug: FullSlug,
  node: FileTrieNode,
  tree: ExplorerTree,
  root: string,
): HTMLLIElement {
  builtItems += 1
  const template = document.getElementById("template-file") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const a = li.querySelector("a") as HTMLAnchorElement
  const href = resolveRelative(currentSlug, node.slug)
  a.href = href
  a.dataset.for = node.slug
  a.textContent = node.displayName
  registerLink(tree, a, node.slug, href, root)
  pushActiveTarget(tree, node.slug, a)

  if (currentSlug === node.slug) {
    a.classList.add("active")
    tree.active.push(a)
  }

  return li
}

function createFolderNode(
  currentSlug: FullSlug,
  node: FileTrieNode,
  opts: ParsedOptions,
  depth: number,
  tree: ExplorerTree,
  root: string,
  siblings: FolderRecord[],
  /**
   * 父节点的折叠键（根级传 null）。阶段5.8 只用来判「本行是否开放同级重排」——
   * 判据是 isOrderableParentKey(parentKey)，即父键的 `synthetic:` 前缀。
   * **禁用深度魔数**：分组层一旦增删，深度就会整体漂移，前缀不会。
   */
  parentKey: string | null,
): HTMLLIElement {
  builtItems += 1
  builtFolders += 1
  const template = document.getElementById("template-folder") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const folderContainer = li.querySelector(".folder-container") as HTMLElement
  const titleContainer = folderContainer.querySelector("div") as HTMLElement
  const folderOuter = li.querySelector(".folder-outer") as HTMLElement
  const ul = folderOuter.querySelector("ul") as HTMLUListElement

  // patent-kb（C-3）：合成分组节点没有 slug，折叠键取 synthetic:… 稳定键
  const synthetic = syntheticNodes.get(node)
  const folderPath = synthetic ? synthetic.key : node.slug
  folderContainer.dataset.folderpath = folderPath

  // patent-kb（阶段5.8）：可重排行的标记。**一属性两职**——它的存在表示「本行可拖」
  // （CSS 据此常驻手柄槽位），它的取值就是落表用的父键，拖拽落定时无需再回溯 DOM 找父。
  // 手柄由 attachDragHandle 按需 clone（全库 1,395 个文件夹行里仅约 113 行可重排）。
  if (isOrderableParentKey(parentKey)) {
    folderContainer.dataset.orderable = parentKey as string
    attachDragHandle(folderContainer)
  }

  if (!synthetic) {
    pushActiveTarget(tree, folderPath, folderContainer)
    if (currentSlug === folderPath) {
      folderContainer.classList.add("active")
      tree.active.push(folderContainer)
    }
  } else {
    tree.syntheticLis.push(li)
  }

  if (synthetic) {
    // patent-kb（C-3）：合成节点无对应页面，绝不能渲染成 <a>（会指向不存在的路径）。
    // 保留模板原本的 button > span 形态，仅承担折叠切换，并打 synthetic 标记供样式区分。
    folderContainer.classList.add("synthetic")
    folderContainer.dataset.synthetic = "true"
    const span = titleContainer.querySelector(".folder-title") as HTMLElement
    span.classList.add("synthetic")
    span.textContent = node.displayName
  } else if (opts.folderClickBehavior === "link") {
    // Replace button with link for link behavior
    const button = titleContainer.querySelector(".folder-button") as HTMLElement
    const a = document.createElement("a")
    const href = resolveRelative(currentSlug, folderPath as FullSlug)
    a.href = href
    a.dataset.for = folderPath
    a.className = "folder-title"
    a.textContent = node.displayName
    registerLink(tree, a, folderPath as FullSlug, href, root)
    button.replaceWith(a)
  } else {
    const span = titleContainer.querySelector(".folder-title") as HTMLElement
    span.textContent = node.displayName
  }

  // 折叠判定优先级：localStorage 保存态（已并入 currentExplorerState）> openLevels 默认规则
  // patent-kb（DOM 复用）：原为 currentExplorerState.find 线性查找，1,383 个文件夹各查一遍
  // 即 O(N²)；改查同源的 Map（explorerStateIndex 与 currentExplorerState 由同一处同时构造，
  // 键唯一故取值逐条相同）。命中不到时的回落分支与原写法一字未动。
  const isCollapsed = explorerStateIndex.get(folderPath) ?? defaultCollapsed(depth, opts)

  // if this folder is a prefix of the current path we
  // want to open it anyways
  // patent-kb（C-3）：合成节点没有 slug 前缀可比，改用再父化时算好的 containsCurrent，
  // 否则当前页所在的书虽被强制展开，却仍关在折叠的归类层里看不见
  const simpleFolderPath = synthetic ? null : simplifySlug(folderPath as FullSlug)
  const folderIsPrefixOfCurrentSlug =
    simpleFolderPath === null
      ? synthetic!.containsCurrent
      : simpleFolderPath === currentSlug.slice(0, simpleFolderPath.length)

  if (!isCollapsed || folderIsPrefixOfCurrentSlug) {
    folderOuter.classList.add("open")
  }

  // patent-kb（DOM 复用）：记录本节点的增量更新上下文。push 顺序＝渲染树前序遍历，
  // 与 collectFolderStates 的产出逐条同序同值（两者都按 node.children 次序、只收文件夹、
  // 先记本节点再下潜），故复用路径可直接据此重建 currentExplorerState。
  const record: FolderRecord = {
    outer: folderOuter,
    path: folderPath,
    depth,
    simple: simpleFolderPath,
    children: [],
  }
  tree.flatFolders.push(record)
  siblings.push(record)

  for (const child of node.children) {
    const childNode = child.isFolder
      ? createFolderNode(
          currentSlug,
          child,
          opts,
          depth + 1,
          tree,
          root,
          record.children,
          folderPath,
        )
      : createFileNode(currentSlug, child, tree, root)
    ul.appendChild(childNode)
  }

  return li
}

/**
 * 复用路径的增量更新：把一棵已建好的目录树改到当前页的形态。三件套均为 O(V) 遍历、
 * 零 DOM 创建/销毁，且调用时整棵树处于**离体**状态（见文件上方 DOM 复用注释），
 * 因此展开态变化不会触发 .folder-outer 的 0.3s 过渡，与重建路径一样瞬时到位。
 *
 * @returns 本次是否重写了全部 href（埋点用）
 */
function updateExplorerTree(
  tree: ExplorerTree,
  currentSlug: FullSlug,
  root: string,
  savedState: Map<string, boolean>,
  opts: ParsedOptions,
): boolean {
  // ① 相对 href：只随 pathToRoot(currentSlug) 变化。同深度页面互跳（条文页→条文页
  //    占导航绝大多数）时 root 相同，整棵树的 href 原样正确，一次写入都不必做。
  const hrefRewritten = tree.root !== root
  if (hrefRewritten) {
    if (tree.tailSafe) {
      for (const link of tree.links) {
        link.a.href = root + link.tail
      }
    } else {
      // 兜底慢路径：建树时发现有 href 不以 root 开头（理论上不会发生，见 LinkRecord.tail
      // 的说明），此时逐条重算，结果与重建路径逐字相同，只是慢一些
      for (const link of tree.links) {
        link.a.href = resolveRelative(currentSlug, link.target)
      }
    }
    tree.root = root
  }

  // ② .active 高亮迁移。命中集取自建树时登记的 slug→元素表，与重建路径的
  //    `currentSlug === node.slug` / `currentSlug === folderPath` 两条判据同源。
  for (const el of tree.active) {
    el.classList.remove("active")
    // 文件条目的 <a> 出自 template-file，本无 class 属性；classList.remove 只清内容、
    // 不摘属性，留下的 `class=""` 会让 DOM 与重建路径出现字面差异（无视觉影响，但
    // 目录树 innerHTML 摘要对不上，等于放弃了「逐字节等价」这条最硬的回归判据）。
    if (el.className === "") {
      el.removeAttribute("class")
    }
  }
  const nextActive = tree.activeBySlug.get(currentSlug) ?? []
  for (const el of nextActive) {
    el.classList.add("active")
  }
  tree.active = nextActive

  // ③ 法域过滤残留复位。applyFieldBranchFilter 只写合成分支外层 li 的 hidden；
  //    重建路径下新树天然无 hidden，复用路径须显式抹平，否则离开图谱页后过滤会残留。
  for (const li of tree.syntheticLis) {
    li.hidden = false
  }

  // ④ 折叠态整树重算。逐节点重跑重建路径的同一公式
  //    （保存态 → defaultCollapsed(depth, opts) → 当前页祖先链强制展开），
  //    因此「上一页强制展开的祖先」会随之收回，与重建结果逐位一致。
  currentExplorerState = tree.flatFolders.map((rec) => {
    const saved = savedState.get(rec.path)
    return {
      path: rec.path,
      collapsed: saved === undefined ? defaultCollapsed(rec.depth, opts) : saved,
    }
  })
  explorerStateIndex = new Map(
    currentExplorerState.map((entry) => [entry.path, entry.collapsed] as const),
  )
  for (const rec of tree.rootFolders) {
    refreshFolderOpenState(rec, currentSlug, opts)
  }

  return hrefRewritten
}

/**
 * 递归重算单个文件夹的展开态，返回其 containsCurrent。
 * 真实目录的 containsCurrent 就是自身 slug 前缀命中（祖先链上每一级都各自命中，
 * 无需向下 OR）；合成分组层没有 slug，取子层的 OR——与 regroupByTaxonomy 里
 * 「命中的书把 country/field/docType 三级一起置真」的算法等价。
 */
function refreshFolderOpenState(
  rec: FolderRecord,
  currentSlug: FullSlug,
  opts: ParsedOptions,
): boolean {
  const own = rec.simple !== null && rec.simple === currentSlug.slice(0, rec.simple.length)
  let childContains = false
  for (const child of rec.children) {
    // 不可短路：每个子节点都必须被重算，OR 只影响合成层的取值
    if (refreshFolderOpenState(child, currentSlug, opts)) {
      childContains = true
    }
  }
  const containsCurrent = rec.simple === null ? childContains : own
  const collapsed = explorerStateIndex.get(rec.path) ?? defaultCollapsed(rec.depth, opts)
  const shouldOpen = !collapsed || containsCurrent
  if (rec.outer.classList.contains("open") !== shouldOpen) {
    rec.outer.classList.toggle("open", shouldOpen)
  }
  return containsCurrent
}

// ==== patent-kb: 目录自动定位（v6，替换上游死代码）====
// 上游缺陷：`if (scrollTop)` 对字符串 "0" 恒真，首次 prenav 写入后
// scrollIntoView 分支永不执行；且 scrollIntoView 未限定滚动容器，
// 会连带滚动整个文档。策略：①先恢复上次滚动位置（保留用户在长树中
// 的浏览位置）；②当前项已完整可见则不动（不与用户手动滚动打架）；
// ③不可见才把内层滚动器 scrollTop 置为居中值。
// 同步执行（getBoundingClientRect 强制布局），不用 rAF——后台标签页 /
// 最小化的 Electron 窗口中 rAF 被完全挂起，定位将永不执行。
// 若此刻容器尚不可滚（初载视口未布局 innerWidth=0，同上游 F5 复位注释
// 所述场景），挂起定位，待布局就绪的 resize 补执行。
// patent-kb（DOM 复用）：本段与下面的 bindExplorerToggles 由重建/复用两条路径共用，
// 从 setupExplorer 内联块原样提出，逻辑一字未动。
function restoreExplorerScroll(scroller: HTMLElement) {
  const saved = sessionStorage.getItem("explorerScrollTop")
  if (saved !== null) {
    scroller.scrollTop = parseInt(saved, 10) || 0
  }
  if (scroller.scrollHeight > scroller.clientHeight) {
    explorerLocatePending = false
    locateExplorerActive(scroller)
  } else {
    explorerLocatePending = true
  }

  // 滚动边缘渐隐（P7）：顶/底遮罩随滚动位置显隐（样式见 custom.scss）
  const edgeHost = scroller.closest(".explorer-content") as HTMLElement | null
  if (!edgeHost) {
    return
  }
  const edge = () => {
    edgeHost.toggleAttribute("data-edge-top", scroller.scrollTop > 2)
    edgeHost.toggleAttribute(
      "data-edge-bottom",
      // 与建轨判据、与 util/scrollEdge.ts 的 gradient-* 判据同口径扣除末尾空占位
      //（见 contentScrollHeight 的说明）：不扣则可视高度落在「真实内容高 + 占位高」
      // 窗口内会亮起底部渐隐，而下方并无被遮内容。容差 2 与 scrollEdge.ts 的
      // EDGE_TOLERANCE 同值，两处各自就地写死（该常量未导出），改一处须同步另一处。
      scroller.scrollTop + scroller.clientHeight < contentScrollHeight(scroller) - 2,
    )
  }
  scroller.addEventListener("scroll", edge, { passive: true })
  window.addCleanup(() => scroller.removeEventListener("scroll", edge))
  edge()
}
// ==== /patent-kb ====

/**
 * 根级折叠钮（汉堡 / 标题钮）的监听。这两枚钮属 SSR 骨架、不在缓存树内，
 * 每次 nav 都可能被 micromorph 换过，故沿用「逐 nav 绑定 + addCleanup 摘除」的原写法。
 */
function bindExplorerToggles(explorer: HTMLElement) {
  const explorerButtons = explorer.getElementsByClassName(
    "explorer-toggle",
  ) as HTMLCollectionOf<HTMLElement>
  for (const button of explorerButtons) {
    button.addEventListener("click", toggleExplorer)
    window.addCleanup(() => button.removeEventListener("click", toggleExplorer))
  }
}

// ==== patent-kb: 头部动作组（阶段5.8）====

/** 「恢复默认排序」两段式确认的回退时限 */
const RESET_CONFIRM_TIMEOUT = 4000
let resetConfirmTimer: number | undefined

/**
 * 两枚动作钮的监听绑定。**必须逐 nav 绑定并登记 addCleanup**——与手柄和折叠钮
 * 相反：它们属 SSR 骨架，每次导航都可能被 micromorph 换成新节点，绑在旧节点上
 * 的监听随之作废。复用路径与重建路径两处都要调，漏一处则该路径上的钮全哑。
 *
 * 回调一律用**具名模块函数**（不捕获局部上下文）：同一函数引用重复
 * addEventListener 由浏览器天然去重，故「恢复默认」触发的就地重建即便在同一个
 * nav 周期内二次绑定，也不会造成一次点击跑两遍。上下文改由 explorerContextOf
 * 从被点的钮反查。
 */
function bindExplorerHeaderActions(explorer: HTMLElement) {
  const collapseBtn = explorer.querySelector<HTMLButtonElement>(".explorer-action-collapse")
  if (collapseBtn) {
    // SSR 渲染成 disabled，此处放开——「脚本活着」是这两枚钮可用的前提
    collapseBtn.disabled = false
    collapseBtn.addEventListener("click", onCollapseAllClick)
    window.addCleanup(() => collapseBtn.removeEventListener("click", onCollapseAllClick))
  }
  const resetBtn = explorer.querySelector<HTMLButtonElement>(".explorer-action-reset")
  if (resetBtn) {
    resetBtn.disabled = false
    resetBtn.addEventListener("click", onResetOrderClick)
    window.addCleanup(() => resetBtn.removeEventListener("click", onResetOrderClick))
  }
}

function explorerContextOf(el: HTMLElement): ExplorerContext | undefined {
  const explorer = el.closest<HTMLElement>("div.explorer")
  if (!explorer) {
    return undefined
  }
  for (const ctx of explorerContexts) {
    if (ctx && ctx.explorer === explorer) {
      return ctx
    }
  }
  return undefined
}

function onCollapseAllClick(this: HTMLButtonElement, ev: MouseEvent) {
  ev.stopPropagation()
  const ctx = explorerContextOf(this)
  if (!ctx) {
    return
  }
  collapseAllFolders(ctx)
}

/**
 * 一键收起。**绝不自动执行**——只有用户点这枚钮才会发生（图谱页首访仍按
 * 「书下 3 层可见」铺开，冒烟步 29 的 open ≥1000 是这条纪律的常设护栏）。
 *
 * 做法是「全部置 collapsed=true，再用既有公式 refreshFolderOpenState 重算
 * （shouldOpen = !collapsed || containsCurrent）」，净效果＝除当前页祖先链外
 * 全部收起。刻意不选另两种：
 *   · 回落 openLevels 默认态——图谱页的默认展开深度是 6，几乎等于什么都没收；
 *   · 连祖先链一起强收——下次导航时祖先链会被重新强制展开，弹回来像个鬼影。
 *
 * 作用域是当前 activeStorageKey 对应的那棵状态（图谱页与文档站的双键隔离保持）。
 */
function collapseAllFolders(ctx: ExplorerContext) {
  // ① 折叠态整表重造 + ② 索引重建（两者恒等价，见 explorerStateIndex 的说明）
  currentExplorerState = ctx.tree.flatFolders.map((rec) => ({ path: rec.path, collapsed: true }))
  explorerStateIndex = new Map(currentExplorerState.map((entry) => [entry.path, true] as const))
  // ③ 逐根重算展开态。**在体执行**，故 .folder-outer 的 0.3s 过渡会正常播放，
  //    动画落定后的精确几何由滚动器上既有的 transitionend 监听补齐
  for (const rec of ctx.tree.rootFolders) {
    refreshFolderOpenState(rec, ctx.currentSlug, ctx.opts)
  }
  // ④ 落盘（键取 activeStorageKey：图谱页落 fileTree-graph，其余落 fileTree-v2）
  try {
    localStorage.setItem(activeStorageKey, JSON.stringify(currentExplorerState))
  } catch {
    // 折叠态丢失无妨，绝不因此抛出打断后续
  }
  scheduleOverlayScrollbarSync()
  refreshHeaderActionState()
}

/**
 * 「恢复默认排序」的两段式内联确认：首点进入确认态（显出「确认恢复？」），
 * 4s 内再点才真的执行，超时自动回退。全仓零 window.confirm，也不引模态。
 */
function onResetOrderClick(this: HTMLButtonElement, ev: MouseEvent) {
  ev.stopPropagation()
  const button = this
  if (resetConfirmTimer !== undefined) {
    window.clearTimeout(resetConfirmTimer)
    resetConfirmTimer = undefined
  }
  if (button.dataset.confirm !== "on") {
    button.dataset.confirm = "on"
    resetConfirmTimer = window.setTimeout(() => {
      delete button.dataset.confirm
      resetConfirmTimer = undefined
    }, RESET_CONFIRM_TIMEOUT)
    return
  }
  delete button.dataset.confirm
  const ctx = explorerContextOf(button)
  if (!ctx) {
    return
  }
  void rebuildExplorerInPlace(ctx)
}

/**
 * 就地重建目录树（「恢复默认排序」的执行体）。选重建而非「按默认序就地反排」：
 * 默认序的四个输入（contentIndex / 排序 / 过滤 / 再父化）全是静态纯函数，
 * 重建必然逐位复现默认形态，不存在任何影子副本漂移；代价约 124ms 的同步段，
 * 一次性操作可接受。
 *
 * 步骤次序是铁律：
 *   ① 先 removeItem——即便后续任一步抛错，下次导航也必然回到默认序；
 *   ② 再作废内存缓存；
 *   ③ **先摘旧树再清 explorerTrees**：setupExplorer 的 insertBefore 不会清理
 *      ul 里已有的子节点，少摘一步就是新旧两棵树叠在同一个列表里；
 *   ④ 最后还原滚动位置（重建路径内部的 restoreExplorerScroll 会先按会话记录定位）。
 *
 * **只删顺序表，折叠习惯毫发无损**：fileTree-v2 / fileTree-graph 一个字都不动。
 */
async function rebuildExplorerInPlace(ctx: ExplorerContext) {
  cancelExplorerDrag()
  const scrollTop = ctx.ul.scrollTop
  try {
    localStorage.removeItem(EXPLORER_ORDER_STORAGE_KEY)
  } catch {
    // 隐私模式等：内存缓存置空同样能让本次重建回到默认序
  }
  orderTableCache = null
  detachExplorerTrees()
  explorerTrees = []
  explorerContexts = []
  await setupExplorer(ctx.currentSlug)
  const ul = ctx.explorer.querySelector<HTMLElement>(".explorer-ul")
  if (ul) {
    ul.scrollTop = scrollTop
  }
}

/**
 * 两枚动作钮的状态刷新。凡是可能改变「是否全部折叠」或「是否存在自定义序」的
 * 动作之后都要调一次：重建路径末、复用路径末、toggleFolder 末、一键收起末、
 * 拖拽落定后、恢复默认后。
 *
 * 不接受上下文参数：toggleFolder 是模块级事件回调，拿不到 setupExplorer 的局部量；
 * 而「全部折叠」的判据本就取模块级的 currentExplorerState，与作用域无关。
 * 钮缺席（SSR 骨架尚未换上或旧版本页面）时整体空转。
 */
function refreshHeaderActionState() {
  const state = currentExplorerState ?? []
  const allCollapsed = state.length > 0 && state.every((entry) => entry.collapsed)
  const custom = hasCustomOrder(readOrderTable())
  for (const explorer of document.querySelectorAll<HTMLElement>("div.explorer")) {
    const collapseBtn = explorer.querySelector<HTMLButtonElement>(".explorer-action-collapse")
    if (collapseBtn) {
      collapseBtn.disabled = allCollapsed
      collapseBtn.setAttribute("aria-disabled", String(allCollapsed))
    }
    const resetBtn = explorer.querySelector<HTMLButtonElement>(".explorer-action-reset")
    if (resetBtn) {
      resetBtn.disabled = !custom
      resetBtn.setAttribute("aria-disabled", String(!custom))
      // 显隐由 CSS 的 [data-has-custom-order] 承担（display 控制）。刻意不用 hidden
      // 属性：目录树里的 hidden 是法域过滤的专用信号，冒烟按它做不变式断言。
      resetBtn.toggleAttribute("data-has-custom-order", custom)
      if (!custom) {
        // 表已空（刚恢复过默认）：两段确认的中间态一并复位，免得下次点开就是「确认」
        delete resetBtn.dataset.confirm
      }
    }
  }
}
// ==== /patent-kb ====

async function setupExplorer(currentSlug: FullSlug) {
  const perfStart = performance.now()
  let perfSyncStart = perfStart
  let mode: ExplorerPerfMark["mode"] = "build"
  let items = 0
  let folders = 0
  let hrefRewritten = true
  let explorerIndex = 0
  const generation = ++explorerNavGeneration
  builtItems = 0
  builtFolders = 0
  const allExplorers = document.querySelectorAll("div.explorer") as NodeListOf<HTMLElement>

  // ==== patent-kb: 图谱页独立折叠态（阶段5.4 批 D1）====
  // 每次按当前页刷新存储键与展开深度上限：图谱页用独立键 fileTree-graph ＋
  // 「depth ≤6 默认展开」（书下 3 层可见）；其余页维持 fileTree-v2 ＋ openLevels
  // 原逻辑。activeStorageKey 为模块级变量，toggleFolder 等事件回调经它取当前键，
  // SPA 换页后随本函数同步刷新，语义见其声明处注释。
  const onGraph = onGraphOverviewPage()
  activeStorageKey = onGraph ? GRAPH_FOLDER_STATE_STORAGE_KEY : FOLDER_STATE_STORAGE_KEY
  // ==== /patent-kb ====

  // ==== patent-kb（DOM 复用）：让位一个微任务，保住 nav 监听器之间的既有先后 ====
  // OverflowList 的 createScrollEdgeScript 也监听 nav，且注册在本脚本之后
  //（Explorer.afterDOMLoaded = concatenateResources(script, overflowListAfterDOMLoaded)），
  // 它按当时的 ul 尺寸翻 gradient-top-active / gradient-active——后者会给列表加上
  // base.scss:609 那条 50px 的 mask-image 底部渐隐。现状是：本脚本的重建路径在
  // `await Promise.all([fetchData, …])` 处让出，该监听器恒在**空 ul** 上求值，
  // 故 gradient-* 从来不会亮（实测 maskImage 恒为 none，目录树的边缘渐隐由
  // custom.scss 的 .explorer-content[data-edge-*] 覆盖层单独承担）。
  // 复用路径本可全同步跑完，那会让该监听器第一次看见满树并点亮 mask 遮罩——
  // 与现状不符的新视觉。让位一个微任务即可精确保住原有顺序：微任务在当前任务末尾、
  // 渲染之前执行，目录树仍在同一帧内挂出，出现时序不延后。
  // 竞态放弃：取数/让位期间已被后一次导航接管，本次整体作罢——接管方会自行把树挂回
  // 并按其落地页更新，此处继续走下去只会往同一个 .explorer-ul 里插一棵旧页的树。
  const bailAsStale = () => {
    const now = performance.now()
    recordExplorerPerf({
      slug: currentSlug,
      mode: "stale",
      start: perfStart,
      end: now,
      total: now - perfStart,
      sync: 0,
      items: 0,
      folders: 0,
      hrefRewritten: false,
    })
  }

  await Promise.resolve()
  if (generation !== explorerNavGeneration) {
    bailAsStale()
    return
  }
  perfSyncStart = performance.now()
  // ==== /patent-kb ====

  for (const explorer of allExplorers) {
    const dataFns = JSON.parse(explorer.dataset.dataFns || "{}")
    const opts: ParsedOptions = {
      folderClickBehavior: (explorer.dataset.behavior || "collapse") as "collapse" | "link",
      folderDefaultState: (explorer.dataset.collapsed || "collapsed") as "collapsed" | "open",
      useSavedState: explorer.dataset.savestate === "true",
      openLevels: parseInt(explorer.dataset.openLevels ?? "0", 10) || 0,
      // 阶段5.4 批 D1：图谱页默认展开到渲染树第 6 层（书下 3 层可见），其余页不设
      graphExpandToDepth: onGraph ? GRAPH_EXPAND_TO_DEPTH : undefined,
      order: dataFns.order || ["filter", "map", "sort"],
      // ==== patent-kb: 见文件末尾 sortNodes / keepNode 的说明 ====
      sortFn: sortNodes,
      filterFn: keepNode,
      mapFn: () => {},
      // ==== /patent-kb ====
    }

    // Get folder state from local storage
    // ==== patent-kb: 被污染的 localStorage 不得让整棵目录树消失 ====
    // 原为裸 JSON.parse，抛出即中断 setupExplorer，左侧目录整体不渲染。
    // 阶段5.4 批 D1：读键改取 activeStorageKey——图谱页读 fileTree-graph
    //（首访无键时全按「depth ≤6 默认展开」规则渲染），其余页仍读 fileTree-v2。
    const storageTree = localStorage.getItem(activeStorageKey)
    let serializedExplorerState: FolderState[] = []
    if (storageTree && opts.useSavedState) {
      try {
        const parsed = JSON.parse(storageTree)
        if (Array.isArray(parsed)) serializedExplorerState = parsed
      } catch {
        // 解析失败按「无保存状态」处理，目录树仍以默认展开态正常渲染
      }
    }
    // ==== /patent-kb ====
    const oldIndex = new Map<string, boolean>(
      serializedExplorerState.map((entry: FolderState) => [entry.path, entry.collapsed]),
    )

    const root = pathToRoot(currentSlug)
    // 缓存有效性指纹：只收会改变**树结构**的选项。folderClickBehavior 决定目录标题渲染
    // 成 <a> 还是 <button>；order 决定 filter/map/sort 的施加次序。其余选项
    //（folderDefaultState / useSavedState / openLevels / graphExpandToDepth）只影响展开态，
    // 而展开态本就逐导航整树重算，故不入指纹——图谱页与文档站共用同一棵缓存树。
    // 用 JSON.stringify 而非 join：ParsedOptions.order 的上游类型写作
    // `"sort" | "filter" | "map"[]`（联合而非数组），拿不到 join
    const signature = `${opts.folderClickBehavior}|${JSON.stringify(opts.order)}`
    const cached = explorerTrees[explorerIndex]
    explorerIndex += 1

    if (cached && cached.signature === signature) {
      // ---- 复用路径：全程同步，无取数、无建树、无 DOM 创建 ----
      const explorerUl = explorer.querySelector(".explorer-ul")
      if (!explorerUl) continue
      // 显式摘树：prenav 已摘过，此处是幂等兜底，同时保证增量更新在离体状态下进行
      //（离体元素不参与样式解析 ⇒ .folder-outer 的 0.3s 过渡不会被触发）
      for (const li of cached.roots) {
        li.remove()
      }
      hrefRewritten = updateExplorerTree(cached, currentSlug, root, oldIndex, opts)
      const reuseFragment = document.createDocumentFragment()
      for (const li of cached.roots) {
        reuseFragment.appendChild(li)
      }
      explorerUl.insertBefore(reuseFragment, explorerUl.firstChild)
      mode = "reuse"
      items = cached.items
      folders = cached.folders
      explorerContexts[explorerIndex - 1] = {
        explorer,
        ul: explorerUl as HTMLElement,
        tree: cached,
        currentSlug,
        opts,
      }
      restoreExplorerScroll(explorerUl as HTMLElement)
      bindExplorerToggles(explorer)
      bindExplorerHeaderActions(explorer)
      bindGraphLinkage(explorer)
      continue
    }

    // ---- 重建路径：首次导航，或缓存因指纹不符/分组表缺席而作废 ----
    // patent-kb（C-3）：分组表与 contentIndex 并发取，避免串行等待拖慢首屏目录渲染
    const [data, taxonomy] = await Promise.all([fetchData, fetchTaxonomy(currentSlug)])
    if (generation !== explorerNavGeneration) {
      bailAsStale()
      return
    }
    perfSyncStart = performance.now()
    const entries = [...Object.entries(data)] as [FullSlug, ContentDetails][]
    const trie = FileTrieNode.fromEntries(entries)

    // Apply functions in order
    for (const fn of opts.order) {
      switch (fn) {
        case "filter":
          if (opts.filterFn) trie.filter(opts.filterFn)
          break
        case "map":
          if (opts.mapFn) trie.map(opts.mapFn)
          break
        case "sort":
          if (opts.sortFn) trie.sort(opts.sortFn)
          break
      }
    }

    // patent-kb（C-3）：排序完成后再父化出「中国 → 权利类型 → 文件归类」三层合成分组；
    // taxonomy 缺失或无书命中时静默跳过，目录树保持现状平铺
    if (taxonomy) {
      regroupByTaxonomy(trie, taxonomy, currentSlug)
    }

    // patent-kb（阶段5.8）：施加用户自定义的同级次序。**位置铁律**——必须在
    // regroupByTaxonomy 之后（此前没有合成层，无处可施加）、collectFolderStates
    // 之前（折叠态表与建树共用同一次前序遍历的次序，见 createFolderNode 里
    // 「push 顺序＝渲染树前序遍历」的不变式）。无表或无合成层时整体空转。
    applyCustomOrder(trie, readOrderTable())

    // Get folder paths for state management
    // 初始态优先级（F5）：有保存态用保存态；无保存态按 openLevels 规则
    // patent-kb（C-3）：路径与深度均取自渲染树（含合成节点的 synthetic: 稳定键）
    currentExplorerState = collectFolderStates(trie).map(({ path, depth }) => {
      const previousState = oldIndex.get(path)
      return {
        path,
        collapsed: previousState === undefined ? defaultCollapsed(depth, opts) : previousState,
      }
    })
    explorerStateIndex = new Map(
      currentExplorerState.map((entry) => [entry.path, entry.collapsed] as const),
    )

    const explorerUl = explorer.querySelector(".explorer-ul")
    if (!explorerUl) continue

    // Create and insert new content
    const tree: ExplorerTree = {
      roots: [],
      flatFolders: [],
      rootFolders: [],
      links: [],
      tailSafe: true,
      activeBySlug: new Map(),
      active: [],
      root,
      syntheticLis: [],
      signature,
      items: 0,
      folders: 0,
    }
    const fragment = document.createDocumentFragment()
    for (const child of trie.children) {
      const node = child.isFolder
        ? createFolderNode(currentSlug, child, opts, 1, tree, root, tree.rootFolders, null)
        : createFileNode(currentSlug, child, tree, root)

      tree.roots.push(node)
      fragment.appendChild(node)
    }
    explorerUl.insertBefore(fragment, explorerUl.firstChild)
    tree.items = builtItems
    tree.folders = builtFolders
    items = builtItems
    folders = builtFolders
    // 只在分组表就位时缓存：taxonomy 取不到时目录树回落平铺，此时缓存会把这个降级形态
    // 冻结整个 SPA 生命周期，与 fetchTaxonomy「失败留待下次 nav 重试」的既有语义相悖。
    explorerTrees[explorerIndex - 1] = taxonomy ? tree : undefined
    // patent-kb（阶段5.8）：上下文按本次真实生效的树登记——taxonomy 缺席使上一行
    // 刻意不缓存该树，但它此刻确实挂在 DOM 上，一键收起必须仍能作用于它
    explorerContexts[explorerIndex - 1] = {
      explorer,
      ul: explorerUl as HTMLElement,
      tree,
      currentSlug,
      opts,
    }

    restoreExplorerScroll(explorerUl as HTMLElement)
    bindExplorerToggles(explorer)
    bindExplorerHeaderActions(explorer)

    // Set up folder click handlers
    // patent-kb（C-3）：原本仅在 "collapse" 行为下绑定。"link" 行为下真实目录的标题
    // 已被换成 <a>，留在 DOM 里的 .folder-button 只可能是合成分组节点——它们没有可跳转
    // 的页面，标题点击必须回落为折叠切换，否则整行只有那枚 12px 的箭头能点。
    // 两种行为下均绑定，无重复绑定风险（同一按钮在任一行为下只被这一处遍历到）。
    // patent-kb（DOM 复用）：**只在建树时绑一次，且不登记 window.addCleanup**。
    // 这些钮所在的节点跨导航存活，若沿用「每次 nav 摘除、每次 nav 重绑」的旧写法，
    // 复用路径不再重绑，文件夹会彻底失去折叠能力。整棵树被作废重建时旧节点连同其上的
    // 监听一起失去引用，由 GC 回收，不构成泄漏。
    const folderButtons = explorer.getElementsByClassName(
      "folder-button",
    ) as HTMLCollectionOf<HTMLElement>
    for (const button of folderButtons) {
      button.addEventListener("click", toggleFolder)
    }

    const folderIcons = explorer.getElementsByClassName(
      "folder-icon",
    ) as HTMLCollectionOf<HTMLElement>
    for (const icon of folderIcons) {
      icon.addEventListener("click", toggleFolder)
    }

    // patent-kb（B4）：图谱总览页的目录联动（点条目→图内定位 / 法域标签→分支过滤）。
    // 内部自带页面门控，非图谱页整体空转，不绑定任何监听器
    bindGraphLinkage(explorer)
  }

  // patent-kb（阶段5.8）：两条路径共用的收尾刷新点——「一键收起」置灰随折叠态、
  // 「恢复默认排序」显隐随顺序表。放在循环之外，复用路径的 continue 也覆盖得到。
  refreshHeaderActionState()

  const perfEnd = performance.now()
  recordExplorerPerf({
    slug: currentSlug,
    mode,
    start: perfStart,
    end: perfEnd,
    total: perfEnd - perfStart,
    sync: perfEnd - perfSyncStart,
    items,
    folders,
    hrefRewritten,
  })
}

document.addEventListener("prenav", async () => {
  // patent-kb（阶段5.8）：拖拽途中发生导航一律**取消**（不落定、不写表），
  // 且必须排在 detachExplorerTrees 之前——树一旦离体，被拖行连同同级都脱离文档，
  // 此时再做 insertBefore 只会把次序写进一棵没人看的离体树。
  // 刻意不做「拖拽中禁止导航」：导航来自用户的其他操作，不该被侧栏交互卡住。
  cancelExplorerDrag()
  // save explorer scrollTop position
  const explorer = document.querySelector(".explorer-ul")
  if (explorer) {
    sessionStorage.setItem("explorerScrollTop", explorer.scrollTop.toString())
  }
  // patent-kb（DOM 复用）：在 spa.inline.ts 执行 cleanup 与 micromorph 之前把整棵树摘下。
  // 摘的是顶层 li（本库 3 个），O(1) 量级；换来的是 micromorph 不必再逐个删除 7,400 个
  // 「新页没有的多余节点」，同时这些节点连同其上的折叠监听原样存活，下次 nav 直接挂回。
  detachExplorerTrees()
})

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const currentSlug = e.detail.url
  await setupExplorer(currentSlug)
  bindOverlayScrollbars()

  // if mobile hamburger is visible, collapse by default
  for (const explorer of document.getElementsByClassName(
    "explorer",
  ) as HTMLCollectionOf<HTMLElement>) {
    const mobileExplorer = explorer.querySelector(".mobile-explorer")
    if (!mobileExplorer) return

    if (mobileExplorer.checkVisibility()) {
      // 记下"自动折叠"标记：Electron/预览壳首次 nav 时窗口可能尚未布局
      //（innerWidth=0，$mobile 误判成立）——布局就绪或 resize 后经
      // expandDesktopExplorers 复位，用户手动折叠（toggleExplorer）不受影响
      explorer.classList.add("collapsed")
      explorer.dataset.autoCollapsed = "true"
      explorer.setAttribute("aria-expanded", "false")

      // Allow <html> to be scrollable when mobile explorer is collapsed
      document.documentElement.classList.remove("mobile-no-scroll")
    } else {
      // 桌面端（汉堡钮不可见，F5/根级折叠核查）：根级强制展开——
      // 清掉任何残留的 collapsed class（.explorer.collapsed 会把左栏压成 1.2rem 空条），
      // 并把 aria-expanded 归位 true；根级折叠态不落 localStorage，本分支不影响移动端行为
      explorer.classList.remove("collapsed")
      delete explorer.dataset.autoCollapsed
      explorer.setAttribute("aria-expanded", "true")
    }

    mobileExplorer.classList.remove("hide-until-loaded")
  }

  // 兜底再核一帧：首次 nav 若发生在窗口布局完成之前（视口宽度 0 被误判为移动端），
  // 布局就绪后立即把自动折叠的根级复位为展开
  requestAnimationFrame(expandDesktopExplorers)
})

/**
 * 桌面端根级复位（F5/根级折叠核查）：汉堡钮不可见（桌面宽度）且根级 collapsed
 * 是"自动折叠"（nav 时移动端分支所加，带 data-auto-collapsed 标记）时展开之。
 * 用户经 toggleExplorer 手动折叠的状态（标记已清）不受影响；移动端汉堡行为不变。
 */
function expandDesktopExplorers() {
  for (const explorer of document.getElementsByClassName(
    "explorer",
  ) as HTMLCollectionOf<HTMLElement>) {
    const mobileExplorer = explorer.querySelector(".mobile-explorer")
    if (!mobileExplorer) continue
    if (!mobileExplorer.checkVisibility() && explorer.dataset.autoCollapsed === "true") {
      explorer.classList.remove("collapsed")
      delete explorer.dataset.autoCollapsed
      explorer.setAttribute("aria-expanded", "true")
    }
  }
}

window.addEventListener("resize", function () {
  // 视口跨过桌面断点（或首次布局完成触发 resize）时复位自动折叠的根级
  expandDesktopExplorers()

  // patent-kb: 初载视口未布局导致的挂起定位，布局就绪后补执行一次
  if (explorerLocatePending) {
    const scroller = document.querySelector<HTMLElement>(".explorer-ul")
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      explorerLocatePending = false
      locateExplorerActive(scroller)
    }
  }

  // Desktop explorer opens by default, and it stays open when the window is resized
  // to mobile screen size. Applies `no-scroll` to <html> in this edge case.
  const explorer = document.querySelector(".explorer")
  if (explorer && !explorer.classList.contains("collapsed")) {
    document.documentElement.classList.add("mobile-no-scroll")
    return
  }
})

function setFolderState(folderElement: HTMLElement, collapsed: boolean) {
  return collapsed ? folderElement.classList.remove("open") : folderElement.classList.add("open")
}
