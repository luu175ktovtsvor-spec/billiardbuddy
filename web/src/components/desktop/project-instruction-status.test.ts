import { describe, expect, test } from "vitest";

import { latestProjectInstructionScope, projectInstructionStatus } from "./project-instruction-status";

describe("project instruction status", () => {
  test("uses the latest finished or live list_project_instructions result", () => {
    const oldResult = '<project_instruction file="src/AGENTS.md" truncated="false">old</project_instruction>';
    const liveResult = '<project_instruction file="packages/app/CLAUDE.md" truncated="true">new</project_instruction>';
    const latest = latestProjectInstructionScope([
      { steps: [{ tool: "list_project_instructions", result: oldResult }] },
    ], [
      { tool: "grep_files", result: "noise" },
      { tool: "list_project_instructions", result: liveResult },
    ]);

    expect(latest?.status).toBe("found");
    expect(latest?.files.map(file => file.file)).toEqual(["packages/app/CLAUDE.md"]);
    expect(latest?.files[0]?.truncated).toBe(true);
  });

  test("formats root and recent scope as one compact status chip", () => {
    const latest = latestProjectInstructionScope([
      { steps: [{ tool: "list_project_instructions", result: '<project_instruction file="src/AGENTS.md" truncated="false">rules</project_instruction>' }] },
    ]);
    expect(projectInstructionStatus({
      files: [{ file: "AGENTS.md", truncated: false }],
      count: 1,
      truncated: false,
    }, latest)).toEqual({
      label: "规则:根1 · scope1",
      title: "根级规则: AGENTS.md\n最近 scope: src/AGENTS.md",
      active: true,
    });
  });

  test("shows empty scope without pretending rules were found", () => {
    const latest = latestProjectInstructionScope([
      { steps: [{ tool: "list_project_instructions", result: '<project_instructions status="empty" targets="src/new.ts" />' }] },
    ]);
    expect(projectInstructionStatus(null, latest)).toEqual({
      label: "规则:scope空",
      title: "根级规则: 未发现 AGENTS.md/CLAUDE.md\n最近 scope: 未命中 (src/new.ts)",
      active: true,
    });
  });
});
