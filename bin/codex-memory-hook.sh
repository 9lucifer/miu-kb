#!/bin/bash
set -u

APP_DIR="${MIU_KB_APP_DIR:-${CODEX_MEMORY_REVIEW_APP_DIR:-$HOME/.codex/miu-kb}}"
NODE_BIN="${MIU_KB_NODE_BIN:-${CODEX_MEMORY_REVIEW_NODE_BIN:-}}"

if [ -z "$NODE_BIN" ] && [ -f "$APP_DIR/.node-bin" ]; then
  NODE_BIN="$(cat "$APP_DIR/.node-bin" 2>/dev/null || true)"
fi

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[miu-kb] node not found; install Node.js or set MIU_KB_NODE_BIN" >&2
  exit 0
fi

event="${1:-}"
case "$event" in
  user-prompt|UserPromptSubmit)
    exec "$NODE_BIN" --no-warnings=ExperimentalWarning "$APP_DIR/bin/user-prompt-recall.mjs"
    ;;
  stop|Stop)
    exec "$NODE_BIN" --no-warnings=ExperimentalWarning "$APP_DIR/bin/stop-enqueue.mjs"
    ;;
  *)
    echo "[miu-kb] unknown hook event: $event" >&2
    exit 0
    ;;
esac
