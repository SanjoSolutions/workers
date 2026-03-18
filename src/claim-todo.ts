import { open, readFile, unlink, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

const DEFAULT_RETRIES = 20;
const DEFAULT_RETRY_DELAY_MS = 50;
const IN_PROGRESS_HEADER = "## In progress";
const READY_SECTION_HEADER = "## Ready to be picked up";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findIndexBetween(
  lines: string[],
  start: number,
  end: number,
  predicate: (line: string) => boolean,
): number {
  for (let index = start; index < end; index += 1) {
    if (predicate(lines[index])) return index;
  }
  return -1;
}

function findSectionEnd(lines: string[], start: number, end: number): number {
  return findIndexBetween(lines, start, end, (line) => /^##\s+/.test(line) || /^#\s+/.test(line));
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

function ensureInProgressSection(lines: string[]): string[] {
  if (lines.some((line) => line.trim() === IN_PROGRESS_HEADER)) {
    return lines;
  }

  const readyHeaderIndex = lines.findIndex((line) => line.trim() === READY_SECTION_HEADER);
  if (readyHeaderIndex < 0) {
    return lines;
  }

  const prefix = trimTrailingEmptyLines(lines.slice(0, readyHeaderIndex));
  const suffix = lines.slice(readyHeaderIndex);
  const nextLines = prefix.slice();

  if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
    nextLines.push("");
  }

  nextLines.push(IN_PROGRESS_HEADER, "");

  return nextLines.concat(suffix);
}

function detectTodoType(item: string): string {
  if (/\n\s+- Type:\s*New project\s*$/im.test(item) || /^\s*-\s*Type:\s*New project\s*$/im.test(item)) {
    return "new-project";
  }
  if (/\n\s+- Type:\s*Bug fix\s*$/im.test(item) || /^\s*-\s*Type:\s*Bug fix\s*$/im.test(item)) {
    return "bug-fix";
  }
  if (/\n\s+- Type:\s*Development task\s*$/im.test(item) || /^\s*-\s*Type:\s*Development task\s*$/im.test(item)) {
    return "development-task";
  }
  return "unknown";
}

function detectAgent(item: string): string {
  const match = item.match(/(?:^|\n)\s+- Agent:\s*(\S+)\s*$/im);
  return match ? match[1].toLowerCase() : "";
}

interface ItemRange {
  start: number;
  end: number;
}

function parseItemsInSection(lines: string[], sectionStart: number, sectionEnd: number): ItemRange[] {
  const items: ItemRange[] = [];
  let cursor = sectionStart;
  while (cursor < sectionEnd) {
    const itemStart = findIndexBetween(lines, cursor, sectionEnd, (line) => /^- /.test(line));
    if (itemStart < 0) break;
    const itemEndCandidate = findIndexBetween(lines, itemStart + 1, sectionEnd, (line) => /^- /.test(line));
    const itemEnd = itemEndCandidate < 0 ? sectionEnd : itemEndCandidate;
    items.push({ start: itemStart, end: itemEnd });
    cursor = itemEnd;
  }
  return items;
}

function extractItemSummary(lines: string[], itemStart: number): string {
  const line = lines[itemStart];
  return line.replace(/^- /, "").trim();
}

function extractConflictRiskSummaries(lines: string[], itemStart: number, itemEnd: number): string[] {
  const summaries: string[] = [];
  for (let index = itemStart; index < itemEnd; index += 1) {
    const match = lines[index].match(/^\s+- Conflict risk:.*also modified by "(.+)"$/);
    if (match) {
      summaries.push(match[1]);
    }
  }
  return summaries;
}

function extractDependencies(lines: string[], itemStart: number, itemEnd: number): string[] {
  const summaries: string[] = [];
  for (let index = itemStart; index < itemEnd; index += 1) {
    const match = lines[index].match(/^\s+- Depends on:\s+(.+?)\s*$/);
    if (match) {
      summaries.push(match[1]);
    }
  }
  return summaries;
}

function extractItemAgent(lines: string[], itemStart: number, itemEnd: number): string {
  for (let index = itemStart; index < itemEnd; index += 1) {
    const match = lines[index].match(/^\s+- Agent:\s*(\S+)\s*$/i);
    if (match) return match[1].toLowerCase();
  }
  return "";
}

function isAgentMatch(itemAgent: string, filterAgent: string | undefined): boolean {
  if (!filterAgent) return true;
  if (!itemAgent) {
    return true;
  }
  return itemAgent === filterAgent.toLowerCase();
}

export interface SelectResult {
  status: "selected" | "none";
  reason: string;
  item: string;
  itemType: string;
  itemAgent: string;
}

export function selectFromTodoText(
  content: string,
  options: { agent?: string } = {},
): SelectResult {
  const { agent: filterAgent } = options;

  let lines = content.split(/\r?\n/);
  lines = ensureInProgressSection(lines);

  const readyHeaderIndex = lines.findIndex((line) => line.trim() === READY_SECTION_HEADER);
  if (readyHeaderIndex < 0) {
    return { status: "none", reason: "missing-ready-section", item: "", itemType: "unknown", itemAgent: "" };
  }

  const inProgressHeaderIndex = lines.findIndex((line) => line.trim() === IN_PROGRESS_HEADER);

  const readyStart = readyHeaderIndex + 1;
  const readyEndCandidate = findSectionEnd(lines, readyStart, lines.length);
  const readyEnd = readyEndCandidate < 0 ? lines.length : readyEndCandidate;

  const readyItems = parseItemsInSection(lines, readyStart, readyEnd);
  if (readyItems.length === 0) {
    return { status: "none", reason: "ready-empty", item: "", itemType: "unknown", itemAgent: "" };
  }

  const inProgressStart = inProgressHeaderIndex >= 0 ? inProgressHeaderIndex + 1 : 0;
  const inProgressEndCandidate = inProgressHeaderIndex >= 0
    ? findSectionEnd(lines, inProgressStart, lines.length)
    : 0;
  const inProgressEnd = inProgressEndCandidate < 0 ? lines.length : inProgressEndCandidate;
  const inProgressItems = inProgressHeaderIndex >= 0
    ? parseItemsInSection(lines, inProgressStart, inProgressEnd)
    : [];
  const inProgressSummaries = inProgressItems.map((item) => extractItemSummary(lines, item.start));
  const readySummaries = readyItems.map((item) => extractItemSummary(lines, item.start));

  let chosenItem: ItemRange | null = null;
  let hasReadyItems = false;
  let blockedByDependency = false;
  for (const candidate of readyItems) {
    const itemAgent = extractItemAgent(lines, candidate.start, candidate.end);
    if (!isAgentMatch(itemAgent, filterAgent)) continue;

    hasReadyItems = true;

    const dependencies = extractDependencies(lines, candidate.start, candidate.end);
    if (dependencies.length > 0) {
      const hasPendingDependency = dependencies.some(
        (dep) => readySummaries.includes(dep) || inProgressSummaries.includes(dep),
      );
      if (hasPendingDependency) {
        blockedByDependency = true;
        continue;
      }
    }

    const conflictSummaries = extractConflictRiskSummaries(lines, candidate.start, candidate.end);
    if (conflictSummaries.length > 0) {
      const hasConflict = conflictSummaries.some((summary) => inProgressSummaries.includes(summary));
      if (hasConflict) continue;
    }

    chosenItem = candidate;
    break;
  }

  if (chosenItem === null) {
    const reason = !hasReadyItems
      ? "no-matching-agent"
      : blockedByDependency
        ? "all-blocked-by-dependency"
        : "all-blocked-by-conflict";
    return {
      status: "none",
      reason,
      item: "",
      itemType: "unknown",
      itemAgent: "",
    };
  }

  const itemLines = trimTrailingEmptyLines(lines.slice(chosenItem.start, chosenItem.end));
  const item = itemLines.join("\n");

  return {
    status: "selected",
    reason: "selected",
    item,
    itemType: detectTodoType(item),
    itemAgent: detectAgent(item),
  };
}

export interface ClaimResult {
  status: "claimed" | "no-claim";
  reason: string;
  item: string;
  itemType: string;
  itemAgent: string;
  updatedContent: string;
}

export function claimFromTodoText(
  content: string,
  options: { agent?: string } = {},
): ClaimResult {
  const { agent: filterAgent } = options;

  let lines = content.split(/\r?\n/);
  lines = ensureInProgressSection(lines);
  const inProgressHeaderIndex = lines.findIndex((line) => line.trim() === IN_PROGRESS_HEADER);
  if (inProgressHeaderIndex < 0) {
    return {
      status: "no-claim",
      reason: "missing-in-progress-section",
      item: "",
      itemType: "unknown",
      itemAgent: "",
      updatedContent: content,
    };
  }

  const readyHeaderIndex = lines.findIndex((line) => line.trim() === READY_SECTION_HEADER);

  if (readyHeaderIndex < 0) {
    return {
      status: "no-claim",
      reason: "missing-ready-section",
      item: "",
      itemType: "unknown",
      itemAgent: "",
      updatedContent: content,
    };
  }

  const readyStart = readyHeaderIndex + 1;
  const readyEndCandidate = findSectionEnd(lines, readyStart, lines.length);
  const readyEnd = readyEndCandidate < 0 ? lines.length : readyEndCandidate;

  const readyItems = parseItemsInSection(lines, readyStart, readyEnd);
  if (readyItems.length === 0) {
    return {
      status: "no-claim",
      reason: "ready-empty",
      item: "",
      itemType: "unknown",
      itemAgent: "",
      updatedContent: content,
    };
  }

  const inProgressStart = inProgressHeaderIndex + 1;
  const inProgressEndCandidate = findSectionEnd(lines, inProgressStart, lines.length);
  const inProgressEnd = inProgressEndCandidate < 0 ? lines.length : inProgressEndCandidate;
  const inProgressItems = parseItemsInSection(lines, inProgressStart, inProgressEnd);
  const inProgressSummaries = inProgressItems.map((item) => extractItemSummary(lines, item.start));
  const readySummaries = readyItems.map((item) => extractItemSummary(lines, item.start));

  let chosenItem: ItemRange | null = null;
  let hasReadyItems = false;
  let blockedByDependency = false;
  for (const candidate of readyItems) {
    const itemAgent = extractItemAgent(lines, candidate.start, candidate.end);
    if (!isAgentMatch(itemAgent, filterAgent)) continue;

    hasReadyItems = true;

    const dependencies = extractDependencies(lines, candidate.start, candidate.end);
    if (dependencies.length > 0) {
      const hasPendingDependency = dependencies.some(
        (dep) => readySummaries.includes(dep) || inProgressSummaries.includes(dep),
      );
      if (hasPendingDependency) {
        blockedByDependency = true;
        continue;
      }
    }

    const conflictSummaries = extractConflictRiskSummaries(lines, candidate.start, candidate.end);
    if (conflictSummaries.length > 0) {
      const hasConflict = conflictSummaries.some((summary) => inProgressSummaries.includes(summary));
      if (hasConflict) continue;
    }

    chosenItem = candidate;
    break;
  }

  if (chosenItem === null) {
    const reason = !hasReadyItems
      ? "no-matching-agent"
      : blockedByDependency
        ? "all-blocked-by-dependency"
        : "all-blocked-by-conflict";
    return {
      status: "no-claim",
      reason,
      item: "",
      itemType: "unknown",
      itemAgent: "",
      updatedContent: content,
    };
  }

  const itemLines = trimTrailingEmptyLines(lines.slice(chosenItem.start, chosenItem.end));
  const item = itemLines.join("\n");

  const withoutClaimedItem = lines.slice(0, chosenItem.start).concat(lines.slice(chosenItem.end));
  const refreshedInProgressHeaderIndex = withoutClaimedItem.findIndex((line) => line.trim() === IN_PROGRESS_HEADER);
  if (refreshedInProgressHeaderIndex < 0) {
    return {
      status: "no-claim",
      reason: "missing-in-progress-section",
      item: "",
      itemType: "unknown",
      itemAgent: "",
      updatedContent: content,
    };
  }
  const refreshedInProgressStart = refreshedInProgressHeaderIndex + 1;
  const refreshedInProgressEndCandidate = findSectionEnd(withoutClaimedItem, refreshedInProgressStart, withoutClaimedItem.length);
  const refreshedInProgressEnd =
    refreshedInProgressEndCandidate < 0 ? withoutClaimedItem.length : refreshedInProgressEndCandidate;

  const nextLines = withoutClaimedItem.slice();
  const insertion = itemLines.slice();
  if (insertion.length > 0 && insertion[insertion.length - 1] !== "") insertion.push("");
  nextLines.splice(refreshedInProgressEnd, 0, ...insertion);

  return {
    status: "claimed",
    reason: "claimed",
    item,
    itemType: detectTodoType(item),
    itemAgent: detectAgent(item),
    updatedContent: nextLines.join("\n"),
  };
}

async function withFileLock<T>(
  lockPath: string,
  retries: number,
  retryDelayMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`, { encoding: "utf8" });
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      lastError = error;

      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        if (attempt === retries) break;
        await sleep(retryDelayMs);
        continue;
      }

      throw error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : "unknown lock error";
  const error = new Error(`failed-to-acquire-lock: ${message}`);
  (error as NodeJS.ErrnoException).code = "ELOCKED";
  throw error;
}

export async function withTodoLock<T>(
  todoPath: string,
  fn: () => Promise<T>,
  options: { retries?: number; retryDelayMs?: number } = {},
): Promise<T> {
  const {
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;
  const absoluteTodoPath = path.resolve(todoPath);
  const lockPath = `${absoluteTodoPath}.lock`;
  return withFileLock(lockPath, retries, retryDelayMs, fn);
}

export function todoContainsSummary(content: string, summary: string): boolean {
  const lines = ensureInProgressSection(content.split(/\r?\n/));
  const sections = parseItemsInSection(lines, 0, lines.length);
  return sections.some((item) => extractItemSummary(lines, item.start) === summary);
}

export function removeInProgressItemBySummary(
  content: string,
  summary: string,
): { status: "removed" | "not-found"; updatedContent: string } {
  const lines = ensureInProgressSection(content.split(/\r?\n/));
  const inProgressHeaderIndex = lines.findIndex((line) => line.trim() === IN_PROGRESS_HEADER);

  if (inProgressHeaderIndex < 0) {
    return { status: "not-found", updatedContent: content };
  }

  const inProgressStart = inProgressHeaderIndex + 1;
  const inProgressEndCandidate = findSectionEnd(lines, inProgressStart, lines.length);
  const inProgressEnd =
    inProgressEndCandidate < 0 ? lines.length : inProgressEndCandidate;
  const inProgressItems = parseItemsInSection(lines, inProgressStart, inProgressEnd);
  const target = inProgressItems.find(
    (item) => extractItemSummary(lines, item.start) === summary,
  );

  if (!target) {
    return { status: "not-found", updatedContent: content };
  }

  const nextLines = lines.slice(0, target.start).concat(lines.slice(target.end));
  return {
    status: "removed",
    updatedContent: nextLines.join("\n"),
  };
}

export interface ClaimNextReadyTodoOptions {
  todoPath?: string;
  sharedTodoPath?: string;
  retries?: number;
  retryDelayMs?: number;
  agent?: string;
}

export interface ClaimNextReadyTodoResult {
  status: string;
  reason: string;
  item: string;
  itemType: string;
  itemAgent: string;
  todoPath: string;
  localTodoPath: string;
}

export async function claimNextReadyTodo(
  options: ClaimNextReadyTodoOptions = {},
): Promise<ClaimNextReadyTodoResult> {
  const {
    todoPath = "TODO.md",
    sharedTodoPath = process.env.NEXT_SHARED_TODO_PATH || "",
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    agent,
  } = options;

  const absoluteLocalTodoPath = path.resolve(todoPath);
  const absoluteSharedTodoPath = sharedTodoPath ? path.resolve(sharedTodoPath) : absoluteLocalTodoPath;
  const lockPath = `${absoluteSharedTodoPath}.lock`;

  return withFileLock(lockPath, retries, retryDelayMs, async () => {
    const original = await readFile(absoluteSharedTodoPath, "utf8");
    const claimResult = claimFromTodoText(original, { agent });
    const updatedContent = claimResult.status === "claimed" ? claimResult.updatedContent : original;

    if (claimResult.status === "claimed") {
      await writeFile(absoluteSharedTodoPath, updatedContent, "utf8");
    }

    if (absoluteLocalTodoPath !== absoluteSharedTodoPath) {
      await writeFile(absoluteLocalTodoPath, updatedContent, "utf8");
    }

    return {
      status: claimResult.status,
      reason: claimResult.reason,
      item: claimResult.item,
      itemType: claimResult.itemType,
      itemAgent: claimResult.itemAgent,
      todoPath: absoluteSharedTodoPath,
      localTodoPath: absoluteLocalTodoPath,
    };
  });
}

function parseCliArgs(argv: string[]): ClaimNextReadyTodoOptions {
  const args: ClaimNextReadyTodoOptions = {
    todoPath: "TODO.md",
    retries: DEFAULT_RETRIES,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const nextValue = argv[index + 1];

    if (current === "--todo" && nextValue) {
      args.todoPath = nextValue;
      index += 1;
      continue;
    }

    if (current === "--shared-todo" && nextValue) {
      args.sharedTodoPath = nextValue;
      index += 1;
      continue;
    }

    if (current === "--retries" && nextValue) {
      const parsed = Number.parseInt(nextValue, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        args.retries = parsed;
      }
      index += 1;
      continue;
    }

    if (current === "--retry-delay-ms" && nextValue) {
      const parsed = Number.parseInt(nextValue, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        args.retryDelayMs = parsed;
      }
      index += 1;
      continue;
    }
  }

  return args;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const result = await claimNextReadyTodo(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
