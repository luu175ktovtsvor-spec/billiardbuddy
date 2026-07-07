import { describe, expect, test } from "vitest";

import { parseProjectDiagnosticsResult } from "./project-diagnostics-result";

describe("parseProjectDiagnosticsResult", () => {
  test("parses completed diagnostics", () => {
    const parsed = parseProjectDiagnosticsResult(`<project_diagnostics status="completed" package="web/package.json" cwd="web" check="typecheck" script="typecheck" manager="pnpm" exit_code="0" elapsed_ms="1200" timed_out="false" truncated="false">
<command>pnpm run typecheck</command>
<test_targets count="1">
<target path="src/components/desktop/chat-thread.test.tsx" />
</test_targets>
<test_suggestions count="1">
<suggestion path="src/components/desktop/chat-thread.test.tsx" cwd="web" command="pnpm run test -- src/components/desktop/chat-thread.test.tsx" />
</test_suggestions>
<output>
ok &amp; clean
</output>
</project_diagnostics>`);

    expect(parsed).toMatchObject({
      status: "completed",
      packagePath: "web/package.json",
      cwd: "web",
      check: "typecheck",
      script: "typecheck",
      manager: "pnpm",
      exitCode: 0,
      elapsedMs: 1200,
      timedOut: false,
      truncated: false,
      command: "pnpm run typecheck",
      output: "ok & clean",
      testTargets: ["src/components/desktop/chat-thread.test.tsx"],
      testSuggestions: [{
        path: "src/components/desktop/chat-thread.test.tsx",
        cwd: "web",
        command: "pnpm run test -- src/components/desktop/chat-thread.test.tsx",
      }],
    });
  });

  test("parses missing script metadata", () => {
    const parsed = parseProjectDiagnosticsResult('<project_diagnostics status="missing_script" package="package.json" check="lint" available="build,typecheck" />');
    expect(parsed).toMatchObject({
      status: "missing_script",
      packagePath: "package.json",
      check: "lint",
      available: ["build", "typecheck"],
    });
  });

  test("parses invalid package json metadata", () => {
    const parsed = parseProjectDiagnosticsResult('<project_diagnostics status="invalid_package_json" package="packages/app/package.json" error="Unexpected end of JSON input" />');
    expect(parsed).toMatchObject({
      status: "invalid_package_json",
      packagePath: "packages/app/package.json",
      error: "Unexpected end of JSON input",
    });
  });

  test("parses rejected diagnostics with escaped script body", () => {
    const parsed = parseProjectDiagnosticsResult(`<project_diagnostics status="rejected" package="package.json" check="typecheck" script="typecheck" reason="脚本包含输出重定向">
echo &quot;x&quot; &gt; out.txt
</project_diagnostics>`);
    expect(parsed).toMatchObject({
      status: "rejected",
      reason: "脚本包含输出重定向",
      output: 'echo "x" > out.txt',
    });
  });

  test("parses invalid focused test path metadata", () => {
    const parsed = parseProjectDiagnosticsResult('<project_diagnostics status="invalid_test_path" package="packages/app/package.json" check="test" script="test" reason="测试路径不在 package 内:outside.test.ts" />');
    expect(parsed).toMatchObject({
      status: "invalid_test_path",
      packagePath: "packages/app/package.json",
      check: "test",
      script: "test",
      reason: "测试路径不在 package 内:outside.test.ts",
    });
  });

  test("parses stored long diagnostics preview", () => {
    const parsed = parseProjectDiagnosticsResult(`<stored_tool_result tool="project_diagnostics" call_id="call_1" chars="30000" bytes="30000" path="/tmp/result.txt">
<preview_head chars="130">
&lt;project_diagnostics status=&quot;completed&quot; package=&quot;web/package.json&quot; check=&quot;typecheck&quot; exit_code=&quot;1&quot; truncated=&quot;true&quot;&gt;
</preview_head>
<preview_tail chars="20">
error tail
</preview_tail>
</stored_tool_result>`);
    expect(parsed).toMatchObject({
      status: "completed",
      packagePath: "web/package.json",
      check: "typecheck",
      exitCode: 1,
      truncated: true,
      stored: {
        path: "/tmp/result.txt",
        chars: 30000,
        bytes: 30000,
        previewTail: "error tail",
      },
    });
  });

  test("ignores ordinary output", () => {
    expect(parseProjectDiagnosticsResult("plain text")).toBeNull();
  });
});
