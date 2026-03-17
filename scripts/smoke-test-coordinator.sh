#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

docker build -f Dockerfile.smoke -t workers-smoke .
docker run --rm \
  -v "$(pwd):/app" \
  -v /app/node_modules \
  -v "$HOME/.claude:/root/.claude:ro" \
  workers-smoke
