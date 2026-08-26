// 切片锚定手工映射表（数据管线 D3）
//   用途：prep-term-extraction.mjs 四级自动匹配（精确 label → 归一 → 面包屑路径 → 前缀）
//   仍无法唯一落定的切片，在此按 chunkId 手工指定 anchorNodeId，保证锚定率 100%。
//   chunkId 口径：`<域key>/<相对 _chunks 的路径去 .md>`，如
//     'examination-guideline/02/008/04/12' → 节点 '02-08-04-12'
//   （⚠ 2026-08-23 修复：示例原用旧域名字面量 'examination-guideline-2025'，该域已更名为
//     'examination-guideline'，示例同步更新；本文件当前无实际映射条目，不影响运行时行为。）
//   维护原则：宁改匹配规则、少加人工映射；新增条目须注明原因。
export const ANCHOR_OVERRIDES = new Map([
  // 当前四级匹配 + 编号派生 tie-break 已覆盖全部 636 片，无需人工映射。
]);
