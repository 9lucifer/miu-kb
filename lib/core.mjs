import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "./sqlite-sync.mjs";

export const APP_DIR = process.env.MIU_KB_APP_DIR || process.env.CODEX_MEMORY_REVIEW_APP_DIR || join(homedir(), ".codex", "miu-kb");
export const DATA_DIR = process.env.MIU_KB_DATA_DIR || process.env.CODEX_MEMORY_REVIEW_DATA_DIR || join(homedir(), ".config", "miu-kb");
export const RAW_TURN_DIR = join(DATA_DIR, "raw", "turns");
export const LOG_DIR = join(DATA_DIR, "logs");
export const DB_PATH = join(DATA_DIR, "pending.db");
export const MEMORIES_DB_PATH = process.env.MIU_KB_DB || join(DATA_DIR, "local.db");
export const TOKEN_PATH = join(DATA_DIR, "token");
export const DEFAULT_PORT = 17322;
export const EXTRACTOR_SCHEMA_PATH = join(APP_DIR, "extractor.schema.json");
export const EXTRACTOR_PROMPT_PATH = join(DATA_DIR, "extractor-prompt.md");
export const AI_REVIEW_PROMPT_PATH = join(DATA_DIR, "ai-review-prompt.md");
export const SETTINGS_PATH = join(DATA_DIR, "settings.json");
export const BUILTIN_MEMORY_SETTINGS = Object.freeze({
  model: "gpt-5.5",
  reasoningEffort: "low",
  maxCandidatesPerTurn: 3,
  duplicateThreshold: 0.72,
  topicDuplicateThreshold: 0.62,
  relatedContextLimit: 5,
  relatedContextMinScore: 0.16,
  relatedContextItemChars: 320,
  relatedContextTotalChars: 2400,
  llmTimeoutMs: 180000,
});

function commandPath(name) {
  for (const dir of String(process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}

function firstExisting(paths) {
  return paths.find((path) => path && existsSync(path)) || null;
}

export const NODE_BIN =
  process.env.MIU_KB_NODE_BIN ||
  process.env.CODEX_MEMORY_REVIEW_NODE_BIN ||
  process.execPath ||
  commandPath("node") ||
  firstExisting([
    join(homedir(), ".nvm", "versions", "node", "v22.22.3", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ]) ||
  "node";

export const MEMORIES_BIN =
  process.env.MIU_KB_BIN ||
  process.env.CODEX_MEMORY_REVIEW_MEMORIES_BIN ||
  firstExisting([
    join(APP_DIR, "bin", "miu-kb.mjs"),
    commandPath("miu-kb"),
    join(dirname(NODE_BIN), "miu-kb"),
    join(process.cwd(), "bin", "miu-kb.mjs"),
  ]) ||
  "miu-kb";

export const CODEX_BIN =
  process.env.MIU_KB_CODEX_BIN ||
  process.env.CODEX_MEMORY_REVIEW_CODEX_BIN ||
  commandPath("codex") ||
  firstExisting([
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ]) ||
  "codex";

export function ensureDirs() {
  for (const dir of [APP_DIR, DATA_DIR, RAW_TURN_DIR, LOG_DIR, dirname(DB_PATH)]) {
    mkdirSync(dir, { recursive: true });
  }
}

function envNumber(name) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envSettings() {
  return {
    model: process.env.MIU_KB_MODEL || process.env.CODEX_MEMORY_REVIEW_MODEL,
    reasoningEffort: process.env.MIU_KB_REASONING_EFFORT || process.env.CODEX_MEMORY_REVIEW_REASONING_EFFORT,
    maxCandidatesPerTurn: envNumber("MIU_KB_MAX_CANDIDATES") ?? envNumber("CODEX_MEMORY_REVIEW_MAX_CANDIDATES"),
    duplicateThreshold: envNumber("MIU_KB_DUPLICATE_THRESHOLD") ?? envNumber("CODEX_MEMORY_REVIEW_DUPLICATE_THRESHOLD"),
    topicDuplicateThreshold: envNumber("MIU_KB_TOPIC_DUPLICATE_THRESHOLD") ?? envNumber("CODEX_MEMORY_REVIEW_TOPIC_DUPLICATE_THRESHOLD"),
    relatedContextLimit: envNumber("MIU_KB_RELATED_LIMIT") ?? envNumber("CODEX_MEMORY_REVIEW_RELATED_LIMIT"),
    relatedContextMinScore: envNumber("MIU_KB_RELATED_MIN_SCORE") ?? envNumber("CODEX_MEMORY_REVIEW_RELATED_MIN_SCORE"),
    relatedContextItemChars: envNumber("MIU_KB_RELATED_ITEM_CHARS") ?? envNumber("CODEX_MEMORY_REVIEW_RELATED_ITEM_CHARS"),
    relatedContextTotalChars: envNumber("MIU_KB_RELATED_TOTAL_CHARS") ?? envNumber("CODEX_MEMORY_REVIEW_RELATED_TOTAL_CHARS"),
    llmTimeoutMs: envNumber("MIU_KB_LLM_TIMEOUT_MS") ?? envNumber("CODEX_MEMORY_REVIEW_LLM_TIMEOUT_MS"),
  };
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clampInteger(value, fallback, min, max) {
  return Math.round(clampNumber(value, fallback, min, max));
}

export function sanitizeMemorySettings(value = {}, fallback = BUILTIN_MEMORY_SETTINGS) {
  const source = value && typeof value === "object" ? value : {};
  const model = String(source.model ?? fallback.model ?? BUILTIN_MEMORY_SETTINGS.model).trim();
  const reasoningEffort = String(source.reasoningEffort ?? fallback.reasoningEffort ?? "low").trim();
  return {
    model:
      model && /^[A-Za-z0-9._:-]+$/.test(model) && model.length <= 80
        ? model
        : fallback.model || BUILTIN_MEMORY_SETTINGS.model,
    reasoningEffort: ["minimal", "low", "medium", "high"].includes(reasoningEffort)
      ? reasoningEffort
      : fallback.reasoningEffort || BUILTIN_MEMORY_SETTINGS.reasoningEffort,
    maxCandidatesPerTurn: clampInteger(
      source.maxCandidatesPerTurn,
      fallback.maxCandidatesPerTurn,
      1,
      10
    ),
    duplicateThreshold: clampNumber(source.duplicateThreshold, fallback.duplicateThreshold, 0.1, 0.99),
    topicDuplicateThreshold: clampNumber(
      source.topicDuplicateThreshold,
      fallback.topicDuplicateThreshold,
      0.1,
      0.99
    ),
    relatedContextLimit: clampInteger(source.relatedContextLimit, fallback.relatedContextLimit, 0, 20),
    relatedContextMinScore: clampNumber(source.relatedContextMinScore, fallback.relatedContextMinScore, 0, 0.99),
    relatedContextItemChars: clampInteger(source.relatedContextItemChars, fallback.relatedContextItemChars, 80, 1200),
    relatedContextTotalChars: clampInteger(source.relatedContextTotalChars, fallback.relatedContextTotalChars, 200, 8000),
    llmTimeoutMs: clampInteger(source.llmTimeoutMs, fallback.llmTimeoutMs, 30000, 600000),
  };
}

export function readMemorySettings() {
  ensureDirs();
  const envBackedDefaults = sanitizeMemorySettings(envSettings(), BUILTIN_MEMORY_SETTINGS);
  if (!existsSync(SETTINGS_PATH)) return envBackedDefaults;
  const raw = readJsonMaybe(readFileSync(SETTINGS_PATH, "utf8"));
  return sanitizeMemorySettings(raw, envBackedDefaults);
}

export function writeMemorySettings(value) {
  ensureDirs();
  const settings = sanitizeMemorySettings(value, readMemorySettings());
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

export function getToken() {
  ensureDirs();
  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return token;
}

export function openDb() {
  ensureDirs();
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      turn_id TEXT,
      transcript_path TEXT,
      cwd TEXT,
      hook_payload_json TEXT,
      raw_snapshot_path TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_turns_status_created
      ON turns(status, created_at);

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      scope TEXT NOT NULL DEFAULT 'project',
      project_path TEXT,
      branch_name TEXT,
      content TEXT NOT NULL,
      tags_json TEXT,
      category TEXT,
      rationale TEXT,
      evidence TEXT,
      confidence REAL DEFAULT 0.5,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      memory_action TEXT NOT NULL DEFAULT 'create_new',
      target_kind TEXT,
      target_id TEXT,
      target_status TEXT,
      target_content TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_memory_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT,
      rejected_at TEXT,
      FOREIGN KEY(turn_id) REFERENCES turns(id)
    );

    CREATE INDEX IF NOT EXISTS idx_candidates_status_created
      ON candidates(status, created_at);

    CREATE TABLE IF NOT EXISTS review_events (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lifecycle_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT,
      candidate_id TEXT,
      action TEXT NOT NULL,
      reason TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_lifecycle_memory_created
      ON lifecycle_events(memory_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_lifecycle_candidate_created
      ON lifecycle_events(candidate_id, created_at);

    CREATE TABLE IF NOT EXISTS recall_traces (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      turn_id TEXT,
      cwd TEXT,
      branch_name TEXT,
      prompt_excerpt TEXT,
      query TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      rules_json TEXT,
      memories_json TEXT,
      injected_chars INTEGER NOT NULL DEFAULT 0,
      approx_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_recall_traces_created
      ON recall_traces(created_at);
  `);
  for (const statement of [
    "ALTER TABLE candidates ADD COLUMN memory_action TEXT NOT NULL DEFAULT 'create_new'",
    "ALTER TABLE candidates ADD COLUMN target_kind TEXT",
    "ALTER TABLE candidates ADD COLUMN target_id TEXT",
    "ALTER TABLE candidates ADD COLUMN target_status TEXT",
    "ALTER TABLE candidates ADD COLUMN target_content TEXT",
    "ALTER TABLE candidates ADD COLUMN branch_name TEXT",
  ]) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
    }
  }
  return db;
}

export function nowId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function readJsonMaybe(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

export function writeRawTurn(id, payload) {
  ensureDirs();
  const path = join(RAW_TURN_DIR, `${id}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

export function safeJson(value) {
  return JSON.stringify(value ?? null);
}

export function parseTags(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = readJsonMaybe(trimmed);
    if (Array.isArray(parsed)) return parsed.map(String).map((s) => s.trim()).filter(Boolean);
  }
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

export function stringifyTags(tags) {
  return JSON.stringify([...new Set(parseTags(tags))]);
}

export function stripBranchTags(tags) {
  return parseTags(tags).filter((tag) => !tag.startsWith("branch:"));
}

export function branchTagFor(branchName) {
  const value = String(branchName || "").trim();
  return value && value !== "HEAD" ? `branch:${encodeURIComponent(value)}` : null;
}

export function branchNameFromTags(tags) {
  const tag = parseTags(tags).find((item) => item.startsWith("branch:"));
  if (!tag) return null;
  try {
    return decodeURIComponent(tag.slice("branch:".length));
  } catch {
    return tag.slice("branch:".length);
  }
}

export function normalizeGitUrl(url) {
  let normalized = String(url || "").trim();
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  const httpsMatch = normalized.match(/^https?:\/\/([^/]+)\/(.+)$/);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
  return normalized || null;
}

export function getGitRemoteUrl(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  const result = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const remote = result.status === 0 ? result.stdout.trim() : "";
  return remote || null;
}

export function getProjectId(cwd) {
  return normalizeGitUrl(getGitRemoteUrl(cwd));
}

export function projectIdForCwd(cwd) {
  return getProjectId(cwd) || (cwd && existsSync(cwd) ? cwd : null);
}

export function isGitRepo(cwd) {
  if (!cwd || !existsSync(cwd)) return false;
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

export function getGitBranchName(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const branch = result.status === 0 ? result.stdout.trim() : "";
  return branch && branch !== "HEAD" ? branch : null;
}

export function actualScopeForPath(scope, projectPath, branchName = getGitBranchName(projectPath)) {
  if (scope === "branch" && branchName && isGitRepo(projectPath)) return "branch";
  if (scope === "project" && projectIdForCwd(projectPath)) return "project";
  return "global";
}

export function rowToCandidate(row) {
  return {
    ...row,
    memory_action: row.memory_action || "create_new",
    tags: parseTags(row.tags_json),
  };
}
