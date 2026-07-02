#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOG_DIR,
  openDb,
  nowId,
  readJsonMaybe,
  safeJson,
  writeRawTurn,
  NODE_BIN,
} from "../lib/core.mjs";

const HOOK_LOG_PATH = join(LOG_DIR, "hook.log");

function logHook(message, extra = {}) {
  try {
    appendFileSync(HOOK_LOG_PATH, `${new Date().toISOString()} ${message} ${JSON.stringify(extra)}\n`);
  } catch {
    // Hook logging should never block Codex.
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function enqueue(payload) {
  const db = openDb();
  const id = nowId("turn");
  const rawPath = writeRawTurn(id, payload);
  db.prepare(`
    INSERT INTO turns (
      id, session_id, turn_id, transcript_path, cwd, hook_payload_json,
      raw_snapshot_path, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
  `).run(
    id,
    payload.session_id ?? null,
    payload.turn_id ?? null,
    payload.transcript_path ?? null,
    payload.cwd ?? null,
    safeJson(payload),
    rawPath
  );
  db.close();
  return id;
}

function spawnWorker() {
  const workerPath = new URL("./worker.mjs", import.meta.url).pathname;
  const child = spawn(NODE_BIN, ["--no-warnings=ExperimentalWarning", workerPath], {
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

const raw = readStdin();
if (!raw.trim()) process.exit(0);

const payload = readJsonMaybe(raw);
if (!payload || typeof payload !== "object") process.exit(0);
if (process.env.MIU_KB_SKIP === "1" || process.env.CODEX_MEMORY_REVIEW_SKIP === "1") process.exit(0);

const id = enqueue(payload);
logHook("stop_enqueued", { id, cwd: payload.cwd ?? null, session_id: payload.session_id ?? null });
spawnWorker();
logHook("worker_spawned", { id });
if (process.env.MIU_KB_HOOK_DEBUG === "1") {
  process.stdout.write(`${id}\n`);
}
