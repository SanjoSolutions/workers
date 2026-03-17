import { describe, expect, test } from "vitest";
import { insertIntoSection } from "./add-todo.js";

describe("add-todo section targeting", () => {
  const template = `# TODOs

## In progress

## Ready to be picked up

## Planned

## Requires feedback
`;

  test("adds new items to planned by default section helper", () => {
    const result = insertIntoSection(
      template,
      ["- Planned task"],
      "planned",
    );

    expect(result).toContain("## Planned\n\n- Planned task\n");
    expect(result).not.toContain("## Ready to be picked up\n\n- Planned task\n");
  });

  test("adds ready items to the ready section", () => {
    const result = insertIntoSection(
      template,
      ["- Ready task", "  - Acceptance: can be picked up now"],
      "ready",
    );

    expect(result).toContain(
      "## Ready to be picked up\n\n- Ready task\n  - Acceptance: can be picked up now\n",
    );
    expect(result).not.toContain("## Planned\n\n- Ready task\n");
  });
});
