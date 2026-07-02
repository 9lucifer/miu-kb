# Miu KB

<p>
  <img alt="macOS SwiftUI" src="https://img.shields.io/badge/macOS-SwiftUI-111827?style=flat-square&logo=apple&logoColor=white">
  <img alt="Codex hooks and MCP" src="https://img.shields.io/badge/Codex-hooks%20%2B%20MCP-2563eb?style=flat-square">
  <img alt="Local SQLite" src="https://img.shields.io/badge/storage-SQLite-0f766e?style=flat-square&logo=sqlite&logoColor=white">
  <img alt="Node 18 to 24" src="https://img.shields.io/badge/node-18--24-16a34a?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Local first" src="https://img.shields.io/badge/privacy-local--first-7c3aed?style=flat-square">
</p>

给 Codex App 和 Codex CLI 使用的本地持久记忆系统。

Miu KB 会在每轮 Codex 对话前检索本地知识库并注入相关上下文，在对话结束后异步提炼候选记忆，再通过原生 macOS App 让用户审核、合并、拒绝、删除和追踪生命周期。

> 当前产品形态是 **SwiftUI 原生 Mac App + 本地 runtime + Codex hooks/MCP**。本地 HTTP 服务只作为 App 与 runtime 的通信层，不作为独立网页端产品维护。

## 适合什么场景

| 场景 | Miu KB 做什么 |
| --- | --- |
| 新 Codex session 没有上下文 | 自动召回全局、项目、分支范围内的相关记忆 |
| 对话里产生了可复用经验 | Stop hook 异步入队，由 AI 提炼候选记忆 |
| AI 提炼太碎或不准 | 候选先进入审核台，用户确认后才写入长期记忆 |
| 不知道本轮用了哪些记忆 | Recall Trace 展示命中项、原因、分数和 token 估算 |
| 换机器继续使用 | 支持导出迁移包，在另一台 Mac 初始化恢复 |

## 核心能力

| 能力 | 标签 | 说明 |
| --- | --- | --- |
| 本地优先 | `SQLite` `local-first` | 长期记忆、候选队列、生命周期审计都存储在本机 |
| Codex 集成 | `hooks` `MCP` | 接入 `UserPromptSubmit` 和 `Stop` hooks，同时提供 MCP 工具 |
| 人审闭环 | `review` `approval` | AI 只负责提炼和建议，最终写入、合并、拒绝由用户控制 |
| 范围管理 | `global` `project` `branch` | 支持全局、项目、分支三级记忆，避免临时分支知识污染全局 |
| 可审计 | `trace` `lifecycle` | 候选、写入、合并、删除、恢复、归档都有生命周期记录 |
| 可观测 | `self-check` `logs` | 自检页覆盖 hooks、MCP、CLI、Node、模型调用、日志和性能日志 |

## 快速开始

### 环境要求

- macOS
- Node.js 18-24，推荐 Node.js 22
- Codex App 或 Codex CLI

### 从源码安装

```bash
git clone git@github.com:9lucifer/miu-kb.git
cd miu-kb
node bin/install-on-mac.mjs --overwrite
```

安装脚本会初始化本地目录、SQLite 表、Codex hooks、MCP 配置和 `AGENTS.md` 记忆说明。

### 构建 Mac App

```bash
MiuKbMac/scripts/build-app.sh
open "MiuKbMac/dist/Miu KB.app"
```

首次打开 App 后，可以在「首次使用」或「自检」页确认 hook、MCP、CLI 和模型调用状态。

## 工作流

```text
用户向 Codex 提问
  -> UserPromptSubmit hook
  -> Miu KB 检索本地 SQLite
  -> 相关记忆注入本轮上下文

Codex 回答结束
  -> Stop hook
  -> 对话片段进入异步队列
  -> AI 提炼候选记忆
  -> 用户在 Mac App 审核
  -> 写入长期知识库
```

## Mac App

Mac App 是 Miu KB 的主界面，负责所有可视化管理。

| 页面 | 用途 |
| --- | --- |
| 首次使用 | 初始化或修复 hooks、MCP、权限和本地配置 |
| 概览 | 查看候选、长期记忆、队列、空间占用和趋势统计 |
| 审核台 | 审核候选记忆，支持保存、批量写入、AI 复核、合并、拒绝 |
| 知识库 | 浏览长期记忆，管理范围、状态、生命周期和删除恢复 |
| 引用解释 | 查看每轮 Codex 注入了哪些记忆以及为什么命中 |
| AI 队列 | 查看异步提炼和批量复核任务，包括已处理批次明细 |
| 自检 | 检查 hook、MCP、CLI、Node、日志和模型调用是否正常 |
| 设置 | 配置模型、提示词、阈值、hook 注入/清理、数据清除和卸载 |

## CLI

安装后可以直接使用 `miu-kb`：

```bash
miu-kb add "回答默认使用中文" --type rule --global
miu-kb add "PPTX tab 要区分默认制表间距和显式 tab stop" --type fact --tags pptx,tab
miu-kb recall "制表间距" --limit 8 --json
miu-kb search "tab stop" --limit 10 --json
miu-kb serve
```

在源码目录内调试时可以使用：

```bash
node bin/miu-kb.mjs recall "hook 状态" --json
```

## MCP

Miu KB 提供 Codex 可调用的本地 MCP 工具：

- `get_context`：按当前任务召回上下文
- `search_memories`：搜索长期知识库
- `add_memory`：显式写入一条长期记忆

如果 MCP transport 断开，可以暂时使用 CLI 兜底，重启 Codex App 或新开会话后会重新连接。

## 本地目录

```text
~/.codex/miu-kb              安装后的 runtime
~/.config/miu-kb/local.db    长期记忆数据库
~/.config/miu-kb/pending.db  审核、队列、生命周期、引用解释数据库
~/.config/miu-kb/settings.json
~/.config/miu-kb/logs
```

## 开发

```bash
npm install
npm run check
node bin/server.mjs
```

构建 SwiftUI App：

```bash
swift build --package-path MiuKbMac -c release
```

打包可运行的 `.app`：

```bash
MiuKbMac/scripts/build-app.sh
```

## 迁移

导入旧 `memories.sh` 数据：

```bash
node bin/import-memories-sh.mjs
```

导出迁移包：

```bash
node bin/export-migration.mjs
```

在另一台 Mac 上恢复：

```bash
node install-on-mac.mjs --overwrite
```

## 故障排查

优先打开 Mac App 的「自检」页。常用日志：

```bash
tail -f ~/.config/miu-kb/logs/server.err.log
tail -f ~/.config/miu-kb/logs/hook.log
tail -f ~/.config/miu-kb/logs/worker.log
tail -f ~/.config/miu-kb/logs/perf.log
```

如果 `better-sqlite3` 出现 Node ABI 不匹配，切到受支持的 Node 版本后重新安装依赖：

```bash
nvm install 22
nvm use 22
npm install
```

## 参考文档

- [技术细节](docs/technical-details.md)
- [核心流程图源文件](docs/miu-kb-core-flow.drawio)
