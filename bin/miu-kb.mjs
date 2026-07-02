#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(import.meta.url);
const APP_DIR = dirname(dirname(CLI_PATH));

function sameExecutable(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function pinnedNodeBin() {
  if (process.env.MIU_KB_NODE_BIN) return process.env.MIU_KB_NODE_BIN;
  const nodeBinPath = join(APP_DIR, ".node-bin");
  if (!existsSync(nodeBinPath)) return "";
  try {
    return readFileSync(nodeBinPath, "utf8").trim();
  } catch {
    return "";
  }
}

function reexecWithPinnedNode() {
  if (process.env.MIU_KB_NO_REEXEC === "1") return;
  const nodeBin = pinnedNodeBin();
  if (!nodeBin || !existsSync(nodeBin) || sameExecutable(nodeBin, process.execPath)) return;
  const result = spawnSync(nodeBin, ["--no-warnings=ExperimentalWarning", CLI_PATH, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      MIU_KB_NODE_BIN: nodeBin,
      MIU_KB_REEXECED: "1",
    },
  });
  if (result.error) {
    process.stderr.write(`[miu-kb] failed to switch to pinned Node: ${result.error.message}\n`);
    return;
  }
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 0);
}

reexecWithPinnedNode();

function parseArgs(argv = process.argv.slice(2)) {
  const booleanFlags = new Set(["all", "global", "json", "version"]);
  const flags = {};
  const positionals = [];
  let afterDashDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (afterDashDash) {
      positionals.push(item);
      continue;
    }
    if (item === "--") {
      afterDashDash = true;
      continue;
    }
    if (item.startsWith("--")) {
      const raw = item.slice(2);
      const eq = raw.indexOf("=");
      if (eq >= 0) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1);
      } else if (booleanFlags.has(raw)) {
        flags[raw] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[raw] = argv[++i];
      } else {
        flags[raw] = true;
      }
      continue;
    }
    positionals.push(item);
  }
  const cmd = positionals.shift() || "";
  return { cmd, values: positionals, flags };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function splitTags(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function normalizeGitUrl(url) {
  let normalized = String(url || "").trim();
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  const httpsMatch = normalized.match(/^https?:\/\/([^/]+)\/(.+)$/);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
  return normalized || null;
}

function git(cwd, args) {
  if (!cwd || !existsSync(cwd)) return "";
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function projectIdFromCwd(cwd) {
  return normalizeGitUrl(git(cwd, ["remote", "get-url", "origin"])) || (cwd && existsSync(cwd) ? cwd : null);
}

function branchNameFromCwd(cwd) {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch && branch !== "HEAD" ? branch : null;
}

function inputFromFlags(flags, values, fallback = {}) {
  const cwd = process.cwd();
  const explicitScope = flags.global ? "global" : flags.scope;
  const projectId = flags.project || flags.project_id || fallback.project_id || projectIdFromCwd(cwd);
  const branchName = flags.branch || flags.branch_name || fallback.branch_name || null;
  const scope =
    explicitScope ||
    (branchName ? "branch" : projectId ? "project" : "global");
  return {
    content: flags.content ?? (values.length ? values.join(" ") : fallback.content),
    type: flags.type ?? fallback.type,
    scope,
    project_id: scope === "global" ? null : projectId,
    branch_name: scope === "branch" ? branchName || branchNameFromCwd(cwd) : null,
    tags: flags.tags == null ? fallback.tags : splitTags(flags.tags),
    category: flags.category ?? fallback.category,
    metadata: fallback.metadata,
  };
}

function usage() {
  process.stderr.write(`Usage:
  miu-kb --version
  miu-kb serve
  miu-kb add "content" [--type fact|rule|decision|note] [--global] [--tags a,b]
  miu-kb edit <id> [--content "..."] [--type fact|rule|decision|note] [--tags a,b]
  miu-kb search "query" [--limit 10] [--json]
  miu-kb recall "query" [--limit 8] [--json]
  miu-kb forget -- <id>
  miu-kb list [--all] [--limit 20]
  miu-kb stats
`);
}

const { cmd, values, flags } = parseArgs();

if (flags.version || cmd === "--version" || cmd === "version") {
  process.stdout.write("miu-kb 0.1.0\n");
  process.exit(0);
}

if (cmd === "serve" || cmd === "mcp") {
  const { serveMcp } = await import("../src/mcp.mjs");
  await serveMcp();
} else if (!cmd) {
  usage();
  process.exit(0);
} else {
  const { openStore } = await import("../src/store.mjs");
  const store = openStore(flags.db);
  try {
  if (cmd === "add") {
    const memory = store.add(inputFromFlags(flags, values));
    if (flags.json) printJson(memory);
    else process.stdout.write(`Stored memory ${memory.id}\n`);
  } else if (cmd === "edit") {
    const id = values.shift();
    const before = store.get(id);
    const memory = store.edit(id, inputFromFlags(flags, values, before || {}));
    if (!memory) {
      process.stderr.write(`memory not found or already forgotten: ${id}\n`);
      process.exit(1);
    }
    if (flags.json) printJson(memory);
    else process.stdout.write(`Updated memory ${memory.id}\n`);
  } else if (cmd === "search") {
    const result = store.search(values.join(" "), {
      limit: flags.limit,
      scope: flags.scope,
      project_id: flags.project || flags.project_id,
      branch_name: flags.branch || flags.branch_name,
    });
    printJson(result);
  } else if (cmd === "recall") {
    const result = store.recall(values.join(" "), {
      limit: flags.limit,
      scope: flags.scope,
      project_id: flags.project || flags.project_id || projectIdFromCwd(process.cwd()),
      branch_name: flags.branch || flags.branch_name || branchNameFromCwd(process.cwd()),
    });
    printJson(result);
  } else if (cmd === "forget") {
    const id = values[0];
    const forgotten = store.forget(id);
    if (flags.json) printJson({ id, forgotten });
    else if (forgotten) process.stdout.write(`Forgot memory ${id}\n`);
    else {
      process.stderr.write(`memory not found or already forgotten: ${id}\n`);
      process.exit(1);
    }
  } else if (cmd === "list") {
    printJson(store.list({ limit: flags.limit, all: flags.all }));
  } else if (cmd === "stats") {
    printJson(store.stats());
  } else {
    usage();
    process.exit(1);
  }
  } finally {
    store.close();
  }
}
