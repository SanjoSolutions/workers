#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$script_dir/node_modules/.bin/tsx" "$script_dir/src/add-todo.ts" "$@"
