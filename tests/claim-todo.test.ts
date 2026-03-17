import { describe, expect, test } from "vitest";
import { claimFromTodoText } from "../src/claim-todo.js";

describe("claim todo agent matching", () => {
  test("untagged ready items are claimable by claude", () => {
    const todo = `# TODOs

## In progress

## Ready to be picked up

- Build the feature
  - Acceptance: it works
`;

    const result = claimFromTodoText(todo, { agent: "claude" });

    expect(result.status).toBe("claimed");
    expect(result.item).toContain("Build the feature");
  });
});
