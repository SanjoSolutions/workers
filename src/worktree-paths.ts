import { createHash } from "crypto";
import os from "os";
import path from "path";

function expandHomePath(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function sanitizeSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "repo";
}

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
