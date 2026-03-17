import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, test } from "vitest";
import { loadSettings } from "../src/settings.js";

describe("settings bootstrap", () => {
  test("creates settings.json from settings.template.json when missing", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "workers-settings-"));
    const templatePath = path.join(repoRoot, "settings.template.json");
    const settingsPath = path.join(repoRoot, "settings.json");

    writeFileSync(
      templatePath,
      JSON.stringify({ defaultCli: "gemini" }, null, 2),
      "utf8",
    );

    const settings = loadSettings(repoRoot);

    expect(settings.defaultCli).toBe("gemini");
    expect(existsSync(settingsPath)).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(
      readFileSync(templatePath, "utf8"),
    );
  });
});
