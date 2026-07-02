#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "../lib/sqlite-sync.mjs";
import { join, resolve } from "node:path";
import { URL } from "node:url";
import {
  APP_DIR,
  AI_REVIEW_PROMPT_PATH,
  BUILTIN_MEMORY_SETTINGS,
  CODEX_BIN,
  DATA_DIR,
  DEFAULT_PORT,
  EXTRACTOR_PROMPT_PATH,
  MEMORIES_BIN,
  MEMORIES_DB_PATH,
  NODE_BIN,
  SETTINGS_PATH,
  actualScopeForPath,
  branchNameFromTags,
  branchTagFor,
  ensureDirs,
  getGitBranchName,
  getToken,
  nowId,
  openDb,
  parseTags,
  readJsonMaybe,
  readMemorySettings,
  rowToCandidate,
  safeJson,
  stripBranchTags,
  writeMemorySettings,
  writeRawTurn,
  stringifyTags,
} from "../lib/core.mjs";
import { DEFAULT_AI_REVIEW_PROMPT, DEFAULT_EXTRACTOR_PROMPT, getAiReviewPromptText, getExtractorPromptText, processQueuedTurns } from "./worker.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MIU_KB_PORT || process.env.CODEX_MEMORY_REVIEW_PORT || DEFAULT_PORT);
const TOKEN = getToken();
const AI_QUEUE_STATUSES = ["queued", "processing", "error", "processed"];
const HOME_DIR = process.env.HOME || "";
const CODEX_DIR = join(HOME_DIR, ".codex");
const CODEX_CONFIG_PATH = join(HOME_DIR, ".codex", "config.toml");
const HOOKS_PATH = join(HOME_DIR, ".codex", "hooks.json");
const AGENTS_PATH = join(HOME_DIR, ".codex", "AGENTS.md");
const CLI_SHIM_PATH = join(HOME_DIR, ".local", "bin", "miu-kb");
const LAUNCH_AGENT_PATH = join(HOME_DIR, "Library", "LaunchAgents", "com.miu.kb.plist");
const PLUGIN_HOOKS_PATH = join(APP_DIR, "hooks", "miu-kb-hooks.json");
const PLUGIN_MARKETPLACE_PATH = join(CODEX_DIR, "miu-kb-marketplace", ".agents", "plugins", "marketplace.json");
const PLUGIN_MARKETPLACE_DIR = join(CODEX_DIR, "miu-kb-marketplace");
const PLUGIN_ID = "miu-kb@miu-kb";
const PLUGIN_HOOK_TRUST = [
  {
    key: "miu-kb@miu-kb:hooks/miu-kb-hooks.json:user_prompt_submit:0:0",
    trustedHash: "sha256:4bb9beecfab8e54d1f35b1ba0f050e9730748063075d064ce01b5b00abd112d0",
  },
  {
    key: "miu-kb@miu-kb:hooks/miu-kb-hooks.json:stop:0:0",
    trustedHash: "sha256:6b648cf18e456b77477bd54e2a7405df89f22ea2280a99b351c7501edea3dad8",
  },
];
const USER_PROMPT_DISPATCHER_PATH = join(HOME_DIR, ".ccm-harness", "src", "scripts", "hook-user-prompt-dispatcher.sh");
const STOP_DISPATCHER_PATH = join(HOME_DIR, ".ccm-harness", "src", "scripts", "codex-stop-dispatcher.sh");
const STOP_MEMORY_HOOK_PATH = join(HOME_DIR, ".ccm-harness", "src", "scripts", "codex-stop-hook.sh");
const MEMORY_HOOK_PATH = join(APP_DIR, "bin", "codex-memory-hook.sh");
const USER_PROMPT_RECALL_PATH = join(APP_DIR, "bin", "user-prompt-recall.mjs");
const STOP_ENQUEUE_PATH = join(APP_DIR, "bin", "stop-enqueue.mjs");
const WORKER_PATH = join(APP_DIR, "bin", "worker.mjs");
const SELF_CHECK_CACHE_MS = 30000;
const OVERVIEW_CACHE_MS = 15000;
const BRANCH_LIFECYCLE_SCAN_MS = 60000;
let selfCheckCache = null;
let overviewCache = null;
let branchLifecycleScanCache = null;
let selfCheckInFlight = null;

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function notFound(res) {
  sendJson(res, { error: "not_found" }, 404);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
  });
}

function isAuthorized(req, url) {
  const supplied = url.searchParams.get("token") || req.headers["x-memory-token"];
  return supplied === TOKEN;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function summarizeTurnError(error, max = 900) {
  if (!error) return null;
  const text = String(error).replace(/\r/g, "").trim();
  if (!text) return null;
  if (text.includes("invalid_json_schema")) {
    const message = text.match(/"message":\s*"([^"]+)"/)?.[1]?.replace(/\\"/g, '"');
    return `LLM extractor failed; used heuristic fallback. ${message || "Invalid extractor JSON schema."}`;
  }
  if (text.length <= max) return text;
  return `…${text.slice(-max)}`;
}

function rowToTurn(row) {
  return {
    ...row,
    error: summarizeTurnError(row.error),
  };
}

function pathSize(path, seen = new Set()) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return Number(stat.size || 0);
    const key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) return 0;
    seen.add(key);
    return readdirSync(path, { withFileTypes: true }).reduce(
      (sum, entry) => sum + pathSize(join(path, entry.name), seen),
      Number(stat.size || 0)
    );
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(precision)} ${units[unitIndex]}`;
}

function getStorageOverview() {
  const memoryDbBytes = [MEMORIES_DB_PATH, `${MEMORIES_DB_PATH}-wal`, `${MEMORIES_DB_PATH}-shm`]
    .reduce((sum, path) => sum + pathSize(path), 0);
  const dataBytes = pathSize(DATA_DIR);
  const memoryDbInsideData = isSameOrInside(DATA_DIR, MEMORIES_DB_PATH);
  const parts = [
    { key: "review_data", label: memoryDbInsideData ? "本地数据（含长期记忆库）" : "本地数据", path: DATA_DIR, bytes: dataBytes },
    ...(memoryDbInsideData ? [] : [{ key: "stored_memory_db", label: "长期记忆库", path: MEMORIES_DB_PATH, bytes: memoryDbBytes }]),
    { key: "app_files", label: "审核台程序", path: APP_DIR, bytes: pathSize(APP_DIR) },
  ];
  const totalBytes = parts.reduce((sum, part) => sum + part.bytes, 0);
  return {
    totalBytes,
    totalLabel: formatBytes(totalBytes),
    parts: parts.map((part) => ({
      ...part,
      labelValue: formatBytes(part.bytes),
    })),
  };
}

function isSameOrInside(parent, child) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

function getState(params = {}) {
  const status = ["pending", "approved", "merged", "rejected", "archived", "deleted", "all"].includes(params.status) ? params.status : "pending";
  const page = clampInt(params.page, 1, 1, 100000);
  const pageSize = clampInt(params.pageSize, 20, 5, 50);
  const offset = (page - 1) * pageSize;
  const query = String(params.q ?? "").trim();
  const db = openDb();
  const where = [];
  const args = [];
  if (status !== "all") {
    where.push("c.status = ?");
    args.push(status);
  }
  if (query) {
    where.push(`(
      c.id LIKE ?
      OR c.content LIKE ?
      OR c.evidence LIKE ?
      OR c.tags_json LIKE ?
      OR c.project_path LIKE ?
      OR c.branch_name LIKE ?
      OR t.cwd LIKE ?
    )`);
    const like = `%${query}%`;
    args.push(like, like, like, like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(db.prepare(`
    SELECT count(*) AS count
    FROM candidates c
    LEFT JOIN turns t ON t.id = c.turn_id
    ${whereSql}
  `).get(...args).count ?? 0);
  const candidates = db.prepare(`
    SELECT c.*, t.session_id, t.transcript_path, t.cwd, t.created_at AS turn_created_at
    FROM candidates c
    LEFT JOIN turns t ON t.id = c.turn_id
    ${whereSql}
    ORDER BY
      CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'merged' THEN 2 WHEN 'rejected' THEN 3 WHEN 'archived' THEN 4 WHEN 'deleted' THEN 5 ELSE 6 END,
      c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args, pageSize, offset).map((row) => candidateWithLiveTarget(db, row));
  const turns = db.prepare(`
    SELECT id, session_id, turn_id, transcript_path, cwd, status, error, created_at, processed_at
    FROM turns
    ORDER BY created_at DESC
    LIMIT 80
  `).all();
  const counts = db.prepare(`
    SELECT status, count(*) AS count
    FROM candidates
    GROUP BY status
  `).all();
  db.close();
  return {
    candidates,
    turns: turns.map(rowToTurn),
    counts: Object.fromEntries(counts.map((r) => [r.status, Number(r.count)])),
    pagination: {
      status,
      q: query,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

function getAiReviewCandidateDetails(db, ids) {
  const candidateIds = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!candidateIds.length) return [];
  const placeholders = candidateIds.map(() => "?").join(",");
  const candidates = db.prepare(`
    SELECT id, status, type, scope, content, memory_action, approved_memory_id, updated_at
    FROM candidates
    WHERE id IN (${placeholders})
  `).all(...candidateIds);
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const events = db.prepare(`
    SELECT candidate_id, action, after_json, created_at
    FROM review_events
    WHERE candidate_id IN (${placeholders})
      AND action IN ('ai_approve', 'ai_reject', 'ai_keep')
    ORDER BY created_at DESC
  `).all(...candidateIds);
  const eventByCandidateId = new Map();
  for (const event of events) {
    if (!eventByCandidateId.has(event.candidate_id)) eventByCandidateId.set(event.candidate_id, event);
  }
  return candidateIds.map((id) => {
    const candidate = candidateById.get(id);
    const event = eventByCandidateId.get(id);
    const after = readJsonMaybe(event?.after_json);
    return {
      id,
      status: candidate?.status || "missing",
      type: candidate?.type || null,
      scope: candidate?.scope || null,
      content: candidate?.content || null,
      memory_action: candidate?.memory_action || null,
      approved_memory_id: candidate?.approved_memory_id || null,
      updated_at: candidate?.updated_at || null,
      ai_action: event?.action ? event.action.replace(/^ai_/, "") : null,
      ai_reason: after?.ai_reason || after?.ai_decision || null,
      ai_confidence: Number.isFinite(Number(after?.ai_confidence)) ? Number(after.ai_confidence) : null,
      reviewed_at: event?.created_at || null,
    };
  });
}

function getAiQueueState(params = {}) {
  const status = [...AI_QUEUE_STATUSES, "active", "all"].includes(params.status)
    ? params.status
    : "all";
  const page = clampInt(params.page, 1, 1, 100000);
  const pageSize = clampInt(params.pageSize, 20, 5, 100);
  const offset = (page - 1) * pageSize;
  const query = String(params.q ?? "").trim();
  const db = openDb();
  const where = [];
  const args = [];
  if (status === "all") {
    where.push(`t.status IN (${AI_QUEUE_STATUSES.map(() => "?").join(", ")})`);
    args.push(...AI_QUEUE_STATUSES);
  } else if (status === "active") {
    where.push("t.status IN (?, ?)");
    args.push("queued", "processing");
  } else {
    where.push("t.status = ?");
    args.push(status);
  }
  if (query) {
    where.push(`(
      t.id LIKE ?
      OR t.session_id LIKE ?
      OR t.turn_id LIKE ?
      OR t.cwd LIKE ?
      OR t.error LIKE ?
      OR t.transcript_path LIKE ?
    )`);
    const like = `%${query}%`;
    args.push(like, like, like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(db.prepare(`
    SELECT count(*) AS count
    FROM turns t
    ${whereSql}
  `).get(...args).count ?? 0);
  const turns = db.prepare(`
    SELECT
      t.id,
      t.session_id,
      t.turn_id,
      t.transcript_path,
      t.cwd,
      t.hook_payload_json,
      t.status,
      t.error,
      t.created_at,
      t.processed_at,
      count(c.id) AS candidate_count,
      sum(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS pending_candidate_count,
      sum(CASE WHEN c.status = 'approved' THEN 1 ELSE 0 END) AS approved_candidate_count,
      sum(CASE WHEN c.status = 'rejected' THEN 1 ELSE 0 END) AS rejected_candidate_count
    FROM turns t
    LEFT JOIN candidates c ON c.turn_id = t.id
    ${whereSql}
    GROUP BY t.id
    ORDER BY
      CASE t.status WHEN 'queued' THEN 0 WHEN 'processing' THEN 1 WHEN 'error' THEN 2 ELSE 3 END,
      t.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args, pageSize, offset);
  const counts = db.prepare(`
    SELECT status, count(*) AS count
    FROM turns
    WHERE status IN (${AI_QUEUE_STATUSES.map(() => "?").join(", ")})
    GROUP BY status
  `).all(...AI_QUEUE_STATUSES);
  const countMap = Object.fromEntries(counts.map((r) => [r.status, Number(r.count)]));
  countMap.active = Number(countMap.queued || 0) + Number(countMap.processing || 0);
  countMap.all = AI_QUEUE_STATUSES.reduce((sum, key) => sum + Number(countMap[key] || 0), 0);
  const mappedTurns = turns.map((turn) => {
    const payload = readJsonMaybe(turn.hook_payload_json);
    const reviewCandidateIds = Array.isArray(payload.candidate_ids) ? payload.candidate_ids : [];
    return {
      ...rowToTurn(turn),
      task_type: payload.miu_kb_task || "extract_candidates",
      review_candidate_count: reviewCandidateIds.length,
      review_candidates: reviewCandidateIds.length ? getAiReviewCandidateDetails(db, reviewCandidateIds) : [],
      hook_payload_json: undefined,
      candidate_count: Number(turn.candidate_count || 0),
      pending_candidate_count: Number(turn.pending_candidate_count || 0),
      approved_candidate_count: Number(turn.approved_candidate_count || 0),
      rejected_candidate_count: Number(turn.rejected_candidate_count || 0),
    };
  });
  db.close();
  return {
    turns: mappedTurns,
    counts: countMap,
    pagination: {
      status,
      q: query,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

function getPromptState() {
  return getPromptFileState(EXTRACTOR_PROMPT_PATH, DEFAULT_EXTRACTOR_PROMPT, getExtractorPromptText);
}

function getAiReviewPromptState() {
  return getPromptFileState(AI_REVIEW_PROMPT_PATH, DEFAULT_AI_REVIEW_PROMPT, getAiReviewPromptText);
}

function getPromptFileState(path, defaultPrompt, readPrompt) {
  ensureDirs();
  const exists = existsSync(path);
  const rawPrompt = exists ? readFileSync(path, "utf8") : "";
  const hasCustomPrompt = Boolean(rawPrompt.trim());
  const matchesDefault = rawPrompt.trim() === defaultPrompt.trim();
  const stat = exists ? statSync(path) : null;
  return {
    prompt: readPrompt(),
    defaultPrompt,
    path,
    usingDefault: !hasCustomPrompt || matchesDefault,
    updatedAt: stat ? stat.mtime.toISOString() : null,
  };
}

function savePrompt(body) {
  return savePromptFile(body, EXTRACTOR_PROMPT_PATH, getPromptState);
}

function saveAiReviewPrompt(body) {
  return savePromptFile(body, AI_REVIEW_PROMPT_PATH, getAiReviewPromptState);
}

function savePromptFile(body, path, readState) {
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return { error: "prompt_required", status: 400 };
  if (prompt.length > 50000) return { error: "prompt_too_large", status: 400 };
  ensureDirs();
  writeFileSync(path, `${prompt}\n`, { mode: 0o600 });
  return readState();
}

function resetPrompt() {
  return resetPromptFile(EXTRACTOR_PROMPT_PATH, DEFAULT_EXTRACTOR_PROMPT, getPromptState);
}

function resetAiReviewPrompt() {
  return resetPromptFile(AI_REVIEW_PROMPT_PATH, DEFAULT_AI_REVIEW_PROMPT, getAiReviewPromptState);
}

function resetPromptFile(path, defaultPrompt, readState) {
  ensureDirs();
  writeFileSync(path, `${defaultPrompt}\n`, { mode: 0o600 });
  return readState();
}

function getSettingsState() {
  ensureDirs();
  const exists = existsSync(SETTINGS_PATH);
  const stat = exists ? statSync(SETTINGS_PATH) : null;
  const settings = readMemorySettings();
  return {
    settings,
    defaults: BUILTIN_MEMORY_SETTINGS,
    path: SETTINGS_PATH,
    updatedAt: stat ? stat.mtime.toISOString() : null,
    modelOptions: [
      settings.model,
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2",
    ].filter(Boolean).filter((value, index, array) => array.indexOf(value) === index),
  };
}

function saveSettings(body) {
  const settings = body && typeof body.settings === "object" ? body.settings : body;
  writeMemorySettings(settings);
  return getSettingsState();
}

function resetSettings() {
  writeMemorySettings(BUILTIN_MEMORY_SETTINGS);
  return getSettingsState();
}

function readTextMaybe(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function tailText(text, max = 900) {
  const value = String(text || "").replace(/\r/g, "").trim();
  if (value.length <= max) return value;
  return `…${value.slice(-max)}`;
}

function commandPreview(command) {
  return String(command || "").replaceAll(HOME_DIR, "$HOME");
}

function tomlSectionText(text, header) {
  const lines = String(text || "").split(/\r?\n/);
  const sectionHeader = `[${header}]`;
  const values = [];
  let inSection = false;
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      if (inSection) break;
      inSection = line.trim() === sectionHeader;
      continue;
    }
    if (inSection) values.push(line);
  }
  return values.join("\n");
}

function hasTrustedHook(codexConfig, key) {
  return /^\s*trusted_hash\s*=\s*"sha256:[a-f0-9]{64}"\s*$/m.test(
    tomlSectionText(codexConfig, `hooks.state."${key}"`)
  );
}

function executableStatus(path) {
  if (!path || !existsSync(path)) return false;
  try {
    const stat = statSync(path);
    return Boolean(stat.mode & 0o111);
  } catch {
    return false;
  }
}

function hookCommands(config, eventName) {
  const eventEntries = Array.isArray(config?.hooks?.[eventName]) ? config.hooks[eventName] : [];
  const commands = [];
  for (const entry of eventEntries) {
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (hook?.command) {
        commands.push({
          command: String(hook.command),
          blocking: hook.blocking,
          timeout: hook.timeout,
          source: hook._source || entry?._source || "",
        });
      }
    }
  }
  return commands;
}

function checkStatus(ok, warn = false) {
  if (ok) return "pass";
  return warn ? "warn" : "fail";
}

function buildCheck({ id, title, ok, warn = false, detail = "", hint = "", meta = {} }) {
  return {
    id,
    title,
    status: checkStatus(ok, warn),
    detail,
    hint,
    meta,
  };
}

function runCommandCheck(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 5000,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    input: options.input,
    cwd: options.cwd || HOME_DIR || process.cwd(),
    env: {
      ...process.env,
      PATH: `${join(HOME_DIR, ".nvm", "versions", "node", "v22.22.3", "bin")}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ""}`,
      ...(options.env || {}),
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    stdout: tailText(result.stdout, options.tail || 1200),
    stderr: tailText(result.stderr, options.tail || 1200),
    durationMs: Date.now() - startedAt,
  };
}

function runCommandCheckAsync(command, args, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBuffer = options.maxBuffer || 1024 * 1024;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: value.status,
        signal: value.signal,
        error: value.error || null,
        stdout: tailText(stdout, options.tail || 1200),
        stderr: tailText(stderr, options.tail || 1200),
        durationMs: Date.now() - startedAt,
      });
    };
    const child = spawn(command, args, {
      cwd: options.cwd || HOME_DIR || process.cwd(),
      env: {
        ...process.env,
        PATH: `${join(HOME_DIR, ".nvm", "versions", "node", "v22.22.3", "bin")}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ""}`,
        ...(options.env || {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      stderr += `\n[timeout after ${options.timeout || 5000}ms]`;
      child.kill("SIGTERM");
    }, options.timeout || 5000);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`;
      if (stdout.length > maxBuffer) stdout = stdout.slice(-maxBuffer);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`;
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
    });
    child.on("error", (error) => finish({ status: null, signal: null, error: error.message }));
    child.on("close", (status, signal) => finish({ status, signal }));
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function getLogSnapshot() {
  return [
    { key: "recall", label: "前置检索日志", path: join(DATA_DIR, "logs", "recall.log") },
    { key: "hook", label: "后置入队日志", path: join(DATA_DIR, "logs", "hook.log") },
    { key: "worker", label: "AI worker 日志", path: join(DATA_DIR, "logs", "worker.log") },
    { key: "server_error", label: "服务错误日志", path: join(DATA_DIR, "logs", "server.err.log") },
  ].map((item) => {
    const exists = existsSync(item.path);
    const stat = exists ? statSync(item.path) : null;
    return {
      ...item,
      exists,
      updatedAt: stat ? stat.mtime.toISOString() : null,
      tail: exists ? tailText(readTextMaybe(item.path), 700) : "",
    };
  });
}

function backupConfigFile(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const backup = `${path}.bak.${stamp}`;
  copyFileSync(path, backup);
  return backup;
}

function ensureFeaturesHooks(toml) {
  const lines = String(toml || "").split("\n");
  const start = lines.findIndex((line) => line.trim() === "[features]");
  if (start === -1) return `${String(toml || "").trimEnd()}\n\n[features]\nhooks = true\n`;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const hookIndex = lines.slice(start + 1, end).findIndex((line) => /^\s*hooks\s*=/.test(line));
  if (hookIndex >= 0) lines[start + 1 + hookIndex] = "hooks = true";
  else lines.splice(start + 1, 0, "hooks = true");
  return lines.join("\n");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function upsertMcpConfig(toml) {
  const nodeDir = NODE_BIN.includes("/") ? NODE_BIN.replace(/\/[^/]+$/, "") : "/opt/homebrew/bin";
  const lines = ensureFeaturesHooks(toml).split("\n");
  const kept = [];
  let skippingMiu = false;
  for (const line of lines) {
    const header = line.trim();
    if (/^\[mcp_servers\.miu-kb\]$/.test(header)) {
      skippingMiu = true;
      continue;
    }
    if (skippingMiu && /^\[[^\]]+\]$/.test(header) && !header.startsWith("[mcp_servers.miu-kb")) {
      skippingMiu = false;
    }
    if (!skippingMiu) kept.push(line);
  }
  return `${kept.join("\n").trimEnd()}

[mcp_servers.miu-kb]
command = ${tomlString(NODE_BIN)}
args = [ ${tomlString(join(APP_DIR, "bin", "miu-kb.mjs"))}, "serve" ]

  [mcp_servers.miu-kb.env]
  MIU_KB_DB = ${tomlString(MEMORIES_DB_PATH)}
  MIU_KB_APP_DIR = ${tomlString(APP_DIR)}
  MIU_KB_DATA_DIR = ${tomlString(DATA_DIR)}
  PATH = ${tomlString(`${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}
`;
}

function upsertTomlSection(toml, header, body) {
  const lines = String(toml || "").split(/\r?\n/);
  const sectionHeader = `[${header}]`;
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      if (skipping) skipping = false;
      if (line.trim() === sectionHeader) {
        skipping = true;
        continue;
      }
    }
    if (!skipping) kept.push(line);
  }
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n\n${sectionHeader}\n${body.trimEnd()}\n`;
}

function upsertPluginConfig(toml) {
  let next = upsertTomlSection(toml, "marketplaces.miu-kb", [
    'source_type = "local"',
    `source = ${tomlString(PLUGIN_MARKETPLACE_DIR)}`,
  ].join("\n"));
  next = upsertTomlSection(next, `plugins."${PLUGIN_ID}"`, "enabled = true");
  for (const hook of PLUGIN_HOOK_TRUST) {
    next = upsertTomlSection(
      next,
      `hooks.state."${hook.key}"`,
      `trusted_hash = ${tomlString(hook.trustedHash)}`
    );
  }
  return next;
}

function writePluginMarketplace() {
  const agentsDir = join(PLUGIN_MARKETPLACE_DIR, ".agents", "plugins");
  const pluginsDir = join(PLUGIN_MARKETPLACE_DIR, "plugins");
  const pluginLink = join(pluginsDir, "miu-kb");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  rmSync(pluginLink, { recursive: true, force: true });
  symlinkSync(APP_DIR, pluginLink, "dir");
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
  writeFileSync(PLUGIN_MARKETPLACE_PATH, `${JSON.stringify(marketplace, null, 2)}\n`);
}

function bootstrapHooksJson() {
  if (!existsSync(HOOKS_PATH)) return false;
  let config = { hooks: {} };
  try {
    config = JSON.parse(readFileSync(HOOKS_PATH, "utf8"));
  } catch {
    backupConfigFile(HOOKS_PATH);
    return false;
  }
  config.hooks ||= {};
  let changed = false;
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    config.hooks[event] = existing.filter((entry) => {
      if (entry?._source === "miu-kb" || entry?._source === "codex-memory-review") return false;
      const text = JSON.stringify(entry);
      return !(text.includes("codex-memory-hook.sh") || text.includes(".codex/memory-review") || text.includes(".codex/miu-kb"));
    });
    changed ||= config.hooks[event].length !== existing.length;
  }
  if (!changed) return false;
  if (existsSync(HOOKS_PATH)) backupConfigFile(HOOKS_PATH);
  writeFileSync(HOOKS_PATH, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

function bootstrapAgentsMd() {
  const marker = "<!-- miu-kb:persistent-memory -->";
  const existing = readTextMaybe(AGENTS_PATH);
  if (existing.includes(marker) || existing.includes("Use miu-kb as the local persistent memory layer")) return false;
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
  writeFileSync(AGENTS_PATH, `${existing.trimEnd()}\n\n${block}\n`);
  return true;
}

function bootstrapFirstUse() {
  mkdirSync(CODEX_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  writePluginMarketplace();
  const beforeConfig = readTextMaybe(CODEX_CONFIG_PATH);
  const nextConfig = upsertPluginConfig(upsertMcpConfig(beforeConfig));
  if (beforeConfig !== nextConfig && existsSync(CODEX_CONFIG_PATH)) backupConfigFile(CODEX_CONFIG_PATH);
  writeFileSync(CODEX_CONFIG_PATH, nextConfig);
  bootstrapHooksJson();
  const agentsUpdated = bootstrapAgentsMd();
  try {
    if (existsSync(MEMORY_HOOK_PATH)) chmodSync(MEMORY_HOOK_PATH, 0o755);
  } catch {
    // chmod failure is reported by self-check; bootstrap should continue.
  }
  selfCheckCache = null;
  return {
    ok: true,
    agentsUpdated,
    paths: {
      hooks: HOOKS_PATH,
      codexConfig: CODEX_CONFIG_PATH,
      agents: AGENTS_PATH,
      app: APP_DIR,
      data: DATA_DIR,
    },
  };
}

function stripTomlSections(toml, sectionNames) {
  const lines = String(toml || "").split("\n");
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1] || "";
    if (header) {
      skipping = sectionNames.some((name) => header === name || header.startsWith(`${name}.`));
    }
    if (!skipping) kept.push(line);
  }
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function stripMiuAgentsBlock(text) {
  const marker = "<!-- miu-kb:persistent-memory -->";
  const start = String(text || "").indexOf(marker);
  if (start < 0) return text;
  const before = text.slice(0, start).replace(/[ \t]*\n+$/, "");
  const rest = text.slice(start).split("\n");
  let end = rest.length;
  for (let index = 1; index < rest.length; index += 1) {
    if (/^##\s+/.test(rest[index]) && !/Persistent Memory/i.test(rest[index])) {
      end = index;
      break;
    }
  }
  return `${before}\n${rest.slice(end).join("\n")}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function clearCodexIntegration() {
  const changed = [];
  if (existsSync(CODEX_CONFIG_PATH)) {
    const before = readTextMaybe(CODEX_CONFIG_PATH);
    let next = stripTomlSections(before, [
      "mcp_servers.miu-kb",
      'plugins."miu-kb@miu-kb"',
      "marketplaces.miu-kb",
    ]);
    next = next.replace(/\n?\[hooks\.state\."miu-kb@miu-kb:[^\n]+?\]\n(?:[^\[]|\[(?![A-Za-z0-9_."-]+\]))*/g, "\n");
    next = `${next.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
    if (next !== before) {
      backupConfigFile(CODEX_CONFIG_PATH);
      writeFileSync(CODEX_CONFIG_PATH, next);
      changed.push(CODEX_CONFIG_PATH);
    }
  }
  if (existsSync(HOOKS_PATH)) {
    const before = readTextMaybe(HOOKS_PATH);
    try {
      const config = JSON.parse(before);
      config.hooks ||= {};
      for (const event of Object.keys(config.hooks)) {
        config.hooks[event] = (Array.isArray(config.hooks[event]) ? config.hooks[event] : []).filter((entry) => {
          const text = JSON.stringify(entry);
          return !(entry?._source === "miu-kb" || entry?._source === "codex-memory-review" || text.includes("miu-kb") || text.includes("memory-review") || text.includes("codex-memory-hook.sh"));
        });
        if (!config.hooks[event].length) delete config.hooks[event];
      }
      const next = `${JSON.stringify(config, null, 2)}\n`;
      if (next !== before) {
        backupConfigFile(HOOKS_PATH);
        writeFileSync(HOOKS_PATH, next);
        changed.push(HOOKS_PATH);
      }
    } catch {
      backupConfigFile(HOOKS_PATH);
      writeFileSync(HOOKS_PATH, "{\n  \"hooks\": {}\n}\n");
      changed.push(HOOKS_PATH);
    }
  }
  if (existsSync(AGENTS_PATH)) {
    const before = readTextMaybe(AGENTS_PATH);
    const next = stripMiuAgentsBlock(before);
    if (next !== before) {
      backupConfigFile(AGENTS_PATH);
      writeFileSync(AGENTS_PATH, next);
      changed.push(AGENTS_PATH);
    }
  }
  rmSync(join(CODEX_DIR, "miu-kb-marketplace"), { recursive: true, force: true });
  selfCheckCache = null;
  return { ok: true, changed, message: changed.length ? "已清除 miu-kb Hook / MCP / AGENTS 注入。" : "未发现 miu-kb 注入。" };
}

function clearStoredMemories() {
  if (!existsSync(MEMORIES_DB_PATH)) return { ok: true, deletedCount: 0, message: "长期记忆库尚未创建。" };
  const db = new DatabaseSync(MEMORIES_DB_PATH);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get();
    if (!table) return { ok: true, deletedCount: 0, message: "长期记忆表尚未创建。" };
    const count = Number(db.prepare("SELECT count(*) AS count FROM memories").get().count || 0);
    db.exec("DELETE FROM memories; VACUUM;");
    overviewCache = null;
    return { ok: true, deletedCount: count, message: `已清除 ${count} 条长期记忆。` };
  } catch (error) {
    return { ok: false, error: "clear_memories_failed", message: error.message, status: 500 };
  } finally {
    db.close();
  }
}

function uninstallMiuKb() {
  const integration = clearCodexIntegration();
  const paths = [LAUNCH_AGENT_PATH, CLI_SHIM_PATH, APP_DIR, DATA_DIR, PLUGIN_MARKETPLACE_DIR];
  const script = `
sleep 0.5
launchctl bootout gui/$(id -u) ${JSON.stringify(LAUNCH_AGENT_PATH)} >/dev/null 2>&1 || true
rm -f ${JSON.stringify(LAUNCH_AGENT_PATH)}
rm -f ${JSON.stringify(CLI_SHIM_PATH)}
rm -rf ${JSON.stringify(PLUGIN_MARKETPLACE_DIR)}
rm -rf ${JSON.stringify(APP_DIR)}
rm -rf ${JSON.stringify(DATA_DIR)}
`;
  const child = spawn("bash", ["-lc", script], { detached: true, stdio: "ignore" });
  child.unref();
  return {
    ok: true,
    changed: integration.changed || [],
    paths,
    message: "已开始卸载：将移除 Hook/MCP、后台服务、CLI、程序目录和本地数据。App 本体不会自删，可手动移到废纸篓。",
  };
}

async function getSelfCheckState({ force = false } = {}) {
  if (!force && selfCheckCache && Date.now() - selfCheckCache.cachedAt < SELF_CHECK_CACHE_MS) {
    return {
      ...selfCheckCache.value,
      cached: true,
      cacheAgeMs: Date.now() - selfCheckCache.cachedAt,
    };
  }
  if (!force && selfCheckInFlight) return selfCheckInFlight;
  selfCheckInFlight = buildSelfCheckState();
  try {
    return await selfCheckInFlight;
  } finally {
    selfCheckInFlight = null;
  }
}

async function buildSelfCheckState() {
  const hooksRaw = readTextMaybe(HOOKS_PATH);
  const hooksConfig = readJsonMaybe(hooksRaw);
  const pluginHooksRaw = readTextMaybe(PLUGIN_HOOKS_PATH);
  const pluginHooksConfig = readJsonMaybe(pluginHooksRaw);
  const codexConfig = readTextMaybe(CODEX_CONFIG_PATH);
  const pluginSection = tomlSectionText(codexConfig, 'plugins."miu-kb@miu-kb"');
  const pluginEnabled = /^\s*enabled\s*=\s*true\s*$/m.test(pluginSection);
  const pluginPromptTrusted = hasTrustedHook(
    codexConfig,
    "miu-kb@miu-kb:hooks/miu-kb-hooks.json:user_prompt_submit:0:0"
  );
  const pluginStopTrusted = hasTrustedHook(
    codexConfig,
    "miu-kb@miu-kb:hooks/miu-kb-hooks.json:stop:0:0"
  );
  const pluginUserCommands = hookCommands(pluginHooksConfig, "UserPromptSubmit");
  const pluginStopCommands = hookCommands(pluginHooksConfig, "Stop");
  const userCommands = hookCommands(hooksConfig, "UserPromptSubmit");
  const stopCommands = hookCommands(hooksConfig, "Stop");
  const pluginUserHookCommand = pluginUserCommands.find((item) =>
    /codex-memory-hook\.sh.*user-prompt/.test(item.command)
  );
  const pluginStopHookCommand = pluginStopCommands.find((item) =>
    /codex-memory-hook\.sh.*stop/.test(item.command)
  );
  const legacyUserHookCommand = userCommands.find((item) =>
    /hook-user-prompt-dispatcher\.sh|codex-memory-hook\.sh|user-prompt-recall\.mjs/.test(item.command)
  );
  const legacyStopHookCommand = stopCommands.find((item) =>
    /codex-stop-dispatcher\.sh|codex-stop-hook\.sh|codex-memory-hook\.sh|stop-enqueue\.mjs/.test(item.command)
  );
  const userHookCommand = pluginUserHookCommand || legacyUserHookCommand;
  const stopHookCommand = pluginStopHookCommand || legacyStopHookCommand;
  const settings = readMemorySettings();
  const [recallProbe, stopProbe, memoriesProbe, codexProbe] = await Promise.all([
    runCommandCheckAsync(NODE_BIN, ["--no-warnings=ExperimentalWarning", USER_PROMPT_RECALL_PATH], {
      input: JSON.stringify({ prompt: "Codex 记忆自检：检查前置 hook recall 是否可运行", cwd: HOME_DIR }),
      timeout: 8000,
      env: { MIU_KB_DEBUG_SALUTE: "0", CODEX_MEMORY_REVIEW_DEBUG_SALUTE: "0", MIU_KB_TRACE_SKIP: "1", CODEX_MEMORY_REVIEW_TRACE_SKIP: "1" },
    }),
    runCommandCheckAsync(NODE_BIN, ["--no-warnings=ExperimentalWarning", STOP_ENQUEUE_PATH], {
      input: JSON.stringify({ session_id: "self-check", turn_id: "dry-run", cwd: HOME_DIR }),
      timeout: 5000,
      env: { MIU_KB_SKIP: "1", CODEX_MEMORY_REVIEW_SKIP: "1" },
    }),
    runCommandCheckAsync(MEMORIES_BIN, ["--version"], { timeout: 5000 }),
    runCommandCheckAsync(CODEX_BIN, ["--version"], { timeout: 8000 }),
  ]);
  const checks = [
    buildCheck({
      id: "hooks_feature",
      title: "Codex hooks 总开关",
      ok: /^\s*hooks\s*=\s*true\s*$/m.test(codexConfig),
      detail: CODEX_CONFIG_PATH,
      hint: "需要在 ~/.codex/config.toml 的 [features] 下开启 hooks = true。",
    }),
    buildCheck({
      id: "plugin_enabled",
      title: "miu-kb 插件已启用",
      ok: pluginEnabled && existsSync(PLUGIN_HOOKS_PATH),
      detail: existsSync(PLUGIN_HOOKS_PATH)
        ? `${PLUGIN_HOOKS_PATH}；enabled=${String(pluginEnabled)}`
        : "未找到插件 hook 文件。",
      hint: "Codex App 和 Codex CLI 现在优先通过 miu-kb 插件 hook 接入记忆能力。",
    }),
    buildCheck({
      id: "user_prompt_hook_config",
      title: "前置 hook 已注册",
      ok: Boolean(userHookCommand),
      detail: userHookCommand
        ? `${commandPreview(userHookCommand.command)}；blocking=${String(userHookCommand.blocking)}；timeout=${userHookCommand.timeout ?? "默认"}`
        : "未在 miu-kb 插件或 hooks.json 的 UserPromptSubmit 中找到记忆命令。",
      hint: "前置 hook 用来在用户提问前检索本地知识库并注入上下文。",
    }),
    buildCheck({
      id: "user_prompt_plugin_trust",
      title: "前置插件 hook 已信任",
      ok: Boolean(pluginUserHookCommand && pluginPromptTrusted),
      detail: pluginUserHookCommand
        ? `${commandPreview(pluginUserHookCommand.command)}；trusted=${String(pluginPromptTrusted)}`
        : "插件 hooks 中未找到 UserPromptSubmit 记忆命令。",
      hint: "Codex 需要信任插件 hook，否则前置记忆检索不会稳定执行。",
    }),
    buildCheck({
      id: "stop_hook_config",
      title: "后置 hook 已注册",
      ok: Boolean(stopHookCommand),
      detail: stopHookCommand
        ? `${commandPreview(stopHookCommand.command)}；blocking=${String(stopHookCommand.blocking)}；timeout=${stopHookCommand.timeout ?? "默认"}`
        : "未在 miu-kb 插件或 hooks.json 的 Stop 中找到记忆命令。",
      hint: "后置 hook 用来在回答结束后异步入队，触发知识提炼。",
    }),
    buildCheck({
      id: "stop_plugin_trust",
      title: "后置插件 hook 已信任",
      ok: Boolean(pluginStopHookCommand && pluginStopTrusted),
      detail: pluginStopHookCommand
        ? `${commandPreview(pluginStopHookCommand.command)}；trusted=${String(pluginStopTrusted)}`
        : "插件 hooks 中未找到 Stop 记忆命令。",
      hint: "Codex 需要信任插件 hook，否则后置异步入队不会稳定执行。",
    }),
    buildCheck({
      id: "memory_scripts",
      title: "miu-kb 脚本完整",
      ok:
        existsSync(MEMORY_HOOK_PATH) &&
        existsSync(USER_PROMPT_RECALL_PATH) &&
        existsSync(STOP_ENQUEUE_PATH) &&
        existsSync(WORKER_PATH),
      warn: true,
      detail: APP_DIR,
      hint: "缺少脚本会导致前置检索或后置沉淀无法运行。",
      meta: {
        hookExecutable: executableStatus(MEMORY_HOOK_PATH),
      },
    }),
    buildCheck({
      id: "user_prompt_probe",
      title: "前置检索脚本试跑",
      ok: recallProbe.status === 0 && !recallProbe.error,
      detail: recallProbe.stdout ? `有输出，${recallProbe.stdout.length} 字符` : "脚本可运行，本次无相关记忆输出。",
      hint: recallProbe.stderr || recallProbe.error || "",
      meta: recallProbe,
    }),
    buildCheck({
      id: "stop_probe",
      title: "后置入队脚本 dry-run",
      ok: stopProbe.status === 0 && !stopProbe.error,
      detail: "使用 MIU_KB_SKIP=1 试跑，不写入队列。",
      hint: stopProbe.stderr || stopProbe.error || "",
      meta: stopProbe,
    }),
    buildCheck({
      id: "memories_cli",
      title: "miu-kb CLI 可用",
      ok: memoriesProbe.status === 0 && !memoriesProbe.error,
      detail: `${MEMORIES_BIN} ${memoriesProbe.stdout || ""}`.trim(),
      hint: memoriesProbe.stderr || memoriesProbe.error || "",
      meta: memoriesProbe,
    }),
    buildCheck({
      id: "codex_cli",
      title: "Codex CLI 可用",
      ok: codexProbe.status === 0 && !codexProbe.error,
      detail: `${CODEX_BIN} ${codexProbe.stdout || ""}`.trim(),
      hint: codexProbe.stderr || codexProbe.error || "",
      meta: codexProbe,
    }),
  ];
  const score = checks.filter((check) => check.status === "pass").length;
  const state = {
    generatedAt: new Date().toISOString(),
    cached: false,
    cacheAgeMs: 0,
    summary: {
      total: checks.length,
      pass: checks.filter((check) => check.status === "pass").length,
      warn: checks.filter((check) => check.status === "warn").length,
      fail: checks.filter((check) => check.status === "fail").length,
    },
    health: checks.some((check) => check.status === "fail")
      ? "需要处理"
      : score === checks.length
        ? "正常"
        : "可用但有提示",
    settings: {
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      settingsPath: SETTINGS_PATH,
    },
    paths: {
      hooks: HOOKS_PATH,
      codexConfig: CODEX_CONFIG_PATH,
      pluginHooks: PLUGIN_HOOKS_PATH,
      pluginMarketplace: PLUGIN_MARKETPLACE_PATH,
      userPromptDispatcher: USER_PROMPT_DISPATCHER_PATH,
      stopDispatcher: STOP_DISPATCHER_PATH,
      app: APP_DIR,
      data: DATA_DIR,
    },
    checks,
    logs: getLogSnapshot(),
  };
  selfCheckCache = { cachedAt: Date.now(), value: state };
  return state;
}

async function runModelSelfCheck() {
  const settings = readMemorySettings();
  const result = await runCommandCheckAsync(CODEX_BIN, [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--disable",
    "hooks",
    "--sandbox",
    "read-only",
    "--model",
    settings.model,
    "-c",
    `model_reasoning_effort="${settings.reasoningEffort || "low"}"`,
    "-",
  ], {
    input: "这是 miu-kb 自检。请只回复 OK。",
    timeout: Math.min(Number(settings.llmTimeoutMs || 180000), 90000),
    tail: 1600,
    env: { MIU_KB_SKIP: "1", CODEX_MEMORY_REVIEW_SKIP: "1" },
  });
  return {
    generatedAt: new Date().toISOString(),
    ok: result.status === 0 && !result.error,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    detail: result.status === 0 ? "模型调用成功。" : "模型调用失败。",
    result,
  };
}

function getCandidate(db, id) {
  return db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
}

function resolveReviewCandidateTarget(db, source) {
  if (source.target_kind !== "review_candidate" || !source.target_id) {
    return { error: "merge_target_required", status: 400, message: "缺少可合并的目标候选。" };
  }
  if (source.target_id === source.id) {
    return { error: "cannot_merge_candidate_into_itself", status: 400, message: "候选不能合并到自身。" };
  }

  const visited = new Set([source.id]);
  let targetId = source.target_id;
  let depth = 0;
  while (targetId && depth < 12) {
    if (visited.has(targetId)) {
      return { error: "merge_target_cycle", status: 409, message: "目标候选形成循环引用，不能自动合并。" };
    }
    visited.add(targetId);
    const target = getCandidate(db, targetId);
    if (!target) return { error: "merge_target_not_found", status: 404, message: "目标候选不存在，可能已被清理。" };
    if (target.status === "pending") return { kind: "pending_candidate", target };
    if (target.status === "approved" && target.approved_memory_id) {
      return { kind: "approved_memory", target, memoryId: target.approved_memory_id };
    }
    if (target.status === "merged" && target.approved_memory_id) {
      targetId = target.approved_memory_id;
      depth += 1;
      continue;
    }
    return {
      error: "merge_target_unavailable",
      status: 409,
      target,
      message: `目标候选当前状态：${labelStatus(target.status)}，不能继续合并。请改为新建记忆或拒绝这条候选。`,
    };
  }
  return { error: "merge_target_chain_too_deep", status: 409, message: "目标候选合并链过长，不能自动处理。" };
}

function labelStatus(status) {
  return {
    pending: "待审核",
    approved: "已写入",
    ai_reviewing: "AI 复核中",
    merged: "已合并",
    rejected: "已拒绝",
    archived: "已归档",
    deleted: "已删除",
  }[status] || status || "处理";
}

function candidateWithLiveTarget(db, row) {
  const candidate = rowToCandidate(row);
  if (candidate.target_kind !== "review_candidate" || !candidate.target_id) return candidate;
  const resolved = resolveReviewCandidateTarget(db, candidate);
  const target = resolved.target;
  if (!target && !resolved.error) return candidate;
  return {
    ...candidate,
    target_current_id: target?.id || candidate.target_id,
    target_current_status: target?.status || null,
    target_current_memory_id: resolved.memoryId || target?.approved_memory_id || null,
    target_current_content: target?.content || null,
    target_resolution_error: resolved.error || null,
    target_resolution_message: resolved.message || null,
  };
}

function rowToMemory(row) {
  const tags = parseTags(row.tags);
  const branchName = branchNameFromTags(tags);
  return {
    ...row,
    tags,
    branch_name: branchName,
    display_scope: branchName ? "branch" : row.scope,
  };
}

function countRowsBy(rows, key) {
  return Object.fromEntries(rows.map((row) => [row[key], Number(row.count || 0)]));
}

function getMemoriesOverview() {
  if (!existsSync(MEMORIES_DB_PATH)) {
    return {
      counts: { active: 0, deleted: 0, all: 0, types: {}, scopes: {} },
      recent: [],
    };
  }
  const db = new DatabaseSync(MEMORIES_DB_PATH);
  try {
    const statusRows = db.prepare(`
      SELECT CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END AS status,
             count(*) AS count
      FROM memories
      GROUP BY status
    `).all();
    const typeRows = db.prepare(`
      SELECT type, count(*) AS count
      FROM memories
      WHERE deleted_at IS NULL
      GROUP BY type
    `).all();
    const scopeRows = db.prepare(`
      SELECT scope, count(*) AS count
      FROM memories
      WHERE deleted_at IS NULL
      GROUP BY scope
    `).all();
    const branchMemoryCount = Number(db.prepare(`
      SELECT count(*) AS count
      FROM memories
      WHERE deleted_at IS NULL AND scope = 'project' AND tags LIKE '%branch:%'
    `).get().count || 0);
    const recent = db.prepare(`
      SELECT id, content, scope, project_id, type, category, updated_at, created_at
      FROM memories
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 8
    `).all();
    const statusCounts = countRowsBy(statusRows, "status");
    const active = statusCounts.active || 0;
    const deleted = statusCounts.deleted || 0;
    return {
      counts: {
        active,
        deleted,
        all: active + deleted,
        types: countRowsBy(typeRows, "type"),
        scopes: {
          ...countRowsBy(scopeRows, "scope"),
          project: Math.max(0, Number(countRowsBy(scopeRows, "scope").project || 0) - branchMemoryCount),
          branch: branchMemoryCount,
        },
      },
      recent,
    };
  } finally {
    db.close();
  }
}

function getOverviewState({ force = false } = {}) {
  maybeRunBranchLifecycleScan();
  if (!force && overviewCache && Date.now() - overviewCache.cachedAt < OVERVIEW_CACHE_MS) {
    return {
      ...overviewCache.value,
      cached: true,
      cacheAgeMs: Date.now() - overviewCache.cachedAt,
    };
  }
  const db = openDb();
  try {
    const candidateCounts = countRowsBy(db.prepare(`
      SELECT status, count(*) AS count
      FROM candidates
      GROUP BY status
    `).all(), "status");
    const actionCounts = countRowsBy(db.prepare(`
      SELECT COALESCE(memory_action, 'create_new') AS memory_action, count(*) AS count
      FROM candidates
      WHERE status = 'pending'
      GROUP BY COALESCE(memory_action, 'create_new')
    `).all(), "memory_action");
    const typeCounts = countRowsBy(db.prepare(`
      SELECT type, count(*) AS count
      FROM candidates
      WHERE status = 'pending'
      GROUP BY type
    `).all(), "type");
    const turnCounts = countRowsBy(db.prepare(`
      SELECT status, count(*) AS count
      FROM turns
      GROUP BY status
    `).all(), "status");
    const aiQueueRows = db.prepare(`
      SELECT status, count(*) AS count
      FROM turns
      WHERE status IN (${AI_QUEUE_STATUSES.map(() => "?").join(", ")})
      GROUP BY status
    `).all(...AI_QUEUE_STATUSES);
    const aiQueueCounts = countRowsBy(aiQueueRows, "status");
    aiQueueCounts.all = Object.values(aiQueueCounts).reduce((sum, value) => sum + Number(value || 0), 0);

    const last7Rows = db.prepare(`
      WITH RECURSIVE days(day, n) AS (
        SELECT date('now', '-6 days'), 0
        UNION ALL
        SELECT date(day, '+1 day'), n + 1 FROM days WHERE n < 6
      )
      SELECT
        days.day AS day,
        sum(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END) AS created,
        sum(CASE WHEN c.status = 'approved' THEN 1 ELSE 0 END) AS approved,
        sum(CASE WHEN c.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        sum(CASE WHEN c.status = 'merged' THEN 1 ELSE 0 END) AS merged
      FROM days
      LEFT JOIN candidates c ON date(c.created_at) = days.day
      GROUP BY days.day
      ORDER BY days.day
    `).all().map((row) => ({
      day: row.day,
      created: Number(row.created || 0),
      approved: Number(row.approved || 0),
      rejected: Number(row.rejected || 0),
      merged: Number(row.merged || 0),
    }));
    const recentCandidates = db.prepare(`
      SELECT id, status, memory_action, type, scope, content, confidence, created_at, updated_at
      FROM candidates
      ORDER BY created_at DESC
      LIMIT 8
    `).all();
    const recentTurns = db.prepare(`
      SELECT id, status, cwd, error, created_at, processed_at
      FROM turns
      ORDER BY created_at DESC
      LIMIT 8
    `).all().map(rowToTurn);
    const oldestPending = db.prepare(`
      SELECT id, content, created_at
      FROM candidates
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `).get();
    const reviewDone = Number(candidateCounts.approved || 0) + Number(candidateCounts.rejected || 0) + Number(candidateCounts.archived || 0) + Number(candidateCounts.deleted || 0) + Number(candidateCounts.merged || 0);
    const approved = Number(candidateCounts.approved || 0);
    const approvalRate = reviewDone ? approved / reviewDone : 0;
    const pending = Number(candidateCounts.pending || 0);
    const queueOpen = Number(aiQueueCounts.all || 0);
    const totalCandidates = Object.values(candidateCounts).reduce((sum, value) => sum + Number(value || 0), 0);
    const memories = getMemoriesOverview();
    const health =
      queueOpen > 0 ? "AI 队列待处理" :
      pending > 100 ? "审核积压偏高" :
      pending > 0 ? "等待审核" :
      "运行平稳";

    const state = {
      generatedAt: new Date().toISOString(),
      cached: false,
      cacheAgeMs: 0,
      health,
      review: {
        counts: candidateCounts,
        actions: actionCounts,
        types: typeCounts,
        total: totalCandidates,
        pending,
        approvalRate,
        oldestPending,
      },
      ai: {
        queue: aiQueueCounts,
        turns: turnCounts,
      },
      memories,
      storage: getStorageOverview(),
      last7Days: last7Rows,
      recentCandidates,
      recentTurns,
      paths: {
        memoriesDb: MEMORIES_DB_PATH,
      },
    };
    overviewCache = { cachedAt: Date.now(), value: state };
    return state;
  } finally {
    db.close();
  }
}

function getKnowledgeState(params = {}) {
  maybeRunBranchLifecycleScan();
  const type = ["all", "rule", "decision", "fact", "note"].includes(params.type) ? params.type : "all";
  const scope = ["all", "global", "project", "branch"].includes(params.scope) ? params.scope : "all";
  const status = ["active", "deleted", "all"].includes(params.status) ? params.status : "active";
  const page = clampInt(params.page, 1, 1, 100000);
  const pageSize = clampInt(params.pageSize, 20, 5, 100);
  const offset = (page - 1) * pageSize;
  const query = String(params.q ?? "").trim();

  if (!existsSync(MEMORIES_DB_PATH)) {
    return {
      memories: [],
      counts: { active: 0, deleted: 0, all: 0, types: {}, scopes: {} },
      pagination: { type, scope, status, q: query, page, pageSize, total: 0, totalPages: 1 },
    };
  }

  const db = new DatabaseSync(MEMORIES_DB_PATH);
  const where = [];
  const args = [];
  if (status === "active") where.push("deleted_at IS NULL");
  if (status === "deleted") where.push("deleted_at IS NOT NULL");
  if (type !== "all") {
    where.push("type = ?");
    args.push(type);
  }
  if (scope === "branch") {
    where.push("scope = 'project' AND tags LIKE '%branch:%'");
  } else if (scope === "project") {
    where.push("scope = 'project' AND (tags IS NULL OR tags NOT LIKE '%branch:%')");
  } else if (scope !== "all") {
    where.push("scope = ?");
    args.push(scope);
  }
  if (query) {
    where.push(`(
      content LIKE ?
      OR tags LIKE ?
      OR category LIKE ?
      OR project_id LIKE ?
      OR id LIKE ?
    )`);
    const like = `%${query}%`;
    args.push(like, like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(db.prepare(`
    SELECT count(*) AS count
    FROM memories
    ${whereSql}
  `).get(...args).count ?? 0);
  const memories = db.prepare(`
    SELECT id, content, tags, scope, project_id, type, paths, category, metadata,
           created_at, updated_at, deleted_at
    FROM memories
    ${whereSql}
    ORDER BY
      CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END,
      updated_at DESC,
      created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args, pageSize, offset).map(rowToMemory);
  const statusRows = db.prepare(`
    SELECT CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END AS status,
           count(*) AS count
    FROM memories
    GROUP BY status
  `).all();
  const typeRows = db.prepare(`
    SELECT type, count(*) AS count
    FROM memories
    WHERE deleted_at IS NULL
    GROUP BY type
  `).all();
  const scopeRows = db.prepare(`
    SELECT scope, count(*) AS count
    FROM memories
    WHERE deleted_at IS NULL
    GROUP BY scope
  `).all();
  const branchMemoryCount = Number(db.prepare(`
    SELECT count(*) AS count
    FROM memories
    WHERE deleted_at IS NULL AND scope = 'project' AND tags LIKE '%branch:%'
  `).get().count || 0);
  db.close();

  const statusCounts = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.count)]));
  const scopeCounts = Object.fromEntries(scopeRows.map((r) => [r.scope, Number(r.count)]));
  const active = statusCounts.active || 0;
  const deleted = statusCounts.deleted || 0;
  return {
    memories,
    counts: {
      active,
      deleted,
      all: active + deleted,
      types: Object.fromEntries(typeRows.map((r) => [r.type, Number(r.count)])),
      scopes: {
        ...scopeCounts,
        project: Math.max(0, Number(scopeCounts.project || 0) - branchMemoryCount),
        branch: branchMemoryCount,
      },
    },
    pagination: {
      type,
      scope,
      status,
      q: query,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

function getRecallTraceState(params = {}) {
  const page = clampInt(params.page, 1, 1, 100000);
  const pageSize = clampInt(params.pageSize, 20, 5, 100);
  const offset = (page - 1) * pageSize;
  const includeSelfCheck = params.includeSelfCheck === true || params.includeSelfCheck === "1";
  const whereSql = includeSelfCheck
    ? ""
    : "WHERE COALESCE(session_id, '') != 'self-check' AND COALESCE(prompt_excerpt, '') NOT LIKE 'Codex 记忆自检%'";
  const db = openDb();
  try {
    const total = Number(db.prepare(`SELECT count(*) AS count FROM recall_traces ${whereSql}`).get().count || 0);
    const traces = db.prepare(`
      SELECT id, session_id, turn_id, cwd, branch_name, prompt_excerpt, query, status,
             rules_json, memories_json, injected_chars, approx_tokens, error, created_at
      FROM recall_traces
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset).map((row) => ({
      ...row,
      rules: readJsonMaybe(row.rules_json || "[]"),
      memories: readJsonMaybe(row.memories_json || "[]"),
    }));
    return {
      traces,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  } finally {
    db.close();
  }
}

function cleanProcessOutput(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function isGitRepo(path) {
  if (!path || !existsSync(path)) return false;
  const result = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function effectiveBranchName(scope, projectPath, branchName) {
  if (scope !== "branch") return null;
  return String(branchName || "").trim() || getGitBranchName(projectPath);
}

function tagsForScope(tags, scope, branchName) {
  const clean = stripBranchTags(tags);
  const branchTag = scope === "branch" ? branchTagFor(branchName) : null;
  return branchTag ? [branchTag, ...clean] : clean;
}

function recordLifecycleEvent(db, event) {
  db.prepare(`
    INSERT INTO lifecycle_events (
      id, memory_id, candidate_id, action, reason, before_json, after_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    nowId("life"),
    event.memory_id || null,
    event.candidate_id || null,
    event.action,
    event.reason || null,
    JSON.stringify(event.before ?? null),
    JSON.stringify(event.after ?? null)
  );
}

function getStoredMemory(memoryId) {
  if (!memoryId || !existsSync(MEMORIES_DB_PATH)) return null;
  const db = new DatabaseSync(MEMORIES_DB_PATH);
  try {
    const row = db.prepare(`
      SELECT id, content, tags, scope, project_id, type, paths, category, metadata,
             created_at, updated_at, deleted_at
      FROM memories
      WHERE id = ?
    `).get(memoryId);
    return row ? rowToMemory(row) : null;
  } finally {
    db.close();
  }
}

function ensureMemoryLifecycleSeed(db, memory) {
  if (!memory?.id) return;
  const existing = db.prepare(`
    SELECT id
    FROM lifecycle_events
    WHERE memory_id = ?
    LIMIT 1
  `).get(memory.id);
  if (existing) return;
  recordLifecycleEvent(db, {
    memory_id: memory.id,
    action: "memory_backfilled",
    reason: "历史补录：这条记忆缺少早期审计事件，系统在首次查看生命周期时补充当前状态，后续变更会继续记录。",
    after: {
      id: memory.id,
      type: memory.type,
      scope: memory.display_scope || memory.scope,
      project_id: memory.project_id || null,
      category: memory.category || null,
      deleted_at: memory.deleted_at || null,
    },
  });
}

function gitCheck(cwd, args) {
  if (!cwd || !existsSync(cwd)) return { status: 1, stdout: "", stderr: "repo_missing" };
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || result.error?.message || "").trim(),
  };
}

function resolveGitRef(cwd, ref) {
  const result = gitCheck(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  return result.status === 0 ? result.stdout : null;
}

function branchRef(cwd, branchName) {
  for (const ref of [`refs/heads/${branchName}`, `refs/remotes/origin/${branchName}`]) {
    if (resolveGitRef(cwd, ref)) return ref;
  }
  return null;
}

function baseRef(cwd) {
  const originHead = gitCheck(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  for (const ref of [originHead.stdout, "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]) {
    if (ref && resolveGitRef(cwd, ref)) return ref;
  }
  return null;
}

function branchLifecycleState(cwd, branchName) {
  if (!cwd || !branchName || !isGitRepo(cwd)) return { state: "unknown", reason: "repo_or_branch_missing" };
  const ref = branchRef(cwd, branchName);
  if (!ref) return { state: "deleted", reason: `branch ref not found: ${branchName}` };
  const base = baseRef(cwd);
  if (!base) return { state: "active", reason: `base ref not found; keep branch memory active: ${branchName}` };
  const merged = gitCheck(cwd, ["merge-base", "--is-ancestor", ref, base]);
  if (merged.status === 0) return { state: "merged", reason: `${ref} is ancestor of ${base}` };
  return { state: "active", reason: `${ref} is not merged into ${base}` };
}

function editStoredMemoryTags(memoryId, tags, cwd) {
  const result = runMemories(["edit", memoryId, "--tags", tags.join(",")], cwd);
  if (result.status === 0 || tags.length > 0 || !existsSync(MEMORIES_DB_PATH)) return result;
  const db = new DatabaseSync(MEMORIES_DB_PATH);
  try {
    db.prepare("UPDATE memories SET tags = '', updated_at = datetime('now') WHERE id = ?").run(memoryId);
    return { status: 0, stdout: "Cleared tags directly", stderr: "" };
  } finally {
    db.close();
  }
}

function promoteBranchMemory(db, candidate, reason) {
  const beforeCandidate = { ...candidate };
  const beforeMemory = getStoredMemory(candidate.approved_memory_id);
  const tags = stripBranchTags(candidate.tags_json);
  const result = editStoredMemoryTags(candidate.approved_memory_id, tags, candidate.project_path);
  if (result.status !== 0) {
    return { action: "error", candidate_id: candidate.id, memory_id: candidate.approved_memory_id, detail: cleanProcessOutput(result.stderr || result.stdout) };
  }
  db.prepare(`
    UPDATE candidates
    SET scope = 'project',
        branch_name = NULL,
        tags_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(stringifyTags(tags), candidate.id);
  const afterCandidate = getCandidate(db, candidate.id);
  const afterMemory = getStoredMemory(candidate.approved_memory_id);
  recordLifecycleEvent(db, {
    memory_id: candidate.approved_memory_id,
    candidate_id: candidate.id,
    action: "branch_promoted",
    reason,
    before: { candidate: beforeCandidate, memory: beforeMemory },
    after: { candidate: afterCandidate, memory: afterMemory },
  });
  return { action: "promoted", candidate_id: candidate.id, memory_id: candidate.approved_memory_id, branch_name: candidate.branch_name };
}

function archiveBranchMemory(db, candidate, reason) {
  const beforeCandidate = { ...candidate };
  const beforeMemory = getStoredMemory(candidate.approved_memory_id);
  const result = runMemories(["forget", "--", candidate.approved_memory_id], candidate.project_path || process.env.HOME);
  const output = cleanProcessOutput(`${result.stdout || ""}\n${result.stderr || ""}`).trim();
  if (result.status !== 0 && !/not found or already forgotten/i.test(output)) {
    return { action: "error", candidate_id: candidate.id, memory_id: candidate.approved_memory_id, detail: output };
  }
  db.prepare(`
    UPDATE candidates
    SET status = 'archived',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(candidate.id);
  const afterCandidate = getCandidate(db, candidate.id);
  const afterMemory = getStoredMemory(candidate.approved_memory_id);
  recordLifecycleEvent(db, {
    memory_id: candidate.approved_memory_id,
    candidate_id: candidate.id,
    action: "branch_archived",
    reason,
    before: { candidate: beforeCandidate, memory: beforeMemory },
    after: { candidate: afterCandidate, memory: afterMemory, output },
  });
  return { action: "archived", candidate_id: candidate.id, memory_id: candidate.approved_memory_id, branch_name: candidate.branch_name };
}

function runBranchLifecycleScan({ force = false } = {}) {
  if (!force && branchLifecycleScanCache && Date.now() - branchLifecycleScanCache.cachedAt < BRANCH_LIFECYCLE_SCAN_MS) {
    return { ...branchLifecycleScanCache.value, cached: true };
  }
  const db = openDb();
  const results = [];
  try {
    const candidates = db.prepare(`
      SELECT *
      FROM candidates
      WHERE status = 'approved'
        AND scope = 'branch'
        AND branch_name IS NOT NULL
        AND project_path IS NOT NULL
        AND approved_memory_id IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 200
    `).all();
    for (const candidate of candidates) {
      const state = branchLifecycleState(candidate.project_path, candidate.branch_name);
      if (state.state === "merged") {
        results.push(promoteBranchMemory(db, candidate, state.reason));
      } else if (state.state === "deleted") {
        results.push(archiveBranchMemory(db, candidate, state.reason));
      } else {
        results.push({ action: "kept", candidate_id: candidate.id, memory_id: candidate.approved_memory_id, branch_name: candidate.branch_name, reason: state.reason });
      }
    }
  } finally {
    db.close();
  }
  const value = {
    generatedAt: new Date().toISOString(),
    scanned: results.length,
    promoted: results.filter((item) => item.action === "promoted").length,
    archived: results.filter((item) => item.action === "archived").length,
    errors: results.filter((item) => item.action === "error").length,
    results,
    cached: false,
  };
  branchLifecycleScanCache = { cachedAt: Date.now(), value };
  return value;
}

function maybeRunBranchLifecycleScan() {
  try {
    runBranchLifecycleScan();
  } catch {
    // Automatic lifecycle maintenance should not break page reads.
  }
}

function getMemoryLifecycle(memoryId) {
  const id = String(memoryId || "").trim();
  if (!id) return { error: "memory_id_required", status: 400 };
  const db = openDb();
  try {
    const memory = getStoredMemory(id);
    ensureMemoryLifecycleSeed(db, memory);
    const events = db.prepare(`
      SELECT id, memory_id, candidate_id, action, reason, before_json, after_json, created_at
      FROM lifecycle_events
      WHERE memory_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(id).map((event) => ({
      ...event,
      before: readJsonMaybe(event.before_json),
      after: readJsonMaybe(event.after_json),
    }));
    const candidates = db.prepare(`
      SELECT id, status, scope, project_path, branch_name, type, category, approved_memory_id, created_at, updated_at, approved_at
      FROM candidates
      WHERE approved_memory_id = ?
      ORDER BY updated_at DESC
    `).all(id);
    return { memory, events, candidates };
  } finally {
    db.close();
  }
}

function updateCandidate(id, body) {
  const db = openDb();
  const before = getCandidate(db, id);
  if (!before) {
    db.close();
    return null;
  }
  const next = {
    type: body.type ?? before.type,
    scope: body.scope ?? before.scope,
    project_path: body.project_path ?? before.project_path,
    branch_name: body.branch_name ?? before.branch_name,
    content: body.content ?? before.content,
    tags_json: body.tags !== undefined ? stringifyTags(body.tags) : before.tags_json,
    category: body.category ?? before.category,
    rationale: body.rationale ?? before.rationale,
    evidence: body.evidence ?? before.evidence,
    confidence: body.confidence ?? before.confidence,
    sensitivity: body.sensitivity ?? before.sensitivity,
  };
  next.branch_name = effectiveBranchName(next.scope, next.project_path, next.branch_name);
  db.prepare(`
    UPDATE candidates
    SET type = ?, scope = ?, project_path = ?, branch_name = ?, content = ?, tags_json = ?,
        category = ?, rationale = ?, evidence = ?, confidence = ?,
        sensitivity = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    next.type,
    next.scope,
    next.project_path,
    next.branch_name,
    next.content,
    next.tags_json,
    next.category,
    next.rationale,
    next.evidence,
    Number(next.confidence),
    next.sensitivity,
    id
  );
  const after = getCandidate(db, id);
  db.prepare(`
    INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
    VALUES (?, ?, 'edit', ?, ?)
  `).run(nowId("evt"), id, JSON.stringify(before), JSON.stringify(after));
  db.close();
  return rowToCandidate(after);
}

function memoryCommandEnv() {
  return {
    ...process.env,
    PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
}

function runMemories(args, cwd) {
  return spawnSync(MEMORIES_BIN, args, {
    cwd,
    encoding: "utf8",
    env: memoryCommandEnv(),
  });
}

function parseStoredMemoryId(output) {
  const match = cleanProcessOutput(output).match(/Stored\s+\w+\s+([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

function resolveUpdateMemoryId(candidate) {
  if (candidate.target_kind === "stored_memory" && candidate.target_id) return candidate.target_id;
  if (candidate.target_kind === "review_candidate" && candidate.target_id) {
    const db = openDb();
    try {
      const target = getCandidate(db, candidate.target_id);
      if (target?.approved_memory_id) return target.approved_memory_id;
    } finally {
      db.close();
    }
  }
  return null;
}

function mergePendingCandidate(source) {
  const db = openDb();
  const beforeSource = getCandidate(db, source.id);
  if (!beforeSource) {
    db.close();
    return { error: "candidate_not_found", status: 404, message: "候选不存在。" };
  }
  const resolved = resolveReviewCandidateTarget(db, source);
  if (resolved.error) {
    db.close();
    return resolved;
  }
  if (resolved.kind === "approved_memory") {
    db.close();
    return {
      convertToUpdate: true,
      memoryId: resolved.memoryId,
      target: rowToCandidate(resolved.target),
    };
  }

  const beforeTarget = resolved.target;
  const targetId = beforeTarget.id;

  const mergedEvidence = [
    beforeTarget.evidence ? `原候选依据：\n${beforeTarget.evidence}` : "",
    source.evidence ? `\n合并依据：\n${source.evidence}` : "",
  ].filter(Boolean).join("\n\n").trim();

  db.prepare(`
    UPDATE candidates
    SET type = ?,
        scope = ?,
        project_path = ?,
        branch_name = ?,
        content = ?,
        tags_json = ?,
        category = ?,
        rationale = ?,
        evidence = ?,
        confidence = ?,
        sensitivity = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    source.type,
    source.scope,
    source.project_path,
    effectiveBranchName(source.scope, source.project_path, source.branch_name),
    source.content,
    stringifyTags(tagsForScope(source.tags, source.scope, effectiveBranchName(source.scope, source.project_path, source.branch_name))),
    source.category,
    source.rationale || beforeTarget.rationale,
    mergedEvidence || source.evidence || beforeTarget.evidence,
    Number(source.confidence ?? beforeTarget.confidence ?? 0.5),
    source.sensitivity || beforeTarget.sensitivity || "normal",
    targetId
  );
  db.prepare(`
    UPDATE candidates
    SET status = 'merged',
        approved_memory_id = ?,
        target_id = ?,
        target_status = ?,
        target_content = ?,
        approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(targetId, targetId, beforeTarget.status, beforeTarget.content, source.id);
  const afterSource = getCandidate(db, source.id);
  const afterTarget = getCandidate(db, targetId);
  db.prepare(`
    INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
    VALUES (?, ?, 'merge_pending', ?, ?)
  `).run(nowId("evt"), source.id, JSON.stringify(beforeSource), JSON.stringify({ source: afterSource, target: afterTarget }));
  db.prepare(`
    INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
    VALUES (?, ?, 'merged_from', ?, ?)
  `).run(nowId("evt"), targetId, JSON.stringify(beforeTarget), JSON.stringify(afterTarget));
  db.close();
  return { candidate: rowToCandidate(afterSource), target: rowToCandidate(afterTarget), output: `Merged into ${targetId}` };
}

function approveCandidate(id, body) {
  const edited = updateCandidate(id, body);
  if (!edited) return { error: "candidate_not_found", status: 404 };
  if (edited.sensitivity === "sensitive") {
    return { error: "sensitive_candidate_requires_manual_cleanup", status: 400 };
  }

  let memoryAction = edited.memory_action || "create_new";
  let mergeUpdateMemoryId = null;
  let mergeUpdateTarget = null;
  if (edited.memory_action === "merge_pending") {
    const mergeResult = mergePendingCandidate(edited);
    if (!mergeResult.convertToUpdate) return mergeResult;
    memoryAction = "update_existing";
    mergeUpdateMemoryId = mergeResult.memoryId;
    mergeUpdateTarget = mergeResult.target;
  }

  const type = ["rule", "decision", "fact", "note"].includes(edited.type) ? edited.type : "note";
  const requestedProjectPath = edited.project_path;
  const branchName = effectiveBranchName(edited.scope, requestedProjectPath, edited.branch_name);
  const actualScope = actualScopeForPath(edited.scope, requestedProjectPath, branchName);
  const memoriesScope = actualScope === "global" ? "global" : "project";
  const tags = tagsForScope(edited.tags, actualScope, branchName).join(",");
  const targetMemoryId = mergeUpdateMemoryId || (memoryAction === "update_existing" ? resolveUpdateMemoryId(edited) : null);
  if (memoryAction === "update_existing" && !targetMemoryId) {
    return { error: "update_target_memory_not_found", status: 400, message: "找不到要更新的长期记忆。" };
  }
  const args = targetMemoryId
    ? ["edit", targetMemoryId, "--content", edited.content, "--type", type]
    : ["add", "--type", type];
  if (!targetMemoryId && memoriesScope === "global") args.push("--global");
  if (tags) args.push("--tags", tags);
  if (edited.category) args.push("--category", edited.category);
  if (!targetMemoryId) args.push(edited.content);

  const cwd = memoriesScope === "project" && requestedProjectPath && existsSync(requestedProjectPath)
    ? requestedProjectPath
    : process.env.HOME;
  const result = runMemories(args, cwd);
  if (result.status !== 0) {
    return {
      error: targetMemoryId ? "memories_edit_failed" : "memories_add_failed",
      status: 500,
      detail: cleanProcessOutput(result.stderr || result.stdout),
    };
  }
  const output = cleanProcessOutput(result.stdout);
  const memoryId = targetMemoryId || parseStoredMemoryId(output);

  const db = openDb();
  const before = getCandidate(db, id);
  db.prepare(`
    UPDATE candidates
    SET status = 'approved',
        memory_action = ?,
        scope = ?,
        project_path = ?,
        branch_name = ?,
        tags_json = ?,
        target_kind = ?,
        target_id = ?,
        target_status = ?,
        target_content = ?,
        approved_memory_id = ?,
        approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    memoryAction,
    actualScope,
    memoriesScope === "project" ? requestedProjectPath : null,
    actualScope === "branch" ? branchName : null,
    stringifyTags(tags),
    targetMemoryId ? "stored_memory" : edited.target_kind,
    targetMemoryId || edited.target_id,
    targetMemoryId ? "approved" : edited.target_status,
    mergeUpdateTarget?.content || edited.target_content,
    memoryId,
    id
  );
  const after = getCandidate(db, id);
  db.prepare(`
    INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
    VALUES (?, ?, 'approve', ?, ?)
  `).run(nowId("evt"), id, JSON.stringify(before), JSON.stringify({ ...after, memories_action: targetMemoryId ? "edit" : "add" }));
  recordLifecycleEvent(db, {
    memory_id: memoryId,
    candidate_id: id,
    action: targetMemoryId ? "memory_updated" : "memory_approved",
    reason: targetMemoryId ? "人工批准更新已有记忆" : "人工批准写入长期记忆",
    before,
    after: { ...after, memory: getStoredMemory(memoryId), memories_action: targetMemoryId ? "edit" : "add" },
  });
  db.close();
  return { candidate: rowToCandidate(after), output };
}

function rejectCandidate(id) {
  const db = openDb();
  const before = getCandidate(db, id);
  if (!before) {
    db.close();
    return null;
  }
  db.prepare(`
    UPDATE candidates
    SET status = 'rejected',
        rejected_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
  const after = getCandidate(db, id);
  db.prepare(`
    INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
    VALUES (?, ?, 'reject', ?, ?)
  `).run(nowId("evt"), id, JSON.stringify(before), JSON.stringify(after));
  db.close();
  return rowToCandidate(after);
}

function deleteRejectedCandidates() {
  const db = openDb();
  const rows = db.prepare("SELECT * FROM candidates WHERE status = 'rejected'").all();
  for (const before of rows) {
    db.prepare(`
      UPDATE candidates
      SET status = 'deleted',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'rejected'
    `).run(before.id);
    const after = getCandidate(db, before.id);
    db.prepare(`
      INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
      VALUES (?, ?, 'delete_rejected', ?, ?)
    `).run(nowId("evt"), before.id, JSON.stringify(before), JSON.stringify(after));
  }
  db.close();
  return { ok: true, deletedCount: rows.length };
}

function spawnWorkerAsync() {
  const child = spawn(NODE_BIN, ["--no-warnings=ExperimentalWarning", WORKER_PATH], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MIU_KB_WORKER: "1",
      CODEX_MEMORY_REVIEW_WORKER: "1",
    },
  });
  child.unref();
}

function enqueuePendingAiReview(body = {}) {
  const ids = [...new Set((Array.isArray(body.candidate_ids) ? body.candidate_ids : [])
    .map(String)
    .map((id) => id.trim())
    .filter(Boolean))].slice(0, 50);
  if (!ids.length) return { queued: 0, message: "当前页没有待审核候选。" };

  const db = openDb();
  try {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT c.id, c.project_path, t.cwd
      FROM candidates c
      LEFT JOIN turns t ON t.id = c.turn_id
      WHERE c.status = 'pending'
        AND c.id IN (${placeholders})
    `).all(...ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const candidateIds = ids.filter((id) => byId.has(id));
    if (!candidateIds.length) return { queued: 0, message: "当前候选已不在待审核状态。" };
    const activeReviewTurn = db.prepare(`
      SELECT id, hook_payload_json
      FROM turns
      WHERE status IN ('queued', 'processing', 'error')
      ORDER BY created_at DESC
      LIMIT 200
    `).all().find((turn) => {
      const payload = readJsonMaybe(turn.hook_payload_json);
      if (payload.miu_kb_task !== "review_pending_candidates") return false;
      const activeIds = Array.isArray(payload.candidate_ids) ? payload.candidate_ids.map(String) : [];
      return activeIds.some((id) => candidateIds.includes(id));
    });
    if (activeReviewTurn) {
      return { queued: 0, turn_id: activeReviewTurn.id, message: "当前页候选已在 AI 队列中。" };
    }

    const first = byId.get(candidateIds[0]) || {};
    const id = nowId("turn");
    const payload = {
      miu_kb_task: "review_pending_candidates",
      source: body.source || "review_page",
      session_id: "miu-kb-review",
      turn_id: id,
      candidate_ids: candidateIds,
      cwd: first.project_path || first.cwd || HOME_DIR,
      created_at: new Date().toISOString(),
    };
    const rawPath = writeRawTurn(id, payload);
    db.prepare(`
      INSERT INTO turns (
        id, session_id, turn_id, transcript_path, cwd, hook_payload_json,
        raw_snapshot_path, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
    `).run(
      id,
      payload.session_id,
      payload.turn_id,
      null,
      payload.cwd,
      safeJson(payload),
      rawPath
    );
    for (const candidateId of candidateIds) {
      const before = getCandidate(db, candidateId);
      db.prepare(`
        UPDATE candidates
        SET status = 'ai_reviewing',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(candidateId);
      const after = getCandidate(db, candidateId);
      db.prepare(`
        INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
        VALUES (?, ?, 'ai_review_queued', ?, ?)
      `).run(nowId("evt"), candidateId, JSON.stringify(before), JSON.stringify({ ...after, turn_id: id }));
    }
    spawnWorkerAsync();
    return { queued: candidateIds.length, turn_id: id };
  } finally {
    db.close();
  }
}

function deleteApprovedMemory(id) {
  const db = openDb();
  const before = getCandidate(db, id);
  if (!before) {
    db.close();
    return { error: "candidate_not_found", status: 404 };
  }
  if (before.status !== "approved") {
    db.close();
    return { error: "candidate_is_not_approved", status: 400 };
  }
  if (!before.approved_memory_id) {
    db.close();
    return { error: "approved_memory_id_missing", status: 400 };
  }
  db.close();

  const beforeStoredMemory = getStoredMemory(before.approved_memory_id);
  const cwd = ["project", "branch"].includes(before.scope) && before.project_path && existsSync(before.project_path)
    ? before.project_path
    : process.env.HOME;
  const result = spawnSync(MEMORIES_BIN, ["forget", "--", before.approved_memory_id], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  });
  const output = cleanProcessOutput(`${result.stdout || ""}\n${result.stderr || ""}`).trim();
  const alreadyGone = /not found or already forgotten/i.test(output);
  if (result.status !== 0 && !alreadyGone) {
    return {
      error: "memories_forget_failed",
      status: 500,
      detail: output,
    };
  }

  const nextDb = openDb();
  const beforeUpdate = getCandidate(nextDb, id);
  nextDb.prepare(`
    UPDATE candidates
    SET status = 'deleted',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
  const after = getCandidate(nextDb, id);
  nextDb.prepare(`
    INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
    VALUES (?, ?, 'delete_memory', ?, ?)
  `).run(nowId("evt"), id, JSON.stringify(beforeUpdate), JSON.stringify({ ...after, memories_output: output }));
  recordLifecycleEvent(nextDb, {
    memory_id: before.approved_memory_id,
    candidate_id: id,
    action: "memory_deleted",
    reason: "人工删除已写入记忆",
    before: { candidate: beforeUpdate, memory: beforeStoredMemory },
    after: { candidate: after, memory: getStoredMemory(before.approved_memory_id), output },
  });
  nextDb.close();
  return { candidate: rowToCandidate(after), output };
}

function deleteStoredMemory(id) {
  const memoryId = String(id || "").trim();
  if (!memoryId) return { error: "memory_id_required", status: 400 };
  const beforeStoredMemory = getStoredMemory(memoryId);
  const result = spawnSync(MEMORIES_BIN, ["forget", "--", memoryId], {
    cwd: process.env.HOME,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  });
  const output = cleanProcessOutput(`${result.stdout || ""}\n${result.stderr || ""}`).trim();
  const alreadyGone = /not found or already forgotten/i.test(output);
  if (result.status !== 0 && !alreadyGone) {
    return {
      error: "memories_forget_failed",
      status: 500,
      detail: output,
    };
  }
  const db = openDb();
  try {
    recordLifecycleEvent(db, {
      memory_id: memoryId,
      action: "memory_deleted",
      reason: "人工从知识库删除记忆",
      before: { memory: beforeStoredMemory },
      after: { memory: getStoredMemory(memoryId), output },
    });
  } finally {
    db.close();
  }
  return { memory_id: memoryId, output, alreadyGone };
}

function previousStatusBeforeDelete(db, candidateId) {
  const row = db.prepare(`
    SELECT before_json
    FROM review_events
    WHERE candidate_id = ?
      AND action IN ('delete_memory', 'delete_rejected')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(candidateId);
  const before = readJsonMaybe(row?.before_json);
  return ["approved", "rejected", "archived", "merged"].includes(before.status) ? before.status : null;
}

function restoreStoredMemory(memoryId) {
  if (!memoryId || !existsSync(MEMORIES_DB_PATH)) return { ok: false, error: "memory_not_found" };
  const db = new DatabaseSync(MEMORIES_DB_PATH);
  try {
    const before = db.prepare("SELECT id, deleted_at FROM memories WHERE id = ?").get(memoryId);
    if (!before) return { ok: false, error: "memory_not_found" };
    db.prepare("UPDATE memories SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(memoryId);
    return { ok: true, before };
  } finally {
    db.close();
  }
}

function purgeStoredMemoryIfDeleted(memoryId) {
  if (!memoryId || !existsSync(MEMORIES_DB_PATH)) return;
  const db = new DatabaseSync(MEMORIES_DB_PATH);
  try {
    db.prepare("DELETE FROM memories WHERE id = ? AND deleted_at IS NOT NULL").run(memoryId);
  } finally {
    db.close();
  }
}

function restoreDeletedCandidate(id) {
  const db = openDb();
  try {
    const before = getCandidate(db, id);
    if (!before) return { error: "candidate_not_found", status: 404 };
    if (before.status !== "deleted") return { error: "candidate_is_not_deleted", status: 400 };
    const restoredStatus = previousStatusBeforeDelete(db, id) || (before.approved_memory_id ? "approved" : "rejected");
    const memoryBefore = before.approved_memory_id ? getStoredMemory(before.approved_memory_id) : null;
    if (restoredStatus === "approved" && before.approved_memory_id) {
      const restored = restoreStoredMemory(before.approved_memory_id);
      if (!restored.ok) return { error: restored.error, status: 404 };
    }
    db.prepare(`
      UPDATE candidates
      SET status = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'deleted'
    `).run(restoredStatus, id);
    const after = getCandidate(db, id);
    db.prepare(`
      INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
      VALUES (?, ?, 'restore_deleted', ?, ?)
    `).run(nowId("evt"), id, JSON.stringify(before), JSON.stringify(after));
    if (restoredStatus === "approved" && before.approved_memory_id) {
      recordLifecycleEvent(db, {
        memory_id: before.approved_memory_id,
        candidate_id: id,
        action: "memory_restored",
        reason: "人工恢复已删除记忆",
        before: { candidate: before, memory: memoryBefore },
        after: { candidate: after, memory: getStoredMemory(before.approved_memory_id) },
      });
    }
    return { candidate: rowToCandidate(after) };
  } finally {
    db.close();
  }
}

function normalizeCandidateIds(body = {}) {
  return [...new Set((Array.isArray(body.candidate_ids) ? body.candidate_ids : [])
    .map(String)
    .map((id) => id.trim())
    .filter(Boolean))].slice(0, 500);
}

function restoreDeletedCandidates(body = {}) {
  const ids = normalizeCandidateIds(body);
  const results = ids.map((id) => ({ id, ...restoreDeletedCandidate(id) }));
  return {
    ok: true,
    restoredCount: results.filter((item) => !item.error).length,
    results,
  };
}

function purgeDeletedCandidates(body = {}) {
  const ids = normalizeCandidateIds(body);
  const db = openDb();
  let deletedCount = 0;
  try {
    for (const id of ids) {
      const before = getCandidate(db, id);
      if (!before || before.status !== "deleted") continue;
      purgeStoredMemoryIfDeleted(before.approved_memory_id);
      db.prepare("DELETE FROM review_events WHERE candidate_id = ?").run(id);
      db.prepare("DELETE FROM lifecycle_events WHERE candidate_id = ?").run(id);
      db.prepare("DELETE FROM candidates WHERE id = ? AND status = 'deleted'").run(id);
      deletedCount += 1;
    }
  } finally {
    db.close();
  }
  return { ok: true, deletedCount };
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex 记忆台</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --panel: #ffffff;
      --panel-raised: #ffffff;
      --subtle: #f9fafc;
      --selected: #eff5ff;
      --console: #101828;
      --line: #d9dee7;
      --line-subtle: #eef1f5;
      --line-strong: #b8c1cf;
      --text: #1f2937;
      --text-strong: #111827;
      --muted: #667085;
      --subtle-text: #98a2b3;
      --accent: #2563eb;
      --accent-700: #1d4ed8;
      --accent-soft: #eef6ff;
      --accent-line: #b8d8ff;
      --tech: #7c3aed;
      --good: #16833a;
      --good-soft: #ecfdf3;
      --good-line: #abefc6;
      --bad: #b42318;
      --bad-soft: #fef3f2;
      --bad-line: #fecdca;
      --warn: #a15c07;
      --warn-soft: #fff7ed;
      --warn-line: #fed7aa;
      --info-soft: #f0f9ff;
      --info-text: #026aa2;
      --info-line: #b9e6fe;
      --neutral-soft: #f7f8fb;
      --neutral-line: #d9dee7;
      --archived-soft: #fffbeb;
      --archived-text: #92400e;
      --archived-line: #fde68a;
      --toast-good: #14532d;
      --toast-bad: #7f1d1d;
      --scrim: rgba(16, 24, 40, 0.42);
      --inverse-divider: rgba(255, 255, 255, 0.08);
      --inverse-spinner: rgba(255, 255, 255, 0.45);
      --refresh-pulse: rgba(22, 131, 58, 0.28);
      --refresh-pulse-end: rgba(22, 131, 58, 0);
      --mono: "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", ui-monospace, monospace;
      --sans: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --radius: 6px;
      --radius-lg: 8px;
      --radius-xl: 10px;
      --nav-width: 188px;
      --side-width: 336px;
      --shadow-sm: 0 1px 2px rgba(16, 24, 40, 0.06);
      --shadow: 0 18px 48px rgba(16, 24, 40, 0.12);
      --ease: cubic-bezier(.22, 1, .36, 1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.5 var(--sans);
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
    }
    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 4;
      box-shadow: var(--shadow-sm);
    }
    h1 { font-size: 16px; margin: 0; font-weight: 750; color: var(--text-strong); }
    h1::after {
      content: "Personal KB Console";
      display: block;
      margin-top: 1px;
      color: var(--muted);
      font: 11px/1.1 var(--mono);
      font-weight: 500;
    }
    main {
      display: grid;
      grid-template-columns: var(--nav-width) minmax(0, 1fr) var(--side-width);
      gap: 12px;
      padding: 12px;
      max-width: 1680px;
      margin: 0 auto;
      height: calc(100dvh - 56px);
      min-height: 0;
      overflow: hidden;
    }
    .app-nav {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      padding: 10px;
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow-sm);
    }
    .app-nav::before {
      content: "视图";
      display: block;
      margin: 2px 8px 10px;
      color: var(--muted);
      font: 11px/1 var(--mono);
    }
    .app-nav button {
      width: 100%;
      height: 40px;
      margin-bottom: 6px;
      text-align: left;
      color: var(--muted);
      background: transparent;
      border-color: transparent;
      padding: 0 12px;
    }
    .app-nav button:hover { background: var(--subtle); color: var(--text); }
    .app-nav button.active {
      color: var(--accent);
      border-color: var(--accent-line);
      background: var(--selected);
      font-weight: 650;
    }
    .app-nav button.active:hover {
      color: var(--accent);
      border-color: var(--accent-line);
      background: var(--selected);
    }
    .app-nav .settings-tab {
      margin-top: auto;
    }
    .view-panel {
      min-width: 0;
      min-height: 0;
      overflow-y: auto;
      padding-right: 4px;
      scrollbar-gutter: stable;
      position: relative;
    }
    .view-panel[hidden] {
      display: none;
    }
    .view-panel,
    .app-nav,
    #turns,
    .evidence,
    .memory-preview,
    .memory-content,
    .prompt-editor {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .view-panel::-webkit-scrollbar,
    .app-nav::-webkit-scrollbar,
    #turns::-webkit-scrollbar,
    .evidence::-webkit-scrollbar,
    .memory-preview::-webkit-scrollbar,
    .memory-content::-webkit-scrollbar,
    .prompt-editor::-webkit-scrollbar {
      width: 0;
      height: 0;
      display: none;
    }
    .toolbar, .side, .candidate, .prompt-panel, .queue-card, .memory-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
    }
    .overview-hero,
    .overview-card,
    .overview-panel,
    .overview-activity {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
    }
    .overview-hero {
      min-height: 118px;
      padding: 18px;
      margin-bottom: 12px;
      position: relative;
      overflow: hidden;
      border-left: 4px solid var(--accent);
    }
    .overview-hero::before {
      content: "KNOWLEDGE / MEMORY / REVIEW";
      position: absolute;
      right: 16px;
      bottom: 10px;
      color: var(--line-subtle);
      font: 800 34px/1 var(--mono);
      letter-spacing: 0;
      pointer-events: none;
      z-index: 0;
    }
    .overview-hero > * {
      position: relative;
      z-index: 1;
    }
    .overview-hero h2 {
      font-size: 28px;
      line-height: 1.05;
      margin: 8px 0 8px;
      letter-spacing: 0;
    }
    .overview-hero p {
      max-width: 680px;
      color: var(--muted);
      margin: 0;
    }
    .overview-eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 26px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--subtle);
      color: var(--muted);
      font-size: 12px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--good);
      box-shadow: 0 0 0 4px var(--good-soft);
      flex: 0 0 auto;
    }
    .status-dot.warn { background: var(--warn); box-shadow: 0 0 0 4px var(--warn-soft); }
    .status-dot.bad { background: var(--bad); box-shadow: 0 0 0 4px var(--bad-soft); }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(156px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .overview-card {
      min-height: 120px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .overview-card .label {
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
    }
    .overview-card .value {
      font-size: 34px;
      line-height: 1;
      font-weight: 760;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
    }
    .overview-card .hint {
      color: var(--muted);
      font-size: 12px;
    }
    .overview-split {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
      gap: 12px;
      margin-bottom: 12px;
    }
    .overview-panel,
    .overview-activity {
      padding: 14px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .overview-panel h3,
    .overview-activity h3 {
      font-size: 14px;
      margin: 0 0 12px;
    }
    .bar-list {
      display: grid;
      gap: 9px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 82px minmax(0, 1fr) 42px;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .bar-track {
      height: 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      overflow: hidden;
      background: var(--neutral-soft);
    }
    .bar-fill {
      display: block;
      height: 100%;
      width: 0%;
      background: var(--console);
      border-radius: inherit;
    }
    .trend {
      display: grid;
      grid-template-columns: repeat(7, minmax(24px, 1fr));
      align-items: end;
      gap: 8px;
      height: 150px;
      padding-top: 8px;
    }
    .trend-col {
      display: grid;
      grid-template-rows: 1fr auto;
      gap: 6px;
      min-width: 0;
      height: 100%;
    }
    .trend-bar {
      align-self: end;
      min-height: 4px;
      border-radius: 6px 6px 2px 2px;
      background: linear-gradient(180deg, var(--console), var(--accent));
      border: 1px solid var(--line);
    }
    .trend-label {
      color: var(--muted);
      font-size: 11px;
      text-align: center;
      white-space: nowrap;
    }
    .activity-list {
      display: grid;
      gap: 8px;
    }
    .activity-item {
      border-top: 1px solid var(--line);
      padding-top: 8px;
      color: var(--muted);
      font-size: 12px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .activity-item b {
      color: var(--text);
      font-size: 13px;
    }
    .mock-console {
      background: var(--console);
      color: var(--panel);
      border-radius: var(--radius-lg);
      border: 1px solid var(--console);
      padding: 12px;
      font-family: var(--mono);
      font-size: 12px;
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    .mock-console .line {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px solid var(--inverse-divider);
      padding: 6px 0;
    }
    .mock-console .line:last-child { border-bottom: 0; }
    .mock-console .key { color: var(--subtle-text); }
    .mock-console .val { color: var(--panel); text-align: right; }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      margin-bottom: 12px;
      gap: 10px;
      flex-wrap: wrap;
      position: sticky;
      top: 0;
      z-index: 3;
      box-shadow: var(--shadow-sm);
    }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .pager { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 10px 0; color: var(--muted); }
    .pager .row { gap: 6px; }
    button, select, input, textarea {
      font: inherit;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel);
      color: var(--text);
    }
    button {
      height: 36px;
      padding: 0 10px;
      cursor: pointer;
      transition: background 120ms var(--ease), border-color 120ms var(--ease), color 120ms var(--ease), opacity 120ms var(--ease), transform 90ms var(--ease), box-shadow 120ms var(--ease);
    }
    button:hover:not(:disabled) { border-color: var(--line-strong); background: var(--subtle); }
    button:focus-visible,
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible {
      outline: 2px solid var(--accent-line);
      outline-offset: 2px;
      border-color: var(--accent);
    }
    button:disabled { cursor: not-allowed; opacity: 0.62; }
    button.primary { background: var(--accent); border-color: var(--accent); color: var(--panel); }
    button.primary:hover:not(:disabled) { background: var(--accent-700); border-color: var(--accent-700); }
    button.good { background: var(--good); border-color: var(--good); color: var(--panel); }
    button.bad { background: var(--bad); border-color: var(--bad); color: var(--panel); }
    button.active { border-color: var(--accent); color: var(--accent); }
    #refresh {
      min-width: 96px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      overflow: hidden;
    }
    #refresh .refresh-icon {
      display: inline-block;
      font-size: 15px;
      line-height: 1;
      transform-origin: 50% 48%;
    }
    #refresh.is-refreshing {
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    #refresh.is-refreshing .refresh-icon {
      animation: spin 700ms linear infinite;
    }
    #refresh.just-updated {
      animation: refreshPulse 520ms ease;
    }
    #refresh.is-pressed {
      transform: translateY(1px) scale(0.985);
    }
    #refresh.is-loading {
      color: var(--panel) !important;
    }
    #refresh.is-loading::after {
      content: none;
    }
    .last-refresh {
      min-width: 92px;
      color: var(--muted);
      font-size: 12px;
    }
    button.is-loading {
      color: transparent !important;
      position: relative;
      pointer-events: none;
    }
    button.is-loading::after {
      content: "";
      width: 14px;
      height: 14px;
      border: 2px solid var(--line-strong);
      border-top-color: var(--accent);
      border-radius: 999px;
      position: absolute;
      left: calc(50% - 7px);
      top: calc(50% - 7px);
      animation: spin 700ms linear infinite;
    }
    button.primary.is-loading::after,
    button.good.is-loading::after,
    button.bad.is-loading::after {
      border-color: var(--inverse-spinner);
      border-top-color: var(--panel);
    }
    input, select { height: 36px; padding: 0 10px; }
    textarea {
      width: 100%;
      min-height: 92px;
      padding: 8px;
      resize: vertical;
    }
    .candidate {
      padding: 10px 12px;
      margin-bottom: 10px;
    }
    .memory-card,
    .queue-card,
    .prompt-panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      padding: 10px 12px;
      margin-bottom: 10px;
      box-shadow: var(--shadow-sm);
    }
    .memory-content {
      margin: 10px 0;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--subtle);
      max-height: 150px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .memory-id {
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
    }
    .prompt-panel h2 {
      font-size: 14px;
      margin: 0;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .settings-grid label {
      display: flex;
      flex-direction: column;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
    }
    .settings-grid input,
    .settings-grid select {
      width: 100%;
      color: var(--text);
    }
    .settings-grid .wide {
      grid-column: span 2;
    }
    .prompt-editor {
      min-height: 260px;
      margin-top: 10px;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.55;
      white-space: pre;
      overflow: auto;
    }
    .prompt-path {
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .queue-path {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .queue-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 8px;
      margin: 10px 0 0;
    }
    .queue-stat {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 8px;
      background: var(--subtle);
      color: var(--muted);
      font-size: 12px;
    }
    .queue-stat b {
      display: block;
      color: var(--text);
      font-size: 16px;
      margin-top: 2px;
    }
    .queue-stat b.text-value {
      font-size: 14px;
      line-height: 1.3;
      word-break: keep-all;
    }
    .queue-note {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
    }
    .self-check-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .self-check-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      padding: 10px 12px;
      margin-bottom: 10px;
      box-shadow: var(--shadow-sm);
    }
    .self-check-card.pass { border-left: 4px solid var(--good); }
    .self-check-card.warn { border-left: 4px solid var(--warn); }
    .self-check-card.fail { border-left: 4px solid var(--bad); }
    .self-check-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      font-weight: 650;
    }
    .self-check-detail {
      color: var(--text);
      word-break: break-word;
    }
    .self-check-hint {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
      white-space: pre-wrap;
    }
    .log-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .log-card {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--subtle);
      padding: 10px;
      min-height: 92px;
    }
    .log-tail {
      margin-top: 6px;
      color: var(--text);
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 140px;
      overflow: auto;
    }
    #overviewContent,
    #list,
    #memoryList,
    #aiQueueList,
    #selfCheckList {
      position: relative;
      min-height: 72px;
      transition: opacity 160ms var(--ease);
    }
    #overviewContent.is-refreshing,
    #list.is-refreshing,
    #memoryList.is-refreshing,
    #aiQueueList.is-refreshing,
    #selfCheckList.is-refreshing {
      opacity: 0.68;
    }
    #overviewContent.is-refreshing::before,
    #list.is-refreshing::before,
    #memoryList.is-refreshing::before,
    #aiQueueList.is-refreshing::before,
    #selfCheckList.is-refreshing::before {
      content: "";
      position: sticky;
      top: 0;
      display: block;
      height: 3px;
      width: 100%;
      margin-bottom: 8px;
      border-radius: 999px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      background-size: 220% 100%;
      animation: refreshSweep 850ms linear infinite;
      z-index: 1;
    }
    .meta, .row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .meta {
      justify-content: space-between;
      color: var(--muted);
      margin-bottom: 10px;
      font-size: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: 130px 130px 1fr 150px;
      gap: 8px;
      margin: 8px 0;
    }
    .evidence {
      margin-top: 8px;
      padding: 8px;
      background: var(--subtle);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--text);
      white-space: pre-wrap;
      max-height: 160px;
      overflow: auto;
      font-size: 12px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 7px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent-700);
      font-size: 12px;
      border: 1px solid var(--accent-line);
    }
    .pill.pending { background: var(--warn-soft); color: var(--warn); border-color: var(--warn-line); }
    .pill.approved { background: var(--good-soft); color: var(--good); border-color: var(--good-line); }
    .pill.merged { background: var(--info-soft); color: var(--info-text); border-color: var(--info-line); }
    .pill.rejected { background: var(--bad-soft); color: var(--bad); border-color: var(--bad-line); }
    .pill.archived { background: var(--archived-soft); color: var(--archived-text); border-color: var(--archived-line); }
    .pill.deleted { background: var(--neutral-soft); color: var(--muted); border-color: var(--neutral-line); }
    .metric {
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--subtle);
      color: var(--muted);
      font-size: 12px;
    }
    .time-text {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      font-family: var(--mono);
    }
    .side {
      padding: 12px;
      align-self: stretch;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      position: sticky;
      top: 0;
      border-left: 4px solid var(--console);
    }
    .side::before {
      content: "上下文面板";
      display: block;
      color: var(--muted);
      font: 11px/1 var(--mono);
      margin-bottom: 10px;
    }
    .side h2 { font-size: 14px; margin: 0 0 10px; color: var(--text-strong); }
    .side h2.side-recent-title { margin-top: 18px; }
    .side-stat {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 30px;
      border-top: 1px solid var(--line-subtle);
      color: var(--muted);
      font-size: 12px;
    }
    .side-stat b {
      color: var(--text-strong);
      font: 650 13px/1.2 var(--mono);
      text-align: right;
      overflow-wrap: anywhere;
    }
    #counts {
      flex: 0 0 auto;
    }
    #turns {
      min-height: 0;
      overflow-y: auto;
      padding-right: 4px;
      scrollbar-gutter: stable;
    }
    .turn {
      border-top: 1px solid var(--line);
      padding: 8px 0;
      font-size: 12px;
      color: var(--muted);
    }
    .empty {
      padding: 36px;
      text-align: center;
      color: var(--muted);
      background: var(--subtle);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
    }
    .error { color: var(--bad); white-space: pre-wrap; }
    .toast-host {
      position: fixed;
      right: 16px;
      top: 68px;
      display: grid;
      gap: 8px;
      z-index: 10;
      pointer-events: none;
    }
    .toast {
      min-width: 220px;
      max-width: 360px;
      padding: 10px 12px;
      border-radius: var(--radius-lg);
      background: var(--console);
      color: var(--panel);
      box-shadow: var(--shadow);
      transform: translateY(-6px);
      opacity: 0;
      transition: opacity 160ms var(--ease), transform 160ms var(--ease);
    }
    .toast.show { transform: translateY(0); opacity: 1; }
    .toast.good { background: var(--toast-good); }
    .toast.bad { background: var(--toast-bad); }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: var(--scrim);
      z-index: 9;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      width: min(520px, 100%);
      max-height: calc(100vh - 36px);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow);
      padding: 16px;
      display: flex;
      flex-direction: column;
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .modal-close {
      width: 32px;
      height: 32px;
      padding: 0;
      font-size: 18px;
      line-height: 1;
    }
    .modal h2 {
      font-size: 16px;
      margin: 0;
    }
    .modal p {
      color: var(--muted);
      margin: 0 0 12px;
    }
    .memory-preview {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--subtle);
      padding: 10px;
      max-height: 160px;
      overflow: auto;
      white-space: pre-wrap;
      margin-bottom: 12px;
      color: var(--text);
    }
    .lifecycle-list {
      display: grid;
      gap: 8px;
      min-height: 0;
      overflow: auto;
      margin-bottom: 12px;
    }
    .lifecycle-item {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--subtle);
      padding: 10px;
      color: var(--text);
      overflow-wrap: anywhere;
    }
    .lifecycle-item b {
      display: block;
      color: var(--text);
      margin-bottom: 4px;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes refreshSweep {
      from { background-position: 220% 0; }
      to { background-position: -220% 0; }
    }
    @keyframes refreshPulse {
      0% { box-shadow: 0 0 0 0 var(--refresh-pulse); }
      70% { box-shadow: 0 0 0 7px var(--refresh-pulse-end); }
      100% { box-shadow: none; }
    }
    @media (max-width: 980px) {
      body { overflow: auto; }
      main {
        grid-template-columns: 1fr;
        height: auto;
        overflow: visible;
      }
      .app-nav {
        height: auto;
        display: flex;
        flex-direction: row;
        gap: 8px;
        overflow-x: auto;
        overflow-y: hidden;
      }
      .app-nav::before {
        display: none;
      }
      .app-nav button {
        width: auto;
        flex: 0 0 auto;
        margin-bottom: 0;
        white-space: nowrap;
      }
      .app-nav .settings-tab {
        margin-top: 0;
        margin-left: 0;
      }
      .view-panel {
        overflow: visible;
        padding-right: 0;
      }
      .side {
        height: auto;
        overflow: visible;
      }
      #turns {
        max-height: 420px;
      }
      .overview-grid,
      .overview-split {
        grid-template-columns: 1fr 1fr;
      }
      .grid,
      .queue-grid,
      .settings-grid,
      .self-check-summary,
      .log-grid { grid-template-columns: 1fr 1fr; }
      .settings-grid .wide { grid-column: span 2; }
    }
    @media (max-width: 680px) {
      button,
      select,
      input {
        min-height: 40px;
      }
      .overview-grid,
      .overview-split,
      .settings-grid,
      .self-check-summary,
      .log-grid {
        grid-template-columns: 1fr;
      }
      .settings-grid .wide { grid-column: span 1; }
      .overview-hero h2 {
        font-size: 23px;
      }
      .overview-hero::before {
        display: none;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>Codex 记忆台</h1>
    <div class="row">
      <button id="runWorker">处理队列</button>
      <button id="refresh" class="primary">
        <span class="refresh-icon">↻</span>
        <span class="refresh-label">刷新</span>
      </button>
      <span id="lastRefresh" class="last-refresh">尚未刷新</span>
    </div>
  </header>
  <main>
    <nav class="app-nav" aria-label="视图切换">
      <button class="active" data-view-tab="overview">概览</button>
      <button data-view-tab="review">审核台</button>
      <button data-view-tab="knowledge">知识库</button>
      <button data-view-tab="trace">引用解释</button>
      <button data-view-tab="ai">AI 队列</button>
      <button data-view-tab="selfCheck">自检</button>
      <button class="settings-tab" data-view-tab="settings">设置</button>
    </nav>
    <section id="overviewView" class="view-panel">
      <div id="overviewContent"></div>
    </section>
    <section id="reviewView" class="view-panel" hidden>
      <div class="toolbar">
        <div class="tabs" id="tabs"></div>
        <div class="row">
          <input id="query" placeholder="搜索候选记忆" />
          <select id="pageSize">
            <option value="10">每页 10 条</option>
            <option value="20" selected>每页 20 条</option>
            <option value="50">每页 50 条</option>
          </select>
          <button id="aiReviewPending">AI 复核当前页</button>
        </div>
      </div>
      <div class="pager" id="pagerTop"></div>
      <div id="list"></div>
      <div class="pager" id="pagerBottom"></div>
    </section>
    <section id="knowledgeView" class="view-panel" hidden>
      <div class="toolbar">
        <div class="tabs" id="memoryTabs"></div>
        <div class="row">
          <input id="memoryQuery" placeholder="搜索知识库" />
          <select id="memoryScope">
            <option value="all">全部范围</option>
            <option value="global">全局</option>
            <option value="project">项目</option>
            <option value="branch">分支</option>
          </select>
          <select id="memoryStatus">
            <option value="active">可用记忆</option>
            <option value="deleted">已删除</option>
            <option value="all">全部状态</option>
          </select>
          <select id="memoryPageSize">
            <option value="10">每页 10 条</option>
            <option value="20" selected>每页 20 条</option>
            <option value="50">每页 50 条</option>
          </select>
          <button id="runBranchLifecycle">扫描分支生命周期</button>
        </div>
      </div>
      <div class="pager" id="memoryPagerTop"></div>
      <div id="memoryList"></div>
      <div class="pager" id="memoryPagerBottom"></div>
    </section>
    <section id="traceView" class="view-panel" hidden>
      <div class="toolbar">
        <div class="tabs"><button class="active">最近注入</button></div>
        <div class="row">
          <select id="tracePageSize">
            <option value="10">每页 10 条</option>
            <option value="20" selected>每页 20 条</option>
            <option value="50">每页 50 条</option>
          </select>
        </div>
      </div>
      <div class="pager" id="tracePagerTop"></div>
      <div id="traceList"></div>
      <div class="pager" id="tracePagerBottom"></div>
    </section>
    <section id="aiView" class="view-panel" hidden>
      <div class="toolbar">
        <div class="tabs" id="aiTabs"></div>
        <div class="row">
          <input id="aiQuery" placeholder="搜索 AI 队列" />
          <select id="aiPageSize">
            <option value="10">每页 10 条</option>
            <option value="20" selected>每页 20 条</option>
            <option value="50">每页 50 条</option>
          </select>
        </div>
      </div>
      <div class="pager" id="aiPagerTop"></div>
      <div id="aiQueueList"></div>
      <div class="pager" id="aiPagerBottom"></div>
    </section>
    <section id="selfCheckView" class="view-panel" hidden>
      <div class="toolbar">
        <div class="tabs">
          <button id="runSelfCheck" class="active">快速自检</button>
          <button id="runModelCheck">测试模型调用</button>
        </div>
        <span class="time-text" id="selfCheckUpdated"></span>
      </div>
      <div id="selfCheckSummary"></div>
      <div id="selfCheckList"></div>
      <article class="prompt-panel" id="modelCheckPanel"></article>
      <article class="prompt-panel">
        <div class="meta">
          <h2>最近日志</h2>
          <span class="time-text">只展示尾部片段</span>
        </div>
        <div class="log-grid" id="selfCheckLogs"></div>
      </article>
    </section>
    <section id="settingsView" class="view-panel" hidden>
      <article class="prompt-panel">
        <div class="meta">
          <div class="row">
            <h2>AI 设置</h2>
            <span class="pill" id="settingsModel">模型</span>
            <span class="time-text" id="settingsUpdated"></span>
          </div>
          <span class="prompt-path" id="settingsPath"></span>
        </div>
        <div class="settings-grid">
          <label class="wide">提炼模型
            <input id="settingModelInput" list="modelOptions" placeholder="例如 gpt-5.4-mini" />
            <datalist id="modelOptions"></datalist>
          </label>
          <label>Reasoning
            <select id="settingReasoningEffort">
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label>每轮候选上限
            <input id="settingMaxCandidates" type="number" min="1" max="10" step="1" />
          </label>
          <label>重复阈值
            <input id="settingDuplicateThreshold" type="number" min="0.1" max="0.99" step="0.01" />
          </label>
          <label>同主题阈值
            <input id="settingTopicDuplicateThreshold" type="number" min="0.1" max="0.99" step="0.01" />
          </label>
          <label>相似上下文条数
            <input id="settingRelatedContextLimit" type="number" min="0" max="20" step="1" />
          </label>
          <label>相似分数下限
            <input id="settingRelatedContextMinScore" type="number" min="0" max="0.99" step="0.01" />
          </label>
          <label>单条上下文长度
            <input id="settingRelatedContextItemChars" type="number" min="80" max="1200" step="20" />
          </label>
          <label>上下文总长度
            <input id="settingRelatedContextTotalChars" type="number" min="200" max="8000" step="100" />
          </label>
          <label>LLM 超时秒数
            <input id="settingTimeoutSeconds" type="number" min="30" max="600" step="5" />
          </label>
        </div>
        <div class="row" style="margin-top:10px;">
          <button id="saveSettings" class="good">保存设置</button>
          <button id="resetSettings">恢复默认设置</button>
          <span class="time-text">保存后下一次 AI 提炼生效</span>
        </div>
      </article>
      <article class="prompt-panel">
        <div class="meta">
          <div class="row">
            <h2>AI 提炼提示词</h2>
            <span class="pill" id="promptMode">默认</span>
            <span class="time-text" id="promptUpdated"></span>
          </div>
          <span class="prompt-path" id="promptPath"></span>
        </div>
        <textarea id="extractorPrompt" class="prompt-editor" spellcheck="false"></textarea>
        <div class="row" style="margin-top:10px;">
          <button id="savePrompt" class="good">保存提示词</button>
          <button id="resetPrompt">恢复默认</button>
          <span class="time-text">保存后下一次 AI 提炼生效</span>
        </div>
      </article>
    </section>
    <aside class="side">
      <h2 id="sideStatusTitle">状态</h2>
      <div id="counts"></div>
      <h2 id="sideRecentTitle" class="side-recent-title">最近对话</h2>
      <div id="turns"></div>
    </aside>
  </main>
  <div class="toast-host" id="toastHost"></div>
  <div class="modal-backdrop" id="deleteModal" role="dialog" aria-modal="true" aria-labelledby="deleteTitle">
    <div class="modal">
      <div class="modal-header">
        <h2 id="deleteTitle">删除已写入记忆</h2>
        <button class="modal-close" id="closeDelete" aria-label="关闭">×</button>
      </div>
      <p id="deleteDescription">这会从 miu-kb 里删除该条记忆，审核台会保留一条已删除记录。</p>
      <div class="memory-preview" id="deletePreview"></div>
      <div class="modal-actions">
        <button id="cancelDelete">取消</button>
        <button id="confirmDelete" class="bad">确认删除</button>
      </div>
    </div>
  </div>
  <div class="modal-backdrop" id="lifecycleModal" role="dialog" aria-modal="true" aria-labelledby="lifecycleTitle">
    <div class="modal">
      <div class="modal-header">
        <h2 id="lifecycleTitle">记忆生命周期</h2>
        <button class="modal-close" id="closeLifecycleTop" aria-label="关闭">×</button>
      </div>
      <p id="lifecycleDescription">展示这条记忆在本地系统中的批准、提升、归档、删除等审计事件。</p>
      <div class="lifecycle-list" id="lifecycleList"></div>
      <div class="modal-actions">
        <button id="closeLifecycle">关闭</button>
      </div>
    </div>
  </div>
  <script>
    const token = ${JSON.stringify(TOKEN)};
    let state = { candidates: [], turns: [], counts: {}, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } };
    let filter = 'pending';
    let page = 1;
    let pageSize = 20;
    let searchTimer = null;
    let activeView = 'overview';
    let overviewState = null;
    let memoryState = { memories: [], counts: {}, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } };
    let memoryType = 'all';
    let memoryScope = 'all';
    let memoryStatus = 'active';
    let memoryPage = 1;
    let memoryPageSize = 20;
    let memorySearchTimer = null;
    let traceState = { traces: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } };
    let tracePage = 1;
    let tracePageSize = 20;
    let aiState = { turns: [], counts: {}, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } };
    let aiPromptState = { prompt: '', defaultPrompt: '', path: '', usingDefault: true, updatedAt: null };
    let aiSettingsState = { settings: {}, defaults: {}, path: '', updatedAt: null, modelOptions: [] };
    let selfCheckState = null;
    let modelCheckState = null;
    let aiStatus = 'all';
    let aiPage = 1;
    let aiPageSize = 20;
    let aiSearchTimer = null;
    let aiPromptDirty = false;
    let aiSettingsDirty = false;
    let loadSeq = 0;
    let pendingDelete = null;

    const api = async (path, options = {}) => {
      const joiner = path.includes('?') ? '&' : '?';
      const res = await fetch(path + joiner + 'token=' + encodeURIComponent(token), {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.detail || errorLabel(data.error) || res.statusText);
      return data;
    };

    function errorLabel(code) {
      return {
        merge_target_required: '缺少可合并的目标候选',
        cannot_merge_candidate_into_itself: '候选不能合并到自身',
        merge_target_not_found: '目标候选不存在，可能已被清理',
        merge_target_is_not_pending: '目标候选已被处理，请刷新后重新判断',
        merge_target_unavailable: '目标候选已被处理，不能继续合并',
        merge_target_cycle: '目标候选形成循环引用，不能自动合并',
        merge_target_chain_too_deep: '目标候选合并链过长，不能自动处理',
        update_target_memory_not_found: '找不到要更新的长期记忆',
      }[code] || code;
    }

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[c]);
    function setButtonLoading(button, loading, loadingText) {
      if (!button) return;
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.disabled = loading;
      button.classList.toggle('is-loading', loading);
      button.setAttribute('aria-busy', loading ? 'true' : 'false');
      button.textContent = loading ? (loadingText || button.dataset.label) : button.dataset.label;
    }
    function showToast(message, tone = 'good') {
      const host = document.getElementById('toastHost');
      const item = document.createElement('div');
      item.className = 'toast ' + tone;
      item.textContent = message;
      host.appendChild(item);
      requestAnimationFrame(() => item.classList.add('show'));
      setTimeout(() => {
        item.classList.remove('show');
        setTimeout(() => item.remove(), 180);
      }, 2200);
    }
    function showError(message) {
      showToast(message || '操作失败', 'bad');
    }
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function visibleTags(tags) {
      const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
      return [...new Set(list.map((tag) => String(tag).trim()).filter((tag) => tag && !tag.startsWith('branch:')))].join(', ');
    }
    const APP_TIME_ZONE = 'Asia/Shanghai';
    function parseDbTime(value) {
      if (!value) return null;
      if (value instanceof Date) return value;
      const text = String(value).trim();
      if (!text) return null;
      const isoLike = text.includes('T') ? text : text.replace(' ', 'T') + 'Z';
      const date = new Date(isoLike);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    function formatDbDateTime(value) {
      const date = parseDbTime(value);
      if (!date) return '';
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: APP_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(date);
      const get = (type) => parts.find((part) => part.type === type)?.value || '';
      return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute') + ':' + get('second');
    }
    function formatCandidateTime(value) {
      const formatted = formatDbDateTime(value);
      return formatted ? '北京时间 ' + formatted : '';
    }
    function confidenceLabel(value) {
      const percent = Math.round(Number(value || 0) * 100);
      return 'AI 置信度 ' + percent + '%';
    }
    function formatTime(date) {
      return date.toLocaleTimeString('zh-CN', { timeZone: APP_TIME_ZONE, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    function setRefreshLoading(loading) {
      const button = document.getElementById('refresh');
      const labelEl = button.querySelector('.refresh-label');
      const listEl = document.getElementById(activeView === 'overview' ? 'overviewContent' : activeView === 'knowledge' ? 'memoryList' : activeView === 'trace' ? 'traceList' : activeView === 'ai' ? 'aiQueueList' : 'list');
      button.disabled = loading;
      button.classList.toggle('is-loading', loading);
      button.classList.toggle('is-refreshing', loading);
      button.setAttribute('aria-busy', loading ? 'true' : 'false');
      labelEl.textContent = loading ? '刷新中' : '刷新';
      if (listEl) listEl.classList.toggle('is-refreshing', loading);
    }
    function markRefreshDone() {
      const button = document.getElementById('refresh');
      const lastRefresh = document.getElementById('lastRefresh');
      lastRefresh.textContent = '刚刚刷新 ' + formatTime(new Date());
      button.classList.remove('just-updated');
      void button.offsetWidth;
      button.classList.add('just-updated');
      setTimeout(() => button.classList.remove('just-updated'), 560);
    }
    const STATUS_LABELS = {
      pending: '待审核',
      ai_reviewing: 'AI 复核中',
      approved: '已写入',
      merged: '已合并',
      rejected: '已拒绝',
      archived: '已归档',
      deleted: '已删除',
      all: '全部',
      queued: '排队中',
      processing: '处理中',
      processed: '已处理',
      error: '错误'
    };
    const TYPE_LABELS = {
      rule: '规则',
      decision: '决策',
      fact: '事实',
      note: '笔记'
    };
    const SCOPE_LABELS = {
      project: '项目',
      branch: '分支',
      global: '全局'
    };
    const SENSITIVITY_LABELS = {
      sensitive: '含敏感信息',
      normal: '普通'
    };
    const ACTION_LABELS = {
      create_new: '新建记忆',
      update_existing: '更新已有',
      skip_duplicate: '重复跳过',
      merge_pending: '合并待审'
    };
    const CHECK_STATUS_LABELS = {
      pass: '通过',
      warn: '提醒',
      fail: '失败'
    };
    const label = (dict, value) => dict[value] || value || '';
    const countOf = (obj, key) => Number(obj?.[key] || 0);
    function formatPercent(value) {
      return Math.round(Number(value || 0) * 100) + '%';
    }
    function shortDate(value) {
      const date = parseDbTime(value);
      if (!date) return '';
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: APP_TIME_ZONE,
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const get = (type) => parts.find((part) => part.type === type)?.value || '';
      return get('month') + '/' + get('day');
    }
    function overviewTone(health) {
      if (/错误|积压|队列/.test(health || '')) return 'warn';
      return '';
    }
    function statCard(labelText, value, hint) {
      return \`
        <article class="overview-card">
          <div class="label">\${esc(labelText)}</div>
          <div class="value">\${esc(value)}</div>
          <div class="hint">\${esc(hint)}</div>
        </article>
      \`;
    }
    function barList(rows) {
      const max = Math.max(1, ...rows.map((row) => Number(row.value || 0)));
      return '<div class="bar-list">' + rows.map((row) => {
        const width = Math.max(3, Math.round((Number(row.value || 0) / max) * 100));
        return '<div class="bar-row"><span>' + esc(row.label) + '</span><div class="bar-track"><span class="bar-fill" style="width:' + width + '%"></span></div><b>' + esc(row.value) + '</b></div>';
      }).join('') + '</div>';
    }
    function trendChart(rows) {
      const max = Math.max(1, ...rows.map((row) => Number(row.created || 0)));
      return '<div class="trend">' + rows.map((row) => {
        const height = Math.max(4, Math.round((Number(row.created || 0) / max) * 118));
        return '<div class="trend-col" title="' + esc(row.day + ' 创建 ' + row.created + ' 条') + '"><div class="trend-bar" style="height:' + height + 'px"></div><div class="trend-label">' + esc(shortDate(row.day)) + '</div></div>';
      }).join('') + '</div>';
    }
    function activityList(items) {
      return '<div class="activity-list">' + (items || []).slice(0, 6).map((item) => {
        return '<div class="activity-item"><b>' + esc(label(STATUS_LABELS, item.status)) + ' · ' + esc(label(ACTION_LABELS, item.memory_action || 'create_new')) + '</b><br><span class="time-text">' + esc(formatCandidateTime(item.created_at)) + '</span><br>' + esc(item.content || '').slice(0, 96) + '</div>';
      }).join('') + '</div>';
    }
    function consoleLines(lines) {
      return '<div class="mock-console">' + lines.map(([key, value]) =>
        '<div class="line"><span class="key">' + esc(key) + '</span><span class="val">' + esc(value) + '</span></div>'
      ).join('') + '</div>';
    }

    function renderTabs() {
      const items = ['pending', 'approved', 'merged', 'rejected', 'archived', 'deleted', 'all'];
      document.getElementById('tabs').innerHTML = items.map((name) => {
        const count = name === 'all'
          ? ((state.counts.pending || 0) + (state.counts.approved || 0) + (state.counts.merged || 0) + (state.counts.rejected || 0) + (state.counts.archived || 0) + (state.counts.deleted || 0))
          : (state.counts[name] || 0);
        const text = name === 'all' ? '全部候选' : label(STATUS_LABELS, name);
        return '<button class="' + (filter === name ? 'active' : '') + '" data-filter="' + name + '">' +
          text + ' ' + count + '</button>';
      }).join('');
      document.querySelectorAll('[data-filter]').forEach((el) => {
        el.onclick = () => {
          filter = el.dataset.filter;
          page = 1;
          load({ silent: true }).catch((err) => showError(err.message));
        };
      });
    }

    function renderMemoryTabs() {
      const counts = memoryState.counts?.types || {};
      const activeTotal = memoryState.counts?.active || 0;
      const items = ['all', 'rule', 'decision', 'fact', 'note'];
      document.getElementById('memoryTabs').innerHTML = items.map((name) => {
        const count = name === 'all' ? activeTotal : (counts[name] || 0);
        const text = name === 'all' ? '全部记忆' : label(TYPE_LABELS, name);
        return '<button class="' + (memoryType === name ? 'active' : '') + '" data-memory-type="' + name + '">' +
          text + ' ' + count + '</button>';
      }).join('');
      document.querySelectorAll('[data-memory-type]').forEach((el) => {
        el.onclick = () => {
          memoryType = el.dataset.memoryType;
          memoryPage = 1;
          loadMemories({ silent: true }).catch((err) => showError(err.message));
        };
      });
    }

    function renderAiTabs() {
      const counts = aiState.counts || {};
      const items = ['all', 'active', 'processed', 'error'];
      document.getElementById('aiTabs').innerHTML = items.map((name) => {
        const count = counts[name] || 0;
        const text = name === 'all' ? '全部批次' : (name === 'active' ? '待处理' : label(STATUS_LABELS, name));
        return '<button class="' + (aiStatus === name ? 'active' : '') + '" data-ai-status="' + name + '">' +
          text + ' ' + count + '</button>';
      }).join('');
      document.querySelectorAll('[data-ai-status]').forEach((el) => {
        el.onclick = () => {
          aiStatus = el.dataset.aiStatus;
          aiPage = 1;
          loadAiQueue({ silent: true }).catch((err) => showError(err.message));
        };
      });
    }

    function candidateCard(c) {
      const tags = visibleTags(c.tags);
      const scopeOptions = ['project','branch','global'];
      const createdAt = formatCandidateTime(c.created_at);
      const confidence = confidenceLabel(c.confidence);
      const memoryAction = c.memory_action || 'create_new';
      const targetStatus = c.target_current_status || c.target_status || '';
      const targetId = c.target_current_id || c.target_id || '';
      const targetContent = c.target_current_content || c.target_content || '';
      const mergeTargetApproved = memoryAction === 'merge_pending' && targetStatus === 'approved' && c.target_current_memory_id;
      const mergeTargetUnavailable = memoryAction === 'merge_pending' && c.target_id && targetStatus && targetStatus !== 'pending' && !mergeTargetApproved;
      const effectiveAction = mergeTargetApproved ? 'update_existing' : memoryAction;
      const approveLabel = mergeTargetUnavailable
        ? '目标不可合并'
        : effectiveAction === 'update_existing'
        ? '批准更新'
        : effectiveAction === 'merge_pending'
          ? '合并候选'
          : '批准写入';
      const approveButton = c.status === 'pending'
        ? (mergeTargetUnavailable
          ? '<button class="good" data-action="approve" disabled title="' + esc(c.target_resolution_message || '目标候选已被处理，不能继续合并') + '">' + approveLabel + '</button>'
          : '<button class="good" data-action="approve">' + approveLabel + '</button>') +
          '<button class="bad" data-action="reject">拒绝</button>'
        : '';
      const targetDetails = c.target_id ? \`
          <details open>
            <summary>目标记忆</summary>
            <div class="evidence">动作：\${esc(label(ACTION_LABELS, memoryAction))}
目标类型：\${esc(c.target_kind || '')}
目标 ID：\${esc(targetId || '')}\${targetId && c.target_id && targetId !== c.target_id ? '（原目标 ' + esc(c.target_id) + '）' : ''}
目标状态：\${esc(label(STATUS_LABELS, targetStatus || c.target_status || ''))}
\${c.target_current_memory_id ? '目标长期记忆：' + esc(c.target_current_memory_id) + '\\n' : ''}\${c.target_resolution_message ? '提示：' + esc(c.target_resolution_message) + '\\n' : ''}

\${esc(targetContent || '')}</div>
          </details>
        \` : '';
      return \`
        <article class="candidate" data-id="\${esc(c.id)}" data-branch-name="\${esc(c.branch_name || '')}" data-memory-action="\${esc(effectiveAction)}">
          <div class="meta">
            <div class="row">
              <span class="pill \${esc(c.status)}">\${esc(label(STATUS_LABELS, c.status))}</span>
              <span class="pill">\${esc(label(ACTION_LABELS, memoryAction))}</span>
              <span class="time-text" title="数据库原始 UTC 时间：\${esc(c.created_at || '')}">\${esc(createdAt)}</span>
              <span class="metric" title="AI 提炼候选记忆时给出的置信度，只表示它认为这条内容值得沉淀的把握，不代表事实正确率。">\${esc(confidence)}</span>
              \${c.sensitivity !== 'normal' ? '<span class="pill rejected">' + esc(label(SENSITIVITY_LABELS, c.sensitivity)) + '</span>' : ''}
              \${c.branch_name ? '<span class="pill">分支 ' + esc(c.branch_name) + '</span>' : ''}
            </div>
            <span>\${esc(c.project_path || c.cwd || label(SCOPE_LABELS, 'global'))}</span>
          </div>
          <textarea data-field="content">\${esc(c.content)}</textarea>
          <div class="grid">
            <select data-field="type">
              \${['rule','decision','fact','note'].map(t => '<option value="' + t + '" ' + (c.type === t ? 'selected' : '') + '>' + label(TYPE_LABELS, t) + '</option>').join('')}
            </select>
            <select data-field="scope">
              \${scopeOptions.map(s => '<option value="' + s + '" ' + (c.scope === s ? 'selected' : '') + '>' + label(SCOPE_LABELS, s) + '</option>').join('')}
            </select>
            <input data-field="tags" value="\${esc(tags)}" />
            <input data-field="category" value="\${esc(c.category || '')}" placeholder="分组" />
          </div>
          <div class="row">
            <button data-action="save">保存</button>
            \${approveButton}
            \${c.status === 'approved' && c.approved_memory_id ? '<button class="bad" data-action="delete-memory">删除记忆</button>' : ''}
            \${c.status === 'approved' && c.approved_memory_id ? '<span class="pill approved">记忆 ' + esc(c.approved_memory_id) + '</span>' : ''}
            \${c.status === 'merged' && c.approved_memory_id ? '<span class="pill merged">目标候选 ' + esc(c.approved_memory_id) + '</span>' : ''}
          </div>
          \${targetDetails}
          <details>
            <summary>来源依据</summary>
            <div class="evidence">\${esc(c.evidence || '')}</div>
          </details>
        </article>
      \`;
    }

    function queueTurnCard(t) {
      const createdAt = formatCandidateTime(t.created_at);
      const processedAt = formatCandidateTime(t.processed_at);
      return \`
        <article class="queue-card" data-turn-id="\${esc(t.id)}">
          <div class="meta">
            <div class="row">
              <span class="pill \${esc(t.status)}">\${esc(label(STATUS_LABELS, t.status))}</span>
              <span class="time-text" title="入队原始 UTC 时间：\${esc(t.created_at || '')}">\${esc(createdAt)}</span>
              \${processedAt ? '<span class="time-text" title="处理完成时间">' + esc(processedAt) + '</span>' : ''}
            </div>
            <span class="memory-id">\${esc(t.id)}</span>
          </div>
          <div class="queue-path">\${esc(t.cwd || '')}</div>
          \${queueTurnStats(t)}
          <details style="margin-top:10px;">
            <summary>队列明细</summary>
            <div class="evidence">session_id: \${esc(t.session_id || '')}
turn_id: \${esc(t.turn_id || '')}
transcript_path: \${esc(t.transcript_path || '')}\${t.error ? '\\n\\nerror:\\n' + esc(t.error) : ''}</div>
          </details>
        </article>
      \`;
    }

    function queueTurnStats(t) {
      const total = Number(t.candidate_count || 0);
      const reviewTotal = Number(t.review_candidate_count || 0);
      if (total > 0) {
        return \`
          <div class="queue-grid">
            <div class="queue-stat">候选记忆<b>\${total}</b></div>
            <div class="queue-stat">待审核<b>\${Number(t.pending_candidate_count || 0)}</b></div>
            <div class="queue-stat">已写入<b>\${Number(t.approved_candidate_count || 0)}</b></div>
            <div class="queue-stat">已拒绝<b>\${Number(t.rejected_candidate_count || 0)}</b></div>
          </div>
        \`;
      }
      if (reviewTotal > 0) {
        return '<div class="queue-note">AI 正在复核当前页待审核候选 ' + esc(reviewTotal) + ' 条，完成后会自动写入、拒绝或保留待审。</div>';
      }
      const stage = t.status === 'queued'
        ? '等待提炼'
        : t.status === 'processing'
          ? '正在提炼'
          : t.status === 'error'
            ? '提炼失败'
            : esc(label(STATUS_LABELS, t.status));
      const nextStep = t.status === 'error' ? '查看错误' : '完成后进审核台';
      return \`
        <div class="queue-grid">
          <div class="queue-stat">当前阶段<b class="text-value">\${esc(stage)}</b></div>
          <div class="queue-stat">候选记忆<b class="text-value">待生成</b></div>
          <div class="queue-stat">下一步<b class="text-value">\${esc(nextStep)}</b></div>
          <div class="queue-stat">审核统计<b class="text-value">完成后显示</b></div>
        </div>
      \`;
    }

    function memoryCard(m) {
      const tags = (m.tags || []).filter((tag) => !String(tag).startsWith('branch:')).join(', ');
      const deleted = Boolean(m.deleted_at);
      const createdAt = formatCandidateTime(m.created_at);
      const updatedAt = formatCandidateTime(m.updated_at);
      return \`
        <article class="memory-card" data-memory-id="\${esc(m.id)}">
          <div class="meta">
            <div class="row">
              <span class="pill \${deleted ? 'deleted' : 'approved'}">\${deleted ? '已删除' : '可用'}</span>
              <span class="pill">\${esc(label(TYPE_LABELS, m.type))}</span>
              <span class="pill">\${esc(label(SCOPE_LABELS, m.display_scope || m.scope))}</span>
              \${m.branch_name ? '<span class="pill">分支 ' + esc(m.branch_name) + '</span>' : ''}
              <span class="time-text" title="创建：\${esc(createdAt)}；更新：\${esc(updatedAt)}">\${esc(updatedAt || createdAt)}</span>
            </div>
            <span class="memory-id">\${esc(m.id)}</span>
          </div>
          <div class="memory-content">\${esc(m.content)}</div>
          <div class="row">
            \${tags ? '<span class="metric">标签 ' + esc(tags) + '</span>' : ''}
            \${m.category ? '<span class="metric">分组 ' + esc(m.category) + '</span>' : ''}
            \${m.project_id ? '<span class="metric">项目 ' + esc(m.project_id) + '</span>' : ''}
          </div>
          <div class="row" style="margin-top:10px;">
            <button data-memory-action="lifecycle">生命周期</button>
            \${deleted ? '' : '<button class="bad" data-memory-action="delete">删除记忆</button>'}
          </div>
        </article>
      \`;
    }

    function selfCheckCard(check) {
      const status = check.status || 'warn';
      const meta = check.meta || {};
      const duration = Number(meta.durationMs || 0);
      return \`
        <article class="self-check-card \${esc(status)}">
          <div class="self-check-title">
            <span>\${esc(check.title)}</span>
            <span class="pill \${status === 'pass' ? 'approved' : status === 'fail' ? 'rejected' : 'pending'}">\${esc(label(CHECK_STATUS_LABELS, status))}</span>
          </div>
          <div class="self-check-detail">\${esc(check.detail || '')}</div>
          \${duration ? '<div class="self-check-hint">耗时 ' + esc(duration) + ' ms</div>' : ''}
          \${check.hint ? '<div class="self-check-hint">' + esc(check.hint) + '</div>' : ''}
        </article>
      \`;
    }

    function renderSelfCheckModelPanel() {
      const panel = document.getElementById('modelCheckPanel');
      if (!modelCheckState) {
        panel.innerHTML = \`
          <div class="meta">
            <h2>模型调用</h2>
            <span class="pill">未测试</span>
          </div>
          <div class="self-check-detail">点击“测试模型调用”后，会用当前设置里的模型执行一个极小的 Codex exec。</div>
        \`;
        return;
      }
      const result = modelCheckState.result || {};
      const status = modelCheckState.ok ? 'pass' : 'fail';
      panel.innerHTML = \`
        <div class="meta">
          <div class="row">
            <h2>模型调用</h2>
            <span class="pill \${modelCheckState.ok ? 'approved' : 'rejected'}">\${modelCheckState.ok ? '可用' : '失败'}</span>
            <span class="time-text">\${esc(formatCandidateTime(modelCheckState.generatedAt))}</span>
          </div>
          <span class="prompt-path">\${esc(modelCheckState.model || '')} / \${esc(modelCheckState.reasoningEffort || '')}</span>
        </div>
        <article class="self-check-card \${status}">
          <div class="self-check-detail">\${esc(modelCheckState.detail || '')}</div>
          <div class="self-check-hint">status=\${esc(result.status ?? '')} duration=\${esc(result.durationMs ?? '')}ms</div>
          \${result.stdout ? '<div class="evidence">' + esc(result.stdout) + '</div>' : ''}
          \${result.stderr || result.error ? '<div class="error">' + esc(result.stderr || result.error) + '</div>' : ''}
        </article>
      \`;
    }

    function renderSelfCheckLogs() {
      const logs = selfCheckState?.logs || [];
      document.getElementById('selfCheckLogs').innerHTML = logs.length
        ? logs.map((log) => \`
          <article class="log-card">
            <div class="self-check-title">
              <span>\${esc(log.label)}</span>
              <span class="pill \${log.exists ? 'approved' : 'deleted'}">\${log.exists ? '存在' : '缺失'}</span>
            </div>
            <div class="memory-id">\${esc(log.path || '')}</div>
            \${log.updatedAt ? '<div class="self-check-hint">更新 ' + esc(formatCandidateTime(log.updatedAt)) + '</div>' : ''}
            \${log.tail ? '<div class="log-tail">' + esc(log.tail) + '</div>' : ''}
          </article>
        \`).join('')
        : '<div class="empty">暂无日志</div>';
    }

    function renderSelfCheck() {
      if (!selfCheckState) {
        document.getElementById('selfCheckSummary').innerHTML = '';
        document.getElementById('selfCheckList').innerHTML = '<div class="empty">正在读取自检状态</div>';
        renderSelfCheckModelPanel();
        renderSelfCheckLogs();
        return;
      }
      const summary = selfCheckState.summary || {};
      document.getElementById('selfCheckUpdated').textContent = selfCheckState.generatedAt
        ? '更新时间 ' + formatCandidateTime(selfCheckState.generatedAt) + (selfCheckState.cached ? ' · 缓存' : '')
        : '';
      document.getElementById('selfCheckSummary').innerHTML = \`
        <section class="self-check-summary">
          \${statCard('整体状态', selfCheckState.health || '未知', 'hook、CLI、脚本综合状态')}
          \${statCard('通过', summary.pass || 0, '当前正常项')}
          \${statCard('提醒', summary.warn || 0, '可用但需要留意')}
          \${statCard('失败', summary.fail || 0, '需要处理的阻断项')}
        </section>
      \`;
      document.getElementById('selfCheckList').innerHTML = (selfCheckState.checks || []).length
        ? selfCheckState.checks.map(selfCheckCard).join('')
        : '<div class="empty">暂无检查结果</div>';
      renderSelfCheckModelPanel();
      renderSelfCheckLogs();
      renderSelfCheckSide();
    }

    function getPayload(card) {
      const value = (field) => card.querySelector('[data-field="' + field + '"]').value;
      return {
        content: value('content'),
        type: value('type'),
        scope: value('scope'),
        branch_name: card.dataset.branchName || null,
        tags: visibleTags(value('tags')),
        category: value('category') || null,
      };
    }

    function openDeleteModal(card) {
      pendingDelete = {
        source: card.dataset.memoryId ? 'memory' : 'candidate',
        id: card.dataset.id,
        memoryId: card.dataset.memoryId,
        content: card.dataset.memoryId
          ? card.querySelector('.memory-content').textContent
          : card.querySelector('[data-field="content"]').value,
      };
      document.getElementById('deleteTitle').textContent = pendingDelete.source === 'memory' ? '删除知识记忆' : '删除已写入记忆';
      document.getElementById('deleteDescription').textContent = pendingDelete.source === 'memory'
        ? '这会从 miu-kb 长期知识库里删除该条记忆。'
        : '这会从 miu-kb 里删除该条记忆，审核台会保留一条已删除记录。';
      document.getElementById('deletePreview').textContent = pendingDelete.content;
      document.getElementById('deleteModal').classList.add('open');
      document.getElementById('cancelDelete').focus();
    }

    function closeDeleteModal() {
      pendingDelete = null;
      document.getElementById('deleteModal').classList.remove('open');
      setButtonLoading(document.getElementById('confirmDelete'), false);
    }

    function lifecycleItem(event) {
      const title = label({
        memory_approved: '批准写入',
        memory_updated: '更新记忆',
        memory_deleted: '删除记忆',
        memory_backfilled: '历史补录',
        branch_promoted: '分支提升为项目',
        branch_archived: '分支归档',
      }, event.action);
      return '<div class="lifecycle-item"><b>' + esc(title) + '</b>' +
        '<div class="time-text">' + esc(formatCandidateTime(event.created_at)) + '</div>' +
        (event.reason ? '<div>' + esc(event.reason) + '</div>' : '') +
        (event.candidate_id ? '<div class="memory-id">候选 ' + esc(event.candidate_id) + '</div>' : '') +
        '</div>';
    }

    async function openLifecycleModal(memoryId) {
      const modal = document.getElementById('lifecycleModal');
      const list = document.getElementById('lifecycleList');
      list.innerHTML = '<div class="empty">正在读取生命周期</div>';
      modal.classList.add('open');
      const data = await api('/api/memories/' + encodeURIComponent(memoryId) + '/lifecycle');
      const events = data.events || [];
      const candidateRows = (data.candidates || []).map((c) =>
        '<div class="lifecycle-item"><b>关联候选</b><div class="memory-id">' + esc(c.id) + '</div><div>' +
        esc(label(STATUS_LABELS, c.status)) + ' · ' + esc(label(SCOPE_LABELS, c.scope)) +
        (c.branch_name ? ' · 分支 ' + esc(c.branch_name) : '') + '</div>' +
        '<button data-lifecycle-candidate="' + esc(c.id) + '">查看候选</button></div>'
      );
      list.innerHTML = events.length || candidateRows.length
        ? events.map(lifecycleItem).join('') + candidateRows.join('')
        : '<div class="empty">暂无生命周期事件</div>';
      list.querySelectorAll('[data-lifecycle-candidate]').forEach((button) => {
        button.onclick = () => openCandidateFromLifecycle(button.dataset.lifecycleCandidate);
      });
    }

    function closeLifecycleModal() {
      document.getElementById('lifecycleModal').classList.remove('open');
    }

    async function openCandidateFromLifecycle(candidateId) {
      closeLifecycleModal();
      filter = 'all';
      page = 1;
      document.getElementById('query').value = candidateId;
      switchView('review');
      await load({ silent: true });
    }

    async function handleAction(card, action, trigger) {
      const id = card.dataset.id;
      if (action === 'delete-memory') {
        openDeleteModal(card);
        return;
      }
      setButtonLoading(trigger, true);
      if (action === 'save') await api('/api/candidates/' + id, { method: 'PATCH', body: JSON.stringify(getPayload(card)) });
      if (action === 'approve') await api('/api/candidates/' + id + '/approve', { method: 'POST', body: JSON.stringify(getPayload(card)) });
      if (action === 'reject') await api('/api/candidates/' + id + '/reject', { method: 'POST' });
      await load({ silent: true });
      if (action === 'save') showToast('已保存');
      if (action === 'approve') {
        const memoryAction = card.dataset.memoryAction || 'create_new';
        showToast(memoryAction === 'update_existing'
          ? '已更新记忆'
          : memoryAction === 'merge_pending'
            ? '已合并候选'
            : '已写入记忆');
      }
      if (action === 'reject') showToast('已拒绝');
    }

    async function handleMemoryAction(card, action, trigger) {
      if (action === 'lifecycle') {
        await openLifecycleModal(card.dataset.memoryId);
        return;
      }
      if (action === 'delete') {
        openDeleteModal(card);
        return;
      }
    }

    function currentPendingCandidateIds() {
      return (state.candidates || [])
        .filter((candidate) => candidate.status === 'pending')
        .map((candidate) => candidate.id);
    }

    function updateAiReviewButton() {
      const button = document.getElementById('aiReviewPending');
      if (!button) return;
      const ids = currentPendingCandidateIds();
      button.disabled = filter !== 'pending' || ids.length === 0;
      button.title = filter === 'pending'
        ? (ids.length ? '把当前页待审核候选加入 AI 队列，由模型异步决定采纳、拒绝或继续待审。' : '当前页没有待审核候选')
        : '切换到待审核后可使用 AI 复核当前页';
    }

    async function enqueuePendingAiReview(trigger) {
      const ids = currentPendingCandidateIds();
      if (!ids.length) {
        showToast('当前页没有待审核候选', 'bad');
        return;
      }
      setButtonLoading(trigger, true, '入队中');
      try {
        const result = await api('/api/candidates/pending/ai-review', {
          method: 'POST',
          body: JSON.stringify({ candidate_ids: ids, source: 'review_page' }),
        });
        await load({ silent: true });
        await loadAiQueue({ silent: true });
        showToast(Number(result.queued || 0) > 0
          ? '已加入 AI 队列：' + Number(result.queued || 0) + ' 条'
          : (result.message || '没有候选入队'));
      } finally {
        setButtonLoading(trigger, false);
        updateAiReviewButton();
      }
    }

    function renderList() {
      const items = state.candidates;
      document.getElementById('list').innerHTML = items.length
        ? items.map(candidateCard).join('')
        : '<div class="empty">暂无候选记忆</div>';
      document.querySelectorAll('[data-action]').forEach((el) => {
        el.onclick = () => handleAction(el.closest('.candidate'), el.dataset.action, el)
          .catch((err) => {
            setButtonLoading(el, false);
            showError(err.message);
          });
      });
    }

    function renderMemoryList() {
      const items = memoryState.memories || [];
      document.getElementById('memoryList').innerHTML = items.length
        ? items.map(memoryCard).join('')
        : '<div class="empty">暂无知识记忆</div>';
      document.querySelectorAll('[data-memory-action]').forEach((el) => {
        el.onclick = () => handleMemoryAction(el.closest('.memory-card'), el.dataset.memoryAction, el)
          .catch((err) => {
            setButtonLoading(el, false);
            showError(err.message);
          });
      });
    }

    function traceMemoryLine(item) {
      const rank = item.rank === null || item.rank === undefined ? '' : ' · 分数 ' + Number(item.rank).toFixed(4);
      return '<div class="activity-item"><b>' + esc(item.id || 'unknown') + ' · ' + esc(label(TYPE_LABELS, item.type)) + ' · ' + esc(label(SCOPE_LABELS, item.scope)) + esc(rank) + '</b><br>' +
        '<span class="time-text">' + esc(item.reason || '范围过滤后注入') + '</span><br>' +
        esc(item.content || '').slice(0, 180) + '</div>';
    }

    function traceCard(trace) {
      const rules = trace.rules || [];
      const memories = trace.memories || [];
      const statusText = trace.status === 'ok' ? '已注入' : trace.status === 'empty' ? '无命中' : '错误';
      return \`
        <article class="candidate" data-trace-id="\${esc(trace.id)}">
          <div class="meta">
            <div class="row">
              <span class="pill">\${esc(statusText)}</span>
              <span class="time-text">\${esc(formatCandidateTime(trace.created_at))}</span>
              <span class="time-text">\${esc(Number(trace.approx_tokens || 0))} token 估算</span>
            </div>
            <span class="time-text">\${esc(trace.cwd || '')}</span>
          </div>
          <div class="memory-content">\${esc(trace.prompt_excerpt || '')}</div>
          <div class="meta">
            <span class="pill">规则 \${rules.length}</span>
            <span class="pill">相关记忆 \${memories.length}</span>
            <span class="pill">注入 \${Number(trace.injected_chars || 0)} 字符</span>
            \${trace.branch_name ? '<span class="pill">分支 ' + esc(trace.branch_name) + '</span>' : ''}
          </div>
          \${trace.error ? '<div class="error">' + esc(trace.error) + '</div>' : ''}
          <details data-trace-detail="\${esc(trace.id)}">
            <summary>命中明细</summary>
            <div class="activity-list">\${rules.concat(memories).length ? rules.concat(memories).map(traceMemoryLine).join('') : '<div class="empty">没有注入记忆</div>'}</div>
          </details>
        </article>
      \`;
    }

    function renderTraceList() {
      const items = traceState.traces || [];
      const openIds = new Set([...document.querySelectorAll('[data-trace-detail][open]')].map((el) => el.dataset.traceDetail));
      document.getElementById('traceList').innerHTML = items.length
        ? items.map(traceCard).join('')
        : '<div class="empty">暂无引用记录</div>';
      document.querySelectorAll('[data-trace-detail]').forEach((el) => {
        if (openIds.has(el.dataset.traceDetail)) el.open = true;
      });
    }

    function renderAiPrompt() {
      document.getElementById('promptMode').textContent = aiPromptState.usingDefault ? '默认提示词' : '自定义提示词';
      document.getElementById('promptUpdated').textContent = aiPromptState.updatedAt
        ? '更新时间 ' + formatCandidateTime(aiPromptState.updatedAt)
        : '';
      document.getElementById('promptPath').textContent = aiPromptState.path || '';
      const editor = document.getElementById('extractorPrompt');
      if (!aiPromptDirty) editor.value = aiPromptState.prompt || '';
    }

    function setFieldValue(id, value) {
      const el = document.getElementById(id);
      if (el) el.value = value ?? '';
    }

    function renderAiSettings() {
      const settings = aiSettingsState.settings || {};
      document.getElementById('settingsModel').textContent = settings.model ? '模型 ' + settings.model : '模型未设置';
      document.getElementById('settingsUpdated').textContent = aiSettingsState.updatedAt
        ? '更新时间 ' + formatCandidateTime(aiSettingsState.updatedAt)
        : '';
      document.getElementById('settingsPath').textContent = aiSettingsState.path || '';
      const modelOptions = document.getElementById('modelOptions');
      modelOptions.innerHTML = (aiSettingsState.modelOptions || [])
        .map((model) => '<option value="' + esc(model) + '"></option>')
        .join('');
      if (aiSettingsDirty) return;
      setFieldValue('settingModelInput', settings.model || '');
      setFieldValue('settingReasoningEffort', settings.reasoningEffort || 'low');
      setFieldValue('settingMaxCandidates', settings.maxCandidatesPerTurn ?? 3);
      setFieldValue('settingDuplicateThreshold', settings.duplicateThreshold ?? 0.72);
      setFieldValue('settingTopicDuplicateThreshold', settings.topicDuplicateThreshold ?? 0.62);
      setFieldValue('settingRelatedContextLimit', settings.relatedContextLimit ?? 5);
      setFieldValue('settingRelatedContextMinScore', settings.relatedContextMinScore ?? 0.16);
      setFieldValue('settingRelatedContextItemChars', settings.relatedContextItemChars ?? 320);
      setFieldValue('settingRelatedContextTotalChars', settings.relatedContextTotalChars ?? 2400);
      setFieldValue('settingTimeoutSeconds', Math.round(Number(settings.llmTimeoutMs || 180000) / 1000));
    }

    function renderAiQueueList() {
      const items = aiState.turns || [];
      document.getElementById('aiQueueList').innerHTML = items.length
        ? items.map(queueTurnCard).join('')
        : '<div class="empty">暂无待处理 AI 任务</div>';
    }

    function renderPager(targetId) {
      const p = state.pagination || { page: 1, pageSize, total: 0, totalPages: 1 };
      const start = p.total ? ((p.page - 1) * p.pageSize + 1) : 0;
      const end = Math.min(p.total, p.page * p.pageSize);
      document.getElementById(targetId).innerHTML = \`
        <span>第 \${p.page} / \${p.totalPages} 页，显示 \${start}-\${end}，共 \${p.total} 条</span>
        <div class="row">
          <button data-page="prev" \${p.page <= 1 ? 'disabled' : ''}>上一页</button>
          <button data-page="next" \${p.page >= p.totalPages ? 'disabled' : ''}>下一页</button>
        </div>
      \`;
      document.querySelectorAll('#' + targetId + ' [data-page]').forEach((el) => {
        el.onclick = () => {
          const p = state.pagination || { page: 1, totalPages: 1 };
          page = el.dataset.page === 'next'
            ? Math.min(p.totalPages, p.page + 1)
            : Math.max(1, p.page - 1);
          load({ silent: true });
        };
      });
    }

    function renderMemoryPager(targetId) {
      const p = memoryState.pagination || { page: 1, pageSize: memoryPageSize, total: 0, totalPages: 1 };
      const start = p.total ? ((p.page - 1) * p.pageSize + 1) : 0;
      const end = Math.min(p.total, p.page * p.pageSize);
      document.getElementById(targetId).innerHTML = \`
        <span>第 \${p.page} / \${p.totalPages} 页，显示 \${start}-\${end}，共 \${p.total} 条</span>
        <div class="row">
          <button data-memory-page="prev" \${p.page <= 1 ? 'disabled' : ''}>上一页</button>
          <button data-memory-page="next" \${p.page >= p.totalPages ? 'disabled' : ''}>下一页</button>
        </div>
      \`;
      document.querySelectorAll('#' + targetId + ' [data-memory-page]').forEach((el) => {
        el.onclick = () => {
          const p = memoryState.pagination || { page: 1, totalPages: 1 };
          memoryPage = el.dataset.memoryPage === 'next'
            ? Math.min(p.totalPages, p.page + 1)
            : Math.max(1, p.page - 1);
          loadMemories({ silent: true }).catch((err) => showError(err.message));
        };
      });
    }

    function renderTracePager(targetId) {
      const p = traceState.pagination || { page: 1, pageSize: tracePageSize, total: 0, totalPages: 1 };
      const start = p.total ? ((p.page - 1) * p.pageSize + 1) : 0;
      const end = Math.min(p.total, p.page * p.pageSize);
      document.getElementById(targetId).innerHTML = \`
        <span>第 \${p.page} / \${p.totalPages} 页，显示 \${start}-\${end}，共 \${p.total} 条</span>
        <div class="row">
          <button data-trace-page="prev" \${p.page <= 1 ? 'disabled' : ''}>上一页</button>
          <button data-trace-page="next" \${p.page >= p.totalPages ? 'disabled' : ''}>下一页</button>
        </div>
      \`;
      document.querySelectorAll('#' + targetId + ' [data-trace-page]').forEach((el) => {
        el.onclick = () => {
          const p = traceState.pagination || { page: 1, totalPages: 1 };
          tracePage = el.dataset.tracePage === 'next'
            ? Math.min(p.totalPages, p.page + 1)
            : Math.max(1, p.page - 1);
          loadTrace({ silent: true }).catch((err) => showError(err.message));
        };
      });
    }

    function renderAiPager(targetId) {
      const p = aiState.pagination || { page: 1, pageSize: aiPageSize, total: 0, totalPages: 1 };
      const start = p.total ? ((p.page - 1) * p.pageSize + 1) : 0;
      const end = Math.min(p.total, p.page * p.pageSize);
      document.getElementById(targetId).innerHTML = \`
        <span>第 \${p.page} / \${p.totalPages} 页，显示 \${start}-\${end}，共 \${p.total} 条</span>
        <div class="row">
          <button data-ai-page="prev" \${p.page <= 1 ? 'disabled' : ''}>上一页</button>
          <button data-ai-page="next" \${p.page >= p.totalPages ? 'disabled' : ''}>下一页</button>
        </div>
      \`;
      document.querySelectorAll('#' + targetId + ' [data-ai-page]').forEach((el) => {
        el.onclick = () => {
          const p = aiState.pagination || { page: 1, totalPages: 1 };
          aiPage = el.dataset.aiPage === 'next'
            ? Math.min(p.totalPages, p.page + 1)
            : Math.max(1, p.page - 1);
          loadAiQueue({ silent: true }).catch((err) => showError(err.message));
        };
      });
    }

    function renderSide() {
      document.getElementById('sideStatusTitle').textContent = '状态';
      document.getElementById('sideRecentTitle').textContent = '最近对话';
      document.getElementById('counts').innerHTML = ['pending','approved','merged','rejected','archived','deleted'].map((k) =>
        '<div class="side-stat"><span>' + label(STATUS_LABELS, k) + '</span><b>' + (state.counts[k] || 0) + '</b></div>'
      ).join('');
      document.getElementById('turns').innerHTML = state.turns.slice(0, 12).map((t) =>
        '<div class="turn"><b>' + esc(label(STATUS_LABELS, t.status)) + '</b><br><span class="time-text" title="数据库原始 UTC 时间：' + esc(t.created_at || '') + '">' + esc(formatCandidateTime(t.created_at)) + '</span><br>' +
        esc(t.cwd || '') + (t.error ? '<div class="error">' + esc(t.error) + '</div>' : '') + '</div>'
      ).join('');
    }

    function renderKnowledgeSide() {
      const counts = memoryState.counts || {};
      const types = counts.types || {};
      const scopes = counts.scopes || {};
      document.getElementById('sideStatusTitle').textContent = '知识库';
      document.getElementById('sideRecentTitle').textContent = '最近记忆';
      document.getElementById('counts').innerHTML = [
        ['可用记忆', counts.active || 0],
        ['已删除', counts.deleted || 0],
        ['全局', scopes.global || 0],
        ['项目', scopes.project || 0],
        ['分支', scopes.branch || 0],
        ['规则', types.rule || 0],
        ['决策', types.decision || 0],
        ['事实', types.fact || 0],
        ['笔记', types.note || 0],
      ].map(([name, count]) =>
        '<div class="side-stat"><span>' + esc(name) + '</span><b>' + count + '</b></div>'
      ).join('');
      document.getElementById('turns').innerHTML = (memoryState.memories || []).slice(0, 12).map((m) =>
        '<div class="turn"><b>' + esc(label(TYPE_LABELS, m.type)) + '</b><br><span class="time-text">' + esc(formatCandidateTime(m.updated_at || m.created_at)) + '</span><br>' +
        esc(m.content || '').slice(0, 90) + '</div>'
      ).join('');
    }

    function renderAiSide() {
      const counts = aiState.counts || {};
      document.getElementById('sideStatusTitle').textContent = 'AI 队列';
      document.getElementById('sideRecentTitle').textContent = '当前队列';
      document.getElementById('counts').innerHTML = [
        ['待处理总数', counts.all || 0],
        ['排队中', counts.queued || 0],
        ['处理中', counts.processing || 0],
        ['错误', counts.error || 0],
        ['模型', aiSettingsState.settings?.model || '未设置'],
        ['Reasoning', aiSettingsState.settings?.reasoningEffort || 'low'],
        [aiPromptState.usingDefault ? '提示词' : '提示词', aiPromptState.usingDefault ? '默认' : '自定义'],
      ].map(([name, count]) =>
        '<div class="side-stat"><span>' + esc(name) + '</span><b>' + esc(count) + '</b></div>'
      ).join('');
      document.getElementById('turns').innerHTML = (aiState.turns || []).slice(0, 12).map((t) =>
        '<div class="turn"><b>' + esc(label(STATUS_LABELS, t.status)) + '</b><br><span class="time-text" title="数据库原始 UTC 时间：' + esc(t.created_at || '') + '">' + esc(formatCandidateTime(t.created_at)) + '</span><br>' +
        esc(t.cwd || '') + '<br><span>候选 ' + Number(t.candidate_count || 0) + '</span>' + (t.error ? '<div class="error">' + esc(t.error).slice(0, 200) + '</div>' : '') + '</div>'
      ).join('');
    }

    function renderSelfCheckSide() {
      const summary = selfCheckState?.summary || {};
      document.getElementById('sideStatusTitle').textContent = '自检';
      document.getElementById('sideRecentTitle').textContent = '关键路径';
      document.getElementById('counts').innerHTML = [
        ['整体状态', selfCheckState?.health || '未检查'],
        ['通过', summary.pass || 0],
        ['提醒', summary.warn || 0],
        ['失败', summary.fail || 0],
        ['模型', selfCheckState?.settings?.model || aiSettingsState.settings?.model || '未设置'],
      ].map(([name, count]) =>
        '<div class="side-stat"><span>' + esc(name) + '</span><b>' + esc(count) + '</b></div>'
      ).join('');
      const paths = selfCheckState?.paths || {};
      document.getElementById('turns').innerHTML = [
        ['插件 hooks', paths.pluginHooks],
        ['config.toml', paths.codexConfig],
        ['legacy hooks.json', paths.hooks],
        ['插件市场', paths.pluginMarketplace],
      ].map(([name, path]) =>
        '<div class="turn"><b>' + esc(name) + '</b><br>' + esc(path || '未读取') + '</div>'
      ).join('');
    }

    function renderSettingsSide() {
      const settings = aiSettingsState.settings || {};
      document.getElementById('sideStatusTitle').textContent = '设置';
      document.getElementById('sideRecentTitle').textContent = '配置文件';
      document.getElementById('counts').innerHTML = [
        ['模型', settings.model || '未设置'],
        ['Reasoning', settings.reasoningEffort || 'low'],
        ['候选上限', settings.maxCandidatesPerTurn ?? 3],
        ['重复阈值', settings.duplicateThreshold ?? 0.72],
        ['同主题阈值', settings.topicDuplicateThreshold ?? 0.62],
        ['提示词', aiPromptState.usingDefault ? '默认' : '自定义'],
      ].map(([name, count]) =>
        '<div class="side-stat"><span>' + esc(name) + '</span><b>' + esc(count) + '</b></div>'
      ).join('');
      document.getElementById('turns').innerHTML = [
        ['设置文件', aiSettingsState.path || ''],
        ['提示词文件', aiPromptState.path || ''],
      ].map(([name, path]) =>
        '<div class="turn"><b>' + esc(name) + '</b><br>' + esc(path || '未创建') + '</div>'
      ).join('');
    }

    function renderConfigSide() {
      if (activeView === 'settings') renderSettingsSide();
      else renderAiSide();
    }

    function renderOverview() {
      const data = overviewState;
      if (!data) {
        document.getElementById('overviewContent').innerHTML = '<div class="empty">正在读取概览</div>';
        return;
      }
      const pending = data.review?.pending || 0;
      const activeMemories = data.memories?.counts?.active || 0;
      const queueOpen = data.ai?.queue?.all || 0;
      const approvalRate = formatPercent(data.review?.approvalRate || 0);
      const storageTotal = data.storage?.totalLabel || '0 B';
      const healthTone = overviewTone(data.health);
      const actionRows = [
        { label: '新建', value: countOf(data.review?.actions, 'create_new') },
        { label: '更新', value: countOf(data.review?.actions, 'update_existing') },
        { label: '合并', value: countOf(data.review?.actions, 'merge_pending') },
      ];
      const typeRows = [
        { label: '规则', value: countOf(data.review?.types, 'rule') },
        { label: '决策', value: countOf(data.review?.types, 'decision') },
        { label: '事实', value: countOf(data.review?.types, 'fact') },
        { label: '笔记', value: countOf(data.review?.types, 'note') },
      ];
      const memoryRows = [
        { label: '规则', value: countOf(data.memories?.counts?.types, 'rule') },
        { label: '决策', value: countOf(data.memories?.counts?.types, 'decision') },
        { label: '事实', value: countOf(data.memories?.counts?.types, 'fact') },
        { label: '笔记', value: countOf(data.memories?.counts?.types, 'note') },
      ];
      document.getElementById('overviewContent').innerHTML = \`
        <section class="overview-hero">
          <span class="overview-eyebrow"><span class="status-dot \${esc(healthTone)}"></span>\${esc(data.health || '运行状态')}</span>
          <h2>个人知识库运行概览</h2>
          <p>从对话进入队列、AI 提炼候选、人工审核到长期记忆写入，这里展示整条记忆工作流的当前状态。</p>
        </section>
        <section class="overview-grid">
          \${statCard('长期记忆', activeMemories, 'miu-kb 可用记忆')}
          \${statCard('待审核', pending, '需要你确认的候选')}
          \${statCard('AI 队列', queueOpen, '排队/处理中/错误')}
          \${statCard('通过率', approvalRate, '已处理候选中的写入占比')}
          \${statCard('磁盘占用', storageTotal, '本地数据、程序和长期库合计')}
        </section>
        <section class="overview-split">
          <article class="overview-panel">
            <div class="meta"><h3>最近 7 天候选生成</h3><span class="overview-eyebrow">StatCounter</span></div>
            \${trendChart(data.last7Days || [])}
          </article>
          <article class="overview-panel">
            <div class="meta"><h3>待审动作分布</h3><span class="overview-eyebrow">Memory Actions</span></div>
            \${barList(actionRows)}
          </article>
        </section>
        <section class="overview-split">
          <article class="overview-panel">
            <div class="meta"><h3>待审类型</h3><span class="overview-eyebrow">Review</span></div>
            \${barList(typeRows)}
          </article>
          <article class="overview-panel">
            <div class="meta"><h3>知识库类型</h3><span class="overview-eyebrow">Stored</span></div>
            \${barList(memoryRows)}
          </article>
        </section>
        <section class="overview-split">
          <article class="overview-activity">
            <div class="meta"><h3>最近候选</h3><span class="overview-eyebrow">Activity</span></div>
            \${activityList(data.recentCandidates || []) || '<div class="empty">暂无候选</div>'}
          </article>
          <article class="overview-panel">
            <div class="meta"><h3>系统快照</h3><span class="overview-eyebrow">MockIDE</span></div>
            \${consoleLines([
              ['review.pending', pending],
              ['review.total', data.review?.total || 0],
              ['memory.active', activeMemories],
              ['memory.deleted', data.memories?.counts?.deleted || 0],
              ['storage.total', storageTotal],
              ['turn.processed', countOf(data.ai?.turns, 'processed')],
              ['turn.error', countOf(data.ai?.turns, 'error')],
              ['generated', formatCandidateTime(data.generatedAt)],
            ])}
          </article>
        </section>
      \`;
      renderOverviewSide();
    }

    function renderOverviewSide() {
      const data = overviewState || {};
      const queue = data.ai?.queue || {};
      const review = data.review || {};
      document.getElementById('sideStatusTitle').textContent = '概览';
      document.getElementById('sideRecentTitle').textContent = '最近 AI turn';
      document.getElementById('counts').innerHTML = [
        ['系统状态', data.health || '读取中'],
        ['待审核', review.pending || 0],
        ['长期记忆', data.memories?.counts?.active || 0],
        ['AI 队列', queue.all || 0],
        ['磁盘占用', data.storage?.totalLabel || '0 B'],
        ['通过率', formatPercent(review.approvalRate || 0)],
      ].map(([name, count]) =>
        '<div class="side-stat"><span>' + esc(name) + '</span><b>' + esc(count) + '</b></div>'
      ).join('');
      document.getElementById('turns').innerHTML = (data.recentTurns || []).slice(0, 10).map((t) =>
        '<div class="turn"><b>' + esc(label(STATUS_LABELS, t.status)) + '</b><br><span class="time-text">' + esc(formatCandidateTime(t.created_at)) + '</span><br>' +
        esc(t.cwd || '') + (t.error ? '<div class="error">' + esc(t.error).slice(0, 180) + '</div>' : '') + '</div>'
      ).join('');
    }

    function render() {
      renderTabs();
      renderPager('pagerTop');
      renderList();
      renderPager('pagerBottom');
      renderSide();
      updateAiReviewButton();
    }

    function renderKnowledge() {
      renderMemoryTabs();
      renderMemoryPager('memoryPagerTop');
      renderMemoryList();
      renderMemoryPager('memoryPagerBottom');
      renderKnowledgeSide();
    }

    function renderTrace() {
      renderTracePager('tracePagerTop');
      renderTraceList();
      renderTracePager('tracePagerBottom');
      document.getElementById('sideStatusTitle').textContent = '引用解释';
      document.getElementById('sideRecentTitle').textContent = '最近注入';
      document.getElementById('counts').innerHTML = '<div class="side-stat"><span>总记录</span><b>' + Number(traceState.pagination?.total || 0) + '</b></div>';
      document.getElementById('turns').innerHTML = (traceState.traces || []).slice(0, 8).map((t) =>
        '<div class="turn"><b>' + esc(t.status === 'ok' ? '已注入' : t.status === 'empty' ? '无命中' : '错误') + '</b><br><span class="time-text">' + esc(formatCandidateTime(t.created_at)) + '</span><br>' + esc(t.cwd || '') + '</div>'
      ).join('');
    }

    function renderAi() {
      renderAiTabs();
      renderAiPager('aiPagerTop');
      renderAiQueueList();
      renderAiPager('aiPagerBottom');
      renderAiSide();
    }

    function renderSettings() {
      renderAiSettings();
      renderAiPrompt();
      renderSettingsSide();
    }

    async function load(options = {}) {
      const silent = options.silent !== false;
      const requestId = ++loadSeq;
      const startedAt = Date.now();
      if (!silent) setRefreshLoading(true);
      const q = document.getElementById('query').value.trim();
      const params = new URLSearchParams({
        status: filter,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (q) params.set('q', q);
      try {
        const nextState = await api('/api/state?' + params.toString());
        if (!silent) await sleep(Math.max(0, 650 - (Date.now() - startedAt)));
        if (requestId !== loadSeq) return;
        state = nextState;
        page = state.pagination?.page || page;
        pageSize = state.pagination?.pageSize || pageSize;
        render();
        if (!silent) {
          markRefreshDone();
          showToast('已刷新');
        }
      } finally {
        if (!silent) setRefreshLoading(false);
      }
    }

    async function loadMemories(options = {}) {
      const silent = options.silent !== false;
      const requestId = ++loadSeq;
      const startedAt = Date.now();
      if (!silent) setRefreshLoading(true);
      const q = document.getElementById('memoryQuery').value.trim();
      const params = new URLSearchParams({
        type: memoryType,
        scope: memoryScope,
        status: memoryStatus,
        page: String(memoryPage),
        pageSize: String(memoryPageSize),
      });
      if (q) params.set('q', q);
      try {
        const nextState = await api('/api/memories?' + params.toString());
        if (!silent) await sleep(Math.max(0, 650 - (Date.now() - startedAt)));
        if (requestId !== loadSeq) return;
        memoryState = nextState;
        memoryPage = memoryState.pagination?.page || memoryPage;
        memoryPageSize = memoryState.pagination?.pageSize || memoryPageSize;
        renderKnowledge();
        if (!silent) {
          markRefreshDone();
          showToast('知识库已刷新');
        }
      } finally {
        if (!silent) setRefreshLoading(false);
      }
    }

    async function loadTrace(options = {}) {
      const silent = options.silent !== false;
      const requestId = ++loadSeq;
      const startedAt = Date.now();
      if (!silent) setRefreshLoading(true);
      const params = new URLSearchParams({
        page: String(tracePage),
        pageSize: String(tracePageSize),
      });
      try {
        const nextState = await api('/api/recall-traces?' + params.toString());
        if (!silent) await sleep(Math.max(0, 650 - (Date.now() - startedAt)));
        if (requestId !== loadSeq) return;
        traceState = nextState;
        tracePage = traceState.pagination?.page || tracePage;
        tracePageSize = traceState.pagination?.pageSize || tracePageSize;
        renderTrace();
        if (!silent) {
          markRefreshDone();
          showToast('引用记录已刷新');
        }
      } finally {
        if (!silent) setRefreshLoading(false);
      }
    }

    async function runBranchLifecycle(trigger) {
      setButtonLoading(trigger, true, '扫描中');
      try {
        const result = await api('/api/branches/lifecycle/run', { method: 'POST' });
        await loadMemories({ silent: true });
        showToast('扫描完成：提升 ' + Number(result.promoted || 0) + '，归档 ' + Number(result.archived || 0));
      } finally {
        setButtonLoading(trigger, false);
      }
    }

    async function loadAiQueue(options = {}) {
      const silent = options.silent !== false;
      const requestId = ++loadSeq;
      const startedAt = Date.now();
      if (!silent) setRefreshLoading(true);
      const q = document.getElementById('aiQuery').value.trim();
      const params = new URLSearchParams({
        status: aiStatus,
        page: String(aiPage),
        pageSize: String(aiPageSize),
      });
      if (q) params.set('q', q);
      try {
        const nextState = await api('/api/ai/queue?' + params.toString());
        if (!silent) await sleep(Math.max(0, 650 - (Date.now() - startedAt)));
        if (requestId !== loadSeq) return;
        aiState = nextState;
        aiPage = aiState.pagination?.page || aiPage;
        aiPageSize = aiState.pagination?.pageSize || aiPageSize;
        renderAi();
        if (!silent) {
          markRefreshDone();
          showToast('AI 队列已刷新');
        }
      } finally {
        if (!silent) setRefreshLoading(false);
      }
    }

    async function loadSelfCheck(options = {}) {
      const silent = options.silent !== false;
      const force = options.force === true;
      const requestId = ++loadSeq;
      const startedAt = Date.now();
      if (!silent) setRefreshLoading(true);
      try {
        const nextState = await api('/api/self-check' + (force ? '?force=1' : ''));
        if (!silent) await sleep(Math.max(0, 650 - (Date.now() - startedAt)));
        if (requestId !== loadSeq) return;
        selfCheckState = nextState;
        renderSelfCheck();
        if (!silent) {
          markRefreshDone();
          showToast('自检已完成');
        }
      } finally {
        if (!silent) setRefreshLoading(false);
      }
    }

    async function runModelCheck(trigger) {
      setButtonLoading(trigger, true, '测试中');
      try {
        modelCheckState = await api('/api/self-check/model', { method: 'POST' });
        renderSelfCheckModelPanel();
        renderSelfCheckSide();
        showToast(modelCheckState.ok ? '模型调用成功' : '模型调用失败', modelCheckState.ok ? 'good' : 'bad');
      } finally {
        setButtonLoading(trigger, false);
      }
    }

    async function loadAiSettings() {
      aiSettingsState = await api('/api/ai/settings');
      renderAiSettings();
      renderConfigSide();
    }

    async function loadAiPrompt() {
      aiPromptState = await api('/api/ai/prompt');
      renderAiPrompt();
      renderConfigSide();
    }

    function numericSetting(id, fallback) {
      const value = document.getElementById(id).value;
      if (String(value ?? '').trim() === '') return fallback;
      const raw = Number(value);
      return Number.isFinite(raw) ? raw : fallback;
    }

    function collectAiSettings() {
      const current = aiSettingsState.settings || {};
      return {
        model: document.getElementById('settingModelInput').value.trim() || current.model || 'gpt-5.5',
        reasoningEffort: document.getElementById('settingReasoningEffort').value || current.reasoningEffort || 'low',
        maxCandidatesPerTurn: numericSetting('settingMaxCandidates', current.maxCandidatesPerTurn || 3),
        duplicateThreshold: numericSetting('settingDuplicateThreshold', current.duplicateThreshold || 0.72),
        topicDuplicateThreshold: numericSetting('settingTopicDuplicateThreshold', current.topicDuplicateThreshold || 0.62),
        relatedContextLimit: numericSetting('settingRelatedContextLimit', current.relatedContextLimit || 5),
        relatedContextMinScore: numericSetting('settingRelatedContextMinScore', current.relatedContextMinScore || 0.16),
        relatedContextItemChars: numericSetting('settingRelatedContextItemChars', current.relatedContextItemChars || 320),
        relatedContextTotalChars: numericSetting('settingRelatedContextTotalChars', current.relatedContextTotalChars || 2400),
        llmTimeoutMs: Math.round(numericSetting('settingTimeoutSeconds', Math.round((current.llmTimeoutMs || 180000) / 1000)) * 1000),
      };
    }

    async function saveAiSettings(trigger) {
      setButtonLoading(trigger, true, '保存中');
      try {
        aiSettingsState = await api('/api/ai/settings', {
          method: 'PUT',
          body: JSON.stringify({ settings: collectAiSettings() }),
        });
        aiSettingsDirty = false;
        renderAiSettings();
        renderConfigSide();
        showToast('AI 设置已保存，下一次提炼生效');
      } finally {
        setButtonLoading(trigger, false);
      }
    }

    async function resetAiSettings(trigger) {
      setButtonLoading(trigger, true, '恢复中');
      try {
        aiSettingsState = await api('/api/ai/settings/reset', { method: 'POST' });
        aiSettingsDirty = false;
        renderAiSettings();
        renderConfigSide();
        showToast('已恢复默认 AI 设置');
      } finally {
        setButtonLoading(trigger, false);
      }
    }

    async function saveAiPrompt(trigger) {
      setButtonLoading(trigger, true, '保存中');
      try {
        aiPromptState = await api('/api/ai/prompt', {
          method: 'PUT',
          body: JSON.stringify({ prompt: document.getElementById('extractorPrompt').value }),
        });
        aiPromptDirty = false;
        renderAiPrompt();
        renderConfigSide();
        showToast('提示词已保存，下一次 AI 提炼生效');
      } finally {
        setButtonLoading(trigger, false);
      }
    }

    async function resetAiPrompt(trigger) {
      setButtonLoading(trigger, true, '恢复中');
      try {
        aiPromptState = await api('/api/ai/prompt/reset', { method: 'POST' });
        aiPromptDirty = false;
        renderAiPrompt();
        renderConfigSide();
        showToast('已恢复默认提示词');
      } finally {
        setButtonLoading(trigger, false);
      }
    }

    async function loadSettingsView(options = {}) {
      const silent = options.silent !== false;
      const requestId = ++loadSeq;
      const startedAt = Date.now();
      if (!silent) setRefreshLoading(true);
      try {
        const [settingsState, promptState] = await Promise.all([
          api('/api/ai/settings'),
          api('/api/ai/prompt'),
        ]);
        if (!silent) await sleep(Math.max(0, 650 - (Date.now() - startedAt)));
        if (requestId !== loadSeq) return;
        aiSettingsState = settingsState;
        aiPromptState = promptState;
        renderSettings();
        if (!silent) {
          markRefreshDone();
          showToast('设置已刷新');
        }
      } finally {
        if (!silent) setRefreshLoading(false);
      }
    }

    async function loadOverview(options = {}) {
      const silent = options.silent !== false;
      const requestId = ++loadSeq;
      const startedAt = Date.now();
      if (!silent) setRefreshLoading(true);
      try {
        const nextState = await api('/api/overview');
        if (!silent) await sleep(Math.max(0, 650 - (Date.now() - startedAt)));
        if (requestId !== loadSeq) return;
        overviewState = nextState;
        renderOverview();
        if (!silent) {
          markRefreshDone();
          showToast('概览已刷新');
        }
      } finally {
        if (!silent) setRefreshLoading(false);
      }
    }

    function refreshCurrent(options = {}) {
      if (activeView === 'overview') return loadOverview(options);
      if (activeView === 'knowledge') return loadMemories(options);
      if (activeView === 'trace') return loadTrace(options);
      if (activeView === 'ai') return loadAiQueue(options);
      if (activeView === 'selfCheck') return loadSelfCheck(options);
      if (activeView === 'settings') return loadSettingsView(options);
      return load(options);
    }

    function switchView(view) {
      activeView = ['overview', 'review', 'knowledge', 'trace', 'ai', 'selfCheck', 'settings'].includes(view) ? view : 'overview';
      document.querySelectorAll('[data-view-tab]').forEach((button) => {
        button.classList.toggle('active', button.dataset.viewTab === activeView);
      });
      document.getElementById('overviewView').hidden = activeView !== 'overview';
      document.getElementById('reviewView').hidden = activeView !== 'review';
      document.getElementById('knowledgeView').hidden = activeView !== 'knowledge';
      document.getElementById('traceView').hidden = activeView !== 'trace';
      document.getElementById('aiView').hidden = activeView !== 'ai';
      document.getElementById('selfCheckView').hidden = activeView !== 'selfCheck';
      document.getElementById('settingsView').hidden = activeView !== 'settings';
      if (activeView === 'overview') {
        loadOverview({ silent: true }).catch((err) => showError(err.message));
      } else if (activeView === 'knowledge') {
        loadMemories({ silent: true }).catch((err) => showError(err.message));
      } else if (activeView === 'trace') {
        loadTrace({ silent: true }).catch((err) => showError(err.message));
      } else if (activeView === 'ai') {
        loadAiSettings().catch((err) => showError(err.message));
        loadAiQueue({ silent: true }).catch((err) => showError(err.message));
      } else if (activeView === 'selfCheck') {
        loadSelfCheck({ silent: true }).catch((err) => showError(err.message));
      } else if (activeView === 'settings') {
        loadSettingsView({ silent: true }).catch((err) => showError(err.message));
      } else {
        load({ silent: true }).catch((err) => showError(err.message));
      }
    }

    document.querySelectorAll('[data-view-tab]').forEach((button) => {
      button.onclick = () => switchView(button.dataset.viewTab);
    });
    document.getElementById('runSelfCheck').onclick = (event) => {
      loadSelfCheck({ silent: false, force: true }).catch((err) => showError(err.message));
    };
    document.getElementById('runModelCheck').onclick = (event) => {
      runModelCheck(event.currentTarget).catch((err) => showError(err.message));
    };
    document.getElementById('refresh').onclick = () => {
      const button = document.getElementById('refresh');
      button.classList.add('is-pressed');
      setTimeout(() => button.classList.remove('is-pressed'), 120);
      refreshCurrent({ silent: false }).catch((err) => showError(err.message));
    };
    document.getElementById('runWorker').onclick = async () => {
      const button = document.getElementById('runWorker');
      setButtonLoading(button, true, '处理中');
      try {
        await api('/api/worker/run', { method: 'POST' });
        await refreshCurrent({ silent: true });
        showToast('队列处理完成');
      } catch (err) {
        showError(err.message);
      } finally {
        setButtonLoading(button, false);
      }
    };
    document.getElementById('aiReviewPending').onclick = (event) => {
      enqueuePendingAiReview(event.currentTarget).catch((err) => {
        setButtonLoading(event.currentTarget, false);
        showError(err.message);
        updateAiReviewButton();
      });
    };
    document.getElementById('query').oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { page = 1; load({ silent: true }).catch((err) => showError(err.message)); }, 250);
    };
    document.getElementById('pageSize').onchange = (event) => {
      pageSize = Number(event.target.value || 20);
      page = 1;
      load({ silent: true }).catch((err) => showError(err.message));
    };
    document.getElementById('memoryQuery').oninput = () => {
      clearTimeout(memorySearchTimer);
      memorySearchTimer = setTimeout(() => {
        memoryPage = 1;
        loadMemories({ silent: true }).catch((err) => showError(err.message));
      }, 250);
    };
    document.getElementById('memoryScope').onchange = (event) => {
      memoryScope = event.target.value || 'all';
      memoryPage = 1;
      loadMemories({ silent: true }).catch((err) => showError(err.message));
    };
    document.getElementById('memoryStatus').onchange = (event) => {
      memoryStatus = event.target.value || 'active';
      memoryPage = 1;
      loadMemories({ silent: true }).catch((err) => showError(err.message));
    };
    document.getElementById('memoryPageSize').onchange = (event) => {
      memoryPageSize = Number(event.target.value || 20);
      memoryPage = 1;
      loadMemories({ silent: true }).catch((err) => showError(err.message));
    };
    document.getElementById('runBranchLifecycle').onclick = (event) => {
      runBranchLifecycle(event.currentTarget).catch((err) => showError(err.message));
    };
    document.getElementById('tracePageSize').onchange = (event) => {
      tracePageSize = Number(event.target.value || 20);
      tracePage = 1;
      loadTrace({ silent: true }).catch((err) => showError(err.message));
    };
    document.getElementById('aiQuery').oninput = () => {
      clearTimeout(aiSearchTimer);
      aiSearchTimer = setTimeout(() => {
        aiPage = 1;
        loadAiQueue({ silent: true }).catch((err) => showError(err.message));
      }, 250);
    };
    document.getElementById('aiPageSize').onchange = (event) => {
      aiPageSize = Number(event.target.value || 20);
      aiPage = 1;
      loadAiQueue({ silent: true }).catch((err) => showError(err.message));
    };
    [
      'settingModelInput',
      'settingReasoningEffort',
      'settingMaxCandidates',
      'settingDuplicateThreshold',
      'settingTopicDuplicateThreshold',
      'settingRelatedContextLimit',
      'settingRelatedContextMinScore',
      'settingRelatedContextItemChars',
      'settingRelatedContextTotalChars',
      'settingTimeoutSeconds',
    ].forEach((id) => {
      const el = document.getElementById(id);
      el.oninput = () => {
        aiSettingsDirty = true;
      };
      el.onchange = () => {
        aiSettingsDirty = true;
      };
    });
    document.getElementById('saveSettings').onclick = (event) => {
      saveAiSettings(event.currentTarget).catch((err) => showError(err.message));
    };
    document.getElementById('resetSettings').onclick = (event) => {
      resetAiSettings(event.currentTarget).catch((err) => showError(err.message));
    };
    document.getElementById('extractorPrompt').oninput = () => {
      aiPromptDirty = true;
    };
    document.getElementById('savePrompt').onclick = (event) => {
      saveAiPrompt(event.currentTarget).catch((err) => showError(err.message));
    };
    document.getElementById('resetPrompt').onclick = (event) => {
      resetAiPrompt(event.currentTarget).catch((err) => showError(err.message));
    };
    document.getElementById('cancelDelete').onclick = () => closeDeleteModal();
    document.getElementById('closeDelete').onclick = () => closeDeleteModal();
    document.getElementById('closeLifecycle').onclick = () => closeLifecycleModal();
    document.getElementById('closeLifecycleTop').onclick = () => closeLifecycleModal();
    document.getElementById('deleteModal').onclick = (event) => {
      if (event.target.id === 'deleteModal') closeDeleteModal();
    };
    document.getElementById('lifecycleModal').onclick = (event) => {
      if (event.target.id === 'lifecycleModal') closeLifecycleModal();
    };
    document.getElementById('confirmDelete').onclick = async () => {
      if (!pendingDelete) return;
      const button = document.getElementById('confirmDelete');
      setButtonLoading(button, true, '删除中');
      try {
        if (pendingDelete.source === 'memory') {
          await api('/api/memories/' + encodeURIComponent(pendingDelete.memoryId) + '/delete', { method: 'POST' });
        } else {
          await api('/api/candidates/' + pendingDelete.id + '/delete-memory', { method: 'POST' });
        }
        closeDeleteModal();
        await refreshCurrent({ silent: true });
        showToast('记忆已删除');
      } catch (err) {
        setButtonLoading(button, false);
        showError(err.message);
      }
    };
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.getElementById('deleteModal').classList.contains('open')) {
        closeDeleteModal();
      }
      if (event.key === 'Escape' && document.getElementById('lifecycleModal').classList.contains('open')) {
        closeLifecycleModal();
      }
    });
    switchView('overview');
    setInterval(() => {
      if (activeView === 'selfCheck') return;
      refreshCurrent({ silent: true }).catch(() => {});
    }, 8000);
  </script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === "/health") return sendJson(res, { ok: true });
    if (url.pathname === "/" && !isAuthorized(req, url)) {
      res.writeHead(302, { location: `/?token=${encodeURIComponent(TOKEN)}` });
      return res.end();
    }
    if (!isAuthorized(req, url)) return sendJson(res, { error: "unauthorized" }, 401);
    if (url.pathname === "/") return sendHtml(res, html());
    if (url.pathname === "/api/overview" && req.method === "GET") {
      return sendJson(res, getOverviewState({ force: url.searchParams.get("force") === "1" }));
    }
    if (url.pathname === "/api/self-check" && req.method === "GET") {
      return sendJson(res, await getSelfCheckState({ force: url.searchParams.get("force") === "1" }));
    }
    if (url.pathname === "/api/self-check/model" && req.method === "POST") {
      return sendJson(res, await runModelSelfCheck());
    }
    if (url.pathname === "/api/bootstrap" && req.method === "POST") {
      return sendJson(res, bootstrapFirstUse());
    }
    if (url.pathname === "/api/settings/integrations/inject" && req.method === "POST") {
      return sendJson(res, bootstrapFirstUse());
    }
    if (url.pathname === "/api/settings/integrations/clear" && req.method === "POST") {
      return sendJson(res, clearCodexIntegration());
    }
    if (url.pathname === "/api/settings/memories/clear" && req.method === "POST") {
      const result = clearStoredMemories();
      return result.error ? sendJson(res, result, result.status || 500) : sendJson(res, result);
    }
    if (url.pathname === "/api/settings/uninstall" && req.method === "POST") {
      return sendJson(res, uninstallMiuKb());
    }
    if (url.pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, getState({
        status: url.searchParams.get("status") || "pending",
        page: url.searchParams.get("page") || "1",
        pageSize: url.searchParams.get("pageSize") || "20",
        q: url.searchParams.get("q") || "",
      }));
    }
    if (url.pathname === "/api/memories" && req.method === "GET") {
      return sendJson(res, getKnowledgeState({
        type: url.searchParams.get("type") || "all",
        scope: url.searchParams.get("scope") || "all",
        status: url.searchParams.get("status") || "active",
        page: url.searchParams.get("page") || "1",
        pageSize: url.searchParams.get("pageSize") || "20",
        q: url.searchParams.get("q") || "",
      }));
    }
    if (url.pathname === "/api/recall-traces" && req.method === "GET") {
      return sendJson(res, getRecallTraceState({
        page: url.searchParams.get("page") || "1",
        pageSize: url.searchParams.get("pageSize") || "20",
        includeSelfCheck: url.searchParams.get("includeSelfCheck") || "0",
      }));
    }
    if (url.pathname === "/api/ai/queue" && req.method === "GET") {
      return sendJson(res, getAiQueueState({
        status: url.searchParams.get("status") || "all",
        page: url.searchParams.get("page") || "1",
        pageSize: url.searchParams.get("pageSize") || "20",
        q: url.searchParams.get("q") || "",
      }));
    }
    if (url.pathname === "/api/ai/prompt" && req.method === "GET") {
      return sendJson(res, getPromptState());
    }
    if (url.pathname === "/api/ai/prompt" && req.method === "PUT") {
      const result = savePrompt(await readBody(req));
      return result.error ? sendJson(res, result, result.status || 500) : sendJson(res, result);
    }
    if (url.pathname === "/api/ai/prompt/reset" && req.method === "POST") {
      return sendJson(res, resetPrompt());
    }
    if (url.pathname === "/api/ai/review-prompt" && req.method === "GET") {
      return sendJson(res, getAiReviewPromptState());
    }
    if (url.pathname === "/api/ai/review-prompt" && req.method === "PUT") {
      const result = saveAiReviewPrompt(await readBody(req));
      return result.error ? sendJson(res, result, result.status || 500) : sendJson(res, result);
    }
    if (url.pathname === "/api/ai/review-prompt/reset" && req.method === "POST") {
      return sendJson(res, resetAiReviewPrompt());
    }
    if (url.pathname === "/api/ai/settings" && req.method === "GET") {
      return sendJson(res, getSettingsState());
    }
    if (url.pathname === "/api/ai/settings" && req.method === "PUT") {
      const result = saveSettings(await readBody(req));
      return result.error ? sendJson(res, result, result.status || 500) : sendJson(res, result);
    }
    if (url.pathname === "/api/ai/settings/reset" && req.method === "POST") {
      return sendJson(res, resetSettings());
    }
    if (url.pathname === "/api/worker/run" && req.method === "POST") {
      return sendJson(res, { results: processQueuedTurns({ limit: 20 }) });
    }
    if (url.pathname === "/api/candidates/pending/ai-review" && req.method === "POST") {
      return sendJson(res, enqueuePendingAiReview(await readBody(req)));
    }
    if (url.pathname === "/api/candidates/rejected/delete" && req.method === "POST") {
      return sendJson(res, deleteRejectedCandidates());
    }
    if (url.pathname === "/api/candidates/deleted/restore" && req.method === "POST") {
      return sendJson(res, restoreDeletedCandidates(await readBody(req)));
    }
    if (url.pathname === "/api/candidates/deleted/purge" && req.method === "POST") {
      return sendJson(res, purgeDeletedCandidates(await readBody(req)));
    }
    if (url.pathname === "/api/branches/lifecycle/run" && req.method === "POST") {
      return sendJson(res, runBranchLifecycleScan({ force: true }));
    }
    const memoryLifecycleMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/lifecycle$/);
    if (memoryLifecycleMatch && req.method === "GET") {
      const result = getMemoryLifecycle(decodeURIComponent(memoryLifecycleMatch[1]));
      return result.error ? sendJson(res, result, result.status || 500) : sendJson(res, result);
    }
    const memoryMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/delete$/);
    if (memoryMatch && req.method === "POST") {
      const result = deleteStoredMemory(decodeURIComponent(memoryMatch[1]));
      return result.error ? sendJson(res, result, result.status || 500) : sendJson(res, result);
    }
    const restoreCandidateMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/restore$/);
    if (restoreCandidateMatch && req.method === "POST") {
      const result = restoreDeletedCandidate(decodeURIComponent(restoreCandidateMatch[1]));
      return result.error ? sendJson(res, result, result.status || 500) : sendJson(res, result);
    }
    const purgeCandidateMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/purge$/);
    if (purgeCandidateMatch && req.method === "POST") {
      const result = purgeDeletedCandidates({ candidate_ids: [decodeURIComponent(purgeCandidateMatch[1])] });
      return sendJson(res, result);
    }
    const candidateMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)(?:\/(approve|reject|delete-memory))?$/);
    if (candidateMatch) {
      const [, id, action] = candidateMatch;
      if (req.method === "PATCH" && !action) {
        const body = await readBody(req);
        const candidate = updateCandidate(id, body);
        return candidate ? sendJson(res, { candidate }) : sendJson(res, { error: "not_found" }, 404);
      }
      if (req.method === "POST" && action === "approve") {
        const result = approveCandidate(id, await readBody(req));
        return result.error ? sendJson(res, result, result.status || 500) : sendJson(res, result);
      }
      if (req.method === "POST" && action === "reject") {
        const candidate = rejectCandidate(id);
        return candidate ? sendJson(res, { candidate }) : sendJson(res, { error: "not_found" }, 404);
      }
      if (req.method === "POST" && action === "delete-memory") {
        const result = deleteApprovedMemory(id);
        return result.error ? sendJson(res, result, result.status || 500) : sendJson(res, result);
      }
    }
    notFound(res);
  } catch (error) {
    sendJson(res, { error: "server_error", detail: error instanceof Error ? error.stack : String(error) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`miu-kb: http://${HOST}:${PORT}/?token=${TOKEN}\n`);
});
