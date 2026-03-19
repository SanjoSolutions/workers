import { existsSync, lstatSync, readFileSync } from "fs";
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
    const assistantClaudeSkillPath = path.join(
      packageRoot,
      "agents",
      "assistant",
      ".claude",
      "skills",
      "clarification",
      "SKILL.md",
    );
    const assistantClaudeSkillLink = path.join(
      packageRoot,
      "agents",
      "assistant",
      ".claude",
      "skills",
      "clarification",
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
    expect(existsSync(assistantClaudeSkillPath)).toBe(true);
    expect(lstatSync(assistantClaudeSkillLink).isSymbolicLink()).toBe(true);
    expect(existsSync(legacySkillPath)).toBe(false);
    expect(readFileSync(assistantSystemPath, "utf8")).toContain(
      "{{include ../SYSTEM_BASE.md}}",
    );
    expect(readFileSync(assistantSystemPath, "utf8")).toContain(
      "# Workflow",
    );
    expect(readFileSync(assistantSystemPath, "utf8")).not.toContain(
      "assistant-local clarification capability",
    );
  });
});
