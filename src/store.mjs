import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_DB_PATH = join(homedir(), ".config", "miu-kb", "local.db");

const require = createRequire(import.meta.url);
const TYPES = new Set(["rule", "decision", "fact", "note"]);
const SCOPES = new Set(["global", "project", "branch"]);
const LOCAL_WEAK_TERMS_PATH = join(homedir(), ".config", "miu-kb", "weak-terms.txt");
const DOMAIN_WEAK_TERMS = [
  "这个", "那个", "这里", "那里", "现在", "之前", "之后", "不会", "不是", "没有",
  "可以", "应该", "需要", "感觉", "看下", "为什", "什么", "怎么", "多少",
  "不然", "就是", "有问", "问题", "修改", "变更",
];
const CJK_STOP_TERMS = new Set([...require("stopwords-zh"), ...DOMAIN_WEAK_TERMS, ...readLocalWeakTerms()]);

function readLocalWeakTerms() {
  if (!existsSync(LOCAL_WEAK_TERMS_PATH)) return [];
  return readFileSync(LOCAL_WEAK_TERMS_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function now() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = parseJson(trimmed, []);
    if (Array.isArray(parsed)) return parsed.map(String).map((s) => s.trim()).filter(Boolean);
  }
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

function stringifyTags(value) {
  return JSON.stringify([...new Set(normalizeTags(value))]);
}

function bigrams(text) {
  const chars = String(text || "").match(/[\p{Script=Han}]|[a-zA-Z0-9_:/.-]+/gu) || [];
  const out = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (/^\p{Script=Han}$/u.test(chars[i]) && /^\p{Script=Han}$/u.test(chars[i + 1])) {
      out.push(chars[i] + chars[i + 1]);
    }
  }
  return out.join(" ");
}

function searchText(content, tags) {
  const normalizedTags = normalizeTags(tags);
  return `${content || ""} ${normalizedTags.join(" ")} ${bigrams(content)}`.trim();
}

function ftsQuery(query) {
  const raw = String(query || "").trim();
  const expanded = `${raw} ${bigrams(raw)}`;
  return expanded
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function meaningfulTerms(text) {
  const raw = String(text || "").toLowerCase();
  return [
    ...(raw.match(/[a-z0-9_:/.-]{3,}/g) || []),
    ...bigrams(raw).split(/\s+/),
  ].filter((term) => term && !CJK_STOP_TERMS.has(term));
}

function hasMeaningfulOverlap(row, terms) {
  if (!terms.length) return false;
  const haystack = `${row.content || ""} ${row.tags || ""} ${row.category || ""} ${row.project_id || ""} ${row.search_text || ""}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function rowToMemory(row) {
  if (!row) return null;
  const tags = row.tags != null ? row.tags : row.tags_json;
  const metadata = row.metadata != null ? row.metadata : row.metadata_json;
  const parsedMetadata = typeof metadata === "string" ? parseJson(metadata, {}) : (metadata || {});
  return {
    ...row,
    tags: normalizeTags(tags),
    metadata: parsedMetadata && typeof parsedMetadata === "object" ? parsedMetadata : {},
  };
}

function ensureColumn(db, table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function normalizeScope(input) {
  return SCOPES.has(input?.scope) ? input.scope : "global";
}

function normalizeType(input) {
  return TYPES.has(input?.type) ? input.type : "note";
}

function normalizeLimit(value, fallback, max) {
  return Math.max(1, Math.min(Number(value || fallback), max));
}

function upsertFts(db) {
  db.exec(`
    INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
  `);
}

export function openStore(dbPath = process.env.MIU_KB_DB || process.env.PKB_DB || DEFAULT_DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      scope TEXT NOT NULL DEFAULT 'global',
      project_id TEXT,
      type TEXT NOT NULL DEFAULT 'note',
      paths TEXT,
      category TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      branch_name TEXT,
      search_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `);

  ensureColumn(db, "memories", "tags", "tags TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "memories", "paths", "paths TEXT");
  ensureColumn(db, "memories", "metadata", "metadata TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "memories", "branch_name", "branch_name TEXT");
  ensureColumn(db, "memories", "search_text", "search_text TEXT NOT NULL DEFAULT ''");

  try {
    db.exec("UPDATE memories SET tags = tags_json WHERE (tags IS NULL OR tags = '[]' OR tags = '') AND tags_json IS NOT NULL");
  } catch {
    // Older databases may not have the prototype tags_json column.
  }
  try {
    db.exec("UPDATE memories SET metadata = metadata_json WHERE (metadata IS NULL OR metadata = '{}' OR metadata = '') AND metadata_json IS NOT NULL");
  } catch {
    // Older databases may not have the prototype metadata_json column.
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_scope_project
      ON memories(scope, project_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_memories_type
      ON memories(type, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_memories_updated
      ON memories(updated_at, deleted_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      tags,
      search_text,
      content='memories',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories
    WHEN NEW.deleted_at IS NULL
    BEGIN
      INSERT INTO memories_fts(rowid, content, tags, search_text)
      VALUES (NEW.rowid, NEW.content, COALESCE(NEW.tags, ''), COALESCE(NEW.search_text, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories
    WHEN OLD.deleted_at IS NULL
    BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, search_text)
      VALUES ('delete', OLD.rowid, OLD.content, COALESCE(OLD.tags, ''), COALESCE(OLD.search_text, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories
    BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, search_text)
      SELECT 'delete', OLD.rowid, OLD.content, COALESCE(OLD.tags, ''), COALESCE(OLD.search_text, '')
      WHERE OLD.deleted_at IS NULL;
      INSERT INTO memories_fts(rowid, content, tags, search_text)
      SELECT NEW.rowid, NEW.content, COALESCE(NEW.tags, ''), COALESCE(NEW.search_text, '')
      WHERE NEW.deleted_at IS NULL;
    END;
  `);

  const rowsMissingSearch = db.prepare(`
    SELECT id, content, tags
    FROM memories
    WHERE search_text IS NULL OR search_text = ''
    LIMIT 10000
  `).all();
  const fillSearch = db.prepare("UPDATE memories SET search_text = ? WHERE id = ?");
  const fillMany = db.transaction((rows) => {
    for (const row of rows) fillSearch.run(searchText(row.content, row.tags), row.id);
  });
  fillMany(rowsMissingSearch);
  upsertFts(db);

  return {
    path: dbPath,
    close: () => db.close(),

    add(input) {
      const content = String(input?.content || "").trim();
      if (!content) throw new Error("content is required");
      const type = normalizeType(input);
      const scope = normalizeScope(input);
      const tags = stringifyTags(input?.tags);
      const id = input?.id || `mem_${randomUUID().slice(0, 12)}`;
      const time = input?.created_at || now();
      db.prepare(`
        INSERT INTO memories (
          id, content, tags, scope, project_id, type, paths, category,
          metadata, branch_name, search_text, created_at, updated_at, deleted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        content,
        tags,
        scope === "branch" ? "project" : scope,
        input?.project_id || null,
        type,
        input?.paths ? json(input.paths) : null,
        input?.category || null,
        json(input?.metadata || {}),
        input?.branch_name || null,
        searchText(content, tags),
        time,
        input?.updated_at || time,
        input?.deleted_at || null
      );
      return this.get(id);
    },

    get(id) {
      return rowToMemory(db.prepare("SELECT * FROM memories WHERE id = ?").get(id));
    },

    edit(id, input) {
      const before = this.get(id);
      if (!before || before.deleted_at) return null;
      const content = String(input?.content ?? before.content).trim();
      if (!content) throw new Error("content is required");
      const tags = input?.tags == null ? stringifyTags(before.tags) : stringifyTags(input.tags);
      const type = input?.type ? normalizeType(input) : before.type;
      const scope = input?.scope ? normalizeScope(input) : before.scope;
      const updatedAt = now();
      db.prepare(`
        UPDATE memories
        SET content = ?,
            tags = ?,
            scope = ?,
            project_id = ?,
            type = ?,
            paths = ?,
            category = ?,
            metadata = ?,
            branch_name = ?,
            search_text = ?,
            updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(
        content,
        tags,
        scope === "branch" ? "project" : scope,
        input?.project_id ?? before.project_id ?? null,
        type,
        input?.paths == null ? before.paths ?? null : json(input.paths),
        input?.category ?? before.category ?? null,
        input?.metadata == null ? json(before.metadata || {}) : json(input.metadata),
        input?.branch_name ?? before.branch_name ?? null,
        searchText(content, tags),
        updatedAt,
        id
      );
      return this.get(id);
    },

    search(query, opts = {}) {
      const match = ftsQuery(query);
      if (!match) return [];
      const limit = normalizeLimit(opts.limit, 10, 50);
      const terms = meaningfulTerms(query);
      const rows = db.prepare(`
        SELECT m.*, bm25(memories_fts) AS rank
        FROM memories m
        JOIN memories_fts ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ?
          AND m.deleted_at IS NULL
          AND (? IS NULL OR m.scope = ? OR m.scope = 'global')
          AND (? IS NULL OR m.project_id IS NULL OR m.project_id = ?)
          AND (? IS NULL OR m.branch_name IS NULL OR m.branch_name = ? OR m.tags LIKE ?)
        ORDER BY
          CASE WHEN m.branch_name IS NOT NULL AND m.branch_name = ? THEN 0 WHEN m.scope = 'project' THEN 1 ELSE 2 END,
          rank ASC,
          m.updated_at DESC
        LIMIT ?
      `).all(
        match,
        opts.scope || null,
        opts.scope === "branch" ? "project" : opts.scope || null,
        opts.project_id || null,
        opts.project_id || null,
        opts.branch_name || null,
        opts.branch_name || null,
        opts.branch_name ? `%branch:${encodeURIComponent(opts.branch_name)}%` : null,
        opts.branch_name || null,
        Math.min(limit * 3, 100)
      );
      return rows.filter((row) => hasMeaningfulOverlap(row, terms)).slice(0, limit).map(rowToMemory);
    },

    recall(query, opts = {}) {
      const limit = normalizeLimit(opts.limit, 8, 30);
      const rules = db.prepare(`
        SELECT *
        FROM memories
        WHERE deleted_at IS NULL
          AND type = 'rule'
          AND (? IS NULL OR scope = ? OR scope = 'global')
          AND (? IS NULL OR project_id IS NULL OR project_id = ?)
          AND (? IS NULL OR branch_name IS NULL OR branch_name = ? OR tags LIKE ?)
        ORDER BY
          CASE WHEN branch_name IS NOT NULL AND branch_name = ? THEN 0 WHEN scope = 'project' THEN 1 ELSE 2 END,
          updated_at DESC
        LIMIT 8
      `).all(
        opts.scope || null,
        opts.scope === "branch" ? "project" : opts.scope || null,
        opts.project_id || null,
        opts.project_id || null,
        opts.branch_name || null,
        opts.branch_name || null,
        opts.branch_name ? `%branch:${encodeURIComponent(opts.branch_name)}%` : null,
        opts.branch_name || null
      ).map(rowToMemory);
      return { rules, memories: this.search(query, { ...opts, limit }) };
    },

    forget(id) {
      const result = db.prepare(`
        UPDATE memories
        SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(now(), now(), id);
      return result.changes > 0;
    },

    list(opts = {}) {
      const limit = normalizeLimit(opts.limit, 20, 100);
      const rows = db.prepare(`
        SELECT *
        FROM memories
        WHERE (? OR deleted_at IS NULL)
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
      `).all(opts.all ? 1 : 0, limit);
      return rows.map(rowToMemory);
    },

    stats() {
      const counts = db.prepare(`
        SELECT
          count(*) AS total,
          sum(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
          sum(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
        FROM memories
      `).get();
      return {
        total: Number(counts.total || 0),
        active: Number(counts.active || 0),
        deleted: Number(counts.deleted || 0),
      };
    },
  };
}
