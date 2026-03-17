import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, test } from "vitest";
import { loadSettings } from "../src/settings.js";

async function createFakeCli(binDir: string, name: string): Promise<void> {
  const { mkdir, writeFile, chmod } = await import("fs/promises");
  await mkdir(binDir, { recursive: true });
  const filePath = path.join(binDir, name);
  await writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(filePath, 0o755);
}

describe("settings bootstrap", () => {
  test("creates settings.json from template and auto-selects the only installed cli", async () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), "workers-settings-"));
    const templatePath = path.join(cfgDir, "settings.template.json");
    const settingsFilePath = path.join(cfgDir, "settings.json");
    const binDir = path.join(cfgDir, "bin");

    writeFileSync(templatePath, "{}\n", "utf8");
    await createFakeCli(binDir, "codex");

    const settings = await loadSettings(undefined, {
      env: {
        ...process.env,
        PATH: binDir,
      },
      configDir: cfgDir,
    });

    expect(settings.defaults.cli).toBe("codex");
    expect(settings.defaults.model).toBe("gpt-5.4");
    expect(settings.assistant.defaults.cli).toBeUndefined();
    expect(settings.taskTrackers).toEqual({});
    expect(settings.projects).toEqual([]);
    expect(existsSync(settingsFilePath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsFilePath, "utf8"))).toMatchObject({
      worker: { defaults: { cli: "codex" } },
    });
  });

  test("prompts only during initial creation when multiple clis are installed", async () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), "workers-settings-prompt-"));
    const templatePath = path.join(cfgDir, "settings.template.json");
    const settingsFilePath = path.join(cfgDir, "settings.json");
    const binDir = path.join(cfgDir, "bin");

    writeFileSync(templatePath, "{}\n", "utf8");
    await createFakeCli(binDir, "claude");
    await createFakeCli(binDir, "codex");

    const firstLoad = await loadSettings(undefined, {
      env: {
        ...process.env,
        PATH: binDir,
      },
      promptForCli: async (choices) => {
        expect(choices).toEqual(["claude", "codex"]);
        return "claude";
      },
      configDir: cfgDir,
    });

    expect(firstLoad.defaults.cli).toBe("claude");
    expect(firstLoad.defaults.model).toBe("gpt-5.4");
    expect(JSON.parse(readFileSync(settingsFilePath, "utf8"))).toMatchObject({
      worker: { defaults: { cli: "claude" } },
    });

    writeFileSync(
      settingsFilePath,
      JSON.stringify({ worker: { defaults: { cli: "gemini", model: "gpt-5.3-codex" } } }, null, 2),
      "utf8",
    );

    const settings = await loadSettings(undefined, {
      promptForCli: async () => {
        throw new Error("should not prompt");
      },
      configDir: cfgDir,
    });

    expect(settings.defaults.cli).toBe("gemini");
    expect(settings.defaults.model).toBe("gpt-5.3-codex");
    expect(settings.taskTrackers).toEqual({});
    expect(settings.projects).toEqual([]);
  });
});
