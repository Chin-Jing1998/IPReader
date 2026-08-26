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
 * 一段——若沿用 slug 段数，87 部书会全部落在 openLevels: 1 的展开档内，一旦展开某个
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

/** 合成节点折叠态的持久化键前缀。真实 slug 不含冒号，故与任何页面路径天然不冲突。 */
const SYNTHETIC_KEY_PREFIX = "synthetic:"

/**
 * 折叠态存储键。分组层把书目录从渲染树第 1 层推到第 4 层，旧键 `fileTree` 里
 * 沉淀的记录（87 部书清一色 collapsed:false，是 openLevels:1 平铺时代的默认值）
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

/** 法域（country）展示顺序与显示名。当前 87 部书全为 CN，其余法域按首次出现顺序追加。 */
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
}

function createFileNode(currentSlug: FullSlug, node: FileTrieNode): HTMLLIElement {
  const template = document.getElementById("template-file") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const a = li.querySelector("a") as HTMLAnchorElement
  a.href = resolveRelative(currentSlug, node.slug)
  a.dataset.for = node.slug
  a.textContent = node.displayName

  if (currentSlug === node.slug) {
    a.classList.add("active")
  }

  return li
}

function createFolderNode(
  currentSlug: FullSlug,
  node: FileTrieNode,
  opts: ParsedOptions,
  depth: number,
): HTMLLIElement {
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

  if (!synthetic && currentSlug === folderPath) {
    folderContainer.classList.add("active")
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
    a.href = resolveRelative(currentSlug, folderPath as FullSlug)
    a.dataset.for = folderPath
    a.className = "folder-title"
    a.textContent = node.displayName
    button.replaceWith(a)
  } else {
    const span = titleContainer.querySelector(".folder-title") as HTMLElement
    span.textContent = node.displayName
  }

  // 折叠判定优先级：localStorage 保存态（已并入 currentExplorerState）> openLevels 默认规则
  const isCollapsed =
    currentExplorerState.find((item) => item.path === folderPath)?.collapsed ??
    defaultCollapsed(depth, opts)

  // if this folder is a prefix of the current path we
  // want to open it anyways
  // patent-kb（C-3）：合成节点没有 slug 前缀可比，改用再父化时算好的 containsCurrent，
  // 否则当前页所在的书虽被强制展开，却仍关在折叠的归类层里看不见
  let folderIsPrefixOfCurrentSlug: boolean
  if (synthetic) {
    folderIsPrefixOfCurrentSlug = synthetic.containsCurrent
  } else {
    const simpleFolderPath = simplifySlug(folderPath as FullSlug)
    folderIsPrefixOfCurrentSlug = simpleFolderPath === currentSlug.slice(0, simpleFolderPath.length)
  }

  if (!isCollapsed || folderIsPrefixOfCurrentSlug) {
    folderOuter.classList.add("open")
  }

  for (const child of node.children) {
    const childNode = child.isFolder
      ? createFolderNode(currentSlug, child, opts, depth + 1)
      : createFileNode(currentSlug, child)
    ul.appendChild(childNode)
  }

  return li
}

async function setupExplorer(currentSlug: FullSlug) {
  const allExplorers = document.querySelectorAll("div.explorer") as NodeListOf<HTMLElement>

  // ==== patent-kb: 图谱页独立折叠态（阶段5.4 批 D1）====
  // 每次按当前页刷新存储键与展开深度上限：图谱页用独立键 fileTree-graph ＋
  // 「depth ≤6 默认展开」（书下 3 层可见）；其余页维持 fileTree-v2 ＋ openLevels
  // 原逻辑。activeStorageKey 为模块级变量，toggleFolder 等事件回调经它取当前键，
  // SPA 换页后随本函数同步刷新，语义见其声明处注释。
  const onGraph = onGraphOverviewPage()
  activeStorageKey = onGraph ? GRAPH_FOLDER_STATE_STORAGE_KEY : FOLDER_STATE_STORAGE_KEY
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

    // patent-kb（C-3）：分组表与 contentIndex 并发取，避免串行等待拖慢首屏目录渲染
    const [data, taxonomy] = await Promise.all([fetchData, fetchTaxonomy(currentSlug)])
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

    const explorerUl = explorer.querySelector(".explorer-ul")
    if (!explorerUl) continue

    // Create and insert new content
    const fragment = document.createDocumentFragment()
    for (const child of trie.children) {
      const node = child.isFolder
        ? createFolderNode(currentSlug, child, opts, 1)
        : createFileNode(currentSlug, child)

      fragment.appendChild(node)
    }
    explorerUl.insertBefore(fragment, explorerUl.firstChild)

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
    {
      const scroller = explorerUl as HTMLElement
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
      if (edgeHost) {
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
    }
    // ==== /patent-kb ====

    // Set up event handlers
    const explorerButtons = explorer.getElementsByClassName(
      "explorer-toggle",
    ) as HTMLCollectionOf<HTMLElement>
    for (const button of explorerButtons) {
      button.addEventListener("click", toggleExplorer)
      window.addCleanup(() => button.removeEventListener("click", toggleExplorer))
    }

    // Set up folder click handlers
    // patent-kb（C-3）：原本仅在 "collapse" 行为下绑定。"link" 行为下真实目录的标题
    // 已被换成 <a>，留在 DOM 里的 .folder-button 只可能是合成分组节点——它们没有可跳转
    // 的页面，标题点击必须回落为折叠切换，否则整行只有那枚 12px 的箭头能点。
    // 两种行为下均绑定，无重复绑定风险（同一按钮在任一行为下只被这一处遍历到）。
    const folderButtons = explorer.getElementsByClassName(
      "folder-button",
    ) as HTMLCollectionOf<HTMLElement>
    for (const button of folderButtons) {
      button.addEventListener("click", toggleFolder)
      window.addCleanup(() => button.removeEventListener("click", toggleFolder))
    }

    const folderIcons = explorer.getElementsByClassName(
      "folder-icon",
    ) as HTMLCollectionOf<HTMLElement>
    for (const icon of folderIcons) {
      icon.addEventListener("click", toggleFolder)
      window.addCleanup(() => icon.removeEventListener("click", toggleFolder))
    }

    // patent-kb（B4）：图谱总览页的目录联动（点条目→图内定位 / 法域标签→分支过滤）。
    // 内部自带页面门控，非图谱页整体空转，不绑定任何监听器
    bindGraphLinkage(explorer)
  }
}

document.addEventListener("prenav", async () => {
  // save explorer scrollTop position
  const explorer = document.querySelector(".explorer-ul")
  if (!explorer) return
  sessionStorage.setItem("explorerScrollTop", explorer.scrollTop.toString())
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
