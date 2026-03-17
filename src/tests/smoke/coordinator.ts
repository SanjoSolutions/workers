/**
 * Smoke test: verify the coordinator skill is picked up by Claude CLI.
 *
 * Requires ANTHROPIC_API_KEY in the environment and a real `claude` binary.
 *
 * The test sets up a small project with the coordinator skill, gives Claude
 * a tiny task, and checks that it was handled directly (not queued).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { $ } from "zx";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("ANTHROPIC_API_KEY is not set");
  }

  const root = mkdtempSync(path.join(tmpdir(), "smoke-coordinator-"));
  const projectPath = path.join(root, "test-project");
  const cwd = process.cwd();

  // --- Set up a git repo with the coordinator skill ---
  mkdirSync(projectPath, { recursive: true });
  await $`git -C ${projectPath} init -b main`.quiet();
  await $`git -C ${projectPath} config user.name Test`.quiet();
  await $`git -C ${projectPath} config user.email test@test`.quiet();

  // Copy the coordinator skill into the project
  const skillDir = path.join(
    projectPath,
    ".agents",
    "skills",
    "coordinator",
  );
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(
    path.join(cwd, ".agents", "skills", "coordinator", "SKILL.md"),
    path.join(skillDir, "SKILL.md"),
  );

  // Create AGENTS.md that tells Claude to follow the coordinator skill
  writeFileSync(
    path.join(projectPath, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "## Workflow",
      "",
      "- The direct user-facing agent session should automatically follow `.agents/skills/coordinator/SKILL.md`.",
      "",
    ].join("\n"),
  );

  // Create a TODO.md from the template
  const todoTemplate = readFileSync(
    path.join(cwd, "TODO.template.md"),
    "utf8",
  );
  writeFileSync(path.join(projectPath, "TODO.md"), todoTemplate);

  // Initial commit so git is clean
  await $`git -C ${projectPath} add -A`.quiet();
  await $`git -C ${projectPath} commit -m "initialize repository"`.quiet();

  // --- Test: small task should be handled directly ---
  console.log(
    "Smoke test: small task — coordinator should handle it directly\n",
  );

  const prompt =
    "Create a file called hello.txt containing exactly: Hello, world!";

  const result =
    await $({ cwd: projectPath, nothrow: true })`claude -p ${prompt} --dangerously-skip-permissions --max-turns 10`;

  const output = result.stdout + result.stderr;

  if (result.exitCode !== 0) {
    console.log("Claude output:\n", output);
    fail(`claude exited with code ${result.exitCode}`);
  }

  // Check: hello.txt should exist with the right content
  const helloPath = path.join(projectPath, "hello.txt");
  if (!existsSync(helloPath)) {
    console.log("Claude output:\n", output);
    fail("hello.txt was not created — coordinator may not have handled the task directly");
  }

  const content = readFileSync(helloPath, "utf8");
  if (!content.includes("Hello, world!")) {
    fail(`hello.txt has unexpected content: ${content}`);
  }
  console.log("PASS: hello.txt created with correct content");

  // Check: TODO.md should be unchanged (small task should not be queued)
  const todoAfter = readFileSync(
    path.join(projectPath, "TODO.md"),
    "utf8",
  );
  if (todoAfter !== todoTemplate) {
    console.log(
      "WARNING: TODO.md was modified — coordinator may have queued instead of handling directly",
    );
  } else {
    console.log("PASS: TODO.md unchanged (task was not queued)");
  }

  console.log("\nSmoke test passed!");
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
