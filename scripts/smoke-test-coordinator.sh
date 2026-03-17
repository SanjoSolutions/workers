#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

docker build -f Dockerfile.smoke -t workers-smoke .
docker run --rm -it \
  -v "$(pwd):/app" \
  -v /app/node_modules \
  -v "$HOME/.claude/.credentials.json:/home/smoketest/.claude/.credentials.json:ro" \
  workers-smoke
