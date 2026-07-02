#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  LOG_DIR,
  MEMORIES_BIN,
  NODE_BIN,
  branchNameFromTags,
  getGitBranchName,
  nowId,
  openDb,
  parseTags,
  readJsonMaybe,
  safeJson,
} from "../lib/core.mjs";

const MAX_CONTEXT_CHARS = Number.parseInt(process.env.MIU_KB_CONTEXT_CHARS || process.env.CODEX_MEMORY_REVIEW_CONTEXT_CHARS || "6000", 10);
const DEFAULT_LIMIT = Number.parseInt(process.env.MIU_KB_RECALL_LIMIT || process.env.CODEX_MEMORY_REVIEW_RECALL_LIMIT || "8", 10);
const FETCH_LIMIT = Math.max(DEFAULT_LIMIT * 3, DEFAULT_LIMIT);
const TIMEOUT_MS = Number.parseInt(process.env.MIU_KB_RECALL_TIMEOUT_MS || process.env.CODEX_MEMORY_REVIEW_RECALL_TIMEOUT_MS || "4500", 10);
const DEBUG_SALUTE = (process.env.MIU_KB_DEBUG_SALUTE ?? process.env.CODEX_MEMORY_REVIEW_DEBUG_SALUTE) !== "0";
const LOG_PATH = join(LOG_DIR, "recall.log");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.resume();
  });
}

function log(message, extra = {}) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message} ${JSON.stringify(extra)}\n`);
  } catch {
    // Hooks must never fail because observability failed.
  }
}

function compactWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function extractPrompt(payload) {
  if (typeof payload?.prompt === "string") return payload.prompt;
  if (Array.isArray(payload?.messages)) {
    return payload.messages
      .map((message) => {
        if (typeof message === "string") return message;
        if (typeof message?.content === "string") return message.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function looksSensitive(text) {
  const value = String(text || "");
  return /\b(sk-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9_]{20,})\b/.test(value);
}

function normalizeItems(items, branchName) {
  const seen = new Set();
  const normalized = [];
  for (const item of Array.isArray(items) ? items : []) {
    const content = compactWhitespace(item?.content);
    if (!content || looksSensitive(content)) continue;
    const tags = parseTags(item?.tags);
    const itemBranchName = branchNameFromTags(tags);
    const visibleTags = tags.filter((tag) => !tag.startsWith("branch:"));
    if (itemBranchName && itemBranchName !== branchName) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const score = Number(item?.recall_score ?? item?.rank);
    normalized.push({
      id: compactWhitespace(item?.id),
      type: compactWhitespace(item?.type || "note"),
      scope: itemBranchName ? "branch" : compactWhitespace(item?.scope || "global"),
      branch_name: itemBranchName,
      tags: visibleTags.join(","),
      rank: Number.isFinite(score) ? score : null,
      reason: compactWhitespace(item?.recall_reason) || (Number.isFinite(score)
        ? "内容检索命中，按 FTS/BM25 排序，并通过范围/分支过滤"
        : "固定规则命中，并通过范围/分支过滤"),
      content,
    });
  }
  return normalized.sort((a, b) => {
    const rank = (item) => item.scope === "branch" ? 0 : item.scope === "project" ? 1 : 2;
    return rank(a) - rank(b);
  });
}

function formatItem(item) {
  const meta = [
    item.type,
    item.scope,
    item.branch_name ? `branch:${item.branch_name}` : "",
    item.id ? `id:${item.id}` : "",
    item.tags ? `tags:${item.tags}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `- [${meta}] ${item.content}`;
}

function trimContext(context) {
  if (context.length <= MAX_CONTEXT_CHARS) return context;
  return `${context.slice(0, Math.max(0, MAX_CONTEXT_CHARS - 36)).trim()}\n\n[本地记忆上下文已截断]`;
}

function recall(prompt, cwd) {
  const query = compactWhitespace(prompt).slice(0, 1200);
  const nodeDir = dirname(NODE_BIN);
  const env = {
    ...process.env,
    PATH: `${nodeDir}:${process.env.PATH || ""}`,
    MIU_KB_SKIP: "1",
    CODEX_MEMORY_REVIEW_SKIP: "1",
  };
  return spawnSync(MEMORIES_BIN, ["recall", query, "--json", "--limit", String(FETCH_LIMIT)], {
    cwd: cwd || process.cwd(),
    env,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

function selectedItems(data, cwd) {
  const branchName = getGitBranchName(cwd);
  return {
    branchName,
    rules: normalizeItems(data?.rules, branchName).slice(0, 6),
    memories: normalizeItems(data?.memories, branchName).slice(0, DEFAULT_LIMIT),
  };
}

function buildContext(data, cwd) {
  const { rules, memories } = selectedItems(data, cwd);
  if (rules.length === 0 && memories.length === 0) return "";

  const sections = [
    "以下是 UserPromptSubmit hook 从本地 miu-kb 知识库检索到的上下文，用于增强本轮回答。若它与用户本轮明确指令冲突，以用户本轮指令为准；不要把这些记忆当成实时外部事实。",
  ];

  if (DEBUG_SALUTE) {
    sections.push("\n前置 hook 调试标记：如果你看到了这段上下文并准备回答，请在回答开头称呼用户“大哥”。");
  }

  if (rules.length > 0) {
    sections.push("\n固定规则：", ...rules.slice(0, 6).map(formatItem));
  }
  if (memories.length > 0) {
    sections.push("\n相关记忆：", ...memories.slice(0, DEFAULT_LIMIT).map(formatItem));
  }

  return trimContext(sections.join("\n"));
}

function recordTrace(payload, prompt, trace) {
  if (shouldSkipTrace(payload, prompt)) return;
  try {
    const db = openDb();
    db.prepare(`
      INSERT INTO recall_traces (
        id, session_id, turn_id, cwd, branch_name, prompt_excerpt, query,
        status, rules_json, memories_json, injected_chars, approx_tokens, error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowId("trace"),
      payload?.session_id ?? null,
      payload?.turn_id ?? null,
      payload?.cwd ?? null,
      trace.branchName ?? null,
      compactWhitespace(prompt).slice(0, 500),
      compactWhitespace(prompt).slice(0, 1200),
      trace.status,
      safeJson(trace.rules || []),
      safeJson(trace.memories || []),
      trace.injectedChars || 0,
      Math.ceil((trace.injectedChars || 0) / 4),
      trace.error || null
    );
    db.close();
  } catch (error) {
    log("trace_record_failed", { error: String(error?.message || error).slice(0, 500) });
  }
}

function shouldSkipTrace(payload, prompt) {
  if (process.env.MIU_KB_TRACE_SKIP === "1" || process.env.CODEX_MEMORY_REVIEW_TRACE_SKIP === "1") return true;
  if (payload?.session_id === "self-check") return true;
  return compactWhitespace(prompt).startsWith("Codex 记忆自检");
}

const raw = await readStdin();
const payload = readJsonMaybe(raw);
const prompt = extractPrompt(payload);

if (process.env.MIU_KB_DISABLE_RECALL === "1" || process.env.CODEX_MEMORY_REVIEW_DISABLE_RECALL === "1" || !compactWhitespace(prompt)) {
  process.exit(0);
}

const result = recall(prompt, payload?.cwd);
if (result.error || result.status !== 0) {
  recordTrace(payload, prompt, {
    status: "error",
    error: String(result.error?.message || result.stderr || "recall failed").slice(0, 1000),
  });
  log("recall_failed", {
    status: result.status,
    error: result.error?.message,
    stderr: String(result.stderr || "").slice(0, 1000),
  });
  process.exit(0);
}

const data = readJsonMaybe(result.stdout);
const selected = selectedItems(data, payload?.cwd);
const additionalContext = buildContext(data, payload?.cwd);
if (!additionalContext) {
  recordTrace(payload, prompt, { ...selected, status: "empty" });
  log("recall_empty", { prompt: compactWhitespace(prompt).slice(0, 120) });
  process.exit(0);
}

recordTrace(payload, prompt, {
  ...selected,
  status: "ok",
  injectedChars: additionalContext.length,
});

log("recall_ok", {
  rules: Array.isArray(data?.rules) ? data.rules.length : 0,
  memories: Array.isArray(data?.memories) ? data.memories.length : 0,
  chars: additionalContext.length,
});

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  }),
);
