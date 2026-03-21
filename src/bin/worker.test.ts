import { describe, expect, test } from "vitest";
import { finishedBranchFollowUpMessage } from "./worker.js";

describe("finishedBranchFollowUpMessage", () => {
  test("does not suggest opening a pull request when disabled", () => {
    expect(finishedBranchFollowUpMessage(false)).not.toContain("pull request");
  });

  test("can suggest opening a pull request when enabled", () => {
    expect(finishedBranchFollowUpMessage(true)).toContain("pull request");
  });
});
