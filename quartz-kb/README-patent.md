# IPReader · quartz 定制备忘（patent-kb 分支）

本仓库基于 quartz v4.5.2，承载 88 部知识产权工具书 + 关键词索引 + 图谱总览共 7397 页的纯离线知识库。
内容 markdown 由 `../site/scripts/build-quartz-md.mjs` 生成（幂等，重跑前自动清空受管目录）。

## 构建流程

数据变更后的完整再生成链（在各自目录内执行）：

```sh
# 1. 数据层（../site 内）：抽取边（含 W1 termco 词共现）→ 增量布局
node scripts/extract-edges.mjs           # → data/edges.json（degree/hub 写回 nodes.json）
node scripts/compute-layout.mjs          # 增量模式：非 term 坐标取 layout-baseline.json 冻结基线

# 2. 内容层（../site 内）：重新生成 quartz markdown（7397 页）
node scripts/build-quartz-md.mjs

# 3. 静态资源同步（本目录内）
./sync-content.sh            # ../site/public/content/（7282 个节点详情 JSON）→ quartz/static/content/

# 4. 构建站点（产物 public/）
npx quartz build
```

仅内容文案变更时可跳过第 1 步；仅节点详情 JSON 变更时只需第 3 步的 `./sync-content.sh` + 第 4 步。

桌面端打包见 `../desktop/`（Electron 本地 http 托管 public/，经 extraResources 带入产物）。

## 图谱总览集成（W1 数据层 + W3 组件）

- **宿主页**：生成器产出 `content/0-图谱总览/index.md`（目录 0- 前缀使 Explorer 排在 7 部书之前）；
  首页「检索入口」以 wikilink `[[0-图谱总览/index|🗺️ 图谱总览]]` 指向该页；
  专用组件按 `fileData.slug === "0-图谱总览/index"` 自判注入（交互：点击节点侧栏阅读、双击/按钮前往文档页）。
- **数据源**：图数据来自 Quartz 自身的 contentIndex（构建产出 `public/static/contentIndex.json`，
  经每页注入的全局 `fetchData` 取用），渲染入口是 `graph.inline.ts` 暴露的 `window.__graphRender`；
  节点详情 `quartz/static/content/<id>.json`（经 `./sync-content.sh` 同步，运行时路径
  `/static/content/<id>.json`）。本页数据仅来自上述两处，无其他数据依赖。

## 其他定制点（Q1–Q3，详见各阶段提交）

- 离线化：analytics 置空、本地字体栈、移除 Latex/CustomOgImages/mermaid 等外联依赖；
- Explorer：目录数字前缀排序（`quartz.layout.ts` 的 explorerConfig.sortFn，序列化进浏览器执行）；
- Graph：按 7 书 + 术语域配色，局部图 depth=2、全局图径向布局；
- 首页与全部内容页均由生成器管理，**不要手改 `content/`**（重跑生成器会清空重建）。
