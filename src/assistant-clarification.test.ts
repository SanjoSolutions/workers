import { existsSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, test } from "vitest";
import { determinePackageRoot } from "./settings.js";

describe("assistant clarification capability", () => {
  test("keeps clarification only under the assistant agent directory", () => {
    const packageRoot = determinePackageRoot();
    const assistantSkillPath = path.join(
      packageRoot,
      "agents",
      "assistant",
      ".agents",
      "skills",
      "clarification",
      "SKILL.md",
    );
    const legacySkillPath = path.join(
      packageRoot,
      ".agents",
      "skills",
      "clarification",
      "SKILL.md",
    );
    const assistantSystemPath = path.join(
      packageRoot,
      "agents",
      "assistant",
      "SYSTEM.md",
    );

    expect(existsSync(assistantSkillPath)).toBe(true);
    expect(existsSync(legacySkillPath)).toBe(false);
    expect(readFileSync(assistantSystemPath, "utf8")).toContain(
      "You are a coding agent running in the Codex CLI",
    );
    expect(readFileSync(assistantSystemPath, "utf8")).not.toContain(
      "assistant-local clarification capability",
    );
  });
});
