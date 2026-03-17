import { mkdtempSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, test } from "vitest";
import { parseCliOptions } from "../src/cli.js";
import { resolveProjectWorktreeDir } from "../src/worktree-paths.js";

describe("worktree layout", () => {
  test("cli defaults preserve worker outputs in ~/.worktrees", () => {
    const options = parseCliOptions(["node", "work"]);

    expect(options.cli).toBe("codex");
    expect(options.worktreeDir).toBe("~/.worktrees");
    expect(options.cleanup).toBe(false);
    expect(options.cleanupStale).toBe(false);
  });

  test("project worktree dirs are namespaced to avoid collisions", () => {
    const parentA = mkdtempSync(path.join(os.tmpdir(), "workers-layout-a-"));
    const parentB = mkdtempSync(path.join(os.tmpdir(), "workers-layout-b-"));
    const repoA = path.join(parentA, "shared-name");
    const repoB = path.join(parentB, "shared-name");
    mkdirSync(repoA);
    mkdirSync(repoB);

    const dirA = resolveProjectWorktreeDir(repoA, "~/.worktrees");
    const dirB = resolveProjectWorktreeDir(repoB, "~/.worktrees");

    expect(dirA).not.toBe(dirB);
    expect(dirA.startsWith(path.join(os.homedir(), ".worktrees", "shared-name-"))).toBe(true);
    expect(dirB.startsWith(path.join(os.homedir(), ".worktrees", "shared-name-"))).toBe(true);
  });
});
