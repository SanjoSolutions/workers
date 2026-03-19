import { describe, expect, test } from "vitest";
import { buildAgentPrompt } from "./agent-prompt.js";

describe("buildAgentPrompt", () => {
  test("describes TODO.md as a local task copy and syncs back to the configured tracker", () => {
    const prompt = buildAgentPrompt(
      "- Fix issue routing\n  - Repo: /tmp/repo",
      "Development task",
      undefined,
    );

    expect(prompt).toContain('local TODO.md copy');
    expect(prompt).toContain("configured");
    expect(prompt).toContain("task tracker");
    expect(prompt).not.toContain("shared TODO repo");
  });
});
