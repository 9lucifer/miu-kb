#!/usr/bin/env node
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "../lib/sqlite-sync.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const APP_DIR = dirname(dirname(SCRIPT_PATH));
const HOME = homedir();
const DATA_DIR = join(HOME, ".config", "miu-kb");
const OLD_REVIEW_DATA_DIR = join(HOME, ".config", "codex-memory");
const OLD_MEMORIES_DB_PATH = join(HOME, ".config", "memories", "local.db");
const OUT_DIR = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : join(HOME, "Desktop");
const INCLUDE_RAW = process.argv.includes("--include-raw-turns");
const STAMP = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const BUNDLE_NAME = `miu-kb-mac-migration-${STAMP}`;
const BUNDLE_DIR = join(OUT_DIR, BUNDLE_NAME);
const ARCHIVE_PATH = `${BUNDLE_DIR}.tar.gz`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function sqliteSnapshot(source, target) {
  if (!source || !existsSync(source)) return false;
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  try {
    const db = new DatabaseSync(source, { readOnly: true });
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    db.close();
  } catch {
    copyFileSync(source, target);
  }
  return true;
}

function firstExisting(paths) {
  return paths.find((path) => existsSync(path)) || null;
}

function copyApp() {
  const target = join(BUNDLE_DIR, "miu-kb");
  cpSync(APP_DIR, target, {
    recursive: true,
    filter: (path) => shouldCopyAppItem(path),
  });
}

function shouldCopyAppItem(path) {
  const parts = relative(APP_DIR, path).split(/[\\/]/).filter(Boolean);
  if (!parts.length) return true;
  if (parts.includes("node_modules") || parts.includes(".git") || parts.includes(".build")) return false;
  if (parts[0] === "MiuKbMac" && parts[1] === "dist") return false;
  return !path.endsWith(".DS_Store");
}

function copyData() {
  const target = join(BUNDLE_DIR, "data");
  mkdirSync(target, { recursive: true });
  sqliteSnapshot(firstExisting([join(DATA_DIR, "pending.db"), join(OLD_REVIEW_DATA_DIR, "pending.db")]), join(target, "pending.db"));
  sqliteSnapshot(firstExisting([join(DATA_DIR, "local.db"), OLD_MEMORIES_DB_PATH]), join(target, "local.db"));
  for (const name of ["extractor-prompt.md", "settings.json"]) {
    const source = firstExisting([join(DATA_DIR, name), join(OLD_REVIEW_DATA_DIR, name)]);
    if (source) copyFileSync(source, join(target, name));
  }
  const rawTurns = firstExisting([join(DATA_DIR, "raw", "turns"), join(OLD_REVIEW_DATA_DIR, "raw", "turns")]);
  if (INCLUDE_RAW && rawTurns) {
    cpSync(rawTurns, join(target, "raw-turns"), { recursive: true });
  }
}

function writeRootInstaller() {
  writeFileSync(join(BUNDLE_DIR, "install-on-mac.mjs"), `#!/usr/bin/env node
import "./miu-kb/bin/install-on-mac.mjs";
`);
}

function writeReadme() {
  const readme = `# miu-kb Mac Migration

这个包用于把当前 Mac 上的 miu-kb 个人知识库工作流迁移到另一台 Mac。

## 包内包含

- \`miu-kb/\`: 审核台、知识库、AI 队列、hook、worker、CLI 和 MCP server
- \`data/pending.db\`: 待审核/已处理候选数据库快照
- \`data/local.db\`: 长期记忆数据库快照
- \`data/extractor-prompt.md\`: AI 提炼提示词（如果存在）
- \`data/settings.json\`: AI 提炼模型、阈值和超时设置（如果存在）

默认不包含 raw turn 快照、日志、token、Codex auth、OpenAI API key 或任何凭据。

## 在目标 Mac 安装

\`\`\`bash
tar -xzf ${basename(ARCHIVE_PATH)}
cd ${BUNDLE_NAME}
node install-on-mac.mjs --overwrite
\`\`\`

安装脚本会自动：

- 复制程序到 \`~/.codex/miu-kb\`
- 复制数据库到 \`~/.config/miu-kb\`
- 执行 \`npm install --omit=dev\` 安装本地依赖
- 写入 Codex hooks
- 写入 \`[mcp_servers.miu-kb]\`
- 创建 LaunchAgent，默认启动网页端

安装后打开：

\`\`\`text
http://127.0.0.1:17322/
\`\`\`

说明：

- 安装脚本会备份目标机已有的 \`~/.codex/hooks.json\`、\`~/.codex/config.toml\` 和同名数据文件。
- 目标机 token 会重新生成，不会复用本机 token。
- Codex hooks 会直接接入 \`~/.codex/miu-kb/bin/codex-memory-hook.sh\`，不依赖 ccm-harness。
- MCP 工具由 \`miu-kb serve\` 提供，包括 \`get_context\`、\`search_memories\`、\`add_memory\`、\`edit_memory\`、\`forget_memory\`。
`;
  writeFileSync(join(BUNDLE_DIR, "README.md"), readme);
}

function archive() {
  rmSync(ARCHIVE_PATH, { force: true });
  const result = spawnSync("tar", ["-czf", ARCHIVE_PATH, "-C", OUT_DIR, BUNDLE_NAME], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr || "tar failed");
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE_DIR, { recursive: true });
  copyApp();
  copyData();
  writeRootInstaller();
  writeReadme();
  archive();
  log(`迁移目录：${BUNDLE_DIR}`);
  log(`迁移压缩包：${ARCHIVE_PATH}`);
}

main();
