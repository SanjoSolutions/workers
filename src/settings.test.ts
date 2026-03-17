import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, test } from "vitest";
import { ensureWorkerCli, loadSettings } from "./settings.js";

async function createFakeCli(binDir: string, name: string): Promise<void> {
  const { mkdir, writeFile, chmod } = await import("fs/promises");
  await mkdir(binDir, { recursive: true });
  const filePath = path.join(binDir, name);
  await writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(filePath, 0o755);
}

describe("settings bootstrap", () => {
  test("creates settings.json from template", async () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), "workers-settings-"));
    const templatePath = path.join(cfgDir, "settings.template.json");
    const settingsFilePath = path.join(cfgDir, "settings.json");

    writeFileSync(templatePath, '{ "worker": { "defaults": { "model": "gpt-5.4" } } }\n', "utf8");

    const settings = await loadSettings(undefined, { configDir: cfgDir });

    expect(settings.defaults.cli).toBeUndefined();
    expect(settings.defaults.model).toBe("gpt-5.4");
    expect(settings.assistant.defaults.cli).toBeUndefined();
    expect(settings.taskTrackers).toEqual({});
    expect(settings.projects).toEqual([]);
    expect(existsSync(settingsFilePath)).toBe(true);
  });

  test("reads existing settings without prompting", async () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), "workers-settings-existing-"));
    writeFileSync(
      path.join(cfgDir, "settings.json"),
      JSON.stringify({ worker: { defaults: { cli: "gemini", model: "gpt-5.3-codex" } } }, null, 2),
      "utf8",
    );

    const settings = await loadSettings(undefined, { configDir: cfgDir });

    expect(settings.defaults.cli).toBe("gemini");
    expect(settings.defaults.model).toBe("gpt-5.3-codex");
    expect(settings.taskTrackers).toEqual({});
    expect(settings.projects).toEqual([]);
  });
});

describe("ensureWorkerCli", () => {
  test("auto-selects the only installed cli and persists", async () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), "workers-ensure-"));
    const settingsFilePath = path.join(cfgDir, "settings.json");
    const binDir = path.join(cfgDir, "bin");

    writeFileSync(settingsFilePath, '{ "worker": { "defaults": { "model": "gpt-5.4" } } }\n', "utf8");
    await createFakeCli(binDir, "codex");

    const settings = await loadSettings(undefined, { configDir: cfgDir });
    expect(settings.defaults.cli).toBeUndefined();

    const cli = await ensureWorkerCli(settings, cfgDir, {
      env: { ...process.env, PATH: binDir },
    });

    expect(cli).toBe("codex");
    expect(settings.defaults.cli).toBe("codex");
    expect(JSON.parse(readFileSync(settingsFilePath, "utf8"))).toMatchObject({
      worker: { defaults: { cli: "codex" } },
    });
  });

  test("prompts when multiple clis are installed", async () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), "workers-ensure-prompt-"));
    const settingsFilePath = path.join(cfgDir, "settings.json");
    const binDir = path.join(cfgDir, "bin");

    writeFileSync(settingsFilePath, '{ "worker": { "defaults": { "model": "gpt-5.4" } } }\n', "utf8");
    await createFakeCli(binDir, "claude");
    await createFakeCli(binDir, "codex");

    const settings = await loadSettings(undefined, { configDir: cfgDir });

    const cli = await ensureWorkerCli(settings, cfgDir, {
      env: { ...process.env, PATH: binDir },
      promptForCli: async (choices) => {
        expect(choices).toEqual(["claude", "codex"]);
        return "claude";
      },
    });

    expect(cli).toBe("claude");
    expect(settings.defaults.cli).toBe("claude");
    expect(JSON.parse(readFileSync(settingsFilePath, "utf8"))).toMatchObject({
      worker: { defaults: { cli: "claude" } },
    });
  });

  test("returns existing cli without prompting", async () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), "workers-ensure-existing-"));
    writeFileSync(
      path.join(cfgDir, "settings.json"),
      JSON.stringify({ worker: { defaults: { cli: "gemini", model: "gpt-5.4" } } }, null, 2),
      "utf8",
    );

    const settings = await loadSettings(undefined, { configDir: cfgDir });

    const cli = await ensureWorkerCli(settings, cfgDir, {
      promptForCli: async () => {
        throw new Error("should not prompt");
      },
    });

    expect(cli).toBe("gemini");
  });
});
