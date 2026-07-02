# miu-kb

miu-kb 是一套给 Codex 使用的本地个人知识库 runtime。

它包含：

- 本地 SQLite 长期记忆库：`better-sqlite3` + FTS5 + 中文 bigram 检索辅助
- Codex hooks：前置检索注入、后置异步入队
- AI worker：从对话 transcript 中提炼候选记忆
- Mac App 管理台：概览、审核台、知识库、引用解释、AI 队列、自检、设置
- CLI：`add/search/recall/edit/forget/list/stats`
- MCP server：`get_context/search_memories/add_memory/edit_memory/forget_memory`
- Mac 迁移/安装脚本：自动初始化数据库、hooks、LaunchAgent 和 MCP 配置

## 本地开发

```bash
npm install
npm run check
node bin/server.mjs
```

Mac App：

```bash
cd MiuKbMac
swift build -c release
```

默认数据：

```text
~/.config/miu-kb/local.db
~/.config/miu-kb/pending.db
```

## CLI

```bash
node bin/miu-kb.mjs add "回答默认使用中文" --type rule --global
node bin/miu-kb.mjs add "PPTX tab 要区分默认制表间距和显式 tab stop" --type fact --tags pptx,tab
node bin/miu-kb.mjs recall "制表间距" --limit 8
node bin/miu-kb.mjs serve
```

## 迁移旧 memories.sh 数据

```bash
node bin/import-memories-sh.mjs
```

## 打包迁移到另一台 Mac

```bash
node bin/export-migration.mjs
```

目标机解压后：

```bash
node install-on-mac.mjs --overwrite
```
