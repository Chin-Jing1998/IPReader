# PatentReader · 专利知识库桌面端

把七部专利法规与实务文献重构为一座可检索、可批注、可离线阅读的知识库，装成桌面应用。

**完全离线**：内容全部内置，运行期不发出任何外部请求，无遥测、无账号、无云同步。批注只存在你自己的机器上。

---

## 内容

| 书目 | 规模 | 来源 |
|---|---|---|
| 专利法 | 82 条 | 全国人民代表大会常务委员会 |
| 专利法实施细则 | 149 条 | 国务院 |
| 专利审查指南（2025） | 6 部 38 章 259 节 523 小节 | 国家知识产权局 |
| 侵权判定指南（2017） | 153 条 | 北京市高级人民法院 |
| 机械案件撰写规范 | 2 章 18 节 | 自撰 / 已获授权 |
| 化学案件撰写规范 | 2 章 26 节 | 自撰 / 已获授权 |
| 审查意见答复指引 | 7 章 26 节 | 自撰 / 已获授权 |

合计 **2077 页**，另有 **851 个术语词条**的关键词索引（23 个主题分组）与一张全库知识图谱。各书正文中的术语自动成链（8142 处行内链接），条文之间的引用亦互相可跳转。

许可状态见 [CONTENT_LICENSE.md](CONTENT_LICENSE.md)。

## 功能

- **全文搜索** —— 本地索引，输入即出结果
- **知识图谱** —— 图谱总览页可视化全库结构；每页右栏显示该页的局部关联图
- **批注** —— 选中正文即弹出工具条：复制 / 高亮（四色）/ 划线 / 笔记。批注按页存储，支持整体导出与导入 JSON
- **术语索引** —— 851 个词条，按 23 个主题分组（未落类者归「99-综合」），含释义、出处与相关术语
- **翻页与目录** —— 键盘翻页、自动定位的侧栏目录、阅读进度环
- **界面主题** —— 六套古风配色（宣纸 / 水墨 / 青瓷 / 竹林 / 暮山 / 玄夜），各含明暗两态；独立设置页按外观 / 批注 / 关于三类分栏
- **批注落盘** —— 除整体导出导入 JSON 外，桌面端可在设置中指定保存目录，批注自动写为 Markdown 文件：按所在章节命名，高亮与划线保留格式，笔记以脚注附于整段下方
- **窗口与滚动** —— macOS 下自绘标题栏（随主题着色，补上 `hiddenInset` 窗口缺失的标题文本）；全站滚动条一并主题化

## 界面一览

以下截图取自 macOS 桌面端 1440×900 窗口，界面主题为默认的「宣纸」（末张为其深色态），由 `desktop/shots.cjs` 生成。

![首页](docs/screenshots/01-home.png)

**首页 · 内容总览**　七部工具书与两个检索入口（图谱总览、关键词索引）在此汇总。左栏是贯穿全库的目录树，右栏是本页关系图与大纲。

![章节页](docs/screenshots/02-chapter.png)

**章节页 · 三栏阅读**　左栏目录树自动展开并高亮当前所在位置，中栏是正文，右栏是这一页在知识图谱中的局部关联与反向链接。正文里带下划线的词是术语，点它跳到词条页。

![图谱总览](docs/screenshots/03-graph.png)

**图谱总览 · 全库知识图谱**　节点按所属书目着色，顶栏可按名定位节点、切换术语层的隐藏 / 弱化 / 显示、重置视图。点节点即在侧栏读该知识点的正文，双击前往它的文档页。

![全文搜索](docs/screenshots/04-search.png)

**全文搜索**　点搜索框或按 `Ctrl/⌘ + K`，输入即出结果，标题与正文全文均可命中；左侧列结果、命中词高亮，右侧同步预览该页。索引在本地构建，全程不联网。

![术语词条页](docs/screenshots/05-term.png)

**术语词条页**　851 个词条之一。每条给出释义、在各书中的出处（附原文摘录）、相关法条与相关术语；右栏的反向链接列出哪些页面引用了它。

![批注](docs/screenshots/06-annotate.png)

**批注 · 四色高亮与划线**　选中正文任意一段即浮出工具条：复制 / 划线 / 笔记 / 四色高亮。图为标注后的效果——黄绿蓝粉四色高亮与蓝色划线，带 ✎ 角标的是附了笔记的标记，悬停或点击可读笔记内容。批注按页存在本机，关掉应用再打开仍在。

![批注管理](docs/screenshots/07-annotate-drawer.png)

**批注管理**　设置页「批注」分类中的「批注管理」按钮唤起本页批注列表：点条目定位回正文，可逐条删除，也可在底部整体导出 / 导入 JSON。原文变动后定位不到的批注会灰显并注明，不会被删除。

![设置页 · 界面主题](docs/screenshots/08-settings-theme.png)

**设置 · 界面主题**　六套古风配色——宣纸 / 水墨 / 青瓷 / 竹林 / 暮山 / 玄夜，每套各含浅色与深色两态；明暗模式另有浅色 / 深色 / 跟随系统三档。设置页按外观 / 批注 / 关于三类分栏。

![深色态章节页](docs/screenshots/09-chapter-dark.png)

**深色态**　与上面第二张为同一页面。页面底色、各栏字体与图谱配色随主题一并切换。

## 接入 AI Agent（MCP 服务）

除了自己翻阅，这座知识库也可以交给 AI agent 直接调用。仓内的 [`mcp/`](mcp/) 是一个标准 MCP 服务，接上之后，Claude Code、Codex、腾讯 WorkBuddy 等支持 MCP 的工具就能在这七部法规里检索、读原文、查术语、按条号溯源。

```bash
claude mcp add patentreader -- node <仓库路径>/patent-kb/mcp/dist/server.mjs
```

七个工具：全文检索 `search_kb`、读原文 `read_node`、浏览目录 `browse_toc`、查术语 `lookup_term`、查法条 `find_law`、图谱关联 `related_nodes`、内容清单 `list_books`。

与桌面端同样**完全离线**——stdio 是父子进程管道，不开端口、不发请求；`dist/` 是打包好的自包含单文件，无须 `npm install`。冷启动约 120 ms。装了桌面版的话，安装包内已附同一份服务，配置指向应用内路径即可，连仓库都不必克隆。

配置细节、内容范围开关与其他客户端的接法见 [mcp/README.md](mcp/README.md)。

## 仓库结构

```
patent-kb/
├── site/          内容生成器：由结构化数据产出 quartz 用的 markdown
│   ├── scripts/   build-quartz-md.mjs 是入口
│   ├── data/      nodes / edges / node-bodies / term-link-exclude
│   ├── assets/    原文附图 88 张
│   └── public/    章节与词条详情 JSON（生成器的输入，非网站产物）
├── quartz-kb/     文档站：Quartz v4 的定制分支，content/ 为生成结果
├── desktop/       Electron 壳：本地 http 托管静态站
├── mcp/           MCP 服务：把知识库开放给 AI agent 检索，dist/ 为自包含产物
└── docs/          界面截图（shots.cjs 的产物，供本文「界面一览」引用）
```

`site/` 这个目录名是历史遗留（早期它是一个 Web 应用），现在的职责只有内容生成。

## 构建

需要 Node ≥ 22。

```bash
# 1. 生成 markdown（site/data → quartz-kb/content）
cd site && node scripts/build-quartz-md.mjs

# 2. 构建静态站（quartz-kb/content → quartz-kb/public）
cd ../quartz-kb && npm ci && npx quartz build

# 3. 运行桌面端
cd ../desktop && npm ci && npm start

# 4. 重建 MCP 服务产物（内容有更新时才需要）
cd ../mcp && npm ci && npm run build
```

打包：

```bash
cd desktop && npm run dist:mac    # 或 dist:win
```

**下载已构建的安装包**：见本仓库的 [Releases](../../releases) 页面（macOS 为 `.dmg`，Windows 为 `.exe`）。

Windows 安装包（nsis x64）由 GitHub Actions 云端构建：workflow `build-windows` 支持手动触发（产物见该次运行的 artifact），推送 `v*` tag 时自动构建并发布到 Release。macOS 包在本机 `npm run dist:mac` 后随同一 tag 上传。

生成器是幂等的——同样的输入重跑产出零 diff，可据此验证改动是否引入意外变化。

### 内容修订的传导规程

`site/data` 为生成器唯一输入，须与内容修订保持同步。修订源头在外层工作区七部书源 md，传导规程如下：

1. 外层重跑解析（`parse-domains` 会覆写 `nodes.json` 布局坐标，需要时 `git checkout` 还原坐标字段）；
2. 搬运 `site/data` 与 `site/public/content` 至本仓；
3. 本仓重跑 `build-quartz-md.mjs`；
4. `quartz build`；
5. `cd mcp && npm run build`——MCP 数据包由 `site/data` 与 `site/public/content` 独立生成，不随 quartz 构建更新，漏掉这一步会让 agent 侧内容静默滞后于应用侧。

搬运时须与数据一同对齐的还有三处：`site/scripts/build-quartz-md.mjs` 的 `BOOKS` 域映射、`site/scripts/lib/domains.mjs` 的 `KNOWN_DOMAINS`、以及 `site/assets/book-images/<domain>/` 的目录名。三者以 `domain` 键与 `nodes.json` 耦合，域键改名而未同步会使生成器直接抛 `未知域`。

`site/data/term-extract/`（636 片 LLM 术语提取产物，2026-06 冻结）不在上述解析链内，正文修订**不会**自动传导至此：凡涉及法条条号、机构名的内容修订，须同步定向修订该目录，否则重跑 `merge-terms` / `build-term-nodes` / `build-term-content` 会把 evidence/definition 静默改回旧文。

术语链重跑须在带切片源的工作区进行：本仓 `site/` 不含七部规范的 `_chunks` 切片源，`merge-terms.mjs` 在本仓内直接运行会因 evidence 全部校验失败而静默丢词。重跑后将 `site/data/`、`site/public/content/`、`quartz-kb/content/` 三处产物一并同步回本仓。词条口径另受 `site/data/term-blacklist.json` 的剔除清单约束，改动该清单同样须重跑术语全链。

`site/scripts/lib/topics.mjs` 以**本仓为唯一事实源**：分组层 `TERM_TOPIC_GROUPS` 22 组，加兜底「99-综合」共 23 个主题目录，另有 `manualOnly` 键约定（该键只作人工决策落点，不参与自动归类）。按上述规程「外层重跑解析再搬运」之前，须先确认外层工作区的 `topics.mjs` 与本仓一致，否则已退役的 `examProcedure` 章节主题会原样复活并覆盖分组成果。

## 验证

```bash
cd desktop && npm run smoke
```

24 步端到端冒烟。其中**离线护栏**会阻断一切非 `127.0.0.1` 的请求并统计尝试次数——这把"完全离线"从一句承诺变成了可执行的断言，任何改动都不得让它出现非零值。

```bash
cd mcp && npm run smoke
```

MCP 服务的 89 项端到端断言：以真实 MCP 客户端经 stdio 连接，逐一验证七个工具的行为、分页游标、域白名单，并在子进程内挂载同源的离线护栏（patch `net`/`dns`/`tls`/`fetch`），同样断言外部访问为 0。

服务端自身的安全行为（CSP、Host 校验、路径穿越防护、只读服务）逐条列在 [SECURITY.md](SECURITY.md)。

## 系统要求

- macOS 12 (Monterey) 或更高
- Windows 10 或更高

Windows 7/8.1 自 2026-08 起不再支持——所依赖的 Electron 版本已终止对其支持，继续留用意味着运行在一个两年多未收到安全补丁的浏览器内核上。

## 安装提示

当前发行版**未做代码签名**，首次启动需要手动放行：

- **macOS**：系统设置 → 隐私与安全性 → 在底部「安全性」处允许本应用运行。（macOS 15 起 Apple 已移除「右键打开」这一捷径，旧教程里的做法不再有效。）
- **Windows**：SmartScreen 提示时点「更多信息」→「仍要运行」。

## 隐私

- 不发出任何网络请求。内容、字体、图标全部内置
- 无遥测、无崩溃上报、无使用统计
- 批注、笔记、高亮默认存于浏览器 localStorage；桌面端亦可在设置中指定目录，落盘为 Markdown 文件。两种存储均不离开本机，导出与导入也一律由你手动选择文件
- 桌面端把本地服务固定在 `127.0.0.1:47821`——端口是 localStorage 的隔离维度，固定它才能保证批注不会因换端口而"消失"

## 支持

本项目免费开放，无账号、无内购、无广告。若它替你省下了翻文件的时间，欢迎请我喝杯咖啡：

<img src="quartz-kb/quartz/static/donate-alipay.jpg" width="220" alt="支付宝收款码">


## 许可

代码 [MIT](LICENSE)；内容见 [CONTENT_LICENSE.md](CONTENT_LICENSE.md)；第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
