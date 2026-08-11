// 应用页 slug 单一事实源，供排除链路各消费点引用；刻意零依赖
// （构建期 Node 与浏览器 bundle 双端均可安全引入，不得添加任何 import）
export const GRAPH_SLUG = "0-图谱总览/index"
export const SETTINGS_SLUG = "设置/index"
export const GRAPH_EXCLUDE = "0-图谱总览/"
export const SETTINGS_EXCLUDE = "设置/"
