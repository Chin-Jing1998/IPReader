declare module "*.scss" {
  const content: string
  export = content
}

// dom custom event
interface CustomEventMap {
  prenav: CustomEvent<{}>
  nav: CustomEvent<{ url: FullSlug }>
  themechange: CustomEvent<{ theme: "light" | "dark"; style?: string }>
  readermodechange: CustomEvent<{ mode: "on" | "off" }>
}

type ContentIndex = Record<FullSlug, ContentDetails>
declare const fetchData: Promise<ContentIndex>

// 图谱专用轻量索引（阶段5.6 波2-2.1）：产物 static/contentIndexGraph.json，
// 四字段投影，见 plugins/emitters/contentIndex.tsx 的 GraphContentDetails。
// 与 fetchData 的区别只在**消费面**：fetchData 全站共用（搜索与目录同吃），本索引
// 只服务图谱。取数时机已对齐——两者同由 renderPage.tsx 注入的 head 内联脚本发起
//（阶段5.6 backlog 的冷启动预热），图谱两个 inline 脚本内的取数器保持 `??=` 形态，
// 作为预热缺席时（如脚本被单独复用）的兜底，并以 window.__graphIndex 三处共享同一 Promise。
type GraphContentIndex = Record<FullSlug, GraphContentDetails>

interface Window {
  /** 图谱轻量索引的取数 Promise（首个调用方发起，其余共享） */
  __graphIndex?: Promise<GraphContentIndex>
}
