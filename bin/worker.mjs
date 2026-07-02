#!/usr/bin/env node
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "../lib/sqlite-sync.mjs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openStore } from "../src/store.mjs";
import {
  AI_REVIEW_PROMPT_PATH,
  CODEX_BIN,
  EXTRACTOR_PROMPT_PATH,
  EXTRACTOR_SCHEMA_PATH,
  LOG_DIR,
  MEMORIES_DB_PATH,
  actualScopeForPath,
  branchNameFromTags,
  branchTagFor,
  demoteMergeDependents,
  ensureDirs,
  getGitBranchName,
  projectIdForCwd,
  openDb,
  nowId,
  parseTags,
  readMemorySettings,
  readJsonMaybe,
  repairInvalidMergeCandidates,
  safeJson,
  stringifyTags,
  stripBranchTags,
} from "../lib/core.mjs";

const SECRET_PATTERNS = [
  [/sk-proj-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_PROJECT_KEY]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
  [/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]{12,}/gi, "$1=[REDACTED]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]"],
];
const WORKER_LOG_PATH = join(LOG_DIR, "worker.log");
const MEMORY_ACTIONS = new Set(["create_new", "update_existing", "skip_duplicate", "merge_pending"]);
const TARGET_KINDS = new Set(["review_candidate", "stored_memory"]);
const AI_REVIEW_TASK = "review_pending_candidates";
let runtimeSettings = readMemorySettings();

export const DEFAULT_AI_REVIEW_PROMPT = `
你是 miu-kb 的异步候选记忆复核器。请只根据候选记忆本身、目标信息和复用价值，决定每条候选是否可以自动采纳。

决策口径：
- approve：内容稳定、可复用、非敏感、不是重复/临时状态，并且不需要进一步代码验证；可以直接写入长期记忆。
- reject：重复、无长期价值、太零碎、只是进度状态、明显不可靠或表达未总结好。
- keep：有长期价值但不确定，需要人工确认/代码验证、目标不清晰、merge/update 目标无法确认。

重要规则：
- 不要一刀切；逐条判断。
- AI 有拒绝权。reject 是正常审核结果，不是异常；无价值、跑偏、口水化、一次性进度、用户临时吐槽、缺证据且无法复用的候选应直接 reject。
- 敏感信息、密钥、token、账号、隐私数据必须 reject，不要 approve。
- scope/project_path/branch 是审核依据；如果候选明显应为项目/分支记忆却被标成 global，必须 keep，交给人工修正范围后再写入。
- 对 merge_pending / update_existing，如果目标不明确或目标仍是待审候选，优先 keep。
- 只有能通过“未来至少两次 Codex 会话可能有用”的候选才 approve。
- reason 用中文，简短说明原因。
`.trim();

const AI_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidate_id", "action", "reason", "confidence"],
        properties: {
          candidate_id: { type: "string" },
          action: { type: "string", enum: ["approve", "reject", "keep"] },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
};

function settings() {
  return runtimeSettings;
}

function logWorker(message, extra = {}) {
  try {
    appendFileSync(WORKER_LOG_PATH, `${new Date().toISOString()} ${message} ${JSON.stringify(extra)}\n`);
  } catch {
    // Memory extraction should not fail because logging failed.
  }
}

function redactSecrets(input) {
  let text = String(input ?? "");
  let sensitivity = "normal";
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      sensitivity = "sensitive";
      pattern.lastIndex = 0;
      text = text.replace(pattern, replacement);
    }
  }
  return { text, sensitivity };
}

function cleanText(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, "[code omitted]")
    .replace(/\[[^\]]+\]\([^)]+\)/g, (m) => m.replace(/\(([^)]+)\)/, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text, max = 900) {
  const value = cleanText(text);
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trim()}…`;
}

function diagnosticTail(text, max = 4000) {
  const { text: redacted } = redactSecrets(String(text ?? "").replace(/\r/g, "").trim());
  if (redacted.length <= max) return redacted;
  return `…${redacted.slice(-max)}`;
}

function extractTextParts(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractTextParts(item, out);
    return out;
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") out.push(value.text);
    if (typeof value.message === "string") out.push(value.message);
    if (typeof value.content === "string") out.push(value.content);
    if (value.content && typeof value.content !== "string") extractTextParts(value.content, out);
  }
  return out;
}

function readTextTail(path, maxBytes = 4 * 1024 * 1024) {
  const stat = statSync(path);
  const size = Number(stat.size || 0);
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstLineEnd = text.indexOf("\n");
      text = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : "";
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function readRecentTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const lines = readTextTail(transcriptPath).split("\n").filter(Boolean).slice(-240);
  const messages = [];
  for (const line of lines) {
    const item = readJsonMaybe(line);
    const payload = item.payload ?? item;
    if (payload?.type === "agent_message" && payload.message) {
      messages.push({ role: "assistant", text: payload.message, ts: item.timestamp });
      continue;
    }
    if (payload?.type === "message") {
      const text = extractTextParts(payload.content).join("\n").trim();
      if (text) messages.push({ role: payload.role ?? "unknown", text, ts: item.timestamp });
      continue;
    }
    if (item.type === "user_message" || payload?.role === "user") {
      const text = extractTextParts(payload).join("\n").trim();
      if (text) messages.push({ role: "user", text, ts: item.timestamp });
    }
  }
  return messages;
}

function classifyType(text) {
  if (/默认|总是|必须|禁止|不要|prefer|always|never/i.test(text)) return "rule";
  if (/决定|选择|采用|方案|取舍|tradeoff|decision|chose/i.test(text)) return "decision";
  if (/路径|位置|配置|版本|端口|数据库|事实|root|path|config|version|port/i.test(text)) return "fact";
  return "note";
}

function inferTags(text, cwd) {
  const tags = ["codex-auto"];
  if (/memories|memory|记忆|知识/.test(text)) tags.push("memory");
  if (/hook|Stop|异步|enqueue/.test(text)) tags.push("hook");
  if (/sqlite|数据库|pending/.test(text)) tags.push("sqlite");
  if (/llm_wiki|llmwiki/i.test(text)) tags.push("llm_wiki");
  if (/pptx|导入|导出|tab|制表位/i.test(text)) tags.push("pptx");
  if (cwd) tags.push(`project:${basename(cwd)}`);
  return [...new Set(tags)];
}

function isGitRepo(path) {
  if (!path || !existsSync(path)) return false;
  const result = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function normalizeForSimilarity(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^\p{Script=Han}a-z0-9_./:-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text) {
  const normalized = normalizeForSimilarity(text);
  const tokens = new Set();
  for (const token of normalized.match(/[\p{Script=Han}]|[a-z0-9_./:-]{2,}/gu) || []) {
    tokens.add(token);
  }
  return tokens;
}

function ngramSet(text, size = 2) {
  const compact = normalizeForSimilarity(text).replace(/\s+/g, "");
  const grams = new Set();
  if (compact.length <= size) {
    if (compact) grams.add(compact);
    return grams;
  }
  for (let i = 0; i <= compact.length - size; i += 1) {
    grams.add(compact.slice(i, i + size));
  }
  return grams;
}

function overlapScore(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const item of a) {
    if (b.has(item)) overlap += 1;
  }
  return (2 * overlap) / (a.size + b.size);
}

function textSimilarity(a, b) {
  const left = normalizeForSimilarity(a);
  const right = normalizeForSimilarity(b);
  if (!left || !right) return 0;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length >= 24 && longer.includes(shorter)) return 0.96;
  return Math.max(
    overlapScore(tokenSet(left), tokenSet(right)),
    overlapScore(ngramSet(left, 2), ngramSet(right, 2)),
    overlapScore(ngramSet(left, 3), ngramSet(right, 3))
  );
}

function tagsOverlap(leftTags, rightTags) {
  const left = new Set(meaningfulTags(leftTags));
  const right = new Set(meaningfulTags(rightTags));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const tag of left) {
    if (right.has(tag)) overlap += 1;
  }
  return overlap / Math.min(left.size, right.size);
}

function duplicateScore(candidate, row) {
  const text = textSimilarity(candidate.content, row.content);
  const tagScore = tagsOverlap(candidate.tags, parseTags(row.tags ?? row.tags_json));
  const sameCategory = candidate.category && row.category && candidate.category === row.category;
  const sameType = candidate.type && row.type && candidate.type === row.type;
  let score = text;
  if (sameCategory) score = Math.max(score, text + 0.12);
  if (sameType) score = Math.max(score, text + 0.04);
  if (tagScore >= 0.5) score = Math.max(score, text + 0.08);
  return Math.min(1, score);
}

function isDuplicateMatch(candidate, row) {
  const score = duplicateScore(candidate, row);
  const sameTopic =
    (candidate.category && row.category && candidate.category === row.category) ||
    tagsOverlap(candidate.tags, parseTags(row.tags ?? row.tags_json)) >= 0.5;
  return {
    score,
    matched:
      score >= settings().duplicateThreshold ||
      (sameTopic && score >= settings().topicDuplicateThreshold),
  };
}

function scoreDurability(text) {
  let score = 0.25;
  if (/已经|已|配置|安装|路径|端口|数据库|备份|验证|结论|根因|决定|采用|建议|应该|默认/.test(text)) score += 0.3;
  if (/不要|必须|总是|默认|规则/.test(text)) score += 0.15;
  if (/\/Users\/|~\/|\.db|\.toml|\.json|\.mjs|127\.0\.0\.1|:[0-9]{2,5}/.test(text)) score += 0.15;
  if (text.length > 120) score += 0.1;
  return Math.min(0.9, score);
}

function isNoisyStatusUpdate(text) {
  return /检查过了|检查结果|当前状态|刚刚\s*approve|Pending\s*记录|approved_memory_id|写入 memories\.sh 的 ID|状态：`?approved|服务已重启|页面继续用这个|没有经过 Codex\/LLM 二次处理|已经是默认启动了|已改成中文界面|已经做完了。现在有一套可跑的本地确认台/.test(text);
}

function recentConversationText(payload, messages) {
  const selected = messages.slice(-18).map((message) => {
    return `${message.role || "unknown"}: ${truncate(message.text, 1000)}`;
  });
  if (payload.last_assistant_message) {
    selected.push(`assistant_stop_payload: ${truncate(payload.last_assistant_message, 1600)}`);
  }
  return selected.join("\n\n");
}

function reviewCandidateMatchesScope(row, cwd) {
  if (row.scope === "global") return true;
  if (!cwd || !["project", "branch"].includes(row.scope)) return false;
  if (row.project_path && row.project_path !== cwd) return false;
  if (row.scope === "branch") return row.branch_name === getGitBranchName(cwd);
  return true;
}

function storedMemoryMatchesBranch(row, branchName, desiredScope = "project") {
  const memoryBranch = branchNameFromTags(row.tags);
  if (desiredScope === "branch") return !memoryBranch || memoryBranch === branchName;
  return !memoryBranch;
}

function scopeWithBranch(candidate) {
  return candidate.scope === "branch" ? `${candidate.scope}:${candidate.branch_name || ""}` : candidate.scope;
}

function addBranchTag(tags, branchName) {
  const branchTag = branchTagFor(branchName);
  const clean = parseTags(tags).filter((tag) => !tag.startsWith("branch:"));
  return branchTag ? [branchTag, ...clean] : clean;
}

function storedMemoryScopeSql(cwd) {
  const args = [];
  let scopeSql = "scope = 'global'";
  const projectId = projectIdForCwd(cwd);
  if (projectId) {
    scopeSql = "(scope = 'global' OR (scope = 'project' AND project_id = ?))";
    args.push(projectId);
  }
  return { scopeSql, args };
}

function findRelatedExistingItems(payload, messages) {
  const query = recentConversationText(payload, messages);
  if (!query.trim()) return [];
  const related = [];

  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT id, content, tags_json, scope, project_path, branch_name, type, category, status, approved_memory_id
      FROM candidates
      WHERE status IN ('pending', 'approved')
      ORDER BY created_at DESC
      LIMIT 500
    `).all();
    for (const row of rows) {
      if (!reviewCandidateMatchesScope(row, payload.cwd)) continue;
      const score = textSimilarity(query, row.content);
      if (score < settings().relatedContextMinScore) continue;
      related.push({
        kind: "review_candidate",
        id: row.id,
        status: row.status,
        scope: row.scope,
        branch_name: row.branch_name,
        type: row.type,
        category: row.category,
        tags: parseTags(row.tags_json),
        content: row.content,
        approved_memory_id: row.approved_memory_id,
        score,
      });
    }
  } finally {
    db.close();
  }

  if (existsSync(MEMORIES_DB_PATH)) {
    const memoryDb = new DatabaseSync(MEMORIES_DB_PATH);
    try {
      const { scopeSql, args } = storedMemoryScopeSql(payload.cwd);
      const rows = memoryDb.prepare(`
        SELECT id, content, tags, scope, project_id, type, category
        FROM memories
        WHERE deleted_at IS NULL AND ${scopeSql}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 500
      `).all(...args);
      for (const row of rows) {
        if (!storedMemoryMatchesBranch(row, getGitBranchName(payload.cwd), "branch")) continue;
        const score = textSimilarity(query, row.content);
        if (score < settings().relatedContextMinScore) continue;
        related.push({
          kind: "stored_memory",
          id: row.id,
          status: "active",
          scope: branchNameFromTags(row.tags) ? "branch" : row.scope,
          branch_name: branchNameFromTags(row.tags),
          project_id: row.project_id,
          type: row.type,
          category: row.category,
          tags: parseTags(row.tags),
          content: row.content,
          score,
        });
      }
    } finally {
      memoryDb.close();
    }
  }

  return related
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, settings().relatedContextLimit));
}

function formatRelatedExistingItems(items) {
  if (!items.length) return "None.";
  const chunks = [];
  let usedChars = 0;
  for (const [index, item] of items.entries()) {
    const suggestedAction =
      item.kind === "stored_memory" || item.approved_memory_id
        ? "update_existing or skip_duplicate"
        : item.status === "pending"
          ? "merge_pending or skip_duplicate"
          : "skip_duplicate";
    const meta = [
      `kind=${item.kind}`,
      `id=${item.id}`,
      `status=${item.status}`,
      `scope=${item.scope}`,
      item.branch_name ? `branch=${item.branch_name}` : "",
      `type=${item.type}`,
      item.category ? `category=${item.category}` : "",
      item.tags?.length ? `tags=${item.tags.join(",")}` : "",
      item.approved_memory_id ? `approved_memory_id=${item.approved_memory_id}` : "",
      `score=${item.score.toFixed(2)}`,
      `suggested=${suggestedAction}`,
    ].filter(Boolean).join("; ");
    const chunk = `[${index + 1}] ${meta}\ncontent: ${truncate(item.content, settings().relatedContextItemChars)}`;
    const nextUsed = usedChars + chunk.length + (chunks.length ? 2 : 0);
    if (nextUsed > settings().relatedContextTotalChars) {
      const remaining = settings().relatedContextTotalChars - usedChars;
      if (remaining > 180) chunks.push(truncate(chunk, remaining));
      break;
    }
    chunks.push(chunk);
    usedChars = nextUsed;
  }
  return chunks.join("\n\n");
}

export const DEFAULT_EXTRACTOR_PROMPT = `
You are the asynchronous memory extractor for Codex.

Extract only durable, reusable knowledge from the latest Codex turn. Return JSON that matches the provided schema.

What to save:
- User preferences that should affect future Codex sessions.
- Stable project facts, paths, ports, config locations, commands, and setup decisions.
- Engineering decisions with rationale.
- Reusable procedures, pitfalls, debugging lessons, and constraints.

What NOT to save:
- Progress/status reports like "checked", "done", "now it works", or summaries of a previous approval.
- Temporary test records, throwaway examples, transient pending candidates.
- Secrets, tokens, credentials, private keys, or raw sensitive content.
- Long prose, code blocks, or duplicated information.
- Narrow implementation details that are only useful inside the current turn.
- Separate candidates for adjacent facts from the same topic.
- Facts already contradicted by the same conversation.

Rules:
- Prefer 0 or 1 candidate. Output 2 to 3 only when the turn contains truly unrelated durable themes.
- Treat one candidate as a theme-level memory, not a sentence-level clipping. Merge related facts, paths, commands, caveats, and rationale into one concise content field.
- A candidate must pass the replay test: it is likely to help in at least two future Codex sessions.
- If several possible candidates share the same category, subsystem, file area, or decision, keep one synthesized candidate instead of splitting them.
- Use Chinese content when the source is Chinese.
- Keep each content field concise and directly reusable. One or two dense sentences is preferred.
- Put small supporting details in evidence rather than making them separate memories.
- If nothing is worth remembering, return {"candidates":[]}.
- Do not call tools. Do not browse. Do not run commands.
- Sensitivity must be "sensitive" if the candidate mentions credentials, tokens, secrets, or private data.
- Scope must be "global", "project", or "branch". Use "branch" only for facts/decisions that should not leak to other branches.

Memory evolution actions:
- action "create_new": use when the turn contains a durable memory not covered by related existing items.
- action "update_existing": use when the turn corrects, refines, or materially extends an approved/stored memory. Set target_kind and target_id.
- action "merge_pending": use when the turn should be merged into an existing pending review candidate. Set target_kind="review_candidate" and target_id.
- action "skip_duplicate": use when a related item already covers the durable knowledge and no update is needed. Set target_kind and target_id when possible.
- For update_existing and merge_pending, content must be the proposed final replacement/merged memory, not only the delta.
- If there is no durable new information and nothing needs updating, prefer returning {"candidates":[]} over emitting skip_duplicate.
`.trim();

export function getExtractorPromptText() {
  ensureDirs();
  if (!existsSync(EXTRACTOR_PROMPT_PATH)) return DEFAULT_EXTRACTOR_PROMPT;
  const prompt = readFileSync(EXTRACTOR_PROMPT_PATH, "utf8").trim();
  return prompt || DEFAULT_EXTRACTOR_PROMPT;
}

export function getAiReviewPromptText() {
  ensureDirs();
  if (!existsSync(AI_REVIEW_PROMPT_PATH)) return DEFAULT_AI_REVIEW_PROMPT;
  const prompt = readFileSync(AI_REVIEW_PROMPT_PATH, "utf8").trim();
  return prompt || DEFAULT_AI_REVIEW_PROMPT;
}

function buildExtractorPrompt(payload, messages) {
  const gitRepo = isGitRepo(payload.cwd);
  const branchName = getGitBranchName(payload.cwd);
  const projectId = projectIdForCwd(payload.cwd);
  const scopeGuidance = projectId
    ? `The current cwd is a project context (${projectId}), so project-scoped memories are allowed.${gitRepo && branchName ? ` Use branch scope only for knowledge specific to branch "${branchName}".` : ""}`
    : "The current cwd is not a stable project context. Use global scope only for knowledge that should apply across projects.";
  const extractorPrompt = getExtractorPromptText();
  const relatedExisting = findRelatedExistingItems(payload, messages);
  return `
${extractorPrompt}

Runtime rules:
- ${scopeGuidance}
- Review the "Related existing items" before proposing candidates.
- Use action "create_new" only when the new durable knowledge is not already covered.
- Use action "update_existing" when the turn corrects, refines, or materially extends an approved/stored memory; set target_kind and target_id.
- Use action "merge_pending" when the turn should be merged into an existing pending review candidate; set target_kind="review_candidate" and target_id.
- Use action "skip_duplicate" when a related item already covers the knowledge and no update is needed; set target_kind and target_id when possible.
- For update_existing and merge_pending, content must be the proposed final replacement/merged memory.

Context:
- cwd: ${payload.cwd || ""}
- git_branch: ${branchName || ""}
- session_id: ${payload.session_id || ""}
- turn_id: ${payload.turn_id || ""}

Related existing items:
${formatRelatedExistingItems(relatedExisting)}

Recent conversation:
${recentConversationText(payload, messages)}
`.trim();
}

function parseJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("empty extractor output");
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("extractor output does not contain JSON");
    return JSON.parse(match[0]);
  }
}

function normalizeCandidate(raw, payload) {
  if (!raw || typeof raw !== "object") return null;
  const content = truncate(raw.content, 1000);
  if (!content || content.length < 8) return null;
  if (isNoisyStatusUpdate(content)) return null;
  const { text, sensitivity: redactedSensitivity } = redactSecrets(content);
  const memoryAction = MEMORY_ACTIONS.has(raw.action) ? raw.action : "create_new";
  const targetKind = TARGET_KINDS.has(raw.target_kind) ? raw.target_kind : null;
  const targetId = typeof raw.target_id === "string" && raw.target_id.trim() ? raw.target_id.trim() : null;
  const targetStatus = typeof raw.target_status === "string" && raw.target_status.trim() ? raw.target_status.trim() : null;
  const targetContent = typeof raw.target_content === "string" && raw.target_content.trim()
    ? truncate(raw.target_content, 1000)
    : null;
  const gitRepo = isGitRepo(payload.cwd);
  const branchName = getGitBranchName(payload.cwd);
  const requestedScope = ["global", "project", "branch"].includes(raw.scope) ? raw.scope : "global";
  const scope = actualScopeForPath(requestedScope, payload.cwd, branchName);
  const type = ["rule", "decision", "fact", "note"].includes(raw.type) ? raw.type : classifyType(text);
  const tags = Array.isArray(raw.tags) && raw.tags.length ? raw.tags : inferTags(text, payload.cwd);
  const finalTags = scope === "branch" ? addBranchTag(tags, branchName) : parseTags(tags).filter((tag) => !tag.startsWith("branch:"));
  return {
    type,
    scope,
    project_path: ["project", "branch"].includes(scope) ? payload.cwd ?? null : null,
    branch_name: scope === "branch" ? branchName : null,
    content: text,
    tags: [...new Set(finalTags.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 8))],
    category: typeof raw.category === "string" && raw.category.trim() ? raw.category.trim() : null,
    rationale: truncate(raw.rationale || "Codex 异步提炼候选记忆。", 400),
    evidence: truncate(raw.evidence || text, 1200),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0.5))),
    sensitivity: raw.sensitivity === "sensitive" || redactedSensitivity === "sensitive" ? "sensitive" : "normal",
    memory_action: memoryAction,
    target_kind: targetKind,
    target_id: targetId,
    target_status: targetStatus,
    target_content: targetContent,
  };
}

function typePriority(type) {
  return { rule: 4, decision: 3, fact: 2, note: 1 }[type] ?? 0;
}

function meaningfulTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map(String)
    .filter((tag) => tag && tag !== "codex-auto" && !tag.startsWith("project:"))
    .slice(0, 4);
}

function candidateGroupKey(candidate) {
  const tags = meaningfulTags(candidate.tags);
  const topic = candidate.category || tags.slice(0, 2).join("|") || candidate.type;
  return [scopeWithBranch(candidate), candidate.project_path || "", topic].join("::");
}

function choosePrimary(candidates) {
  return [...candidates].sort((a, b) => {
    const priorityDelta = typePriority(b.type) - typePriority(a.type);
    if (priorityDelta) return priorityDelta;
    return Number(b.confidence ?? 0) - Number(a.confidence ?? 0);
  })[0];
}

function mergeCandidateGroup(group) {
  if (group.length <= 1) return group[0];
  const primary = choosePrimary(group);
  const tags = [...new Set(group.flatMap((candidate) => candidate.tags || []))].slice(0, 8);
  const contents = group
    .map((candidate) => candidate.content.replace(/[。；;.\s]+$/g, ""))
    .filter(Boolean);
  const prefix = primary.category ? `关于 ${primary.category}：` : "同一主题记忆：";
  const content = truncate(`${prefix}${contents.join("；")}。`, 1000);
  const evidence = truncate(
    group
      .map((candidate, index) => `[${index + 1}] ${candidate.evidence || candidate.content}`)
      .join("\n"),
    1200
  );
  const avgConfidence =
    group.reduce((sum, candidate) => sum + Number(candidate.confidence ?? 0.5), 0) / group.length;
  return {
    ...primary,
    content,
    tags,
    rationale: truncate(
      "同一轮对话中多条候选围绕同一主题，已合并为主题级记忆，避免细碎记忆污染后续上下文。",
      400
    ),
    evidence,
    confidence: Math.min(0.95, Math.max(Number(primary.confidence ?? 0.5), avgConfidence)),
    sensitivity: group.some((candidate) => candidate.sensitivity === "sensitive") ? "sensitive" : primary.sensitivity,
  };
}

function coarsenCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = candidateGroupKey(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return [...groups.values()]
    .map(mergeCandidateGroup)
    .sort((a, b) => {
      const priorityDelta = typePriority(b.type) - typePriority(a.type);
      if (priorityDelta) return priorityDelta;
      return Number(b.confidence ?? 0) - Number(a.confidence ?? 0);
    })
    .slice(0, Math.max(1, settings().maxCandidatesPerTurn));
}

function findSimilarStoredMemory(candidate) {
  if (!existsSync(MEMORIES_DB_PATH)) return null;
  const db = new DatabaseSync(MEMORIES_DB_PATH);
  try {
    const args = [];
    let scopeSql = "scope = 'global'";
    if (["project", "branch"].includes(candidate.scope)) {
      const projectId = projectIdForCwd(candidate.project_path);
      if (projectId) {
        scopeSql = "(scope = 'global' OR (scope = 'project' AND project_id = ?))";
        args.push(projectId);
      }
    }
    const rows = db.prepare(`
      SELECT id, content, tags, scope, project_id, type, category
      FROM memories
      WHERE deleted_at IS NULL AND ${scopeSql}
      ORDER BY created_at DESC
      LIMIT 500
    `).all(...args);
    let best = null;
    for (const row of rows) {
      if (!storedMemoryMatchesBranch(row, candidate.branch_name, candidate.scope)) continue;
      const match = isDuplicateMatch(candidate, row);
      if (!best || match.score > best.score) {
        best = { ...row, score: match.score, matched: match.matched };
      }
    }
    return best?.matched ? best : null;
  } finally {
    db.close();
  }
}

function findSimilarReviewCandidate(db, candidate) {
  const rows = db.prepare(`
    SELECT id, content, tags_json, scope, project_path, branch_name, type, category, status, approved_memory_id
    FROM candidates
    WHERE status IN ('pending', 'approved')
    ORDER BY created_at DESC
    LIMIT 500
  `).all();
  let best = null;
  for (const row of rows) {
    if (candidate.scope !== row.scope) continue;
    if (["project", "branch"].includes(candidate.scope) && candidate.project_path !== row.project_path) continue;
    if (candidate.scope === "branch" && candidate.branch_name !== row.branch_name) continue;
    const match = isDuplicateMatch(candidate, row);
    if (!best || match.score > best.score) {
      best = { ...row, score: match.score, matched: match.matched };
    }
  }
  return best?.matched ? best : null;
}

function extractCandidatesWithLlm(payload, messages) {
  if (!existsSync(CODEX_BIN) || !existsSync(EXTRACTOR_SCHEMA_PATH)) {
    return { ok: false, error: "codex binary or extractor schema missing", candidates: [] };
  }
  const prompt = buildExtractorPrompt(payload, messages);
  const tempDir = mkdtempSync(join(tmpdir(), "codex-memory-extractor-"));
  const outputPath = join(tempDir, "output.json");
  const extractorSettings = settings();
  const model = extractorSettings.model;
  const cwd = payload.cwd && existsSync(payload.cwd) ? payload.cwd : process.env.HOME;
  try {
    const result = spawnSync(CODEX_BIN, [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--disable",
      "hooks",
      "--sandbox",
      "read-only",
      "--model",
      model,
      "-c",
      `model_reasoning_effort="${extractorSettings.reasoningEffort}"`,
      "--output-schema",
      EXTRACTOR_SCHEMA_PATH,
      "--output-last-message",
      outputPath,
      "-",
    ], {
      cwd,
      input: prompt,
      encoding: "utf8",
      timeout: extractorSettings.llmTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        MIU_KB_SKIP: "1",
        CODEX_MEMORY_REVIEW_SKIP: "1",
        PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`codex extractor exited ${result.status}: ${diagnosticTail(result.stderr || result.stdout)}`);
    }
    const parsed = parseJsonObject(readFileSync(outputPath, "utf8"));
    const candidates = Array.isArray(parsed.candidates)
      ? parsed.candidates.map((candidate) => normalizeCandidate(candidate, payload)).filter(Boolean)
      : [];
    return { ok: true, candidates: coarsenCandidates(candidates) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.stack || error.message : String(error),
      candidates: [],
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildCandidate(payload, messages) {
  const lastAssistant =
    payload.last_assistant_message ||
    [...messages].reverse().find((m) => m.role === "assistant")?.text ||
    "";
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.text || "";
  const source = cleanText(lastAssistant);
  if (!source || source.length < 40) return null;
  if (isNoisyStatusUpdate(source)) return null;

  const confidence = scoreDurability(source);
  if (confidence < 0.45) return null;

  const { text, sensitivity } = redactSecrets(source);
  const content = truncate(text, 900);
  const scope = isGitRepo(payload.cwd) ? "project" : "global";
  return {
    type: classifyType(content),
    scope,
    project_path: scope === "project" ? payload.cwd ?? null : null,
    branch_name: null,
    content,
    tags: inferTags(content, payload.cwd),
    category: null,
    rationale: truncate("Stop hook 自动提炼：上一轮回复包含可复用的配置、决策、事实或注意事项。", 240),
    evidence: truncate(lastUser ? `User: ${lastUser}\n\nAssistant: ${content}` : content, 1200),
    confidence,
    sensitivity,
    memory_action: "create_new",
    target_kind: null,
    target_id: null,
    target_status: null,
    target_content: null,
  };
}

function insertCandidate(db, turn, candidate) {
  if (candidate.memory_action === "skip_duplicate") {
    logWorker("skip_duplicate_by_extractor", {
      turn_id: turn.id,
      target_kind: candidate.target_kind,
      target_id: candidate.target_id,
      candidate: candidate.content.slice(0, 160),
      target: String(candidate.target_content || "").slice(0, 160),
    });
    return null;
  }

  const existing = db.prepare(
    "SELECT id FROM candidates WHERE turn_id = ? AND content = ? LIMIT 1"
  ).get(turn.id, candidate.content);
  if (existing) return existing.id;

  const hasEvolutionTarget =
    ["update_existing", "merge_pending"].includes(candidate.memory_action) &&
    candidate.target_kind &&
    candidate.target_id;

  if (!hasEvolutionTarget) {
    const existingReview = findSimilarReviewCandidate(db, candidate);
    if (existingReview) {
      logWorker("skip_similar_review_candidate", {
        turn_id: turn.id,
        existing_candidate_id: existingReview.id,
        existing_status: existingReview.status,
        score: existingReview.score,
        candidate: candidate.content.slice(0, 160),
        existing: existingReview.content.slice(0, 160),
      });
      return null;
    }

    const existingMemory = findSimilarStoredMemory(candidate);
    if (existingMemory) {
      logWorker("skip_similar_stored_memory", {
        turn_id: turn.id,
        memory_id: existingMemory.id,
        score: existingMemory.score,
        candidate: candidate.content.slice(0, 160),
        existing: existingMemory.content.slice(0, 160),
      });
      return null;
    }
  }

  const id = nowId("cand");
  db.prepare(`
    INSERT INTO candidates (
      id, turn_id, type, scope, project_path, branch_name, content, tags_json, category,
      rationale, evidence, confidence, sensitivity, memory_action, target_kind,
      target_id, target_status, target_content, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    id,
    turn.id,
    candidate.type,
    candidate.scope,
    candidate.project_path,
    candidate.branch_name,
    candidate.content,
    stringifyTags(candidate.tags),
    candidate.category,
    candidate.rationale,
    candidate.evidence,
    candidate.confidence,
    candidate.sensitivity,
    candidate.memory_action || "create_new",
    candidate.target_kind,
    candidate.target_id,
    candidate.target_status,
    candidate.target_content
  );
  return id;
}

function insertCandidates(db, turn, candidates) {
  const ids = [];
  for (const candidate of candidates) {
    const id = insertCandidate(db, turn, candidate);
    if (id) ids.push(id);
  }
  return ids;
}

function pendingCandidateRowsByIds(db, ids) {
  const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).map(String).map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  if (!cleanIds.length) return [];
  const placeholders = cleanIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT c.*, t.cwd
    FROM candidates c
    LEFT JOIN turns t ON t.id = c.turn_id
    WHERE c.status IN ('pending', 'ai_reviewing')
      AND c.id IN (${placeholders})
  `).all(...cleanIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return cleanIds.map((id) => byId.get(id)).filter(Boolean);
}

function formatCandidateForAiReview(row) {
  return [
    `candidate_id: ${row.id}`,
    `action_hint: ${row.memory_action || "create_new"}`,
    `target_kind: ${row.target_kind || ""}`,
    `target_id: ${row.target_id || ""}`,
    `target_status: ${row.target_status || ""}`,
    `type: ${row.type || "note"}`,
    `scope: ${row.scope || "project"}`,
    row.branch_name ? `branch: ${row.branch_name}` : "",
    row.project_path ? `project_path: ${row.project_path}` : "",
    `category: ${row.category || ""}`,
    `tags: ${stripBranchTags(row.tags_json).join(", ")}`,
    `confidence: ${Number(row.confidence || 0).toFixed(2)}`,
    `sensitivity: ${row.sensitivity || "normal"}`,
    `content: ${truncate(row.content, 1000)}`,
    row.target_content ? `target_content: ${truncate(row.target_content, 700)}` : "",
    row.evidence ? `evidence: ${truncate(row.evidence, 700)}` : "",
  ].filter(Boolean).join("\n");
}

function buildPendingReviewPrompt(rows, payload) {
  return `
${getAiReviewPromptText()}

输出必须匹配 JSON schema，decisions 中每条只允许：
- approve：内容稳定、可复用、非敏感、不是重复/临时状态，并且不需要进一步代码验证；可以直接写入长期记忆。
- reject：重复、无长期价值、太零碎、只是进度状态、明显不可靠或表达未总结好。
- keep：有长期价值但不确定，需要人工确认/代码验证、目标不清晰、merge/update 目标无法确认。

AI 有拒绝权；不要把明显无价值或跑偏的候选默认 keep 给人工处理。

本轮任务：
- queue_turn_id: ${payload.turn_id || payload.id || ""}
- source: ${payload.source || "review_page"}
- candidate_count: ${rows.length}

候选列表：
${rows.map((row, index) => `---\n[${index + 1}]\n${formatCandidateForAiReview(row)}`).join("\n")}
`.trim();
}

function reviewPendingCandidatesWithLlm(rows, payload) {
  if (!rows.length) return { ok: true, decisions: [] };
  if (!existsSync(CODEX_BIN)) {
    return { ok: false, error: "codex binary missing", decisions: [] };
  }
  const tempDir = mkdtempSync(join(tmpdir(), "miu-kb-ai-review-"));
  const outputPath = join(tempDir, "output.json");
  const schemaPath = join(tempDir, "review.schema.json");
  const extractorSettings = settings();
  const cwd = payload.cwd && existsSync(payload.cwd) ? payload.cwd : rows.find((row) => row.project_path && existsSync(row.project_path))?.project_path || process.env.HOME;
  try {
    writeFileSync(schemaPath, JSON.stringify(AI_REVIEW_SCHEMA));
    const result = spawnSync(CODEX_BIN, [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--disable",
      "hooks",
      "--sandbox",
      "read-only",
      "--model",
      extractorSettings.model,
      "-c",
      `model_reasoning_effort="${extractorSettings.reasoningEffort}"`,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ], {
      cwd,
      input: buildPendingReviewPrompt(rows, payload),
      encoding: "utf8",
      timeout: extractorSettings.llmTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        MIU_KB_SKIP: "1",
        CODEX_MEMORY_REVIEW_SKIP: "1",
        PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`codex ai review exited ${result.status}: ${diagnosticTail(result.stderr || result.stdout)}`);
    }
    const parsed = parseJsonObject(readFileSync(outputPath, "utf8"));
    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    return {
      ok: true,
      decisions: decisions.map((decision) => ({
        candidate_id: String(decision.candidate_id || "").trim(),
        action: ["approve", "reject", "keep"].includes(decision.action) ? decision.action : "keep",
        reason: truncate(decision.reason || "AI 未给出明确原因。", 300),
        confidence: Math.max(0, Math.min(1, Number(decision.confidence ?? 0.5))),
      })).filter((decision) => decision.candidate_id),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.stack || error.message : String(error),
      decisions: [],
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function projectIdForCandidate(row) {
  if (!["project", "branch"].includes(row.scope)) return null;
  return projectIdForCwd(row.project_path);
}

function actualScopeForCandidate(row) {
  const branchName = row.branch_name || getGitBranchName(row.project_path);
  return actualScopeForPath(row.scope, row.project_path, branchName);
}

function tagsForCandidate(row, actualScope) {
  const branchName = row.branch_name || getGitBranchName(row.project_path);
  const tags = parseTags(row.tags_json).filter((tag) => !tag.startsWith("branch:"));
  return actualScope === "branch" ? addBranchTag(tags, branchName) : tags;
}

function resolveTargetMemoryId(db, row) {
  if (row.target_kind === "stored_memory" && row.target_id) return row.target_id;
  if (row.target_kind === "review_candidate" && row.target_id) {
    const target = db.prepare("SELECT approved_memory_id FROM candidates WHERE id = ?").get(row.target_id);
    if (target?.approved_memory_id) return target.approved_memory_id;
  }
  return null;
}

function recordReviewEvent(db, candidateId, action, before, after) {
  db.prepare(`
    INSERT INTO review_events (id, candidate_id, action, before_json, after_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(nowId("evt"), candidateId, action, safeJson(before), safeJson(after));
}

function recordMemoryLifecycle(db, memoryId, candidateId, action, reason, before, after) {
  db.prepare(`
    INSERT INTO lifecycle_events (id, memory_id, candidate_id, action, reason, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nowId("life"), memoryId, candidateId, action, reason, safeJson(before), safeJson(after));
}

function keepCandidateForManualReview(db, row, decision) {
  const fresh = db.prepare("SELECT * FROM candidates WHERE id = ?").get(row.id);
  if (!fresh || !["pending", "ai_reviewing"].includes(fresh.status)) {
    return { candidate_id: row.id, action: "skip", reason: "候选已不在待审核状态" };
  }
  db.prepare(`
    UPDATE candidates
    SET status = 'pending',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'ai_reviewing'
  `).run(row.id);
  const after = db.prepare("SELECT * FROM candidates WHERE id = ?").get(row.id);
  recordReviewEvent(db, row.id, "ai_keep", fresh, {
    ...after,
    ai_decision: "keep",
    ai_reason: decision.reason,
    ai_confidence: decision.confidence,
  });
  return { candidate_id: row.id, action: "keep", reason: decision.reason };
}

function rejectCandidateByAi(db, row, decision) {
  const before = db.prepare("SELECT * FROM candidates WHERE id = ?").get(row.id);
  if (!before || !["pending", "ai_reviewing"].includes(before.status)) {
    return { candidate_id: row.id, action: "skip", reason: "候选已不在待审核状态" };
  }
  db.prepare(`
    UPDATE candidates
    SET status = 'rejected',
        rejected_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending', 'ai_reviewing')
  `).run(row.id);
  const after = db.prepare("SELECT * FROM candidates WHERE id = ?").get(row.id);
  recordReviewEvent(db, row.id, "ai_reject", before, {
    ...after,
    ai_reason: decision.reason,
    ai_confidence: decision.confidence,
  });
  demoteMergeDependents(db, row.id, "目标候选被 AI 拒绝，自动改为新建记忆。");
  return { candidate_id: row.id, action: "reject", reason: decision.reason };
}

function approveCandidateByAi(db, row, decision) {
  const before = db.prepare("SELECT * FROM candidates WHERE id = ?").get(row.id);
  if (!before || !["pending", "ai_reviewing"].includes(before.status)) {
    return { candidate_id: row.id, action: "skip", reason: "候选已不在待审核状态" };
  }
  if (before.sensitivity === "sensitive") {
    return keepCandidateForManualReview(db, before, { ...decision, reason: "候选含敏感信息，需要人工确认后再处理。" });
  }

  const targetMemoryId = ["update_existing", "merge_pending"].includes(before.memory_action)
    ? resolveTargetMemoryId(db, before)
    : null;
  if (["update_existing", "merge_pending"].includes(before.memory_action) && !targetMemoryId) {
    return keepCandidateForManualReview(db, before, { ...decision, reason: "候选目标记忆不明确，保留人工审核。" });
  }

  const actualScope = actualScopeForCandidate(before);
  const branchName = actualScope === "branch" ? before.branch_name || getGitBranchName(before.project_path) : null;
  const tags = tagsForCandidate(before, actualScope);
  const store = openStore(MEMORIES_DB_PATH);
  let memoryBefore = null;
  let memory = null;
  try {
    if (targetMemoryId) {
      memoryBefore = store.get(targetMemoryId);
      if (!memoryBefore) {
        return keepCandidateForManualReview(db, before, { ...decision, reason: "目标长期记忆不存在，保留人工审核。" });
      }
      memory = store.edit(targetMemoryId, {
        content: before.content,
        type: before.type,
        scope: actualScope,
        project_id: projectIdForCandidate(before),
        branch_name: branchName,
        tags,
        category: before.category,
        metadata: { source: "miu-kb-ai-review", candidate_id: before.id, reason: decision.reason },
      });
    } else {
      memory = store.add({
        content: before.content,
        type: before.type,
        scope: actualScope,
        project_id: projectIdForCandidate(before),
        branch_name: branchName,
        tags,
        category: before.category,
        metadata: { source: "miu-kb-ai-review", candidate_id: before.id, reason: decision.reason },
      });
    }
  } finally {
    store.close();
  }

  const memoryId = memory?.id || targetMemoryId;
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
    WHERE id = ? AND status IN ('pending', 'ai_reviewing')
  `).run(
    targetMemoryId ? "update_existing" : before.memory_action || "create_new",
    actualScope,
    actualScope === "global" ? null : before.project_path,
    branchName,
    stringifyTags(tags),
    targetMemoryId ? "stored_memory" : before.target_kind,
    targetMemoryId || before.target_id,
    targetMemoryId ? "approved" : before.target_status,
    targetMemoryId && memoryBefore ? memoryBefore.content : before.target_content,
    memoryId,
    before.id
  );
  const after = db.prepare("SELECT * FROM candidates WHERE id = ?").get(before.id);
  recordReviewEvent(db, before.id, "ai_approve", before, {
    ...after,
    ai_reason: decision.reason,
    ai_confidence: decision.confidence,
    memory,
  });
  recordMemoryLifecycle(db, memoryId, before.id, targetMemoryId ? "memory_updated" : "memory_approved", `AI 复核自动${targetMemoryId ? "更新已有记忆" : "批准写入长期记忆"}：${decision.reason}`, memoryBefore || before, {
    candidate: after,
    memory,
  });
  return { candidate_id: before.id, action: targetMemoryId ? "update" : "approve", memory_id: memoryId, reason: decision.reason };
}

function processPendingReviewTurn(db, turn, payload) {
  repairInvalidMergeCandidates(db);
  const rows = pendingCandidateRowsByIds(db, payload.candidate_ids);
  const llm = reviewPendingCandidatesWithLlm(rows, payload);
  if (!llm.ok) throw new Error(llm.error || "AI review failed");
  const decisions = new Map(llm.decisions.map((decision) => [decision.candidate_id, decision]));
  const results = [];
  for (const row of rows) {
    const decision = decisions.get(row.id) || { action: "keep", reason: "AI 未返回该候选的决策，保留人工审核。", confidence: 0 };
    if (decision.action === "approve") {
      results.push(approveCandidateByAi(db, row, decision));
    } else if (decision.action === "reject") {
      results.push(rejectCandidateByAi(db, row, decision));
    } else {
      results.push(keepCandidateForManualReview(db, row, decision));
    }
  }
  return results;
}

function restoreAiReviewingCandidates(db, payload) {
  const ids = Array.isArray(payload?.candidate_ids) ? payload.candidate_ids : [];
  for (const id of ids) {
    db.prepare(`
      UPDATE candidates
      SET status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'ai_reviewing'
    `).run(String(id));
  }
}

export function processQueuedTurns({ limit = 10 } = {}) {
  runtimeSettings = readMemorySettings();
  const db = openDb();
  const turns = db.prepare(
    "SELECT * FROM turns WHERE status IN ('queued', 'error') ORDER BY created_at ASC LIMIT ?"
  ).all(limit);
  logWorker("worker_run", { limit, turns: turns.length });
  const results = [];
  for (const turn of turns) {
    try {
      db.prepare("UPDATE turns SET status = 'processing', error = NULL WHERE id = ?").run(turn.id);
      const payload = readJsonMaybe(turn.hook_payload_json);
      logWorker("turn_processing", { id: turn.id, task: payload.miu_kb_task || "extract_candidates", cwd: turn.cwd });
      if (payload.miu_kb_task === AI_REVIEW_TASK) {
        const reviewResults = processPendingReviewTurn(db, turn, payload);
        db.prepare(
          "UPDATE turns SET status = 'processed', error = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).run(null, turn.id);
        logWorker("turn_processed", { id: turn.id, task: AI_REVIEW_TASK, results: reviewResults.length });
        results.push({ turn_id: turn.id, ai_review_results: reviewResults });
        continue;
      }
      const messages = readRecentTranscript(turn.transcript_path);
      const llm = extractCandidatesWithLlm(payload, messages);
      let candidateIds = [];
      if (llm.ok) {
        candidateIds = insertCandidates(db, turn, llm.candidates);
      } else {
        const candidate = buildCandidate(payload, messages);
        if (candidate) {
          const candidateId = insertCandidate(db, turn, candidate);
          if (candidateId) candidateIds = [candidateId];
        }
      }
      db.prepare(
        "UPDATE turns SET status = 'processed', error = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(llm.ok ? null : `LLM extractor failed; used heuristic fallback. ${llm.error || ""}`, turn.id);
      logWorker("turn_processed", { id: turn.id, candidates: candidateIds.length, extractor: llm.ok ? "llm" : "heuristic" });
      results.push({ turn_id: turn.id, candidate_ids: candidateIds, extractor: llm.ok ? "llm" : "heuristic" });
    } catch (error) {
      const payload = readJsonMaybe(turn.hook_payload_json);
      if (payload.miu_kb_task === AI_REVIEW_TASK) {
        restoreAiReviewingCandidates(db, payload);
      }
      db.prepare("UPDATE turns SET status = 'error', error = ? WHERE id = ?").run(
        error instanceof Error ? error.stack || error.message : String(error),
        turn.id
      );
      logWorker("turn_error", { id: turn.id, error: error instanceof Error ? error.message : String(error) });
      results.push({ turn_id: turn.id, error: String(error) });
    }
  }
  db.close();
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = processQueuedTurns();
  process.stdout.write(`${JSON.stringify(results)}\n`);
}
