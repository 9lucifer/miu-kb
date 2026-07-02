#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { openStore } from "../src/store.mjs";
import { openDb, readJsonMaybe } from "../lib/core.mjs";

const DEFAULT_GOLDEN = join(process.cwd(), "eval", "recall-golden.jsonl");
const ABLATIONS = [
  { name: "full", opts: {} },
  {
    name: "bm25",
    opts: { disableQueryVariants: true, disableRerank: true, disableBoosts: true, disableDiversity: true },
  },
  { name: "no-query-variants", opts: { disableQueryVariants: true } },
  { name: "no-boosts", opts: { disableBoosts: true } },
  { name: "no-diversity", opts: { disableDiversity: true } },
  { name: "no-rerank", opts: { disableRerank: true } },
];

function usage() {
  console.log(`Usage:
  miu-kb eval-recall [--golden eval/recall-golden.jsonl] [--limit 8] [--json]
  miu-kb eval-recall --init-from-traces [--golden eval/recall-golden.jsonl] [--trace-limit 50]

Golden JSONL:
  {"query":"PPTX tab 怎么处理","expected":["mem_xxx"],"scope":"project","project_id":"parser_slide_sdk"}`);
}

function parseArgs(argv) {
  const flags = { golden: DEFAULT_GOLDEN, limit: 8, traceLimit: 50, json: false, initFromTraces: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--init-from-traces") flags.initFromTraces = true;
    else if (arg === "--golden") flags.golden = argv[++i];
    else if (arg === "--limit") flags.limit = Number(argv[++i]);
    else if (arg === "--trace-limit") flags.traceLimit = Number(argv[++i]);
  }
  flags.limit = Math.max(1, Math.min(Number(flags.limit || 8), 50));
  flags.traceLimit = Math.max(1, Math.min(Number(flags.traceLimit || 50), 500));
  return flags;
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1} JSON parse failed: ${error.message}`);
      }
    });
}

function expectedIds(item) {
  return [
    ...(Array.isArray(item.expected) ? item.expected : []),
    ...(Array.isArray(item.expected_ids) ? item.expected_ids : []),
    item.expected_id,
  ].filter(Boolean).map(String);
}

function runOne(store, item, config, limit) {
  const started = performance.now();
  const result = store.recall(item.query, { ...item, ...config.opts, limit: item.limit || limit });
  const elapsedMs = performance.now() - started;
  const rows = [...(result.rules || []), ...(result.memories || [])];
  const ids = rows.map((row) => String(row.id));
  const expected = new Set(expectedIds(item));
  const hitRanks = ids
    .map((id, index) => expected.has(id) ? index + 1 : 0)
    .filter(Boolean);
  const hits = hitRanks.length;
  return {
    ids,
    elapsedMs,
    hit1: hitRanks.some((rank) => rank <= 1) ? 1 : 0,
    hit3: hitRanks.some((rank) => rank <= 3) ? 1 : 0,
    hitK: hits > 0 ? 1 : 0,
    recallK: expected.size ? hits / expected.size : 0,
    precisionK: hits / Math.max(1, limit),
    mrr: hitRanks.length ? 1 / Math.min(...hitRanks) : 0,
  };
}

function avg(rows, field) {
  return rows.length ? rows.reduce((sum, row) => sum + row[field], 0) / rows.length : 0;
}

function evaluate(path, limit) {
  const cases = readJsonl(path).filter((item) => item.query && expectedIds(item).length);
  if (!cases.length) throw new Error(`No evaluable cases in ${path}; fill expected memory ids first.`);
  const store = openStore();
  try {
    return {
      golden: path,
      cases: cases.length,
      limit,
      variants: ABLATIONS.map((config) => {
        const runs = cases.map((item) => runOne(store, item, config, limit));
        return {
          name: config.name,
          hit1: avg(runs, "hit1"),
          hit3: avg(runs, "hit3"),
          hitK: avg(runs, "hitK"),
          recallK: avg(runs, "recallK"),
          precisionK: avg(runs, "precisionK"),
          mrr: avg(runs, "mrr"),
          avgMs: avg(runs, "elapsedMs"),
        };
      }),
    };
  } finally {
    store.close();
  }
}

function printReport(report) {
  console.log(`golden=${report.golden} cases=${report.cases} limit=${report.limit}`);
  console.log("variant             hit@1  hit@3  hit@K  recall@K  precision@K  mrr    avg_ms");
  for (const row of report.variants) {
    console.log([
      row.name.padEnd(19),
      row.hit1.toFixed(3).padStart(5),
      row.hit3.toFixed(3).padStart(6),
      row.hitK.toFixed(3).padStart(6),
      row.recallK.toFixed(3).padStart(8),
      row.precisionK.toFixed(3).padStart(11),
      row.mrr.toFixed(3).padStart(6),
      row.avgMs.toFixed(1).padStart(7),
    ].join("  "));
  }
}

function initFromTraces(path, limit) {
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT query, cwd, branch_name, memories_json, rules_json
      FROM recall_traces
      WHERE status = 'ok'
        AND COALESCE(query, '') != ''
        AND COALESCE(session_id, '') != 'self-check'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
    mkdirSync(dirname(path), { recursive: true });
    const lines = rows.map((row) => {
      const candidates = [
        ...readJsonMaybe(row.rules_json || "[]"),
        ...readJsonMaybe(row.memories_json || "[]"),
      ].map((item) => item.id).filter(Boolean).slice(0, 12);
      return JSON.stringify({
        query: row.query,
        expected: [],
        scope: row.cwd ? "project" : undefined,
        project_id: row.cwd || undefined,
        branch_name: row.branch_name || undefined,
        candidates,
      });
    });
    writeFileSync(path, `${lines.join("\n")}\n`);
    console.log(`wrote ${lines.length} trace templates to ${path}; fill expected before evaluating.`);
  } finally {
    db.close();
  }
}

const flags = parseArgs(process.argv.slice(2));
if (flags.help) {
  usage();
} else if (flags.initFromTraces) {
  initFromTraces(flags.golden, flags.traceLimit);
} else if (!existsSync(flags.golden)) {
  usage();
  process.exitCode = 1;
} else {
  const report = evaluate(flags.golden, flags.limit);
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}
