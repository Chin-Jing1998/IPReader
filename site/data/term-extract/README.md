# `term-extract/` · 文件名与 `chunk` 字段的对应约定

本目录存放 `wf-extract-terms` 的逐片术语提取产物（745 片 JSON），消费方为
`scripts/merge-terms.mjs` 与 `scripts/lib/term-extract-index.mjs`（另经后者供
`build-term-nodes.mjs` / `build-term-content.mjs` 复用）。

## 既有约定

文件名 = `chunk` 路径把 `/` 换成 `__` 再加 `.json`，例如
`chemistry-drafting-rules/01/002` ↔ `chemistry-drafting-rules__01__002.json`。
636 片非商标域产物**继续满足**该恒等式。

## 2026-08-24（阶段5.2 批次 W-3）起的例外：`trademark-exam-guide-2021__*.json`（109 片）

商标审查审理指南域在阶段5.2 连做两件事：批次 W-1 把节点树由 104 扩为 813，
批次 W-2 用 slice-tools v3 原生切片（1201 片）整体覆写了 `_chunks/`。
109 片的两根指针据此重指（`scripts/oneoff-migrate-term-extract-phase52.mjs`）：

- `anchorNode` → 新树节点 id；
- `chunk` → v3 切片路径。

**这 109 片的文件名不再等于 `chunk` 路径**，理由是恒等式在本域已不可维持：
109 片中有 75 片的证据散落在同一节点／章下的多个 v3 切片，其 `chunk` 必须落到
目录级；而其中 11 个目录被 2~3 个片共用（例如 `trademark-exam-guide-2021/08`
被 3 个片共用），按新路径改名必然撞名。故采用「文件名保留旧名不动、仅改内部字段」
的方案，旧文件名在本域退化为**不含语义的稳定标识**。

### 消费方影响：无

`merge-terms.mjs:192` 与 `lib/term-extract-index.mjs:29` 均以 `rec.chunk` 为准，
只有在 `chunk` 字段缺失时才回退「按文件名拼路径」；109 片的 `chunk` 字段均存在。

### 字段口径

- `chunk` 为**单个切片文件**（去 `.md`）或**切片目录**两种形态之一，
  由 `merge-terms.mjs::chunkText()` 分别按 `<path>.md` 与 `collectMd(<dir>)`
  两条路径解析，段数不限；
- 恒有 `anchorNode ≡ pathToNodeId(chunk)`（`slice-tools/lib/tmeg.mjs:39-45`：
  去 `.md` → 去尾部 `_preamble` → 剥掉尾部全部 `d\d+` 段 → 段间以 `-` 连接、前置 `tmeg-`），
  且 `anchorNode` 的子树覆盖本片全部 `evidence`；
- 证据落在深叶片（`dNN`）时，若该片证据集中于单一深叶片则 `chunk` 直接指向该深叶片文件，
  否则由其所属节点的目录级 `chunk` 经 `collectMd` 递归覆盖。

迁移前快照：`_整理工作区/仓库快照/term-extract-tmeg片_20260824_W3前.tar.gz`。
