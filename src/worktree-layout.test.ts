import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseCliOptions } from "./cli.js";
import { resolveProjectWorktreeDir } from "./worktree-paths.js";

describe("worktree layout", () => {
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.WORKERS_CONFIG_DIR;
    const cfgDir = mkdtempSync(path.join(os.tmpdir(), "workers-layout-cfg-"));
    writeFileSync(
      path.join(cfgDir, "settings.json"),
      JSON.stringify({ worker: { defaults: { cli: "claude", model: "gpt-5.4" } } }, null, 2),
      "utf8",
    );
    process.env.WORKERS_CONFIG_DIR = cfgDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.WORKERS_CONFIG_DIR;
    } else {
      process.env.WORKERS_CONFIG_DIR = originalConfigDir;
    }
  });

  test("cli defaults preserve worker outputs in ~/.worktrees", async () => {
    const options = await parseCliOptions(["node", "worker"]);

    expect(["claude", "codex", "gemini"]).toContain(options.cli);
    expect(typeof options.modelDefault).toBe("string");
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
