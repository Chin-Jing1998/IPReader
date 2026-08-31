# IPReader MCP 服务

把 76 部知识产权法规与实务文献开放给任意支持 MCP 的 AI agent 检索、精读与溯源。

**完全离线**：stdio 传输是父子进程之间的管道通信，不开端口、不解析域名、不发任何网络请求。数据全部内置于本地文件。冒烟测试对此设有可执行断言——外部访问次数恒为 0。

**零安装**：`dist/` 下是打包好的自包含单文件，SDK 与检索引擎已全部内联。拿到仓库或桌面安装包即可直接运行，无须 `npm install`，无须联网。

---

## 能做什么

| 工具 | 用途 |
|---|---|
| `search_kb` | 全文检索，返回命中页面的标题、书目、层级路径与命中片段 |
| `read_node` | 按节点 id 读原文，支持仅本节／含子节点两档，长文分页续读 |
| `browse_toc` | 按层级浏览目录树 |
| `lookup_term` | 查 1743 条术语：释义、各书出处（含所在章节）、关联法条、相关术语 |
| `find_law` | 按条号直达法条原文（覆盖 65 部法律法规、2409 条），并列出引用该条的全部章节 |
| `related_nodes` | 取知识图谱关联，按边类型分组（层级／交叉引用／法条依据／术语共现等） |
| `list_books` | 内容清单与规模，可先调它建立全局认知 |

另注册资源模板 `patentkb://node/{id}`，供客户端直接引用节点。

内容规模：76 部书、7706 节点（正文 5963 + 术语 1743）、正文约 471 万字、图谱边 19099 条、法条正文 2409 条（覆盖 65 部法律法规，另有 2983 条「条文 → 引用章节」反向索引）。

## 接入

服务入口是 `dist/server.mjs`，需要 Node ≥ 18。下文的 `<仓库路径>` 指本仓库所在的绝对路径。

### Claude Code

```bash
claude mcp add ipreader -- node <仓库路径>/patent-kb/mcp/dist/server.mjs
```

装了桌面版 IPReader 的话，也可以指向应用内的副本（无须克隆仓库，借用 Electron 自带的 Node）：

```bash
claude mcp add ipreader -e ELECTRON_RUN_AS_NODE=1 -- /Applications/IPReader.app/Contents/MacOS/IPReader /Applications/IPReader.app/Contents/Resources/mcp/server.mjs
```

接好后在会话中用 `/mcp` 查看连接状态。

### Codex CLI

```bash
codex mcp add ipreader -- node <仓库路径>/patent-kb/mcp/dist/server.mjs
```

或直接写入 `~/.codex/config.toml`：

```toml
[mcp_servers.ipreader]
command = "node"
args = ["<仓库路径>/patent-kb/mcp/dist/server.mjs"]
startup_timeout_sec = 30
```

指向桌面应用内副本时（macOS）：

```toml
[mcp_servers.ipreader]
command = "/Applications/IPReader.app/Contents/MacOS/IPReader"
args = ["/Applications/IPReader.app/Contents/Resources/mcp/server.mjs"]
startup_timeout_sec = 30

[mcp_servers.ipreader.env]
ELECTRON_RUN_AS_NODE = "1"
```

Windows 下应用内副本的路径为 `%LOCALAPPDATA%\Programs\IPReader\IPReader.exe` 与 `%LOCALAPPDATA%\Programs\IPReader\resources\mcp\server.mjs`（安装时若改过目录，按实际路径填写）。

配置完成后用 `codex mcp list` 或会话内的 `/mcp` 核对。

### 腾讯 WorkBuddy 及其他支持 MCP 的工具

在其 MCP 管理界面新增一个 stdio 类型的服务，填入相同的 command 与 args 即可：

- 命令：`node`
- 参数：`<仓库路径>/patent-kb/mcp/dist/server.mjs`

凡遵循 MCP 标准 stdio 传输的客户端，配置形式大同小异——本服务不依赖任何客户端专有能力。

> 冷启动实测 354 ms（含解压数据包、建立检索索引与协议握手；节点 7706、书目 76/76，2026-08-30 阶段5.11 波O 书目下线后实测），仍远低于各客户端的默认启动超时。若客户端的超时设置低于 5 秒，建议按上文示例显式放宽。

### 多端安装器

不想逐家手填配置的话，用仓库内的安装器：

```bash
cd <仓库路径>/patent-kb/mcp
node installer/index.mjs list                          # 探测各 agent 在位与当前配置状态
node installer/index.mjs install --agent claude-desktop # 默认只演练，打印落点与将写入的差异
node installer/index.mjs install --agent claude-desktop --write   # 确认后落盘
```

覆盖七个目标：Claude Code 的 user 与 project 两个作用域、Claude Desktop、Hermes Agent、ZCode、MiMo Code、OpenCode。写入一律读—改—写并留时间戳备份，重复运行不产生重复条目。

其余十二家（Codex CLI、Cursor、VS Code Copilot、Zed、Cline、Windsurf、Kimi Code、iFlow、Qwen Code、Antigravity、OpenClaw、MiniMax Code）的现成配置片段，以及作用域选择指引，见 [docs/MCP-安装指南.md](docs/MCP-安装指南.md)。

## 内容范围开关

默认开放全部 76 部书。通过环境变量 `IPREADER_MCP_DOMAINS` 可按书目收窄，逗号分隔：

```bash
claude mcp add ipreader \
  -e IPREADER_MCP_DOMAINS=patent-law,implementation-rules,examination-guideline,infringement-guide \
  -- node <仓库路径>/patent-kb/mcp/dist/server.mjs
```

> 更名前的旧变量名 `PATENTREADER_MCP_DOMAINS` 仍作兜底兼容：未设置新名时按旧名取值，既有配置无需立即改动；新名优先级更高，两者同时设置时以 `IPREADER_MCP_DOMAINS` 为准。

主干七部书的域键：

| 域键 | 书目 |
|---|---|
| `patent-law` | 中华人民共和国专利法 |
| `implementation-rules` | 专利法实施细则 |
| `examination-guideline` | 专利审查指南 |
| `infringement-guide` | 专利侵权判定指南 |
| `mechanical-drafting-rules` | 机械领域申请文件撰写规范 |
| `chemistry-drafting-rules` | 化学领域申请文件撰写规范 |
| `oa-response-guide` | 答复审查意见指南 |

其余 69 部（司法解释与裁判要旨 26 部、法律／行政法规／部门规章与规范性文件 43 部）的域键不在此逐一列举——调 `list_books` 即返回全部书目的 `domain` 字段，以其返回值为准，避免本表与数据脱节。域键给错时服务会直接报错并提示改用 `list_books` 查询。

过滤在数据加载层生效：被关闭的书目既不进检索索引，也无法经任何工具读取，指向它的引用（术语出处、关联节点、法条引用）一并剔除。术语索引层横跨全库，不受开关影响。

## 构建（仅开发者需要）

使用者不必执行本节——`dist/` 已随仓库分发。

```bash
cd patent-kb/mcp
npm install
npm run build        # = build:data + build:code
npm run smoke        # 89 项端到端断言
```

- `scripts/build-data.mjs` 从 `site/data` 与 `site/public/content` 生成 `dist/kb-data.json.gz`（16.7MB → gzip 3.0MB）。它会把重建出的页面 slug 逐条与 quartz 产物对照，上游命名规则若变动即刻抛错。
- `scripts/build.mjs` 用 esbuild 把 `src/` 连同 SDK、zod、flexsearch 打成单文件 `dist/server.mjs`（约 478KB）。
- `smoke.mjs` 以真实 MCP 客户端经 stdio 连接被测服务逐项断言，并在子进程内挂载 `offline-guard.cjs` 统计外部网络访问。加 `--src` 可改测源码而非打包产物。

**上游数据更新后须重跑 `npm run build` 并提交 `dist/`**，否则 MCP 侧内容会滞后于应用内容。

## 检索说明

分词器移植自应用内搜索（`quartz-kb/quartz/components/scripts/search.inline.ts`），中文按字切分配前缀匹配，因此 MCP 的检索口径与应用内一致。

在此之上另加三层精度控制：

1. **术语提权**——命中 1743 条术语之一时按匹配置信度提权（正名高于别名，匹配长度占查询比重越大越可信）。
2. **二字组门槛**——以相邻二字组的覆盖率作最低相关性门槛，单纯若干单字散落在长正文里的候选会被剔除，避免检索不存在的词时返回一堆无关结果；正文由「标题＋页码」堆成的目录倾倒页另行判别剔除，它对本书任何查询都能给出精确匹配，属虚假强命中。
3. **法条直达路由**——查询形如「专利法第26条」「商标法第8条」时，条号经归一后直接查 2409 条法条正文，不再交由二字组去猜。法名以运行时派生的 129 条别名注册表识别（65 部有条文规范的全称与简称，按归一后长度降序匹配以解「专利法」⊂「专利法实施细则」一类子串包含）；左侧出现无法识别的法名样文本时不路由，绝不回落专利法。

## 隐私

- 不发出任何网络请求，无遥测、无账号
- 不写入任何文件，不读取数据包以外的任何路径
- 调用记录只存在于调用方的 agent 会话中，本服务自身不留痕

## 许可

代码 MIT；内容许可见仓库根目录的 [CONTENT_LICENSE.md](../CONTENT_LICENSE.md)。
