#!/bin/sh
set -e

# Build TypeScript and link binaries globally so `assistant` and `worker`
# are available as commands inside the container.
pnpm run build 2>/dev/null && npm link --silent 2>/dev/null || true

exec "$@"
