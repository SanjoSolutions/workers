#!/bin/bash
set -euo pipefail

# Run smoke tests for all three agent CLIs: Claude, Codex, and Gemini.
# Each test verifies the CLI starts, loads system instructions, and responds.
#
# Required environment variables (set as secrets in CI):
#   ANTHROPIC_API_KEY  — for Claude
#   OPENAI_API_KEY     — for Codex
#   GOOGLE_API_KEY     — for Gemini

cd "$(dirname "$0")/.."

# Determine which CLIs to test. Default: all. Override via CLI args.
TESTS="${*:-claude codex gemini}"

FAILED=()

run_smoke() {
  local cli="$1"
  echo "========================================"
  echo "Running smoke test: $cli"
  echo "========================================"
  if npx tsx "src/tests/smoke/${cli}.ts"; then
    echo "PASSED: $cli"
  else
    echo "FAILED: $cli"
    FAILED+=("$cli")
  fi
  echo ""
}

for cli in $TESTS; do
  run_smoke "$cli"
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "========================================"
  echo "SMOKE TESTS FAILED: ${FAILED[*]}"
  echo "========================================"
  exit 1
else
  echo "========================================"
  echo "All smoke tests passed."
  echo "========================================"
fi
