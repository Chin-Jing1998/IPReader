# IPReader MCP 多端安装指南

本文说明如何把 `ipreader` MCP server 接入各类 AI agent。第一至第四节针对安装器直接支持的七个目标，第五节给出其余十二家的配置片段（需手工填写），第六节记录已知的文档与实现冲突。

- 安装器入口：`mcp/installer/index.mjs`
- 快照测试：`npm run test:installer`（在 `mcp/` 目录下执行）
- 本文所有路径均为 macOS 形态；Windows 与 Linux 的差异在相应位置单独标注。

---

## 一、先决事实：运行实体有两种形态

`ipreader` 是 stdio 传输的 Node 程序，不开端口、不联网。它有两个物理副本，安装时须先选定指向哪一个。

| 形态 | 入口 | command | args | env | 适用场景 |
|---|---|---|---|---|---|
| **app**（默认） | `/Applications/IPReader.app/Contents/Resources/mcp/server.mjs` | `/Applications/IPReader.app/Contents/MacOS/IPReader` | 上述入口路径 | `ELECTRON_RUN_AS_NODE=1` | 已装桌面版。借 Electron 自带的 Node 运行，本机无须另装 Node |
| **repo** | `<仓库路径>/patent-kb/mcp/dist/server.mjs` | `node`（建议写绝对路径） | 上述入口路径 | 无 | 未装桌面版，或需跟随仓库最新构建产物 |

三点须留意：

1. **app 内是扁平的 `Resources/mcp/`，没有 `dist` 这一层**。Electron 打包时 `extraResources` 把 `../mcp/dist` 整个目录复制为 `mcp`，故 app 内路径是 `Resources/mcp/server.mjs` 而非 `Resources/mcp/dist/server.mjs`。
2. **`ELECTRON_RUN_AS_NODE=1` 不可省**。缺了它，Electron 会按 GUI 应用启动而不是执行传入的脚本，宿主随即报连接失败。
3. **数据包由 server 自行定位**，按「与 `server.mjs` 同目录 → `../dist/`」两处依次探测。当前版本**没有** `IPREADER_DATA` 一类环境变量，安装器不写入该变量；唯一被 server 识别的环境变量是 `IPREADER_MCP_DOMAINS`（旧名 `PATENTREADER_MCP_DOMAINS` 兜底），用于按书目域键收窄开放范围。

安装器以 `--target` 选择形态：

```bash
node installer/index.mjs install --agent claude-desktop                 # 默认 app
node installer/index.mjs install --agent claude-desktop --target repo   # 指向本仓库 dist
node installer/index.mjs install --agent claude-desktop --target /Volumes/X/IPReader.app
```

app 不在位时安装器直接报错，并列出已尝试的全部路径与三条补救指引，不会静默降级。

---

## 二、安装器用法

### 2.1 三条命令

```bash
cd <仓库路径>/patent-kb/mcp

# 探测：各目标 agent 是否在位、当前 ipreader 配置状态
node installer/index.mjs list

# 安装：默认只演练，打印落点与将写入的差异，不碰任何文件
node installer/index.mjs install --agent claude-desktop
node installer/index.mjs install --all

# 卸载
node installer/index.mjs remove --agent claude-desktop
```

也可经 npm script 调用：`npm run installer -- list`。

### 2.2 演练与落盘

**默认只演练**。`install` 与 `remove` 不带 `--write` 时只打印，不写任何文件。确认输出无误后，在同一条命令末尾追加 `--write` 才真实落盘：

```bash
node installer/index.mjs install --agent claude-desktop --write
```

这条纪律不可由配置反转，只能由命令行上显式的 `--write` 解除。

### 2.3 写入纪律

落盘时遵守四条硬性规则：

1. **读—改—写**。目标文件多为 agent 的主配置（Claude Desktop 一处即含数十个 server，Hermes 的 `config.yaml` 涵盖模型、供应商、平台工具集等全部设置），只改 `ipreader` 一个条目，其余逐字保留。
2. **写前备份**。原文件存在时先复制为 `<原路径>.bak.YYYYMMDD-HHmmss`，再写新内容。演练输出中会预先给出该备份路径。
3. **幂等**。已存在 `ipreader` 条目时更新而非追加，重复运行不产生重复条目；内容与目标一致时直接跳过。
4. **解析失败即停**。JSON／YAML 解析不过、YAML 含 Tab 缩进或行内写法、JSONC 含注释而未显式放行时，报错退出，绝不覆盖写。

### 2.4 全部参数

| 参数 | 含义 |
|---|---|
| `--agent <id>` | 指定目标，逗号分隔或重复给出 |
| `--all` | 一次处理全部七个目标 |
| `--write` | 真实落盘（不给则只演练） |
| `--full` | 演练时打印完整新内容，而非仅打印差异 |
| `--target app\|repo\|<路径>` | 选择运行实体，详见第一节 |
| `--node <路径>` | Node 可执行文件的绝对路径；给 `bare` 则写裸 `node` 交由 PATH 解析 |
| `--domains a,b,c` | 写入 `IPREADER_MCP_DOMAINS`，按书目域键收窄开放范围 |
| `--project-root <路径>` | project 作用域的项目根，默认当前工作目录 |
| `--workspace` | ZCode 改写工作区档而非用户档 |
| `--no-cli` | Claude Code user 作用域强制直接写文件，不走 `claude` CLI |
| `--allow-drop-comments` | 允许重写 JSONC 时丢弃注释（默认遇注释即报错停止） |
| `--json` | 以 JSON 输出结果，供脚本消费 |

`--node` 的默认值取自 PATH 中解析到的 `node` 绝对路径，而非 `process.execPath`——后者可能是某个 agent 内嵌的 Node（本机实测 Hermes Agent 自带 `~/.hermes/node/bin/node`），随该 agent 升级即失效。

---

## 三、CLI 与桌面应用的分道

两类宿主的接入路径不同，不可混淆。

**CLI 型宿主**（Claude Code、Codex CLI、Hermes、MiMo Code、OpenCode、Qwen Code、iFlow、Kimi Code 等）多数提供 `mcp add` 一类子命令，由它自行处理路径与格式，可规避文档与实现不符的坑。安装器对 Claude Code 的 user 作用域即优先走官方 CLI：`~/.claude.json` 是 Claude Code 的主状态文件（含会话历史与授权信息），交由 CLI 改动比整体反序列化再写回更稳妥；PATH 中没有 `claude` 时才回落为读—改—写。

**桌面应用型宿主**（Claude Desktop、ZCode、MiniMax Code 桌面端等）通常没有可脚本化的注册命令，只能改配置文件，且**改完须重启应用**才生效——CLI 型宿主一般在下次会话启动时自动重读，Hermes 另可在运行中用 `/reload-mcp` 热重载。

---

## 四、七个安装目标

### 4.1 Claude Code · user 作用域与 project 作用域的选择

Claude Code 是本文覆盖的宿主中唯一有三层作用域的：

| 作用域 | 落盘位置 | 可迁移 | 进版本控制 | 生效范围 |
|---|---|---|---|---|
| local（默认，安装器不提供） | `~/.claude.json` 的 `projects[<cwd>].mcpServers` | 否 | 否 | 仅当前用户在该目录下 |
| **user** | `~/.claude.json` 顶层 `mcpServers` | 换机需迁移该文件 | 否 | **本机全部项目** |
| **project** | `<项目根>/.mcp.json` | **随仓库走** | **是** | 该仓库的全部协作者 |

选择指引：

- **本机自用，希望在任何目录下都能调 ipreader** → 选 **user**。一次配置，全目录可用。缺点是换机时须迁移 `~/.claude.json`，故安装后应同步在换机参考配置（`知识产权工作站/.claude/mcp-servers-reference.json`）中登记。
- **希望配置随仓库分发给协作者** → 选 **project**，写入项目根的 `.mcp.json` 并提交。需注意其中是绝对路径，在他人机器上未必成立；团队共享前应确认各方的 app 安装位置一致，或改用相对稳定的形态。
- 安装器**不提供 local**。local 与 project 的差别仅在是否进版本控制，而 local 既不可迁移、每换一个工作目录又要重配一次，不值得作为推荐路径。

```bash
node installer/index.mjs install --agent claude-code-user
node installer/index.mjs install --agent claude-code-project --project-root /Users/你/某仓库
```

user 作用域的演练输出会同时给出两样东西：将执行的官方命令，以及等价的落盘差异，便于核对。

### 4.2 Claude Desktop

落点 `~/Library/Application Support/Claude/claude_desktop_config.json`（Windows 为 `%APPDATA%\Claude\claude_desktop_config.json`）。**仅全局，无项目级**。该文件同时承载 Desktop 的其他偏好项，故必须读—改—写。条目形态不写 `type` 字段，与 Desktop 既有条目保持一致（Desktop 按「有 `command` 即 stdio」隐式判别）。

```bash
node installer/index.mjs install --agent claude-desktop
```

改动后须**重启 Claude Desktop**。

### 4.3 Hermes Agent

落点 `~/.hermes/config.yaml`，**YAML 格式，仅全局**。三点关键：

1. **顶层键是 `mcp_servers`**，不是 `mcp:` 下的 `servers:`。官方专门提示过这个常见错误，安装器在检出顶层 `mcp:` 时会告警。
2. **Hermes 不继承父进程完整环境**，只透传显式声明的 `env` 加一组安全基线。因此 `command` 必须写绝对路径（不能指望 PATH 里有 `node`），`env` 必须写全——`ELECTRON_RUN_AS_NODE` 漏写即启动失败。
3. `config.yaml` 是 Hermes 的主配置文件，安装器只做**块级替换**：按缩进定位 `mcp_servers:` 块内的 `ipreader:` 键，替换其所辖行区间，文件其余部分逐字节不动。含 Tab 缩进或 `mcp_servers` 为行内写法时拒绝编辑。

```bash
node installer/index.mjs install --agent hermes
```

密钥不写进 `config.yaml`（Hermes 的约定是落在 `~/.hermes/.env`）；`ipreader` 无密钥，不涉及。运行中可用 `/reload-mcp` 热重载。

### 4.4 ZCode

用户档 `~/.zcode/cli/config.json`，工作区档 `<项目根>/.zcode/config.json`。**键路径是两层嵌套的 `mcp.servers`**，不是顶层 `mcpServers`；安装器写入前会逐层补齐父级 `mcp` 对象。

```bash
node installer/index.mjs install --agent zcode                      # 用户档
node installer/index.mjs install --agent zcode --workspace \
  --project-root /Users/你/某仓库                                    # 工作区档
```

### 4.5 MiMo Code

MiMo Code 是 OpenCode 的 fork，MCP 配置格式与 OpenCode 完全同构：顶层键 `mcp`、`type: "local"`、`command` 为「可执行文件 + 全部参数」的**数组**、环境变量键名是 **`environment`**（不是 `env`）、另有 `enabled` 布尔开关。

**优先走官方 CLI**。其配置层级是本文覆盖的宿主中最复杂的：全局目录内 `config.json` → `mimocode.json` → `mimocode.jsonc` 三个文件**依次合并、后者覆盖前者**；项目侧自父目录向当前目录逐层合并；另有 macOS MDM 托管层整段覆盖全部用户级设置。官方明确没有 `--config`／`--config-file` 这类 flag，路径改由 `MIMOCODE_HOME`／`MIMOCODE_CONFIG`／`MIMOCODE_CONFIG_DIR` 环境变量控制。手工选错落点极易被同目录后序文件覆盖，因此应优先执行：

```bash
mimo mcp add     # 引导式交互命令，按提示填入 command/args/environment
```

**回落落点选 `mimocode.jsonc`**。`mimo mcp add` 是交互式命令，无法非交互传参，脚本无从代劳；安装器因此仍生成文件写入计划，落点定在 `$XDG_CONFIG_HOME/mimocode/mimocode.jsonc`（macOS 默认 `~/.config/mimocode/mimocode.jsonc`）——它是三个用户可写文件中合并顺序最末、优先级最高的一个，写在这里不会被同目录的 `config.json` 或 `mimocode.json` 覆盖。

```bash
node installer/index.mjs install --agent mimo
```

PATH 中检出 `mimo` 时，安装器会同时提示优先使用官方命令，并提醒不要两处并存。

> **本机探测结果（2026-08-31）**：`~/.config/mimocode/` 目录存在，但 `config.json`、`mimocode.json`、`mimocode.jsonc` **三个候选文件均不存在**（目录内只有一个 `.gitignore`）；`~/.local/share/mimocode/` 存在且含 95 MB 的 `mimocode.db`，说明本机装过 MiMo Code 但未留下任何 MCP 配置；`mimo` 不在 PATH 中。故本机若要安装，`mimocode.jsonc` 是新建而非修改。`XDG_CONFIG_HOME` 与 `MIMOCODE_*` 系列环境变量本机均未设置，落点按 macOS 默认推导。

### 4.6 OpenCode

落点 `~/.config/opencode/opencode.json`（亦支持 `.jsonc`），项目级为 `<项目根>/opencode.json`。格式与 MiMo Code 同构，安装器复用同一序列化分支，只换路径与 `$schema`。

```bash
node installer/index.mjs install --agent opencode
```

若原文件是含注释的 JSONC，安装器默认拒绝写入（重新序列化会丢注释），须显式加 `--allow-drop-comments` 或改为手工编辑。

---

## 五、其余十二家的配置片段

以下片段需手工填入对应文件，或用各家自己的 `mcp add` 命令注册。统一采用 **app 形态**的实参；改用 repo 形态时，把 `command` 换成 `node`（建议绝对路径）、`args` 换成 `<仓库路径>/patent-kb/mcp/dist/server.mjs`，并删去 `env` 中的 `ELECTRON_RUN_AS_NODE`。

### 5.1 Codex CLI —— TOML

全局 `~/.codex/config.toml`；项目级 `<项目根>/.codex/config.toml`，**仅在受信任项目中生效**，不打算标记受信任时应装到全局。

```toml
[mcp_servers.ipreader]
command = "/Applications/IPReader.app/Contents/MacOS/IPReader"
args = ["/Applications/IPReader.app/Contents/Resources/mcp/server.mjs"]
startup_timeout_sec = 30

[mcp_servers.ipreader.env]
ELECTRON_RUN_AS_NODE = "1"
```

或用命令注册：

```bash
codex mcp add ipreader --env ELECTRON_RUN_AS_NODE=1 -- \
  /Applications/IPReader.app/Contents/MacOS/IPReader \
  /Applications/IPReader.app/Contents/Resources/mcp/server.mjs
```

### 5.2 Cursor

全局 `~/.cursor/mcp.json`，项目级 `<项目根>/.cursor/mcp.json`（项目优先）。

```json
{
  "mcpServers": {
    "ipreader": {
      "command": "/Applications/IPReader.app/Contents/MacOS/IPReader",
      "args": ["/Applications/IPReader.app/Contents/Resources/mcp/server.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### 5.3 VS Code ＋ GitHub Copilot —— 顶层键是 `servers`

工作区 `<项目根>/.vscode/mcp.json`；用户配置档经命令面板的 `MCP: Open User Configuration` 定位。**顶层键是 `servers` 而非 `mcpServers`**。

```json
{
  "servers": {
    "ipreader": {
      "type": "stdio",
      "command": "/Applications/IPReader.app/Contents/MacOS/IPReader",
      "args": ["/Applications/IPReader.app/Contents/Resources/mcp/server.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### 5.4 Zed —— 顶层键是 `context_servers`

`~/.config/zed/settings.json`（macOS 亦见 `~/Library/Application Support/Zed/settings.json`），项目级 `<项目根>/.zed/settings.json`。

```json
{
  "context_servers": {
    "ipreader": {
      "source": "custom",
      "command": "/Applications/IPReader.app/Contents/MacOS/IPReader",
      "args": ["/Applications/IPReader.app/Contents/Resources/mcp/server.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### 5.5 Cline

VS Code 扩展档：`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`。CLI 档的路径存在文档与实现冲突，见第六节。

```json
{
  "mcpServers": {
    "ipreader": {
      "command": "/Applications/IPReader.app/Contents/MacOS/IPReader",
      "args": ["/Applications/IPReader.app/Contents/Resources/mcp/server.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

整条路径可用环境变量 `CLINE_MCP_SETTINGS_PATH` 覆盖。

### 5.6 Windsurf（Cascade）

`~/.codeium/windsurf/mcp_config.json`（Windows：`%USERPROFILE%\.codeium\windsurf\mcp_config.json`）。**仅全局，无项目级**。格式同 5.2 的标准 `mcpServers`。支持 `${env:VAR}`、`${file:/path}` 插值。

### 5.7 Kimi Code CLI

用户级 `~/.kimi-code/mcp.json`（或 `$KIMI_CODE_HOME/mcp.json`），项目级 `<项目根>/.kimi-code/mcp.json`，**同名条目项目级覆盖用户级**。格式同 5.2，另支持 `cwd`。另一套文档写作 `~/.kimi/mcp.json`，见第六节。

### 5.8 iFlow CLI

用户级 `~/.iflow/settings.json`，项目级 `<项目根>/.iflow/settings.json`，顶层键 `mcpServers`。

```bash
iflow mcp add-json --scope user ipreader \
  '{"command":"/Applications/IPReader.app/Contents/MacOS/IPReader","args":["/Applications/IPReader.app/Contents/Resources/mcp/server.mjs"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}'
```

### 5.9 Qwen Code

用户级 `~/.qwen/settings.json`，项目级 `<项目根>/.qwen/settings.json`，顶层键 `mcpServers`（与 Gemini CLI 同源）。

```bash
qwen mcp add -s user ipreader -e ELECTRON_RUN_AS_NODE=1 \
  /Applications/IPReader.app/Contents/MacOS/IPReader \
  /Applications/IPReader.app/Contents/Resources/mcp/server.mjs
```

### 5.10 Antigravity CLI（`agy`）／IDE

全局 `~/.gemini/config/mcp_config.json`，工作区 `<项目根>/.agents/mcp_config.json`，顶层键 `mcpServers`，格式同 5.2。

> Google 已于 2026-06-18 对个人版停服 Gemini CLI，由 Antigravity CLI 承接。原 `~/.gemini/settings.json` 对企业用户及 Qwen Code、iFlow 等派生产品仍然有效，故两条路径都应保留。

### 5.11 OpenClaw

`~/.openclaw/openclaw.json`。键名存在版本差异（见第六节），官方 CLI 文档写作 `mcp.servers`：

```json
{
  "mcp": {
    "servers": {
      "ipreader": {
        "command": "/Applications/IPReader.app/Contents/MacOS/IPReader",
        "args": ["/Applications/IPReader.app/Contents/Resources/mcp/server.mjs"],
        "env": { "ELECTRON_RUN_AS_NODE": "1" }
      }
    }
  }
}
```

建议以 `openclaw mcp status --verbose` 实测确认。

### 5.12 MiniMax Code（`mcode`）

`~/.minimax/mcp.json`，顶层键 `mcpServers`，支持显式 `type` 与 `description`。

```json
{
  "mcpServers": {
    "ipreader": {
      "type": "stdio",
      "command": "/Applications/IPReader.app/Contents/MacOS/IPReader",
      "args": ["/Applications/IPReader.app/Contents/Resources/mcp/server.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" },
      "enabled": true,
      "description": "IPReader 知识产权知识库（纯离线）"
    }
  }
}
```

### 5.13 通用 stdio 客户端

凡遵循 MCP 标准 stdio 传输的客户端（腾讯 WorkBuddy 等），在其 MCP 管理界面新增一个 stdio 服务，填入相同的 command、args 与 env 即可。本服务不依赖任何客户端专有能力。冷启动实测约 350 ms，远低于常见的 30 秒默认超时；客户端超时设置低于 5 秒时应显式放宽。

---

## 六、已知的文档与实现冲突

以下各处在调研阶段即发现官方文档与实现（或不同官方页面之间）说法不一，**均以官方实测为准，尚待逐一验证**。安装器不覆盖这些目标，手工配置时请先实测确认。

| # | 冲突项 | 甲说 | 乙说 | 处置建议 |
|---|---|---|---|---|
| 1 | **Cline CLI 的真实读取路径** | 官方文档：`~/.cline/mcp.json` | issue #11671：代码实际读 `~/.cline/data/settings/cline_mcp_settings.json` | 两处都探测；或直接用 `CLINE_MCP_SETTINGS_PATH`／`CLINE_DATA_DIR` 显式指定 |
| 2 | **OpenClaw 的键名** | 官方 CLI 文档：`mcp.servers` 两层嵌套 | 第三方指南多写顶层 `mcpServers` | 疑为版本演进产物，以 `openclaw mcp status --verbose` 实测为准 |
| 3 | **MiniMax Code 桌面端是否另有配置路径** | 官方页面正文只给出 `~/.minimax/mcp.json` | 检索摘要称桌面端读 `~/.minimax/mcp/mcp.json` | 两处都探测，以实际存在者为准 |
| 4 | Kimi Code 的用户级路径 | `~/.kimi-code/mcp.json`（或 `$KIMI_CODE_HOME/mcp.json`） | 另一套官方文档写 `~/.kimi/mcp.json` | 两处都探测 |
| 5 | ZCode 导入功能声明的 Claude Code 路径 | ZCode 文档称 `~/.claude/settings.json` | Claude Code 官方：user／local 在 `~/.claude.json`，project 在项目根 `.mcp.json` | 以 Claude Code 官方为准；ZCode 的导入功能可能只覆盖部分情形 |

前三项是调研报告中明列的未决项，第四、五项为交叉核对时另行发现。

---

## 七、安装后的验证

1. **CLI 型宿主**：在会话中执行 `/mcp` 查看连接状态，或用各家的 `mcp list` 子命令。
2. **桌面型宿主**：重启应用后在 MCP 管理界面查看服务状态。
3. **通用**：调一次 `list_books`，应返回 76 部书目的清单。
4. **回滚**：安装器每次落盘都留有 `<原路径>.bak.<时间戳>`，直接覆盖回去即可还原。

---

## 八、附：安装器的目录结构

```
mcp/installer/
├── index.mjs              CLI 入口：参数解析、计划渲染、落盘执行
├── spec.mjs               内部规范模型（单一事实源）：server 定义与运行实体探测
├── lib/
│   ├── io.mjs             读写、时间戳备份、统一差异
│   ├── json-edit.mjs      JSON／JSONC 解析与保持风格的序列化
│   └── yaml-edit.mjs      Hermes config.yaml 的块级编辑
├── adapters/
│   ├── index.mjs          七个目标的注册表
│   ├── common.mjs         JSON 系适配器工厂
│   ├── claude-code.mjs    user 与 project 两个作用域
│   ├── claude-desktop.mjs
│   ├── hermes.mjs
│   ├── zcode.mjs
│   └── opencode-family.mjs  OpenCode 与 MiMo Code（同构，一个分支覆盖两家）
└── test/
    ├── snapshot.test.mjs  快照测试
    └── __snapshots__/     各目标的序列化快照
```

新增一家 agent 时，只需在 `adapters/` 下声明四件事——落点路径怎么算、键路径是什么、条目对象长什么样、新建文件时的初值——再登记到注册表并补一条快照即可；`command`／`args`／`env` 一律从 `spec.mjs` 取，不得自行拼装。
