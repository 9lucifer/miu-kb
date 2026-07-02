# Miu KB 技术细节

Miu KB 是给 Codex App / Codex CLI 使用的本地个人知识库 runtime。当前产品形态已经收敛为 **Mac App + 本地 runtime**，不再把网页端作为用户入口。本地 HTTP 服务主要负责给 Mac App 调用 API；代码中若保留旧 HTML 控制台，也只作为内部调试 / 兼容入口，不作为发布给用户的产品入口。

## 目标定位

Miu KB 解决的是 Codex 会话之间的长期上下文继承问题：

- 在用户提问前，自动从本地知识库召回相关记忆并注入 Codex 上下文。
- 在 Codex 回答结束后，异步沉淀本轮对话，生成候选记忆。
- 候选记忆经过人工审核或 AI 复核后，才进入长期记忆库。
- 支持全局、项目、分支三层作用域，降低跨项目污染。
- 提供生命周期、引用解释、自检和设置能力，让记忆系统可审计、可回滚、可卸载。

## 运行分层

### 1. Codex 集成层

Codex 通过 hook 和 MCP 接入 Miu KB：

- `UserPromptSubmit` hook：用户提交问题前触发，调用 `bin/codex-memory-hook.sh user-prompt`。
- `Stop` hook：Codex 本轮回答结束后触发，调用 `bin/codex-memory-hook.sh stop`。
- MCP server：`src/mcp.mjs` 暴露 `get_context`、`search_memories`、`add_memory`、`edit_memory`、`forget_memory`。
- `AGENTS.md` 注入：写入“优先使用 miu-kb 作为持久记忆层”的说明，给 Codex 读到稳定操作约束。

hook 定义来自 `hooks/miu-kb-hooks.json`，安装和修复逻辑在 `bin/install-on-mac.mjs` 与 `bin/server.mjs`。

### 2. 本地 runtime 层

本地 runtime 由 Node.js 脚本组成：

- `bin/codex-memory-hook.sh`：hook 统一入口，负责定位 Node 和分发事件。
- `bin/user-prompt-recall.mjs`：前置检索脚本，读取 hook payload，调用 miu-kb recall，向 stdout 输出可注入上下文，并记录 recall trace。
- `bin/stop-enqueue.mjs`：后置入队脚本，保存原始 turn snapshot，把 turn 写入 `pending.db`，再 detached 启动 worker。
- `bin/worker.mjs`：异步 worker，负责 LLM 提炼候选记忆、AI 复核、重复判断、写入候选或长期记忆。
- `bin/server.mjs`：本地 API server，监听 `127.0.0.1:17322`，使用本地 token 保护，面向 Mac App；旧 HTML 控制台若仍存在，仅作为内部调试 / 兼容入口。
- `src/store.mjs`：长期记忆库封装，负责 SQLite、FTS5、中文 bigram、召回、写入、编辑、软删除。

### 3. Mac App 管理层

Mac App 位于 `MiuKbMac/`，使用 SwiftUI 编写。它不直接操作数据库，而是调用本地 API server：

- 首次使用：初始化 / 修复 hook、MCP、AGENTS.md、权限、依赖。
- 概览：查看候选、长期记忆、队列、空间占用等统计。
- 审核台：人工保存、批准写入、拒绝、删除、恢复、批量处理。
- 知识库：查看长期记忆，执行删除、恢复、生命周期检查。
- 引用解释：查看每轮 Codex 读了哪些规则和记忆。
- AI 队列：查看正在排队、处理中、已处理、错误的 AI 批次及明细。
- 自检：检查 hook、MCP、CLI、Codex CLI、日志和模型调用。
- 设置：注入 / 清除 hook 与 MCP，清除记忆，卸载配置，调整模型和提示词。

## 数据存储

默认数据目录是 `~/.config/miu-kb`，默认安装目录是 `~/.codex/miu-kb`。

### `local.db`

`local.db` 是长期记忆库，由 `src/store.mjs` 管理。

核心表：

- `memories`：长期记忆正文、标签、作用域、项目 ID、类型、分支名、元数据、删除时间。
- `memories_fts`：FTS5 全文索引，配合中文 bigram 扩展检索。

记忆类型：

- `rule`：长期规则或偏好。
- `decision`：稳定决策。
- `fact`：可复用事实。
- `note`：一般笔记。

作用域：

- `global`：所有 Codex 会话可用。
- `project`：同一项目可用。
- `branch`：同一项目下指定分支优先命中。底层仍按项目存储，并通过 `branch:<encodeURIComponent(branch)>` 标签和 `branch_name` 字段过滤。

### `pending.db`

`pending.db` 是审核、队列和审计库，由 `lib/core.mjs` 初始化。

核心表：

- `turns`：每个后置 hook 入队的 turn，包含 cwd、状态、raw snapshot 路径和处理时间。
- `candidates`：候选记忆，包含类型、作用域、分支、内容、敏感性、动作、目标候选或目标记忆。
- `review_events`：人工审核、AI 审核、删除、恢复等候选级操作。
- `lifecycle_events`：长期记忆生命周期，包括批准、更新、提升、归档、删除、恢复。
- `recall_traces`：前置召回痕迹，记录本轮 Codex 注入了哪些记忆、命中原因、token 估算和错误。

### 其他文件

- `raw/turns/*.json`：后置 hook 保存的原始 turn payload。
- `logs/hook.log`：前置检索和后置入队日志。
- `logs/worker.log`：AI worker 处理日志。
- `logs/server.err.log`：本地服务错误日志。
- `settings.json`：模型、阈值、上下文长度、超时等配置。
- `extractor-prompt.md`：异步提炼候选记忆的提示词。
- `ai-review-prompt.md`：AI 复核当前页候选时使用的提示词。
- `token`：本地 API token。

## 核心流程

### 前置召回

1. 用户在 Codex App 或 Codex CLI 提交问题。
2. Codex 触发 `UserPromptSubmit` hook。
3. `codex-memory-hook.sh` 分发到 `user-prompt-recall.mjs`。
4. 脚本从 payload 中提取用户问题、cwd、session、turn、分支等信息。
5. 脚本调用 miu-kb recall，从 `local.db` 检索规则和长期记忆。
6. 检索会结合作用域、项目、分支、FTS5、中文 bigram、弱词过滤和敏感信息过滤。
7. 命中的上下文通过 stdout 注入 Codex。
8. 本轮注入记录写入 `recall_traces`，供“引用解释”查看。

### 后置沉淀

1. Codex 回答结束后触发 `Stop` hook。
2. `codex-memory-hook.sh` 分发到 `stop-enqueue.mjs`。
3. 脚本把 hook payload 保存为 raw snapshot，并把 turn 写入 `pending.db.turns`。
4. 脚本 detached 启动 `worker.mjs`，不阻塞用户继续使用 Codex。
5. worker 读取 transcript tail，执行密钥脱敏。
6. worker 调用 Codex CLI 模型执行提炼 prompt。
7. LLM 输出候选记忆动作：`create_new`、`update_existing`、`skip_duplicate`、`merge_pending`。
8. 如果 LLM 失败，worker 可退回启发式候选，且在候选 rationale 中保留失败信息。
9. 通过重复判断、敏感信息判断和价值判断的候选写入 `candidates`。
10. Mac App 审核台展示待审核候选。

### 审核与写入

候选进入长期记忆前必须经过审核：

- 人工审核：用户在审核台保存、批准、拒绝、删除或恢复。
- AI 复核：用户点击“AI 复核当前页”，系统创建特殊 turn，worker 对指定候选批量决策。

AI 复核有三种结果：

- `approve`：写入或更新长期记忆。
- `reject`：拒绝无价值、重复、敏感、临时、表达差或不可靠的候选。
- `keep`：保留待审，交给人工确认。

长期记忆写入只发生在人工批准或 AI 复核 `approve` 之后；普通 Stop hook 的异步提炼只产出候选，不直接把普通候选写入长期库。写入长期记忆时，会同步记录：

- `review_events`：候选被如何处理。
- `lifecycle_events`：长期记忆被批准、更新、删除、恢复或归档。

### MCP 工具调用

Codex 可以不依赖 hook，直接通过 MCP 调用：

- `get_context`：给当前任务召回上下文。
- `search_memories`：搜索本地长期记忆。
- `add_memory`：写入明确、稳定、非敏感的记忆。
- `edit_memory`：修改已有记忆。
- `forget_memory`：软删除已有记忆。

MCP 入口由 `miu-kb.mjs serve` 启动，实际实现是 `src/mcp.mjs` 和 `src/store.mjs`。

## 检索策略

Miu KB 当前不是向量 RAG，而是本地 SQLite + FTS5 + 结构化过滤：

- 英文、代码符号、路径、分支名通过 FTS5 命中。
- 中文通过 bigram 扩展进入 `search_text`，补足 FTS5 对中文分词不友好的问题。
- 弱词和停用词降低“这个、那里、问题、修改”等泛词影响。
- `scope`、`project_id`、`branch_name` 和 `branch:` 标签控制召回边界。
- `recall_traces` 记录每轮命中的规则、记忆、token 估算和错误，解决召回不透明问题。

这套方案的优点是部署轻、可离线、可审计、迁移简单。缺点是语义泛化能力弱于 embedding，需要通过提示词、标签、项目/分支范围和弱词库持续校准。

## 安装与迁移

### 安装

Mac App 首次打开后，用户点击“初始化 / 修复 Hook 与配置”。App 会调用本地安装逻辑完成：

- 复制 runtime 到 `~/.codex/miu-kb`。
- 安装 Node 依赖并记录 Node 路径。
- 初始化 `~/.config/miu-kb`。
- 写入 Codex hook、MCP、插件信任和 `AGENTS.md` 说明。
- 创建 LaunchAgent，让本地 API server 可以被 App 使用。

### 迁移

迁移到另一台 Mac 时，需要带上：

- runtime：`~/.codex/miu-kb`
- 数据：`~/.config/miu-kb`
- Codex 配置中的 hook / MCP / AGENTS.md 注入
- Mac App release 包

`bin/export-migration.mjs` 和 `bin/install-on-mac.mjs --overwrite` 用来处理这类迁移。

## 安全与边界

- 本地服务只监听 `127.0.0.1`，并使用 token。
- hook 注入前会过滤敏感内容。
- worker 提炼前会脱敏密钥、token、私钥等模式。
- MCP 的 `add_memory` 明确要求不要保存 secrets 或短期私密内容。
- 记忆删除默认是软删除，支持恢复和生命周期追踪。
- 卸载功能需要用户确认，避免误删 hook、MCP 和本地数据。

## 主要文件索引

- `README.md`：项目简介、开发和迁移命令。
- `package.json`：Node runtime 依赖和版本要求。
- `lib/core.mjs`：路径、设置、pending 数据库、项目/分支工具函数。
- `src/store.mjs`：长期记忆库、FTS5、中文 bigram、召回和 CRUD。
- `src/mcp.mjs`：MCP server 工具定义。
- `bin/codex-memory-hook.sh`：Codex hook shell 入口。
- `bin/user-prompt-recall.mjs`：前置召回。
- `bin/stop-enqueue.mjs`：后置入队。
- `bin/worker.mjs`：异步提炼和 AI 复核。
- `bin/server.mjs`：Mac App 本地 API server、安装修复、自检、设置。
- `bin/install-on-mac.mjs`：安装、迁移、hook/MCP 注入。
- `MiuKbMac/Sources/MiuKbMac/main.swift`：SwiftUI Mac App。
- `MiuKbMac/scripts/build-app.sh`：Mac App 打包脚本。

核心流程图见 `docs/miu-kb-core-flow.drawio`。
