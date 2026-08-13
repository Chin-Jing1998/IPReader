# PatentReader MCP 服务

把七部专利法规与实务文献开放给任意支持 MCP 的 AI agent 检索、精读与溯源。

**完全离线**：stdio 传输是父子进程之间的管道通信，不开端口、不解析域名、不发任何网络请求。数据全部内置于本地文件。冒烟测试对此设有可执行断言——外部访问次数恒为 0。

**零安装**：`dist/` 下是打包好的自包含单文件，SDK 与检索引擎已全部内联。拿到仓库或桌面安装包即可直接运行，无须 `npm install`，无须联网。

---

## 能做什么

| 工具 | 用途 |
|---|---|
| `search_kb` | 全文检索，返回命中页面的标题、书目、层级路径与命中片段 |
| `read_node` | 按节点 id 读原文，支持仅本节／含子节点两档，长文分页续读 |
| `browse_toc` | 按层级浏览目录树 |
| `lookup_term` | 查 851 条术语：释义、各书出处（含所在章节）、关联法条、相关术语 |
| `find_law` | 按条号直达法条原文，并列出引用该条的全部章节 |
| `related_nodes` | 取知识图谱关联，按边类型分组（层级／交叉引用／法条依据／术语共现等） |
| `list_books` | 内容清单与规模，可先调它建立全局认知 |

另注册资源模板 `patentkb://node/{id}`，供客户端直接引用节点。

内容规模：2044 节点（七部书 1193 + 术语 851）、正文 207.7 万字、图谱边 7998 条、法条正文 231 条。

## 接入

服务入口是 `dist/server.mjs`，需要 Node ≥ 18。下文的 `<仓库路径>` 指本仓库所在的绝对路径。

### Claude Code

```bash
claude mcp add patentreader -- node <仓库路径>/patent-kb/mcp/dist/server.mjs
```

装了桌面版 PatentReader 的话，也可以指向应用内的副本（无须克隆仓库，借用 Electron 自带的 Node）：

```bash
claude mcp add patentreader -e ELECTRON_RUN_AS_NODE=1 -- /Applications/PatentReader.app/Contents/MacOS/PatentReader /Applications/PatentReader.app/Contents/Resources/mcp/server.mjs
```

接好后在会话中用 `/mcp` 查看连接状态。

### Codex CLI

```bash
codex mcp add patentreader -- node <仓库路径>/patent-kb/mcp/dist/server.mjs
```

或直接写入 `~/.codex/config.toml`：

```toml
[mcp_servers.patentreader]
command = "node"
args = ["<仓库路径>/patent-kb/mcp/dist/server.mjs"]
startup_timeout_sec = 30
```

指向桌面应用内副本时（macOS）：

```toml
[mcp_servers.patentreader]
command = "/Applications/PatentReader.app/Contents/MacOS/PatentReader"
args = ["/Applications/PatentReader.app/Contents/Resources/mcp/server.mjs"]
startup_timeout_sec = 30

[mcp_servers.patentreader.env]
ELECTRON_RUN_AS_NODE = "1"
```

Windows 下应用内副本的路径为 `%LOCALAPPDATA%\Programs\PatentReader\PatentReader.exe` 与 `%LOCALAPPDATA%\Programs\PatentReader\resources\mcp\server.mjs`（安装时若改过目录，按实际路径填写）。

配置完成后用 `codex mcp list` 或会话内的 `/mcp` 核对。

### 腾讯 WorkBuddy 及其他支持 MCP 的工具

在其 MCP 管理界面新增一个 stdio 类型的服务，填入相同的 command 与 args 即可：

- 命令：`node`
- 参数：`<仓库路径>/patent-kb/mcp/dist/server.mjs`

凡遵循 MCP 标准 stdio 传输的客户端，配置形式大同小异——本服务不依赖任何客户端专有能力。

> 冷启动实测约 120–190 ms（含解压数据包、建立检索索引与协议握手），远低于各客户端的默认启动超时。若客户端的超时设置低于 5 秒，建议按上文示例显式放宽。

## 内容范围开关

默认开放七部书。通过环境变量 `PATENTREADER_MCP_DOMAINS` 可按书目收窄，逗号分隔：

```bash
claude mcp add patentreader \
  -e PATENTREADER_MCP_DOMAINS=patent-law,implementation-rules,examination-guideline,infringement-guide \
  -- node <仓库路径>/patent-kb/mcp/dist/server.mjs
```

可用的域键：

| 域键 | 书目 |
|---|---|
| `patent-law` | 中华人民共和国专利法 |
| `implementation-rules` | 专利法实施细则 |
| `examination-guideline` | 专利审查指南 |
| `infringement-guide` | 专利侵权判定指南 |
| `mechanical-drafting-rules` | 机械领域申请文件撰写规范 |
| `chemistry-drafting-rules` | 化学领域申请文件撰写规范 |
| `oa-response-guide` | 答复审查意见指南 |

过滤在数据加载层生效：被关闭的书目既不进检索索引，也无法经任何工具读取，指向它的引用（术语出处、关联节点、法条引用）一并剔除。术语索引层横跨全库，不受开关影响。

## 构建（仅开发者需要）

使用者不必执行本节——`dist/` 已随仓库分发。

```bash
cd patent-kb/mcp
npm install
npm run build        # = build:data + build:code
npm run smoke        # 89 项端到端断言
```

- `scripts/build-data.mjs` 从 `site/data` 与 `site/public/content` 生成 `dist/kb-data.json.gz`（8.9MB → gzip 1.5MB）。它会把重建出的页面 slug 逐条与 quartz 产物对照，上游命名规则若变动即刻抛错。
- `scripts/build.mjs` 用 esbuild 把 `src/` 连同 SDK、zod、flexsearch 打成单文件 `dist/server.mjs`（约 460KB）。
- `smoke.mjs` 以真实 MCP 客户端经 stdio 连接被测服务逐项断言，并在子进程内挂载 `offline-guard.cjs` 统计外部网络访问。加 `--src` 可改测源码而非打包产物。

**上游数据更新后须重跑 `npm run build` 并提交 `dist/`**，否则 MCP 侧内容会滞后于应用内容。

## 检索说明

分词器移植自应用内搜索（`quartz-kb/quartz/components/scripts/search.inline.ts`），中文按字切分配前缀匹配，因此 MCP 的检索口径与应用内一致。

在此之上另加两层精度控制：其一，命中 851 条术语之一时按匹配置信度提权（正名高于别名，匹配长度占查询比重越大越可信）；其二，以相邻二字组的覆盖率作最低相关性门槛——单纯若干单字散落在长正文里的候选会被剔除，避免检索不存在的词时返回一堆无关结果。

## 隐私

- 不发出任何网络请求，无遥测、无账号
- 不写入任何文件，不读取数据包以外的任何路径
- 调用记录只存在于调用方的 agent 会话中，本服务自身不留痕

## 许可

代码 MIT；内容许可见仓库根目录的 [CONTENT_LICENSE.md](../CONTENT_LICENSE.md)。
