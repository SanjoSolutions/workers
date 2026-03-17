import { createHash } from "crypto";
import path from "path";
import { expandHomePath, sanitizeSegment } from "./path-utils.js";

export function resolveWorktreeRoot(
  repoRoot: string,
  configuredPath: string,
): string {
  const expanded = expandHomePath(configuredPath);
  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(repoRoot, expanded);
}

export function projectWorktreeNamespace(repoRoot: string): string {
  const basename = sanitizeSegment(path.basename(path.resolve(repoRoot)));
  const hash = createHash("sha1")
    .update(path.resolve(repoRoot))
    .digest("hex")
    .slice(0, 8);
  return `${basename}-${hash}`;
}

export function resolveProjectWorktreeDir(
  repoRoot: string,
  configuredPath: string,
): string {
  return path.join(
    resolveWorktreeRoot(repoRoot, configuredPath),
    projectWorktreeNamespace(repoRoot),
  );
}
