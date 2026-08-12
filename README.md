# PatentKB · 专利知识库桌面端

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

## 仓库结构

```
patent-kb/
├── site/          内容生成器：由结构化数据产出 quartz 用的 markdown
│   ├── scripts/   build-quartz-md.mjs 是入口
│   ├── data/      nodes / edges / node-bodies / term-link-exclude
│   ├── assets/    原文附图 88 张
│   └── public/    章节与词条详情 JSON（生成器的输入，非网站产物）
├── quartz-kb/     文档站：Quartz v4 的定制分支，content/ 为生成结果
└── desktop/       Electron 壳：本地 http 托管静态站
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
```

打包：

```bash
cd desktop && npm run dist:mac    # 或 dist:win
```

生成器是幂等的——同样的输入重跑产出零 diff，可据此验证改动是否引入意外变化。

### 内容修订的传导规程

`site/data` 为生成器唯一输入，须与内容修订保持同步。修订源头在外层工作区七部书源 md，传导规程如下：

1. 外层重跑解析（`parse-domains` 会覆写 `nodes.json` 布局坐标，需要时 `git checkout` 还原坐标字段）；
2. 搬运 `site/data` 与 `site/public/content` 至本仓；
3. 本仓重跑 `build-quartz-md.mjs`；
4. `quartz build`。

搬运时须与数据一同对齐的还有三处：`site/scripts/build-quartz-md.mjs` 的 `BOOKS` 域映射、`site/scripts/lib/domains.mjs` 的 `KNOWN_DOMAINS`、以及 `site/assets/book-images/<domain>/` 的目录名。三者以 `domain` 键与 `nodes.json` 耦合，域键改名而未同步会使生成器直接抛 `未知域`。

`site/data/term-extract/`（636 片 LLM 术语提取产物，2026-06 冻结）不在上述解析链内，正文修订**不会**自动传导至此：凡涉及法条条号、机构名的内容修订，须同步定向修订该目录（外层与本仓两份，修订映射见外层 `.hermes/plans/引用台账.md`），否则重跑 `merge-terms` / `build-term-nodes` / `build-term-content` 会把 evidence/definition 静默改回旧文。2026-08-11 已按台账修订两侧各 9 片共 11 处（细则 13→14、20→23、51→57；专利法 59→64、61→66、69→75；「应当向专利复审委员会提出」→「应当向国务院专利行政部门提出」）；注意「国防知识产权局专利复审委员会」（国防专利体系机构）及作为词条名的「专利复审委员会」不在替换之列。

本次（2026-08-11）已完成一次全量同步（法条修订 + 书名去年份 + 词条口径 968）。

2026-08-12 关键词索引删词：三书独有词 98 个 + 非专利法域泛词 19 个共 117 个，经 `site/data/term-blacklist.json` 剔除并重跑全链，词条口径 968 → 851。注意本仓 `site/` 缺少七部规范的 `_chunks` 切片源（切片只在外层工作区），故 `merge-terms.mjs` 无法在本仓内直接重跑——在本仓运行会因 evidence 全部校验失败而静默丢失 261 个词条；重跑须在带切片源的工作区进行，再将 `site/data/`、`site/public/content/`、`quartz-kb/content/` 三处产物同步回本仓。

2026-08-12 起 `site/scripts/lib/topics.mjs` 以**本仓为唯一事实源**（含 23 组分组层 `TERM_TOPIC_GROUPS` 与 `manualOnly` 键约定），外层工作区仍是 2026-08-11 旧版：日后按上述规程"外层重跑解析再搬运"前，须先把本仓 `topics.mjs` 反向覆盖到外层，否则已退役的 `examProcedure` 章节主题会原样复活并覆盖分组成果。

## 验证

```bash
cd desktop && npm run smoke
```

端到端冒烟，10 项断言。其中**离线护栏**会阻断一切非 `127.0.0.1` 的请求并统计尝试次数——这把"完全离线"从一句承诺变成了可执行的断言，任何改动都不得让它出现非零值。

服务端行为（gzip、304、CSP、Host 校验、目录穿越防护）的复验命令见 [发布前审查报告](../发布前审查报告.md) 第七节。

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
- 批注、笔记、高亮存于浏览器 localStorage，不离开本机；导出与导入均由你手动选择文件
- 桌面端把本地服务固定在 `127.0.0.1:47821`——端口是 localStorage 的隔离维度，固定它才能保证批注不会因换端口而"消失"

## 许可

代码 [MIT](LICENSE)；内容见 [CONTENT_LICENSE.md](CONTENT_LICENSE.md)；第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
