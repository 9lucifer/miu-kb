#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const SOURCE_APP_DIR = basename(SCRIPT_DIR) === "bin"
  ? dirname(SCRIPT_DIR)
  : existsSync(join(SCRIPT_DIR, "miu-kb"))
    ? join(SCRIPT_DIR, "miu-kb")
    : SCRIPT_DIR;
const BUNDLE_ROOT = dirname(SOURCE_APP_DIR);
const SOURCE_DATA_DIR = join(BUNDLE_ROOT, "data");
const HOME = homedir();
const TARGET_APP_DIR = join(HOME, ".codex", "miu-kb");
const TARGET_CODEX_DIR = join(HOME, ".codex");
const TARGET_MARKETPLACE_DIR = join(TARGET_CODEX_DIR, "miu-kb-marketplace");
const TARGET_DATA_DIR = join(HOME, ".config", "miu-kb");
const TARGET_CLI_BIN_DIR = join(HOME, ".local", "bin");
const LAUNCH_AGENT_LABEL = "com.miu.kb";
const LAUNCH_AGENT_PATH = join(HOME, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
const HOOKS_PATH = join(TARGET_CODEX_DIR, "hooks.json");
const CONFIG_PATH = join(TARGET_CODEX_DIR, "config.toml");
const AGENTS_PATH = join(TARGET_CODEX_DIR, "AGENTS.md");

const args = new Set(process.argv.slice(2));
const OVERWRITE = args.has("--overwrite");
const AUTO_INSTALL_DEPS = !args.has("--no-install-deps");
const NO_LAUNCH = args.has("--no-launch");
const NO_HOOKS = args.has("--no-hooks");
const MIU_KB_HOOK_TRUST = [
  {
    key: "miu-kb@miu-kb:hooks/miu-kb-hooks.json:user_prompt_submit:0:0",
    trustedHash: "sha256:4bb9beecfab8e54d1f35b1ba0f050e9730748063075d064ce01b5b00abd112d0",
  },
  {
    key: "miu-kb@miu-kb:hooks/miu-kb-hooks.json:stop:0:0",
    trustedHash: "sha256:6b648cf18e456b77477bd54e2a7405df89f22ea2280a99b351c7501edea3dad8",
  },
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function shell(command, options = {}) {
  return spawnSync("bash", ["-lc", command], {
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function commandPath(name) {
  const result = shell(`command -v ${name}`);
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : "";
}

function commandOutput(bin, args) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function nodeMajor(nodeBin) {
  return Number(commandOutput(nodeBin, ["-p", "process.versions.node.split('.')[0]"]) || 0);
}

function nvmNodeBins() {
  const dir = join(HOME, ".nvm", "versions", "node");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((name) => join(dir, name, "bin", "node"));
}

function supportedNodeBin() {
  const candidates = uniqueExisting([
    process.env.MIU_KB_NODE_BIN,
    ...nvmNodeBins(),
    "/opt/homebrew/opt/node@22/bin/node",
    "/opt/homebrew/opt/node@20/bin/node",
    "/usr/local/opt/node@22/bin/node",
    "/usr/local/opt/node@20/bin/node",
    commandPath("node"),
    process.execPath,
  ]);
  return candidates.find((nodeBin) => {
    const major = nodeMajor(nodeBin);
    return major >= 18 && major <= 24;
  });
}

function uniqueExisting(paths) {
  const seen = new Set();
  const result = [];
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    const resolved = resolve(path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function codexBins() {
  return uniqueExisting([
    process.env.CODEX_CLI_PATH,
    "/Applications/Codex.app/Contents/Resources/codex",
    commandPath("codex"),
  ]);
}

function backupPath(path) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${path}.bak.${stamp}`;
}

function backupExisting(path) {
  if (!existsSync(path)) return null;
  const backup = backupPath(path);
  renameSync(path, backup);
  return backup;
}

function copyReplacing(source, target, { directory = false } = {}) {
  if (!existsSync(source)) return false;
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (!OVERWRITE) {
      log(`保留已有文件，跳过：${target}`);
      return false;
    }
    const backup = backupExisting(target);
    log(`已备份：${backup}`);
  }
  if (directory) {
    log(`复制目录：${source} -> ${target}`);
    cpSync(source, target, {
      recursive: true,
      filter: (item) => shouldCopyInstallItem(source, item),
    });
  } else {
    log(`复制文件：${source} -> ${target}`);
    copyFileSync(source, target);
  }
  return true;
}

function shouldCopyInstallItem(source, item) {
  const rel = relative(source, item);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return true;
  if (parts.includes("node_modules") || parts.includes(".git") || parts.includes(".build")) return false;
  if (parts[0] === "MiuKbMac" && parts[1] === "dist") return false;
  return !item.endsWith(".DS_Store");
}

function ensureToken() {
  const tokenPath = join(TARGET_DATA_DIR, "token");
  if (existsSync(tokenPath)) return;
  mkdirSync(TARGET_DATA_DIR, { recursive: true });
  writeFileSync(tokenPath, `${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
}

function installNodeDeps(nodeBin) {
  if (
    existsSync(join(TARGET_APP_DIR, "node_modules", "better-sqlite3", "package.json")) &&
    existsSync(join(TARGET_APP_DIR, "node_modules", "@modelcontextprotocol", "sdk", "package.json"))
  ) {
    return;
  }
  if (!AUTO_INSTALL_DEPS) {
    log("已跳过依赖安装；如首次安装，请在 ~/.codex/miu-kb 内手动运行 npm install --omit=dev。");
    return;
  }
  const nodeDir = dirname(nodeBin);
  const npmBesideNode = join(nodeDir, "npm");
  const npm = existsSync(npmBesideNode) ? npmBesideNode : commandPath("npm");
  if (!npm || !existsSync(npm)) {
    log("未找到 npm，无法自动安装 miu-kb 依赖。");
    return;
  }
  log(`npm：${npm}`);
  log(`npm 版本：${commandOutput(npm, ["-v"]) || "未知"}`);
  log(`执行命令：cd ${TARGET_APP_DIR} && npm install --omit=dev`);
  const result = spawnSync(npm, ["install", "--omit=dev"], {
    cwd: TARGET_APP_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${nodeDir}:${process.env.PATH || ""}`,
    },
  });
  if (result.status !== 0) {
    throw new Error("miu-kb 依赖安装失败");
  }
}

function installCliShim() {
  mkdirSync(TARGET_CLI_BIN_DIR, { recursive: true });
  const target = join(TARGET_CLI_BIN_DIR, "miu-kb");
  rmSync(target, { force: true });
  symlinkSync(join(TARGET_APP_DIR, "bin", "miu-kb.mjs"), target);
  log(`已安装 CLI：${target}`);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function writeLaunchAgent(nodeBin) {
  mkdirSync(dirname(LAUNCH_AGENT_PATH), { recursive: true });
  const nodeDir = dirname(nodeBin);
  const pathValue = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>${xmlEscape(join(TARGET_APP_DIR, "bin", "server.mjs"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(HOME)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathValue)}</string>
    <key>MIU_KB_APP_DIR</key>
    <string>${xmlEscape(TARGET_APP_DIR)}</string>
    <key>MIU_KB_DATA_DIR</key>
    <string>${xmlEscape(TARGET_DATA_DIR)}</string>
    <key>MIU_KB_NODE_BIN</key>
    <string>${xmlEscape(nodeBin)}</string>
    <key>MIU_KB_BIN</key>
    <string>${xmlEscape(join(TARGET_APP_DIR, "bin", "miu-kb.mjs"))}</string>
    <key>MIU_KB_DB</key>
    <string>${xmlEscape(join(TARGET_DATA_DIR, "local.db"))}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(TARGET_DATA_DIR, "logs", "server.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(TARGET_DATA_DIR, "logs", "server.err.log"))}</string>
</dict>
</plist>
`;
  writeFileSync(LAUNCH_AGENT_PATH, plist);
  log(`已写入 LaunchAgent：${LAUNCH_AGENT_PATH}`);
}

function mergeHooksJson() {
  mkdirSync(TARGET_CODEX_DIR, { recursive: true });
  let config = { hooks: {} };
  if (existsSync(HOOKS_PATH)) {
    try {
      config = JSON.parse(readFileSync(HOOKS_PATH, "utf8"));
    } catch {
      const backup = backupExisting(HOOKS_PATH);
      log(`hooks.json 解析失败，已备份旧文件：${backup}`);
      config = { hooks: {} };
    }
  }
  config.hooks ||= {};
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    config.hooks[event] = existing.filter((entry) => {
      if (entry?._source === "miu-kb" || entry?._source === "codex-memory-review") return false;
      const text = JSON.stringify(entry);
      return !(text.includes("codex-memory-hook.sh") || text.includes(".codex/memory-review") || text.includes(".codex/miu-kb"));
    });
  }
  if (existsSync(HOOKS_PATH)) {
    const backup = backupPath(HOOKS_PATH);
    copyFileSync(HOOKS_PATH, backup);
    log(`已备份 hooks.json：${backup}`);
  }
  writeFileSync(HOOKS_PATH, `${JSON.stringify(config, null, 2)}\n`);
  log("已清理 hooks.json 中的旧 miu-kb 入口；Codex 插件负责前后置 hook。");
}

function ensureFeaturesHooks(toml) {
  const lines = toml.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[features]");
  if (start === -1) return `${toml.trimEnd()}\n\n[features]\nhooks = true\n`;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  let found = false;
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*hooks\s*=/.test(lines[index])) {
      lines[index] = "hooks = true";
      found = true;
      break;
    }
  }
  if (!found) lines.splice(start + 1, 0, "hooks = true");
  return lines.join("\n");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function updateCodexConfig(nodeBin) {
  mkdirSync(TARGET_CODEX_DIR, { recursive: true });
  let toml = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  toml = ensureFeaturesHooks(toml);
  if (!/^\s*\[mcp_servers\.miu-kb\]\s*$/m.test(toml)) {
    const nodeDir = dirname(nodeBin);
    toml = `${toml.trimEnd()}

[mcp_servers.miu-kb]
command = ${tomlString(nodeBin)}
args = [ ${tomlString(join(TARGET_APP_DIR, "bin", "miu-kb.mjs"))}, "serve" ]

  [mcp_servers.miu-kb.env]
  MIU_KB_DB = ${tomlString(join(TARGET_DATA_DIR, "local.db"))}
  MIU_KB_APP_DIR = ${tomlString(TARGET_APP_DIR)}
  MIU_KB_DATA_DIR = ${tomlString(TARGET_DATA_DIR)}
  PATH = ${tomlString(`${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}
`;
  }
  if (existsSync(CONFIG_PATH)) {
    const backup = backupPath(CONFIG_PATH);
    copyFileSync(CONFIG_PATH, backup);
    log(`已备份 config.toml：${backup}`);
  }
  writeFileSync(CONFIG_PATH, toml);
}

function updateAgentsMd() {
  const marker = "<!-- miu-kb:persistent-memory -->";
  const block = `${marker}
## Persistent Memory

Use miu-kb as the local persistent memory layer for this machine.

- At the start of a new task, fetch relevant context from miu-kb before answering when the task is not trivial.
- Prefer the miu-kb MCP tools when available: \`get_context\`, \`search_memories\`, and \`add_memory\`.
- If MCP tools are unavailable, use the CLI fallback: \`miu-kb recall "<task>" --json\` or \`miu-kb search "<query>"\`.
- Store only durable preferences, project facts, decisions, procedures, and lessons learned.
- Never store secrets, credentials, tokens, or private content that the user has not asked to persist.
- Prefer Chinese responses unless the user asks for another language.
`;
  const existing = existsSync(AGENTS_PATH) ? readFileSync(AGENTS_PATH, "utf8") : "";
  if (existing.includes(marker) || existing.includes("Use miu-kb as the local persistent memory layer")) return;
  writeFileSync(AGENTS_PATH, `${existing.trimEnd()}\n\n${block}\n`);
}

function upsertHookTrustBlock(toml, key, trustedHash) {
  const header = `[hooks.state.${tomlString(key)}]`;
  const block = `${header}\ntrusted_hash = ${tomlString(trustedHash)}\n`;
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedHeader}\\n[\\s\\S]*?(?=\\n\\[[^\\n]+\\]|$)`);
  if (pattern.test(toml)) {
    return toml.replace(pattern, block.trimEnd());
  }
  return `${toml.trimEnd()}\n\n${block}`;
}

function trustCodexPluginHooks() {
  mkdirSync(TARGET_CODEX_DIR, { recursive: true });
  let toml = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  for (const hook of MIU_KB_HOOK_TRUST) {
    toml = upsertHookTrustBlock(toml, hook.key, hook.trustedHash);
  }
  writeFileSync(CONFIG_PATH, toml.trimEnd() + "\n");
  log("已信任 Miu KB Codex 插件 hooks。");
}

function writeCodexMarketplace() {
  const agentsDir = join(TARGET_MARKETPLACE_DIR, ".agents", "plugins");
  const pluginsDir = join(TARGET_MARKETPLACE_DIR, "plugins");
  const pluginLink = join(pluginsDir, "miu-kb");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  rmSync(pluginLink, { recursive: true, force: true });
  symlinkSync(TARGET_APP_DIR, pluginLink, "dir");
  const marketplace = {
    $schema: "https://anthropic.com/agent-sdk/marketplace.schema.json",
    name: "miu-kb",
    description: "Miu KB local persistent memory for Codex.",
    interface: {
      displayName: "Miu KB",
    },
    plugins: [{
      name: "miu-kb",
      description: "Local persistent memory, recall hooks, async extraction, and review UI for Codex.",
      source: {
        source: "local",
        path: "./plugins/miu-kb",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
      tags: ["memory", "codex", "knowledge-base", "local-first"],
    }],
  };
  writeFileSync(
    join(agentsDir, "marketplace.json"),
    `${JSON.stringify(marketplace, null, 2)}\n`,
  );
}

function runCodexPluginCommand(codexBin, args) {
  const result = spawnSync(codexBin, args, {
    cwd: TARGET_APP_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    ok: result.status === 0,
    status: result.status,
    output,
  };
}

function runCodexPluginCommandCompat(codexBin, args) {
  const result = runCodexPluginCommand(codexBin, args);
  if (
    result.ok ||
    !args.includes("--json") ||
    !/unexpected argument '--json'|unknown option.*json/i.test(result.output)
  ) {
    return result;
  }
  return runCodexPluginCommand(codexBin, args.filter((arg) => arg !== "--json"));
}

function installCodexPlugin() {
  writeCodexMarketplace();
  const bins = codexBins();
  if (!bins.length) {
    log("未找到 Codex CLI，已跳过插件安装；旧版 hooks.json 和 MCP 配置仍已写入。");
    return;
  }

  let installed = false;
  for (const codexBin of bins) {
    log(`注册 Miu KB Codex 插件：${codexBin}`);
    const addMarketplace = runCodexPluginCommandCompat(codexBin, [
      "plugin",
      "marketplace",
      "add",
      TARGET_MARKETPLACE_DIR,
      "--json",
    ]);
    if (!addMarketplace.ok && !/already|exists|configured|已/i.test(addMarketplace.output)) {
      log(`  marketplace add 未完成：${addMarketplace.output || `exit ${addMarketplace.status}`}`);
    }

    const addPlugin = runCodexPluginCommandCompat(codexBin, [
      "plugin",
      "add",
      "miu-kb@miu-kb",
      "--json",
    ]);
    if (addPlugin.ok || /already|installed|enabled|已/i.test(addPlugin.output)) {
      installed = true;
      log("  插件已安装/已启用。");
    } else {
      log(`  plugin add 未完成：${addPlugin.output || `exit ${addPlugin.status}`}`);
    }
  }

  if (!installed) {
    log("提示：Miu KB 插件尚未通过 Codex 插件系统安装，后续可手动执行：");
    log(`  codex plugin marketplace add ${TARGET_MARKETPLACE_DIR}`);
    log("  codex plugin add miu-kb@miu-kb");
  }
}

function startLaunchAgent() {
  if (NO_LAUNCH) return;
  mkdirSync(join(TARGET_DATA_DIR, "logs"), { recursive: true });
  shell(`launchctl bootout gui/$(id -u) ${JSON.stringify(LAUNCH_AGENT_PATH)} >/dev/null 2>&1 || true`);
  shell(`launchctl bootstrap gui/$(id -u) ${JSON.stringify(LAUNCH_AGENT_PATH)} >/dev/null 2>&1 || true`);
  shell(`launchctl kickstart -k gui/$(id -u)/${LAUNCH_AGENT_LABEL} >/dev/null 2>&1 || true`);
}

function main() {
  if (!existsSync(SOURCE_APP_DIR)) throw new Error(`找不到 miu-kb 源目录：${SOURCE_APP_DIR}`);
  const nodeBin = supportedNodeBin() || (!AUTO_INSTALL_DEPS && NO_LAUNCH ? commandPath("node") || process.execPath : "");
  if (!nodeBin) throw new Error("找不到支持的 Node.js 18-24；better-sqlite3 暂不支持 Node 25，请用 nvm 安装 Node 22 或 20。");

  log(`安装源：${resolve(SOURCE_APP_DIR)}`);
  log(`Node：${nodeBin}`);
  log(`Node 版本：${commandOutput(nodeBin, ["-v"]) || "未知"}`);
  log(`目标程序：${TARGET_APP_DIR}`);
  log(`目标数据：${TARGET_DATA_DIR}`);
  log(`目标 LaunchAgent：${LAUNCH_AGENT_PATH}`);

  copyReplacing(SOURCE_APP_DIR, TARGET_APP_DIR, { directory: true });
  log("创建数据目录：local.db / pending.db 会在首次使用时自动初始化表。");
  mkdirSync(TARGET_DATA_DIR, { recursive: true });
  mkdirSync(join(TARGET_DATA_DIR, "logs"), { recursive: true });
  mkdirSync(join(TARGET_DATA_DIR, "raw", "turns"), { recursive: true });

  installNodeDeps(nodeBin);
  writeFileSync(join(TARGET_APP_DIR, ".node-bin"), `${nodeBin}\n`);
  installCliShim();

  copyReplacing(join(SOURCE_DATA_DIR, "pending.db"), join(TARGET_DATA_DIR, "pending.db"));
  copyReplacing(join(SOURCE_DATA_DIR, "local.db"), join(TARGET_DATA_DIR, "local.db"));
  copyReplacing(join(SOURCE_DATA_DIR, "memories-local.db"), join(TARGET_DATA_DIR, "local.db"));
  copyReplacing(join(SOURCE_DATA_DIR, "extractor-prompt.md"), join(TARGET_DATA_DIR, "extractor-prompt.md"));
  copyReplacing(join(SOURCE_DATA_DIR, "settings.json"), join(TARGET_DATA_DIR, "settings.json"));
  ensureToken();

  if (!NO_HOOKS) {
    mergeHooksJson();
    updateCodexConfig(nodeBin);
    updateAgentsMd();
    installCodexPlugin();
    trustCodexPluginHooks();
  }

  writeLaunchAgent(nodeBin);
  startLaunchAgent();

  log("");
  log("安装完成。打开：");
  log("  http://127.0.0.1:17322/");
  log("");
  log("常用检查：");
  log(`  launchctl print gui/$(id -u)/${LAUNCH_AGENT_LABEL}`);
  log("  tail -f ~/.config/miu-kb/logs/server.err.log");
}

main();
