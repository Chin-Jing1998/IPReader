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
// 与 fetchData 的区别在取数时机——fetchData 由 renderPage.tsx 注入的内联脚本在
// 文档 head 里发起（全站共用一份，搜索与目录同吃），本索引则由图谱两个 inline
// 脚本各自惰性发起、并以 window.__graphIndex 去重，故只在真正渲染图谱的页面付费。
type GraphContentIndex = Record<FullSlug, GraphContentDetails>

interface Window {
  /** 图谱轻量索引的取数 Promise（首个调用方发起，其余共享） */
  __graphIndex?: Promise<GraphContentIndex>
}
