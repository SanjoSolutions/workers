import { describe, expect, test } from "vitest";
import { claimFromTodoText, selectFromTodoText } from "./claim-todo.js";

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

describe("dependency tracking", () => {
  test("task with unmet dependency in ready section is skipped", () => {
    const todo = `# TODOs

## In progress

## Ready to be picked up

- First task
  - Acceptance: done

- Second task
  - Depends on: First task
  - Acceptance: done
`;

    const result = claimFromTodoText(todo);

    expect(result.status).toBe("claimed");
    expect(result.item).toContain("First task");
    expect(result.item).not.toContain("Second task");
  });

  test("task with unmet dependency in in-progress section is skipped", () => {
    const todo = `# TODOs

## In progress

- First task
  - Acceptance: done

## Ready to be picked up

- Second task
  - Depends on: First task
  - Acceptance: done
`;

    const result = claimFromTodoText(todo);

    expect(result.status).toBe("no-claim");
    expect(result.reason).toBe("all-blocked-by-dependency");
  });

  test("task with completed dependency (removed from todo) is claimable", () => {
    const todo = `# TODOs

## In progress

## Ready to be picked up

- Second task
  - Depends on: First task
  - Acceptance: done
`;

    const result = claimFromTodoText(todo);

    expect(result.status).toBe("claimed");
    expect(result.item).toContain("Second task");
  });

  test("dependency without quotes is parsed correctly", () => {
    const todo = `# TODOs

## In progress

## Ready to be picked up

- Blocker task
  - Acceptance: done

- Dependent task
  - Depends on: Blocker task
  - Acceptance: done
`;

    const result = selectFromTodoText(todo);

    expect(result.status).toBe("selected");
    expect(result.item).toContain("Blocker task");
  });

  test("all-blocked-by-dependency reason when all ready tasks have pending deps", () => {
    const todo = `# TODOs

## In progress

- Running task
  - Acceptance: done

## Ready to be picked up

- Blocked task
  - Depends on: Running task
  - Acceptance: done
`;

    const result = selectFromTodoText(todo);

    expect(result.status).toBe("none");
    expect(result.reason).toBe("all-blocked-by-dependency");
  });
});
