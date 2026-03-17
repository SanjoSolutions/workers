#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Copy only auth credentials into a temp dir to avoid leaking
# user CLAUDE.md, skills, project memory, etc. into the container.
CLAUDE_TMP="$(mktemp -d)"
trap 'rm -rf "$CLAUDE_TMP"' EXIT
cp "$HOME/.claude/.credentials.json" "$CLAUDE_TMP/.credentials.json"
# Minimal settings to skip first-run setup
echo '{}' > "$CLAUDE_TMP/settings.json"

docker build -f Dockerfile.smoke -t workers-smoke .
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "$(pwd):/app" \
  -v /app/node_modules \
  -v "$CLAUDE_TMP:/tmp/claude-config" \
  -e HOME=/tmp/home \
  workers-smoke sh -c '
    mkdir -p /tmp/home/.claude &&
    cp /tmp/claude-config/.credentials.json /tmp/home/.claude/.credentials.json &&
    cp /tmp/claude-config/settings.json /tmp/home/.claude/settings.json &&
    exec npx tsx src/tests/smoke/coordinator.ts
  '
