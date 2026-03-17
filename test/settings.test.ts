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
    const repoRoot = mkdtempSync(path.join(tmpdir(), "workers-settings-"));
    const templatePath = path.join(repoRoot, "settings.template.json");
    const settingsPath = path.join(repoRoot, "settings.json");
    const binDir = path.join(repoRoot, "bin");

    writeFileSync(templatePath, "{}\n", "utf8");
    await createFakeCli(binDir, "codex");

    const settings = await loadSettings(repoRoot, {
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    expect(settings.defaults.cli).toBe("codex");
    expect(settings.defaults.model).toBe("gpt-5.4");
    expect(settings.taskTrackers).toEqual({});
    expect(settings.projects).toEqual([]);
    expect(existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
      worker: { defaults: { cli: "codex" } },
    });
  });

  test("prompts only during initial creation when multiple clis are installed", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "workers-settings-prompt-"));
    const templatePath = path.join(repoRoot, "settings.template.json");
    const settingsPath = path.join(repoRoot, "settings.json");
    const binDir = path.join(repoRoot, "bin");

    writeFileSync(templatePath, "{}\n", "utf8");
    await createFakeCli(binDir, "claude");
    await createFakeCli(binDir, "codex");

    const firstLoad = await loadSettings(repoRoot, {
      env: {
        ...process.env,
        PATH: binDir,
      },
      promptForCli: async (choices) => {
        expect(choices).toEqual(["claude", "codex"]);
        return "claude";
      },
    });

    expect(firstLoad.defaults.cli).toBe("claude");
    expect(firstLoad.defaults.model).toBe("gpt-5.4");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
      worker: { defaults: { cli: "claude" } },
    });

    writeFileSync(
      settingsPath,
      JSON.stringify({ worker: { defaults: { cli: "gemini", model: "gpt-5.3-codex" } } }, null, 2),
      "utf8",
    );

    const settings = await loadSettings(repoRoot, {
      promptForCli: async () => {
        throw new Error("should not prompt");
      },
    });

    expect(settings.defaults.cli).toBe("gemini");
    expect(settings.defaults.model).toBe("gpt-5.3-codex");
    expect(settings.taskTrackers).toEqual({});
    expect(settings.projects).toEqual([]);
  });
});
