#!/bin/bash
set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Error: ANTHROPIC_API_KEY must be set"
  exit 1
fi

cd "$(dirname "$0")/.."

docker build -f Dockerfile.smoke -t workers-smoke .
docker run --rm \
  -e ANTHROPIC_API_KEY \
  -v "$(pwd):/app" \
  -v /app/node_modules \
  workers-smoke
