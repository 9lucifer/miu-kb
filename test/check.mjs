import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openStore } from "../src/store.mjs";

const dir = mkdtempSync(join(tmpdir(), "miu-kb-"));
process.env.MIU_KB_DATA_DIR = join(dir, "data");
const store = openStore(join(dir, "local.db"));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const {
  AI_REVIEW_PROMPT_PATH,
  demoteMergeDependents,
  openDb,
  repairInvalidMergeCandidates,
} = await import("../lib/core.mjs");
const { DEFAULT_AI_REVIEW_PROMPT, getAiReviewPromptText } = await import("../bin/worker.mjs");

try {
  assert.equal(getAiReviewPromptText(), DEFAULT_AI_REVIEW_PROMPT);
  mkdirSync(dirname(AI_REVIEW_PROMPT_PATH), { recursive: true });
  writeFileSync(AI_REVIEW_PROMPT_PATH, "只批准稳定、可复用、已验证的候选。");
  assert.equal(getAiReviewPromptText(), "只批准稳定、可复用、已验证的候选。");

  const rule = store.add({ content: "回答默认使用中文", type: "rule", scope: "global" });
  const fact = store.add({
    content: "parser_slide_sdk 的 PPTX tab 对齐语义要区分默认制表间距和显式 tab stop",
    type: "fact",
    scope: "project",
    project_id: "parser_slide_sdk",
    tags: ["pptx", "tab"],
  });
  const noisy = store.add({
    content: "miu-kb MCP transport 断开后不会热重连，之前需要重启 Codex 会话。",
    type: "fact",
    scope: "global",
  });
  const baseline = store.add({
    content: "parser_slide_sdk 的 PPTX 导出基线只应在渲染语义变化时更新。",
    type: "fact",
    scope: "project",
    project_id: "parser_slide_sdk",
    tags: ["pptx", "baseline"],
  });

  assert.equal(store.get(rule.id).type, "rule");
  assert.equal(store.search("PPTX tab", { project_id: "parser_slide_sdk" })[0].id, fact.id);
  assert.equal(store.search("制表间距", { project_id: "parser_slide_sdk" })[0].id, fact.id);
  const baselineQuery = "按道理这个修改不会变更之前的基线?? 不然之前基线就是有问题的??";
  const baselineResults = store.search(baselineQuery, { project_id: "parser_slide_sdk" });
  assert.equal(baselineResults.some((item) => item.id === noisy.id), false);
  assert.equal(baselineResults[0].id, baseline.id);

  const recalled = store.recall("怎么处理 PPTX 制表位", {
    scope: "project",
    project_id: "parser_slide_sdk",
  });
  assert.equal(recalled.rules[0].id, rule.id);
  assert.equal(recalled.memories[0].id, fact.id);

  assert.equal(store.forget(fact.id), true);
  assert.equal(store.search("显式 tab stop").length, 0);
  assert.equal(store.forget(noisy.id), true);
  assert.equal(store.forget(baseline.id), true);
  assert.equal(store.stats().active, 1);

  const nonGitProject = join(dir, "plain-project");
  mkdirSync(nonGitProject);
  const cliDb = join(dir, "cli.db");
  const add = spawnSync(process.execPath, [
    join(root, "bin", "miu-kb.mjs"),
    "add",
    "plain project scoped memory",
    "--scope",
    "project",
    "--json",
  ], {
    cwd: nonGitProject,
    encoding: "utf8",
    env: { ...process.env, MIU_KB_DB: cliDb },
  });
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const added = JSON.parse(add.stdout);
  assert.equal(added.scope, "project");
  assert.equal(added.project_id, realpathSync(nonGitProject));

  const recall = spawnSync(process.execPath, [
    join(root, "bin", "miu-kb.mjs"),
    "recall",
    "plain scoped",
    "--json",
  ], {
    cwd: nonGitProject,
    encoding: "utf8",
    env: { ...process.env, MIU_KB_DB: cliDb },
  });
  assert.equal(recall.status, 0, recall.stderr || recall.stdout);
  assert.equal(JSON.parse(recall.stdout).memories[0].id, added.id);

  const installHome = join(dir, "home");
  const install = spawnSync(process.execPath, [
    join(root, "bin", "install-on-mac.mjs"),
    "--overwrite",
    "--no-launch",
    "--no-hooks",
    "--no-install-deps",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: installHome,
      MIU_KB_NODE_BIN: process.execPath,
    },
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.equal(existsSync(join(installHome, ".codex", "miu-kb", "MiuKbMac", ".build")), false);
  assert.equal(existsSync(join(installHome, ".codex", "miu-kb", "MiuKbMac", "dist")), false);
  assert.equal(existsSync(join(installHome, ".codex", "miu-kb", "node_modules")), false);
  assert.equal(existsSync(join(installHome, ".local", "bin", "miu-kb")), true);

  const reviewDb = openDb();
  try {
    reviewDb.prepare("INSERT INTO turns (id, status) VALUES (?, ?)").run("turn_state", "processed");
    reviewDb.prepare(`
      INSERT INTO candidates (id, turn_id, content, status, memory_action)
      VALUES (?, ?, ?, ?, ?)
    `).run("target_rejected", "turn_state", "old target", "rejected", "create_new");
    reviewDb.prepare(`
      INSERT INTO candidates (id, turn_id, content, status, memory_action, target_kind, target_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("source_merge", "turn_state", "new source", "pending", "merge_pending", "review_candidate", "target_rejected");
    assert.equal(repairInvalidMergeCandidates(reviewDb), 1);
    const repaired = reviewDb.prepare("SELECT memory_action, target_id FROM candidates WHERE id = ?").get("source_merge");
    assert.deepEqual(repaired, { memory_action: "create_new", target_id: null });

    reviewDb.prepare(`
      INSERT INTO candidates (id, turn_id, content, status, memory_action)
      VALUES (?, ?, ?, ?, ?)
    `).run("target_later", "turn_state", "later target", "pending", "create_new");
    reviewDb.prepare(`
      INSERT INTO candidates (id, turn_id, content, status, memory_action, target_kind, target_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("source_later", "turn_state", "later source", "pending", "merge_pending", "review_candidate", "target_later");
    assert.equal(demoteMergeDependents(reviewDb, "target_later"), 1);
    const demoted = reviewDb.prepare("SELECT memory_action, target_kind, target_id FROM candidates WHERE id = ?").get("source_later");
    assert.deepEqual(demoted, { memory_action: "create_new", target_kind: null, target_id: null });
  } finally {
    reviewDb.close();
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log("miu-kb check ok");
