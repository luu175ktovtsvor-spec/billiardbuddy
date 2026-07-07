import { describe, expect, test } from "vitest";

import { approvalPreviewState, parseApprovalPlanPreview, parseApprovalPreviewDiff } from "./approval-preview-diff";

describe("parseApprovalPreviewDiff", () => {
  test("reconstructs before and after text from unified diff hunks", () => {
    const parsed = parseApprovalPreviewDiff([
      "@@ -1,3 +1,3 @@",
      " const title = \"old\";",
      "-const enabled = false;",
      "+const enabled = true;",
      " export { title, enabled };",
    ].join("\n"));

    expect(parsed).toEqual({
      before: [
        "const title = \"old\";",
        "const enabled = false;",
        "export { title, enabled };",
      ].join("\n"),
      after: [
        "const title = \"old\";",
        "const enabled = true;",
        "export { title, enabled };",
      ].join("\n"),
    });
  });

  test("keeps multiple hunks separated and ignores non-diff text", () => {
    const parsed = parseApprovalPreviewDiff([
      "restore preview",
      "@@ -2,2 +2,2 @@",
      " keep",
      "-old",
      "+new",
      "@@ -8,2 +8,2 @@",
      "-left",
      "+right",
      " tail",
    ].join("\n"));

    expect(parsed?.before).toBe(["keep", "old", "", "left", "tail"].join("\n"));
    expect(parsed?.after).toBe(["keep", "new", "", "right", "tail"].join("\n"));
  });

  test("returns null for ordinary approval copy", () => {
    expect(parseApprovalPreviewDiff("要运行项目测试诊断")).toBeNull();
    expect(parseApprovalPreviewDiff("@@ not a real hunk")).toBeNull();
  });

  test("marks previews stale once approval args are edited", () => {
    const preview = [
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(approvalPreviewState(preview, false)).toMatchObject({ kind: "diff" });
    expect(approvalPreviewState(preview, true)).toEqual({ kind: "stale", preview });
    expect(approvalPreviewState("要运行测试", false)).toEqual({ kind: "text", preview: "要运行测试" });
    expect(approvalPreviewState(undefined, false)).toEqual({ kind: "none" });
  });
});

describe("parseApprovalPlanPreview", () => {
  test("parses run_command execution plans", () => {
    const parsed = parseApprovalPlanPreview([
      "<run_command_preview>",
      "command: pnpm exec tsc --noEmit",
      "cwd: web",
      "risk: file",
      "timeout_ms: 30000",
      "max_output_bytes: 64000",
      "</run_command_preview>",
    ].join("\n"));

    expect(parsed).toEqual({
      type: "run_command",
      command: "pnpm exec tsc --noEmit",
      cwd: "web",
      risk: "file",
      timeoutMs: "30000",
      maxOutputBytes: "64000",
    });
    expect(approvalPreviewState("<run_command_preview>\ncommand: bun test\n</run_command_preview>", false)).toMatchObject({ kind: "plan" });
  });

  test("parses project_diagnostics ready plans with focused tests", () => {
    const parsed = parseApprovalPlanPreview([
      '<project_diagnostics_preview status="ready">',
      "package: ts/package.json",
      "cwd: ts",
      "check: test",
      "script: test",
      "manager: bun",
      "command: bun test -- src/tools/fileTools.test.ts src/tools/runCommandTool.test.ts",
      "test_targets:",
      "- src/tools/fileTools.test.ts",
      "- src/tools/runCommandTool.test.ts",
      "timeout_ms: 60000",
      "max_output_bytes: 80000",
      "</project_diagnostics_preview>",
    ].join("\n"));

    expect(parsed).toEqual({
      type: "project_diagnostics",
      status: "ready",
      packagePath: "ts/package.json",
      cwd: "ts",
      check: "test",
      script: "test",
      manager: "bun",
      command: "bun test -- src/tools/fileTools.test.ts src/tools/runCommandTool.test.ts",
      testTargets: ["src/tools/fileTools.test.ts", "src/tools/runCommandTool.test.ts"],
      timeoutMs: "60000",
      maxOutputBytes: "80000",
    });
  });

  test("parses project_diagnostics non-ready plan details", () => {
    expect(parseApprovalPlanPreview('<project_diagnostics_preview status="missing_package_json" start="web/src" />')).toEqual({
      type: "project_diagnostics",
      status: "missing_package_json",
      start: "web/src",
    });

    expect(parseApprovalPlanPreview([
      '<project_diagnostics_preview status="missing_script">',
      "package: web/package.json",
      "check: lint",
      "available: dev,build,typecheck",
      "</project_diagnostics_preview>",
    ].join("\n"))).toEqual({
      type: "project_diagnostics",
      status: "missing_script",
      packagePath: "web/package.json",
      check: "lint",
      available: ["dev", "build", "typecheck"],
    });
  });
});
