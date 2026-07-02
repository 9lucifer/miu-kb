#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "../lib/sqlite-sync.mjs";
import { DEFAULT_DB_PATH, openStore } from "../src/store.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const sourcePath = arg("source", join(homedir(), ".config", "memories", "local.db"));
const targetPath = arg("target", process.env.MIU_KB_DB || DEFAULT_DB_PATH);
const overwrite = process.argv.includes("--overwrite");

if (!existsSync(sourcePath)) {
  process.stderr.write(`source database not found: ${sourcePath}\n`);
  process.exit(1);
}

const store = openStore(targetPath);
store.close();

const source = new DatabaseSync(sourcePath, { readOnly: true });
const target = new DatabaseSync(targetPath);

try {
  const rows = source.prepare(`
    SELECT id, content, tags, scope, project_id, type, paths, category, metadata,
           created_at, updated_at, deleted_at, search_text
    FROM memories
  `).all();
  const existing = new Set(target.prepare("SELECT id FROM memories").all().map((row) => row.id));
  const insertSql = `
    INSERT ${overwrite ? "OR REPLACE" : "OR IGNORE"} INTO memories (
      id, content, tags, scope, project_id, type, paths, category, metadata,
      search_text, created_at, updated_at, deleted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const insert = target.prepare(insertSql);
  const importRows = target.db.transaction((items) => {
    for (const row of items) {
      insert.run(
        row.id,
        row.content,
        row.tags || "[]",
        row.scope || "global",
        row.project_id || null,
        row.type || "note",
        row.paths || null,
        row.category || null,
        row.metadata || "{}",
        row.search_text || "",
        row.created_at || new Date().toISOString(),
        row.updated_at || row.created_at || new Date().toISOString(),
        row.deleted_at || null
      );
    }
  });
  importRows(rows);

  const imported = overwrite ? rows.length : rows.filter((row) => !existing.has(row.id)).length;
  process.stdout.write(JSON.stringify({
    source: sourcePath,
    target: targetPath,
    scanned: rows.length,
    imported,
    skipped: rows.length - imported,
  }, null, 2));
  process.stdout.write("\n");
} finally {
  source.close();
  target.close();
  const refreshed = openStore(targetPath);
  refreshed.close();
}
