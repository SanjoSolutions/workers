import { describe, expect, test } from "vitest";
import { buildAgentPrompt } from "./agent-prompt.js";

describe("buildAgentPrompt", () => {
  test("describes a mirrored local task file and syncs back to the configured tracker", () => {
    const prompt = buildAgentPrompt(
      "- Fix issue routing\n  - Repo: /tmp/repo",
      "Development task",
      undefined,
    );

    expect(prompt).toContain("local mirrored task file");
    expect(prompt).toContain("configured");
    expect(prompt).toContain("task tracker");
    expect(prompt).toContain("Claimed item:");
    expect(prompt).toContain("Item type: Development task");
    expect(prompt).not.toContain("shared TODO repo");
  });

  test("does not suggest opening a pull request when disabled for the project", () => {
    const prompt = buildAgentPrompt(
      "- Fix issue routing\n  - Repo: /tmp/repo",
      "Development task",
      undefined,
      { createPullRequest: false },
    );

    expect(prompt).toContain("createPullRequest: false");
    expect(prompt).toContain("Do not suggest opening a pull request");
  });
});
