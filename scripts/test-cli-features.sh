#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

# On-demand CLI feature checks. Run these when installing or updating an agent CLI.
# Usage:
#   scripts/test-cli-features.sh
#   scripts/test-cli-features.sh codex claude

TESTS="${*:-claude codex gemini pi}"

FAILED=""

run_feature_check() {
  cli="$1"
  echo "========================================"
  echo "Running CLI feature check: $cli"
  echo "========================================"
  if npx tsx "src/tests/cli-features/${cli}.ts"; then
    echo "PASSED: $cli"
  else
    echo "FAILED: $cli"
    if [ -n "${FAILED:-}" ]; then
      FAILED="$FAILED $cli"
    else
      FAILED="$cli"
    fi
  fi
  echo ""
}

for cli in $TESTS; do
  run_feature_check "$cli"
done

if [ -n "${FAILED:-}" ]; then
  echo "========================================"
  echo "CLI FEATURE CHECKS FAILED: $FAILED"
  echo "========================================"
  exit 1
fi

echo "========================================"
echo "All CLI feature checks passed."
echo "========================================"
