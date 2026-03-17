#!/usr/bin/env node

import { existsSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const targetPath = path.join(repoRoot, "build", "init-todo-repo.js");

if (!existsSync(targetPath)) {
  console.error(`Missing built entrypoint: ${targetPath}`);
  console.error("Run `npm run build` in the workers repo first.");
  process.exit(1);
}

await import(pathToFileURL(targetPath).href);
