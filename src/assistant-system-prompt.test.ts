import { describe, expect, test } from "vitest";
import { renderAssistantSystemPromptTemplate } from "./assistant-system-prompt.js";

const TEMPLATE = [
  "Common line",
  "{{#cli codex}}",
  "Codex only",
  "{{/cli}}",
  "{{#cli claude}}",
  "Claude only",
  "{{/cli}}",
  "{{#cli gemini pi}}",
  "Gemini and pi",
  "{{/cli}}",
].join("\n");

describe("assistant system prompt templating", () => {
  test("renders only the matching CLI blocks", () => {
    const rendered = renderAssistantSystemPromptTemplate(TEMPLATE, "codex");

    expect(rendered).toContain("Common line");
    expect(rendered).toContain("Codex only");
    expect(rendered).not.toContain("Claude only");
    expect(rendered).not.toContain("Gemini and pi");
  });

  test("supports multiple CLIs in one block", () => {
    const rendered = renderAssistantSystemPromptTemplate(TEMPLATE, "gemini");

    expect(rendered).toContain("Common line");
    expect(rendered).not.toContain("Codex only");
    expect(rendered).not.toContain("Claude only");
    expect(rendered).toContain("Gemini and pi");
  });
});
