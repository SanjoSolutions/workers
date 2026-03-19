import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, test } from "vitest";
import {
  prepareAssistantSystemPrompt,
  renderAssistantSystemPromptTemplate,
} from "./assistant-system-prompt.js";

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

  test("includes markdown files relative to the current file", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workers-system-prompt-"));
    mkdirSync(path.join(root, "partials"), { recursive: true });
    writeFileSync(
      path.join(root, "partials", "shared.md"),
      ["Shared heading", "{{#cli gemini}}", "Gemini shared", "{{/cli}}"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "SYSTEM.md"),
      ["Start", "{{include partials/shared.md}}", "End"].join("\n"),
      "utf8",
    );

    const prepared = prepareAssistantSystemPrompt(path.join(root, "SYSTEM.md"), "gemini");

    expect(prepared.content).toContain("Start");
    expect(prepared.content).toContain("Shared heading");
    expect(prepared.content).toContain("Gemini shared");
    expect(prepared.content).toContain("End");
  });

  test("strips leading source-only HTML comments from the rendered prompt", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workers-system-prompt-"));
    writeFileSync(
      path.join(root, "SYSTEM.md"),
      [
        "<!--",
        "Source-only notice",
        "-->",
        "",
        "Start",
        "End",
      ].join("\n"),
      "utf8",
    );

    const prepared = prepareAssistantSystemPrompt(path.join(root, "SYSTEM.md"), "codex");

    expect(prepared.content).toContain("Start");
    expect(prepared.content).toContain("End");
    expect(prepared.content).not.toContain("Source-only notice");
    expect(prepared.content.trimStart().startsWith("<!--")).toBe(false);
  });

  test("does not resolve includes inside non-matching CLI blocks", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workers-system-prompt-"));
    writeFileSync(
      path.join(root, "SYSTEM.md"),
      [
        "Start",
        "{{#cli codex}}",
        "{{include missing.md}}",
        "{{/cli}}",
        "End",
      ].join("\n"),
      "utf8",
    );

    const prepared = prepareAssistantSystemPrompt(path.join(root, "SYSTEM.md"), "gemini");

    expect(prepared.content).toContain("Start");
    expect(prepared.content).toContain("End");
    expect(prepared.content).not.toContain("missing.md");
  });

  test("rejects include cycles", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workers-system-prompt-"));
    writeFileSync(
      path.join(root, "a.md"),
      "{{include b.md}}",
      "utf8",
    );
    writeFileSync(
      path.join(root, "b.md"),
      "{{include a.md}}",
      "utf8",
    );

    expect(() => prepareAssistantSystemPrompt(path.join(root, "a.md"), "codex")).toThrow(
      "SYSTEM.md include cycle detected",
    );
  });
});
