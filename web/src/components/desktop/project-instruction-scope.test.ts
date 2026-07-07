import { describe, expect, test } from "vitest";

import { parseProjectInstructionScope } from "./project-instruction-scope";

describe("parseProjectInstructionScope", () => {
  test("parses project instruction blocks with decoded excerpts", () => {
    expect(parseProjectInstructionScope([
      "# 项目指令",
      "<project_instruction file=\"src/AGENTS.md\" truncated=\"false\">",
      "Use named exports &amp; run tests.",
      "</project_instruction>",
      "<project_instruction file=\"src/app/CLAUDE.md\" truncated=\"true\">",
      "Keep UI compact.",
      "</project_instruction>",
      "<project_instructions_omitted count=\"2\" />",
    ].join("\n"))).toEqual({
      status: "found",
      omitted: 2,
      files: [
        { file: "src/AGENTS.md", truncated: false, excerpt: "Use named exports & run tests." },
        { file: "src/app/CLAUDE.md", truncated: true, excerpt: "Keep UI compact." },
      ],
    });
  });

  test("parses empty scope responses", () => {
    expect(parseProjectInstructionScope('<project_instructions status="empty" targets="src/new.ts" omitted="3" />')).toEqual({
      status: "empty",
      targets: "src/new.ts",
      omitted: 3,
      files: [],
    });
  });

  test("ignores unrelated tool output", () => {
    expect(parseProjectInstructionScope("plain output")).toBeNull();
  });
});
