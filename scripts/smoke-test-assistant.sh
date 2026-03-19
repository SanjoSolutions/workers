#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Copy only auth credentials into a temp dir to avoid leaking
# user CLAUDE.md, skills, project memory, etc. into the container.
CLAUDE_TMP="$(mktemp -d)"
trap 'rm -rf "$CLAUDE_TMP"' EXIT
cp "$HOME/.claude/.credentials.json" "$CLAUDE_TMP/.credentials.json"
# Read user's theme preference from ~/.claude.json
THEME="dark"
if [ -f "$HOME/.claude.json" ]; then
  THEME="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HOME/.claude.json','utf8')).theme || 'dark')")"
fi
echo "{\"hasCompletedOnboarding\":true,\"theme\":\"$THEME\"}" > "$CLAUDE_TMP/.claude.json"

# Clean build files that may be owned by a different uid from previous Docker runs
docker run --rm -v "$(pwd):/app" node:lts rm -rf /app/build

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
    cp /tmp/claude-config/.claude.json /tmp/home/.claude.json &&
    echo "{\"model\":\"claude-opus-4-6\"}" > /tmp/home/.claude/settings.json &&
    exec npx tsx src/tests/smoke/assistant.ts
  '
