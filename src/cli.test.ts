import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseCliOptions } from "./cli.js";

describe("parseCliOptions", () => {
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.WORKERS_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.WORKERS_CONFIG_DIR;
    } else {
      process.env.WORKERS_CONFIG_DIR = originalConfigDir;
    }
  });

  test("persists an explicit worker cli when the settings file is missing it", async () => {
    const cfgDir = mkdtempSync(path.join(os.tmpdir(), "workers-cli-explicit-"));
    const settingsFilePath = path.join(cfgDir, "settings.json");

    writeFileSync(
      settingsFilePath,
      JSON.stringify({ worker: { defaults: { model: "gpt-5.4" } } }, null, 2),
      "utf8",
    );
    process.env.WORKERS_CONFIG_DIR = cfgDir;

    const options = await parseCliOptions(["node", "worker", "--cli", "codex"]);

    expect(options.cli).toBe("codex");
    expect(JSON.parse(readFileSync(settingsFilePath, "utf8"))).toMatchObject({
      worker: { defaults: { cli: "codex" } },
    });
  });
});
