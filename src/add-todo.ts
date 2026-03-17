export const SECTION_HEADERS = {
  planned: "## Planned",
  ready: "## Ready to be picked up",
} as const;

export type TodoSection = keyof typeof SECTION_HEADERS;

function findSectionEnd(lines: string[], startIndex: number): number {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index]) || /^#\s+/.test(lines[index])) {
      return index;
    }
  }
  return lines.length;
}

export function insertIntoSection(
  content: string,
  itemLines: string[],
  section: TodoSection,
): string {
  const lines = content.split(/\r?\n/);
  const sectionHeader = SECTION_HEADERS[section];
  const plannedIndex = lines.findIndex((line) => line.trim() === sectionHeader);

  if (plannedIndex < 0) {
    const nextLines = lines.slice();
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
      nextLines.pop();
    }
    if (nextLines.length > 0) nextLines.push("");
    nextLines.push(sectionHeader, "", ...itemLines, "");
    return `${nextLines.join("\n")}\n`;
  }

  const plannedEnd = findSectionEnd(lines, plannedIndex);
  const nextLines = lines.slice();
  const insertion: string[] = [];

  if (plannedEnd > plannedIndex + 1 && nextLines[plannedEnd - 1] !== "") {
    insertion.push("");
  }
  insertion.push(...itemLines, "");

  nextLines.splice(plannedEnd, 0, ...insertion);
  return `${nextLines.join("\n")}\n`;
}
