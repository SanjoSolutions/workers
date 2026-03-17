#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Copy only auth credentials into a temp dir to avoid leaking
# user CLAUDE.md, skills, project memory, etc. into the container.
CLAUDE_TMP="$(mktemp -d)"
trap 'rm -rf "$CLAUDE_TMP"' EXIT
cp "$HOME/.claude/.credentials.json" "$CLAUDE_TMP/.credentials.json"
# Mark onboarding as complete so Claude doesn't show first-run setup
echo '{"hasCompletedOnboarding":true,"theme":"dark"}' > "$CLAUDE_TMP/.config.json"

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
    cp /tmp/claude-config/.config.json /tmp/home/.claude/.config.json &&
    exec npx tsx src/tests/smoke/coordinator.ts
  '
